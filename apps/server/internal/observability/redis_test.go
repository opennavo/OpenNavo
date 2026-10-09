package observability

import (
	"context"
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type infoHook struct{ err error }

func (h infoHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h infoHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (h infoHook) ProcessHook(_ redis.ProcessHook) redis.ProcessHook {
	return func(_ context.Context, cmd redis.Cmder) error {
		if h.err != nil {
			return h.err
		}
		cmd.(*redis.StringCmd).SetVal("# Memory\r\nused_memory:100\r\nmaxmemory:200\r\nerrorstat_OOM:count=3\r\nevicted_keys:4\r\nkeyspace_hits:50\r\nkeyspace_misses:5\r\n")
		return nil
	}
}
func TestRedisMetricsExposeMemoryAndOOMWithoutKeyContents(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "unused"})
	t.Cleanup(func() { _ = client.Close() })
	client.AddHook(infoHook{})
	require.Equal(t, float64(3), redisInfo("errorstat_OOM:count=3\r\n")["errorstat_OOM"])
	registry := prometheus.NewRegistry()
	registry.MustRegister(NewRedisMetrics(client, client))
	families, err := registry.Gather()
	require.NoError(t, err)
	found := false
	for _, family := range families {
		if family.GetName() != "opennavo_redis_oom_errors_total" {
			continue
		}
		found = true
		require.Len(t, family.Metric, 2)
		for _, metric := range family.Metric {
			require.Equal(t, float64(3), metric.GetCounter().GetValue())
		}
	}
	require.True(t, found)

}
func TestRedisMetricsUnavailableDoesNotPretendMemoryIsZero(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "unused"})
	t.Cleanup(func() { _ = client.Close() })
	client.AddHook(infoHook{errors.New("unavailable")})
	registry := prometheus.NewRegistry()
	registry.MustRegister(NewRedisMetrics(client, client))
	families, err := registry.Gather()
	require.NoError(t, err)
	require.Len(t, families, 1)
	require.Equal(t, "opennavo_redis_up", families[0].GetName())
	for _, metric := range families[0].Metric {
		require.Zero(t, metric.GetGauge().GetValue())
	}
}
