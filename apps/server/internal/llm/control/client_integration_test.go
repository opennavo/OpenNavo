//go:build integration

package control

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type fakeGateway struct {
	active, maximum, calls atomic.Int32
	failure                error
}

func (f *fakeGateway) TranslateContent(ctx context.Context, _ llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	f.calls.Add(1)
	n := f.active.Add(1)
	for previous := f.maximum.Load(); n > previous; previous = f.maximum.Load() {
		if f.maximum.CompareAndSwap(previous, n) {
			break
		}
	}
	defer f.active.Add(-1)
	timer := time.NewTimer(10 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return llm.ContentOutput{}, llm.Usage{}, ctx.Err()
	case <-timer.C:
	}
	return llm.ContentOutput{}, llm.Usage{Attempts: []llm.Attempt{{Model: "test-model", ReasoningEffort: "high", PromptTokens: 100, CompletionTokens: 50, ReasoningTokens: 20, FinishReason: "stop"}}}, f.failure
}
func TestSharedSemaphoreUsageCostBudgetAndAuthorizationPause(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	gateway := &fakeGateway{}
	cfg := config.Config{LLMEnabled: true, LLMConcurrency: 2, LLMRPM: 120, LLMTimeout: time.Second, LLMMonthlyTokenBudget: 30000000, LLMModelTranslate: "test-model"}
	require.NoError(t, st.DB.WithContext(ctx).Exec(`INSERT INTO app_config(key,value) VALUES('llm.pricing','{"test-model":{"input":1,"output":2}}')`).Error)
	first := &Client{Content: gateway, Store: st, Redis: st.Redis, Config: cfg}
	second := &Client{Content: gateway, Store: st, Redis: st.Redis, Config: cfg}
	var workers sync.WaitGroup
	failures := make(chan error, 8)
	for index := range 8 {
		workers.Go(func() {
			client := first
			if index%2 == 1 {
				client = second
			}
			_, _, err := client.TranslateContent(ctx, llm.ContentInput{RefID: 1})
			failures <- err
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	require.LessOrEqual(t, gateway.maximum.Load(), int32(2))
	require.Equal(t, int32(8), gateway.calls.Load())
	totals, err := st.LLMMonth(ctx, time.Now())
	require.NoError(t, err)
	require.Equal(t, int64(1200), totals.Tokens)
	require.InDelta(t, 0.0016, totals.CostUSD, 0.0000001)
	leases, err := st.Redis.ZCard(ctx, "llm:{gate}:leases").Result()
	require.NoError(t, err)
	require.Zero(t, leases)
	_, usage, err := first.TranslateContent(ctx, llm.ContentInput{RefID: 2})
	require.NoError(t, err)
	require.Equal(t, int64(150), usage.Tokens())
	require.NoError(t, st.DB.Exec("UPDATE i18n_settings SET monthly_token_budget=1000").Error)
	_, _, err = first.TranslateContent(ctx, llm.ContentInput{})
	require.ErrorIs(t, err, llm.ErrPaused)
	require.Equal(t, "budget", st.Redis.Get(ctx, "llm:paused_reason").Val())
	require.Equal(t, int32(9), gateway.calls.Load())
	require.NoError(t, st.DB.Exec("UPDATE i18n_settings SET monthly_token_budget=30000000").Error)
	require.NoError(t, st.Redis.Del(ctx, "llm:paused_reason").Err())
	first.Config.LLMMonthlyBudgetUSD = 0.001
	first.Config.LLMMonthlyTokenBudget = 1
	_, _, err = first.TranslateContent(ctx, llm.ContentInput{})
	require.NoError(t, err)
	first.Config.LLMMonthlyBudgetUSD = 0
	require.NoError(t, st.Redis.Del(ctx, "llm:paused_reason").Err())
	gateway.failure = &llm.Failure{Reason: "authorization", Pause: true}
	_, _, err = first.TranslateContent(ctx, llm.ContentInput{})
	require.Error(t, err)
	require.Equal(t, "authorization", st.Redis.Get(ctx, "llm:paused_reason").Val())
	first.Config.LLMEnabled = false
	require.NoError(t, first.ConfigureQueue(ctx))
	require.Equal(t, "authorization", st.Redis.Get(ctx, "llm:paused_reason").Val())
	require.NoError(t, st.Redis.Del(ctx, "llm:paused_reason").Err())
	require.NoError(t, first.ConfigureQueue(ctx))
	require.Equal(t, "disabled", st.Redis.Get(ctx, "llm:paused_reason").Val())
	_, _, err = first.TranslateContent(ctx, llm.ContentInput{})
	require.ErrorIs(t, err, llm.ErrPaused)
	first.Config.LLMEnabled = true
	require.NoError(t, first.ConfigureQueue(ctx))
	require.Zero(t, st.Redis.Exists(ctx, "llm:paused_reason").Val())
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, _, err = first.TranslateContent(canceled, llm.ContentInput{})
	require.Error(t, err)
}

func TestContentTranslationUsesAdminBudgetAboveFormerCap(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	require.NoError(t, st.DB.Exec("UPDATE i18n_settings SET enabled=true,monthly_token_budget=40000000").Error)
	cost := 10.0
	require.NoError(t, st.SaveLLMUsage(ctx, "translate_content", 0, llm.Attempt{Model: "test-model", ReasoningEffort: "high", PromptTokens: 32000000, FinishReason: "stop"}, &cost))
	gateway := &fakeGateway{}
	client := &Client{Content: gateway, Store: st, Redis: st.Redis, Config: config.Config{LLMEnabled: true, LLMConcurrency: 2, LLMRPM: 120, LLMTimeout: time.Second, LLMMonthlyTokenBudget: 1, LLMMonthlyBudgetUSD: 0.001, LLMModelTranslate: "test-model"}}
	_, _, err := client.TranslateContent(ctx, llm.ContentInput{})
	require.NoError(t, err)
	require.Equal(t, int32(1), gateway.calls.Load())
	require.NoError(t, st.DB.Exec("UPDATE i18n_settings SET monthly_token_budget=32000001").Error)
	_, _, err = client.TranslateContent(ctx, llm.ContentInput{})
	require.ErrorIs(t, err, llm.ErrPaused)
	require.Equal(t, int32(1), gateway.calls.Load())
}
