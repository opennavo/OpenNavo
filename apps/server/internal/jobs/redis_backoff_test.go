package jobs

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func dequeueCommand() *redis.Cmd {
	return redis.NewCmd(context.Background(), "evalsha", "script", 4, "asynq:{llm}:pending", "asynq:{llm}:paused", "asynq:{llm}:active", "asynq:{llm}:lease", 123, "asynq:{llm}:t:")
}
func TestDequeueBackoffBoundsResetAndIgnoresOtherCommands(t *testing.T) {
	h := newDequeueBackoff(context.Background())
	var delays []time.Duration
	h.wait = func(_, _ context.Context, d time.Duration) { delays = append(delays, d) }
	failure := errors.New("OOM command not allowed")
	hook := h.ProcessHook(func(context.Context, redis.Cmder) error { return failure })
	for i := 0; i < 10; i++ {
		require.ErrorIs(t, hook(context.Background(), dequeueCommand()), failure)
	}
	require.Len(t, delays, 10)
	for i, d := range delays {
		ceiling := min(500*time.Millisecond*time.Duration(1<<min(i, 6)), 30*time.Second)
		require.GreaterOrEqual(t, d, ceiling/2)
		require.LessOrEqual(t, d, ceiling)
	}
	require.Error(t, hook(context.Background(), redis.NewCmd(context.Background(), "set", "lease", "value")))
	require.Len(t, delays, 10)
	for _, ok := range []error{nil, redis.Nil} {
		require.Equal(t, ok, h.ProcessHook(func(context.Context, redis.Cmder) error { return ok })(context.Background(), dequeueCommand()))
		_ = hook(context.Background(), dequeueCommand())
		require.LessOrEqual(t, delays[len(delays)-1], 500*time.Millisecond)
	}
	count := len(delays)
	_ = h.ProcessHook(func(context.Context, redis.Cmder) error { return errors.New("NOSCRIPT No matching script") })(context.Background(), dequeueCommand())
	require.Len(t, delays, count)
}
func TestDequeueBackoffCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { waitForRedis(context.Background(), ctx, 30*time.Second); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("backoff ignored shutdown")
	}
}

type dequeueFailureHook struct{}

func (dequeueFailureHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (dequeueFailureHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (dequeueFailureHook) ProcessHook(_ redis.ProcessHook) redis.ProcessHook {
	return func(context.Context, redis.Cmder) error { return errors.New("OOM command not allowed") }
}
func TestDequeueBackoffRecognizesGoRedisScriptEncoding(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "unused"})
	t.Cleanup(func() { _ = client.Close() })
	h := newDequeueBackoff(context.Background())
	waits := 0
	h.wait = func(_, _ context.Context, _ time.Duration) { waits++ }
	client.AddHook(h)
	client.AddHook(dequeueFailureHook{})
	err := redis.NewScript("return nil").Run(context.Background(), client, []string{"asynq:{llm}:pending", "asynq:{llm}:paused", "asynq:{llm}:active", "asynq:{llm}:lease"}, 123, "asynq:{llm}:t:").Err()
	require.Error(t, err)
	require.Equal(t, 1, waits, "the hook must recognize actual go-redis EVALSHA args")
}
