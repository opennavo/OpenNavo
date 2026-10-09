package jobs

import (
	"context"
	"errors"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Asynq 0.26 retries Dequeue immediately on Redis errors. Delay only failed
// dequeue operations, after execution: delaying before execution would age the
// lease timestamp already embedded in the Lua arguments. Other commands (in
// particular lease renewals and acknowledgements) must never be delayed.
type dequeueBackoff struct {
	lifetime context.Context
	mu       sync.Mutex
	failures map[string]int
	wait     func(context.Context, context.Context, time.Duration)
}

func newDequeueBackoff(ctx context.Context) *dequeueBackoff {
	return &dequeueBackoff{lifetime: ctx, failures: map[string]int{}, wait: waitForRedis}
}
func waitForRedis(ctx, lifetime context.Context, delay time.Duration) {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	case <-lifetime.Done():
	}
}
func (h *dequeueBackoff) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h *dequeueBackoff) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func dequeueKey(cmd redis.Cmder) string {
	args := cmd.Args()
	if (cmd.Name() != "evalsha" && cmd.Name() != "eval") || len(args) != 9 || args[2] != 4 {
		return ""
	}
	pending, ok := args[3].(string)
	if !ok || !strings.HasPrefix(pending, "asynq:{") || !strings.HasSuffix(pending, ":pending") {
		return ""
	}
	prefix := strings.TrimSuffix(pending, ":pending")
	if args[4] != prefix+":paused" || args[5] != prefix+":active" || args[6] != prefix+":lease" {
		return ""
	}
	return pending
}
func (h *dequeueBackoff) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		err := next(ctx, cmd)
		key := dequeueKey(cmd)
		if key == "" {
			return err
		}
		// NOSCRIPT triggers Redis Script.Run's normal EVAL fallback, not an outage.
		if err != nil && strings.HasPrefix(err.Error(), "NOSCRIPT ") {
			return err
		}
		h.mu.Lock()
		if err == nil || errors.Is(err, redis.Nil) {
			delete(h.failures, key)
			h.mu.Unlock()
			return err
		}
		attempt := min(h.failures[key]+1, 7)
		h.failures[key] = attempt
		h.mu.Unlock()
		capDelay := min(500*time.Millisecond*time.Duration(1<<(attempt-1)), 30*time.Second)
		delay := capDelay/2 + time.Duration(rand.Int64N(int64(capDelay/2)+1)) //nolint:gosec // Scheduling jitter does not require cryptographic randomness.
		h.wait(ctx, h.lifetime, delay)
		return err
	}
}
