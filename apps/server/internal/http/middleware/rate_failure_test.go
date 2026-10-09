package middleware

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type failedRedisHook struct{ err error }

func (h failedRedisHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h failedRedisHook) ProcessHook(_ redis.ProcessHook) redis.ProcessHook {
	return func(context.Context, redis.Cmder) error { return h.err }
}
func (h failedRedisHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}

func TestRateLimitStorageFailureIsUnavailableAndNeverBypassesQuota(t *testing.T) {
	for _, message := range []string{"OOM command not allowed when used memory > 'maxmemory'", "redis: client is closed"} {
		t.Run(message, func(t *testing.T) {
			client := redis.NewClient(&redis.Options{Addr: "unused:6379"})
			t.Cleanup(func() { _ = client.Close() })
			client.AddHook(failedRedisHook{err: errors.New(message)})
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			router := gin.New()
			router.Use(RequestID(), RateLimit(RateLimiter{Client: client}, logger))
			called := false
			router.GET("/api/v1/collections", func(c *gin.Context) { called = true; c.Status(200) })
			reply := httptest.NewRecorder()
			router.ServeHTTP(reply, httptest.NewRequest("GET", "/api/v1/collections", nil))
			require.False(t, called)
			require.Equal(t, http.StatusServiceUnavailable, reply.Code)
			require.Equal(t, "no-store", reply.Header().Get("Cache-Control"))
			require.Equal(t, "5", reply.Header().Get("Retry-After"))
			require.NotContains(t, reply.Body.String(), message)
			require.Contains(t, logs.String(), message)
			require.Contains(t, logs.String(), reply.Header().Get("X-Request-Id"))
			require.Contains(t, logs.String(), "/api/v1/collections")
		})
	}
}
