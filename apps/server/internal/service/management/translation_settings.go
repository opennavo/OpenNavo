package management

import (
	"context"
	"math"
	"net/url"
	"strings"
	"unicode"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func translationView(settings store.TranslationSettings, cfg config.Config) map[string]any {
	base := settings.BaseURL
	if base == "" {
		base = cfg.LLMBaseURL
	}
	source := "none"
	if cfg.LLMAPIKey != "" {
		source = "environment"
	}
	if settings.APIKeyCiphertext != "" {
		source = "admin"
	}
	return map[string]any{"enabled": settings.Enabled, "baseUrl": base, "model": settings.Model, "reasoningEffort": settings.ReasoningEffort, "monthlyTokenBudget": settings.MonthlyTokenBudget, "apiKeyConfigured": source != "none", "environmentKeyConfigured": cfg.LLMAPIKey != "", "apiKeySource": source}
}
func validateTranslationGateway(body map[string]any, cfg config.Config) error {
	raw := text(body, "baseUrl")
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || len(raw) > 2048 || strings.TrimSpace(raw) != raw || (u.Scheme != "https" && (cfg.AppEnv == "prod" || u.Scheme != "http")) {
		return domain.Validation()
	}
	key := text(body, "apiKey")
	if len(key) > 4096 || strings.TrimSpace(key) != key || strings.IndexFunc(key, unicode.IsControl) >= 0 || (key != "" && boolean(body, "clearApiKey")) {
		return domain.Validation()
	}
	return nil
}
func validateTranslationSettings(body map[string]any, cfg config.Config) error {
	if err := validateTranslationGateway(body, cfg); err != nil {
		return err
	}
	model := text(body, "model")
	if model == "" || len(model) > 200 || strings.IndexFunc(model, unicode.IsSpace) >= 0 || strings.IndexFunc(model, unicode.IsControl) >= 0 {
		return domain.Validation()
	}
	effort := text(body, "reasoningEffort")
	if effort != "low" && effort != "medium" && effort != "high" {
		return domain.Validation()
	}
	budget, ok := body["monthlyTokenBudget"].(float64)
	if !ok || budget < 1 || budget > 9007199254740991 || math.Trunc(budget) != budget {
		return domain.Validation()
	}
	if _, ok := body["enabled"].(bool); !ok {
		return domain.Validation()
	}
	return nil
}
func (s *Service) translationSettings(ctx context.Context, op string, in Input) (any, error) {
	if op == "GetTranslationSettings" {
		settings, err := s.Store.TranslationSettings(ctx)
		if err != nil {
			return nil, err
		}
		return translationView(settings, s.Config), nil
	}
	if err := validateTranslationSettings(in.Body, s.Config); err != nil {
		return nil, err
	}
	var result map[string]any
	err := s.Store.WithTx(ctx, func(tx *gorm.DB) error {
		var before store.TranslationSettings
		if err := tx.WithContext(ctx).Table("i18n_settings").Clauses(clause.Locking{Strength: "UPDATE"}).Where("id=true").Take(&before).Error; err != nil {
			return err
		}
		after := before
		after.Enabled = boolean(in.Body, "enabled")
		after.BaseURL = text(in.Body, "baseUrl")
		after.Model = text(in.Body, "model")
		after.ReasoningEffort = text(in.Body, "reasoningEffort")
		after.MonthlyTokenBudget = int64(in.Body["monthlyTokenBudget"].(float64))
		if boolean(in.Body, "clearApiKey") {
			after.APIKeyCiphertext = ""
		}
		if key := text(in.Body, "apiKey"); key != "" {
			var err error
			after.APIKeyCiphertext, err = s.Config.EncryptTranslationKey(key)
			if err != nil {
				return err
			}
		}
		if after.Enabled && after.APIKeyCiphertext == "" && s.Config.LLMAPIKey == "" {
			return domain.Validation()
		}
		fields := map[string]any{"enabled": after.Enabled, "base_url": after.BaseURL, "model": after.Model, "reasoning_effort": after.ReasoningEffort, "monthly_token_budget": after.MonthlyTokenBudget, "api_key_ciphertext": after.APIKeyCiphertext, "updated_at": s.now()}
		if err := tx.WithContext(ctx).Table("i18n_settings").Where("id=true").Updates(fields).Error; err != nil {
			return err
		}
		result = translationView(after, s.Config)
		return store.Audit(ctx, tx, in.Actor, op, "i18n_settings", "true", translationView(before, s.Config), result)
	})
	if err != nil {
		return nil, store.MapAdminError(err)
	}
	if boolean(in.Body, "enabled") && s.Store.Redis != nil {
		// Allow new credentials and budgets to be revalidated after saving; retain usage and reservation ledgers so the next call still obeys the admin budget.
		reset := redis.NewScript(`local reason=redis.call('GET',KEYS[1]); if reason=='disabled' or reason=='authorization' or reason=='budget' then redis.call('DEL',KEYS[1],KEYS[2]); return 1 end; return 0`)
		if err := reset.Run(ctx, s.Store.Redis, []string{"llm:paused_reason", "asynq:{llm}:paused"}).Err(); err != nil {
			return nil, err
		}
	}
	return result, nil
}
