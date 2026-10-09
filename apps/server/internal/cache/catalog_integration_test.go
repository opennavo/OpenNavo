//go:build integration

package cache_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestInvalidationDoesNotCrossRedisDatabases(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	opts := *st.Redis.Options()
	opts.DB = 9
	e2e := redis.NewClient(&opts)
	t.Cleanup(func() { _ = e2e.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, client := range []*redis.Client{st.Redis, e2e} {
		require.NoError(t, client.Set(ctx, "c:sentinel", "keep", time.Minute).Err())
		stop, err := cache.Subscribe(ctx, client, logger)
		require.NoError(t, err)
		t.Cleanup(stop)
	}
	require.NoError(t, cache.PublishInvalidation(ctx, e2e, "c:*"))
	require.Eventually(t, func() bool { return e2e.Exists(ctx, "c:sentinel").Val() == 0 }, time.Second, 10*time.Millisecond)
	require.Equal(t, "keep", st.Redis.Get(ctx, "c:sentinel").Val())
	require.NoError(t, e2e.Set(ctx, "c:sentinel", "keep", time.Minute).Err())
	require.NoError(t, cache.PublishInvalidation(ctx, st.Redis, "c:*"))
	require.Eventually(t, func() bool { return st.Redis.Exists(ctx, "c:sentinel").Val() == 0 }, time.Second, 10*time.Millisecond)
	require.Equal(t, "keep", e2e.Get(ctx, "c:sentinel").Val())
}

func TestInvalidationReachesDedicatedCacheAndPreservesBusinessData(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	opts := *st.Redis.Options()
	opts.DB = 8
	target := redis.NewClient(&opts)
	t.Cleanup(func() { _ = target.Close() })
	for _, client := range []*redis.Client{st.Redis, target} {
		require.NoError(t, client.Set(ctx, "c:pkg:sentinel", "cached", time.Minute).Err())
		require.NoError(t, client.Set(ctx, "session:sentinel", "keep", time.Minute).Err())
	}
	stop, err := cache.Subscribe(ctx, st.Redis, slog.New(slog.NewTextHandler(io.Discard, nil)), target)
	require.NoError(t, err)
	defer stop()
	require.NoError(t, cache.PublishInvalidation(ctx, st.Redis, "c:pkg:*"))
	require.Eventually(t, func() bool {
		return target.Exists(ctx, "c:pkg:sentinel").Val() == 0 && st.Redis.Exists(ctx, "c:pkg:sentinel").Val() == 0
	}, time.Second, 10*time.Millisecond)
	for _, client := range []*redis.Client{st.Redis, target} {
		require.Equal(t, "keep", client.Get(ctx, "session:sentinel").Val())
	}
}

func TestQueryCacheBounds(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	backend := cache.Redis{Client: st.Redis}
	require.NoError(t, backend.Save(ctx, "c:bounded", []byte("small"), 24*time.Hour))
	ttl := st.Redis.TTL(ctx, "c:bounded").Val()
	require.Positive(t, ttl)
	require.LessOrEqual(t, ttl, time.Hour)
	require.NoError(t, backend.Save(ctx, "c:bounded", bytes.Repeat([]byte("x"), 512*1024+1), time.Minute))
	require.Zero(t, st.Redis.Exists(ctx, "c:bounded").Val())
}
