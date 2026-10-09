package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/opennavo/opennavo/server/internal/llm"
)

func (s *Store) LLMMonth(ctx context.Context, now time.Time) (llm.Totals, error) {
	var out llm.Totals
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	err := s.DB.WithContext(ctx).Raw(`SELECT coalesce(sum(prompt_tokens::bigint+completion_tokens),0) tokens,coalesce(sum(cost_usd),0) cost_usd FROM llm_usage WHERE created_at>=? AND created_at<?`, start, start.AddDate(0, 1, 0)).Scan(&out).Error
	return out, err
}
func (s *Store) LLMPrice(ctx context.Context, model string) (*llm.Price, error) {
	var row struct{ Value json.RawMessage }
	if err := s.DB.WithContext(ctx).Raw("SELECT value FROM app_config WHERE key='llm.pricing'").Scan(&row).Error; err != nil {
		return nil, err
	}
	var prices map[string]llm.Price
	if len(row.Value) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(row.Value, &prices); err != nil {
		return nil, err
	}
	price, exists := prices[model]
	if !exists {
		return nil, nil
	}
	if price.Input < 0 || price.Output < 0 {
		return nil, fmt.Errorf("invalid model price")
	}
	return &price, nil
}
func (s *Store) SaveLLMUsage(ctx context.Context, task string, ref int64, usage llm.Attempt, cost *float64) error {
	result := usage.Result
	if result == "" {
		result = "succeeded"
		if usage.FinishReason != "stop" {
			result = "failed"
		}
	}
	return s.DB.WithContext(ctx).Exec(`INSERT INTO llm_usage(task,ref_id,model,reasoning_effort,prompt_tokens,completion_tokens,reasoning_tokens,cached_tokens,latency_ms,finish_reason,cost_usd,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, task, ref, usage.Model, usage.ReasoningEffort, usage.PromptTokens, usage.CompletionTokens, usage.ReasoningTokens, usage.CachedTokens, usage.LatencyMS, usage.FinishReason, cost, result).Error
}
