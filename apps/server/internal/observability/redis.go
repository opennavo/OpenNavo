package observability

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

type RedisMetrics struct {
	clients map[string]*redis.Client
	desc    map[string]*prometheus.Desc
}

func NewRedisMetrics(business, cache *redis.Client) *RedisMetrics {
	m := &RedisMetrics{clients: map[string]*redis.Client{"business": business, "cache": cache}, desc: map[string]*prometheus.Desc{}}
	for _, name := range []string{"up", "used_memory_bytes", "maxmemory_bytes", "oom_errors_total", "evicted_keys_total", "keyspace_hits_total", "keyspace_misses_total"} {
		m.desc[name] = prometheus.NewDesc("opennavo_redis_"+name, "Redis "+name, []string{"role"}, nil)
	}
	return m
}
func (m *RedisMetrics) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range m.desc {
		ch <- d
	}
}
func redisInfo(raw string) map[string]float64 {
	out := map[string]float64{}
	for _, line := range strings.Split(raw, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		if key == "errorstat_OOM" {
			value = strings.TrimPrefix(value, "count=")
		}
		if n, err := strconv.ParseFloat(value, 64); err == nil {
			out[key] = n
		}
	}
	return out
}
func (m *RedisMetrics) Collect(ch chan<- prometheus.Metric) {
	for role, client := range m.clients {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		raw, err := client.Info(ctx, "memory", "stats", "errorstats").Result()
		cancel()
		up := float64(1)
		if err != nil {
			up = 0
		}
		ch <- prometheus.MustNewConstMetric(m.desc["up"], prometheus.GaugeValue, up, role)
		if err != nil {
			continue
		}
		info := redisInfo(raw)
		for name, key := range map[string]string{"used_memory_bytes": "used_memory", "maxmemory_bytes": "maxmemory", "oom_errors_total": "errorstat_OOM", "evicted_keys_total": "evicted_keys", "keyspace_hits_total": "keyspace_hits", "keyspace_misses_total": "keyspace_misses"} {
			kind := prometheus.GaugeValue
			if strings.HasSuffix(name, "_total") {
				kind = prometheus.CounterValue
			}
			ch <- prometheus.MustNewConstMetric(m.desc[name], kind, info[key], role)
		}
	}
}
