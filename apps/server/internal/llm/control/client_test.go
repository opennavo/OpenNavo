package control

import (
	"errors"
	"testing"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/stretchr/testify/require"
)

func TestRetryPolicyDoesNotReplayPermanentFailures(t *testing.T) {
	require.ErrorIs(t, RetryError(&llm.Failure{Reason: "invalid_request"}), asynq.SkipRetry)
	require.ErrorIs(t, RetryError(llm.ErrPaused), asynq.SkipRetry)
	retry := &llm.Failure{Reason: "rate_limited", Retryable: true}
	require.ErrorIs(t, RetryError(retry), retry)
	paused := &llm.Failure{Reason: "authorization", Pause: true}
	require.ErrorIs(t, RetryError(paused), paused)
	plain := errors.New("storage failure")
	require.ErrorIs(t, RetryError(plain), plain)
}
