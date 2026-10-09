package store

import (
	"context"

	"github.com/opennavo/opennavo/server/internal/config"
)

// Read and return an independent snapshot each time; do not mutate shared clients or cache credentials.
func (s *Store) TranslationConfig(ctx context.Context, base config.Config) (config.Config, error) {
	settings, err := s.TranslationSettings(ctx)
	if err != nil {
		return config.Config{}, err
	}
	base.LLMEnabled = settings.Enabled
	base.LLMMonthlyTokenBudget = settings.MonthlyTokenBudget
	// Only admin settings determine content translation budgets; environment monetary limits are not added.
	base.LLMMonthlyBudgetUSD = 0
	if settings.BaseURL != "" {
		base.LLMBaseURL = settings.BaseURL
	}
	if settings.Model != "" {
		base.LLMModelTranslate = settings.Model
	}
	if settings.ReasoningEffort != "" {
		base.LLMReasoningEffortTranslate = settings.ReasoningEffort
	}
	if settings.APIKeyCiphertext != "" {
		base.LLMAPIKey, err = base.DecryptTranslationKey(settings.APIKeyCiphertext)
		if err != nil {
			return config.Config{}, err
		}
	}
	return base, nil
}
