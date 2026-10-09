package store

import (
	"context"
	"encoding/json"
	"time"
)

type JobMetric struct {
	JobType, Status, Source string
	Runs                    int64
	LastFinishedAt          time.Time
}
type PackageMetric struct {
	Kind  string
	Count int64
}
type LLMMetric struct {
	Task, Result                                    string
	Requests, Prompt, Completion, Reasoning, Cached int64
	Cost                                            *float64
	Seconds                                         float64
	Buckets                                         json.RawMessage
}
type TranslationMetric struct {
	Entity, Status   string
	Requests, Tokens int64
}
type MetricState struct {
	Translations       []TranslationMetric
	Jobs               []JobMetric
	Packages           []PackageMetric
	LLM                []LLMMetric
	MonthlyTokens      int64
	MonthlyTokenBudget int64
	GitHubRemaining    int64
}

func (s *Store) MetricState(ctx context.Context, now time.Time) (MetricState, error) {
	out := MetricState{GitHubRemaining: -1}
	if err := s.DB.WithContext(ctx).Table("translation_metrics").Find(&out.Translations).Error; err != nil {
		return out, err
	}
	if err := s.DB.WithContext(ctx).Raw("SELECT * FROM job_metrics").Scan(&out.Jobs).Error; err != nil {
		return out, err
	}
	if err := s.DB.WithContext(ctx).Raw("SELECT kind,count(*) AS count FROM packages WHERE removed_at IS NULL GROUP BY kind").Scan(&out.Packages).Error; err != nil {
		return out, err
	}
	if err := s.DB.WithContext(ctx).Raw(`SELECT task,result,count(*) AS requests,sum(prompt_tokens::bigint) AS prompt,sum(completion_tokens::bigint) AS completion,sum(reasoning_tokens::bigint) AS reasoning,sum(cached_tokens::bigint) AS cached,sum(cost_usd) AS cost,sum(latency_ms::bigint)/1000.0 AS seconds,jsonb_build_object('1',count(*) FILTER(WHERE latency_ms<=1000),'5',count(*) FILTER(WHERE latency_ms<=5000),'10',count(*) FILTER(WHERE latency_ms<=10000),'30',count(*) FILTER(WHERE latency_ms<=30000),'60',count(*) FILTER(WHERE latency_ms<=60000),'180',count(*) FILTER(WHERE latency_ms<=180000),'300',count(*) FILTER(WHERE latency_ms<=300000),'600',count(*) FILTER(WHERE latency_ms<=600000)) AS buckets FROM llm_usage GROUP BY task,result`).Scan(&out.LLM).Error; err != nil {
		return out, err
	}
	totals, err := s.LLMMonth(ctx, now)
	if err != nil {
		return out, err
	}
	settings, err := s.TranslationSettings(ctx)
	if err != nil {
		return out, err
	}
	out.MonthlyTokenBudget = settings.MonthlyTokenBudget
	out.MonthlyTokens = totals.Tokens
	if s.Redis != nil {
		if value, err := s.Redis.Get(ctx, "metrics:github:remaining").Int64(); err == nil {
			out.GitHubRemaining = value
		}
	}
	return out, nil
}
func (s *Store) ObserveGitHubQuota(ctx context.Context, remaining int64) {
	if s.Redis != nil {
		_ = s.Redis.Set(ctx, "metrics:github:remaining", remaining, time.Hour).Err()
	}
}
