package contenttranslate

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

type Service struct {
	Store   *store.Store
	LLM     llm.ContentTranslator
	Model   string
	NoRetry bool
}

var unlock = redis.NewScript(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`)

func (s *Service) Run(ctx context.Context, ref content.Ref, hash string) (map[string]any, error) {
	if ref.Entity == "about" {
		return s.runAbout(ctx, hash)
	}
	stats := map[string]any{"entity": ref.Entity, "objectKey": ref.Key(), "calls": 0, "tokens": int64(0)}
	if !ref.Valid() {
		return stats, errors.New("invalid content reference")
	}
	settings, err := s.Store.TranslationSettings(ctx)
	if err != nil {
		return stats, err
	}
	var types, enabledLocales []string
	if json.Unmarshal(settings.ContentTypes, &types) != nil || json.Unmarshal(settings.EnabledLocales, &enabledLocales) != nil {
		return stats, errors.New("invalid translation settings")
	}
	allowed := false
	for _, kind := range types {
		allowed = allowed || kind == ref.Entity
	}
	if !settings.Enabled || !allowed {
		stats["skipped"] = "disabled"
		return stats, nil
	}
	lease, key := rand.Text(), "translation:lease:"+ref.Entity+":"+ref.Key()+":"+hash
	acquired, err := s.Store.Redis.SetNX(ctx, key, lease, time.Hour).Result()
	if err != nil {
		return stats, err
	}
	if !acquired {
		stats["skipped"] = "running"
		return stats, nil
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_ = unlock.Run(cleanup, s.Store.Redis, []string{key}, lease).Err()
	}()
	source, err := s.Store.ReadContentSource(ctx, ref)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		stats["skipped"] = "deleted"
		return stats, nil
	}
	if err != nil {
		return stats, err
	}
	if source.Hash != hash || len(source.Targets) == 0 {
		stats["skipped"] = "fresh_or_stale"
		return stats, nil
	}
	glossary, protected, err := s.Store.ContentGlossary(ctx)
	if err != nil {
		return stats, err
	}
	protected = append(protected, source.Protected...)
	targets := []string{}
	for locale := range source.Targets {
		for _, enabled := range enabledLocales {
			if locale == enabled {
				targets = append(targets, locale)
				break
			}
		}
	}
	if len(targets) == 0 {
		stats["skipped"] = "disabled_locales"
		return stats, nil
	}
	sort.Strings(targets)
	fields := content.Flatten(source.Fields)
	limits := map[string]int{}
	spec := content.Registry[ref.Entity]
	for key := range fields {
		root := strings.Split(key, ".")[0]
		limits[key] = spec.Fields[root]
		if strings.HasPrefix(key, "sections.") {
			limits[key] = 400
		}
	}
	base := llm.ContentInput{RefID: ref.ID, SourceLocale: source.SourceLocale, Targets: targets, Fields: fields, Limits: limits, Protected: protected, Glossary: glossary}
	batches := Plan(base, spec.Long)
	model := s.Model
	output := llm.ContentOutput{}
	for _, locale := range targets {
		output[locale] = map[string]string{}
	}
	for _, batch := range batches {
		result, usage, callErr := s.call(ctx, batch)
		if len(usage.Attempts) > 0 {
			model = usage.Attempts[len(usage.Attempts)-1].Model
		}
		stats["calls"] = stats["calls"].(int) + len(usage.Attempts)
		stats["tokens"] = stats["tokens"].(int64) + usage.Tokens()
		status, reason := "succeeded", ""
		if callErr != nil {
			status = "failed"
			reason = failureReason(callErr)
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		logErr := s.Store.LogContentTranslation(cleanup, source, batch.Targets, status, reason, model, usage)
		cancel()
		if logErr != nil {
			return stats, logErr
		}
		if callErr != nil {
			if err := s.Store.FailContentTranslation(ctx, source, targets, reason); err != nil {
				return stats, err
			}
			return stats, callErr
		}
		for locale, translated := range result {
			for key, value := range translated {
				if output[locale][key] != "" {
					output[locale][key] += "\n\n"
				}
				output[locale][key] += value
			}
		}
	}
	if err := llm.ValidateContent(output, base); err != nil {
		return stats, errors.Join(err, s.Store.FailContentTranslation(ctx, source, targets, failureReason(err)), s.Store.LogContentTranslation(ctx, source, targets, "failed", failureReason(err), model, llm.Usage{}))
	}
	applied := 0
	for _, locale := range targets {
		changed, err := s.Store.ApplyContentTranslation(ctx, source, locale, output[locale], model)
		if err != nil {
			return stats, err
		}
		if changed {
			applied++
		}
	}
	if applied > 0 {
		if err := cache.PublishInvalidation(ctx, s.Store.Redis, "c:*"); err != nil {
			return stats, err
		}
	}
	if applied < len(targets) {
		if err := s.Store.LogContentTranslation(ctx, source, targets, "stale", "content_changed", model, llm.Usage{}); err != nil {
			return stats, err
		}
	}
	stats["translated"] = applied
	stats["stale"] = len(targets) - applied
	return stats, nil
}
func failureReason(err error) string {
	var failure *llm.Failure
	if errors.As(err, &failure) {
		return failure.Reason
	}
	if errors.Is(err, llm.ErrPaused) {
		return "paused"
	}
	return "request_failed"
}
func (s *Service) call(ctx context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	var all llm.Usage
	networkRetries, validationRetries := 0, 0
	for {
		out, usage, err := s.LLM.TranslateContent(ctx, in)
		all.Attempts = append(all.Attempts, usage.Attempts...)
		if err == nil {
			err = llm.ValidateContent(out, in)
		}
		if err == nil {
			return out, all, nil
		}
		if s.NoRetry {
			return nil, all, err
		}
		var failure *llm.Failure
		if !errors.As(err, &failure) || failure.Pause || errors.Is(err, llm.ErrPaused) {
			return nil, all, err
		}
		if failure.Retryable {
			if networkRetries >= 3 {
				return nil, all, err
			}
			networkRetries++
			timer := time.NewTimer(time.Duration(networkRetries) * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, all, ctx.Err()
			case <-timer.C:
			}
		} else {
			if validationRetries >= 1 {
				return nil, all, err
			}
			validationRetries++
			in.Strict = true
		}
	}
}

// Generate all target languages together for short fields; request long Markdown per language and split paragraphs without breaking code fences.
func Plan(in llm.ContentInput, long map[string]bool) []llm.ContentInput {
	short := in
	short.Fields = map[string]string{}
	out := []llm.ContentInput{}
	keys := []string{}
	for key := range in.Fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := in.Fields[key]
		if !long[strings.Split(key, ".")[0]] {
			short.Fields[key] = value
			continue
		}
		for _, locale := range in.Targets {
			for _, chunk := range chunks(value, 6000) {
				part := in
				part.Targets = []string{locale}
				part.Fields = map[string]string{key: chunk}
				out = append(out, part)
			}
		}
	}
	if len(short.Fields) > 0 {
		out = append([]llm.ContentInput{short}, out...)
	}
	return out
}
func chunks(value string, maximum int) []string {
	paragraphs := strings.Split(value, "\n\n")
	out := []string{}
	current := ""
	fenced := false
	for _, part := range paragraphs {
		if current != "" && len([]rune(current))+len([]rune(part)) > maximum && !fenced {
			out = append(out, current)
			current = ""
		}
		if current != "" {
			current += "\n\n"
		}
		current += part
		if (strings.Count(part, "```")+strings.Count(part, "~~~"))%2 == 1 {
			fenced = !fenced
		}
	}
	if current != "" {
		out = append(out, current)
	}
	return out
}
func (s *Service) String() string { return fmt.Sprintf("content translator (%s)", s.Model) }
