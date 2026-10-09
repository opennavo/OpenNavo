package observability

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/prometheus/client_golang/prometheus"
)

type BusinessMetrics struct {
	Store  *store.Store
	mu     sync.Mutex
	loaded time.Time
	state  store.MetricState
	err    error
	desc   map[string]*prometheus.Desc
}

func NewBusinessMetrics(st *store.Store) *BusinessMetrics {
	m := &BusinessMetrics{Store: st, desc: map[string]*prometheus.Desc{}}
	for name, labels := range map[string][]string{
		"content_translation_requests_total": {"entity", "status"}, "content_translation_tokens_total": {"entity", "status"},
		"sync_runs_total": {"job", "status"}, "catalog_packages": {"kind"}, "changelog_fetch_total": {"source", "status"}, "github_ratelimit_remaining": {},
		"llm_tokens_total": {"task", "type"}, "llm_request_duration_seconds": {"task"}, "llm_requests_total": {"task", "result"}, "llm_cost_usd_total": {},
		"catalog_last_success_timestamp_seconds": {}, "llm_month_tokens": {}, "llm_month_token_budget": {}, "opennavo_metrics_collection_success": {},
	} {
		m.desc[name] = prometheus.NewDesc(name, "OpenNavo "+name, labels, nil)
	}
	return m
}
func (m *BusinessMetrics) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range m.desc {
		ch <- d
	}
}
func (m *BusinessMetrics) Collect(ch chan<- prometheus.Metric) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	if now.Sub(m.loaded) > 15*time.Second {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		m.state, m.err = m.Store.MetricState(ctx, now)
		cancel()
		m.loaded = now
	}
	emit := func(name string, kind prometheus.ValueType, value float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(m.desc[name], kind, value, labels...)
	}
	if m.err != nil {
		emit("opennavo_metrics_collection_success", prometheus.GaugeValue, 0)
		return
	}
	emit("opennavo_metrics_collection_success", prometheus.GaugeValue, 1)
	for _, row := range m.state.Translations {
		emit("content_translation_requests_total", prometheus.CounterValue, float64(row.Requests), row.Entity, row.Status)
		emit("content_translation_tokens_total", prometheus.CounterValue, float64(row.Tokens), row.Entity, row.Status)
	}
	jobs := map[string]int64{}
	fetches := map[string]int64{}
	lastSuccess := float64(0)
	for _, r := range m.state.Jobs {
		jobs[r.JobType+"\x00"+r.Status] += r.Runs
		if r.JobType == "changelog:fetch" {
			fetches[r.Source+"\x00"+r.Status] += r.Runs
		}
		if r.JobType == "catalog:sync" && r.Status == "succeeded" {
			lastSuccess = max(lastSuccess, float64(r.LastFinishedAt.Unix()))
		}
	}
	if len(jobs) == 0 {
		jobs["catalog:sync\x00succeeded"] = 0
	}
	if len(fetches) == 0 {
		fetches["unknown\x00succeeded"] = 0
	}
	for key, value := range jobs {
		a, b := metricLabels(key)
		emit("sync_runs_total", prometheus.CounterValue, float64(value), a, b)
	}
	for key, value := range fetches {
		a, b := metricLabels(key)
		emit("changelog_fetch_total", prometheus.CounterValue, float64(value), a, b)
	}
	packages := map[string]int64{"cask": 0, "formula": 0}
	for _, r := range m.state.Packages {
		packages[r.Kind] = r.Count
	}
	for kind, value := range packages {
		emit("catalog_packages", prometheus.GaugeValue, float64(value), kind)
	}
	emit("github_ratelimit_remaining", prometheus.GaugeValue, float64(m.state.GitHubRemaining))
	emit("catalog_last_success_timestamp_seconds", prometheus.GaugeValue, lastSuccess)
	emit("llm_month_tokens", prometheus.GaugeValue, float64(m.state.MonthlyTokens))
	emit("llm_month_token_budget", prometheus.GaugeValue, float64(m.state.MonthlyTokenBudget))
	type aggregate struct {
		count   uint64
		seconds float64
		tokens  map[string]int64
		buckets map[float64]uint64
	}
	byTask := map[string]*aggregate{}
	for _, task := range []string{"enrich_package", "translate_release", "translate_content"} {
		byTask[task] = &aggregate{tokens: map[string]int64{"prompt": 0, "completion": 0, "reasoning": 0, "cached": 0}, buckets: map[float64]uint64{1: 0, 5: 0, 10: 0, 30: 0, 60: 0, 180: 0, 300: 0, 600: 0}}
	}
	cost, hasCost := 0.0, false
	for _, r := range m.state.LLM {
		a := byTask[r.Task]
		if a == nil {
			continue
		}
		emit("llm_requests_total", prometheus.CounterValue, float64(r.Requests), r.Task, r.Result)
		a.count += uint64(max(r.Requests, 0))
		a.seconds += r.Seconds
		a.tokens["prompt"] += r.Prompt
		a.tokens["completion"] += r.Completion
		a.tokens["reasoning"] += r.Reasoning
		a.tokens["cached"] += r.Cached
		var buckets map[string]uint64
		if json.Unmarshal(r.Buckets, &buckets) == nil {
			for bound, count := range buckets {
				value, err := strconv.ParseFloat(bound, 64)
				if err == nil {
					a.buckets[value] += count
				}
			}
		}
		if r.Cost != nil {
			hasCost = true
			cost += *r.Cost
		}
	}
	for task, a := range byTask {
		for kind, value := range a.tokens {
			emit("llm_tokens_total", prometheus.CounterValue, float64(value), task, kind)
		}
		ch <- prometheus.MustNewConstHistogram(m.desc["llm_request_duration_seconds"], a.count, a.seconds, a.buckets, task)
		found := false
		for _, r := range m.state.LLM {
			if r.Task == task {
				found = true
				break
			}
		}
		if !found {
			emit("llm_requests_total", prometheus.CounterValue, 0, task, "succeeded")
		}
	}
	if hasCost {
		emit("llm_cost_usd_total", prometheus.CounterValue, cost)
	}
}
func metricLabels(key string) (string, string) {
	for index, c := range key {
		if c == 0 {
			return key[:index], key[index+1:]
		}
	}
	return key, ""
}
