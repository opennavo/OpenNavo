package management

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/opennavo/opennavo/server/internal/domain"
)

func (s *Service) translationModels(ctx context.Context, in Input) (any, error) {
	if err := validateTranslationGateway(in.Body, s.Config); err != nil {
		return nil, err
	}
	key := text(in.Body, "apiKey")
	if key == "" {
		key = s.Config.LLMAPIKey
		if !boolean(in.Body, "clearApiKey") {
			settings, err := s.Store.TranslationSettings(ctx)
			if err != nil {
				return nil, err
			}
			if settings.APIKeyCiphertext != "" {
				key, err = s.Config.DecryptTranslationKey(settings.APIKeyCiphertext)
				if err != nil {
					return nil, fail(domain.CodeLLMUnavailable)
				}
			}
		}
	}
	if key == "" {
		return nil, domain.Validation()
	}
	// Do not retry or follow redirects; raw gateway errors may contain credentials, so return only the standard business error.
	client := openai.NewClient(option.WithBaseURL(text(in.Body, "baseUrl")), option.WithAPIKey(key), option.WithMaxRetries(0), option.WithHTTPClient(&http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}))
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	page, err := client.Models.List(ctx)
	if err != nil || page == nil {
		return nil, fail(domain.CodeLLMUnavailable)
	}
	var shape struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(page.RawJSON()), &shape) != nil || len(shape.Data) == 0 || shape.Data[0] != '[' || len(page.Data) > 10000 {
		return nil, fail(domain.CodeLLMUnavailable)
	}
	models := []string{}
	seen := map[string]bool{}
	for _, model := range page.Data {
		id := model.ID
		if id == "" || len(id) > 200 || strings.IndexFunc(id, unicode.IsSpace) >= 0 || strings.IndexFunc(id, unicode.IsControl) >= 0 || strings.Contains(id, key) || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, id)
	}
	sort.Strings(models)
	return map[string]any{"models": models}, nil
}
