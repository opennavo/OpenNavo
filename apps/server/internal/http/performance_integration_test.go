//go:build integration && performance

package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/service/e2e"
	"github.com/opennavo/opennavo/server/internal/service/search"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type performanceObjects map[string][]byte

func (m performanceObjects) Put(_ context.Context, key string, data []byte, _ string) error {
	m[key] = bytes.Clone(data)
	return nil
}
func (performanceObjects) URL(key string) string { return "https://cdn.example.test/" + key }

type performanceRequestKey struct{}
type performanceCache struct {
	backend             cache.Redis
	cold                bool
	hits, misses, saves atomic.Int64
}

func (c *performanceCache) key(ctx context.Context, key string) string {
	if !c.cold {
		return key
	}
	return fmt.Sprintf("c:perf:%d:%s", ctx.Value(performanceRequestKey{}), key)
}
func (c *performanceCache) Load(ctx context.Context, key string) ([]byte, error) {
	data, err := c.backend.Load(ctx, c.key(ctx, key))
	if err == nil {
		c.hits.Add(1)
	} else {
		c.misses.Add(1)
	}
	return data, err
}
func (c *performanceCache) Save(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	c.saves.Add(1)
	return c.backend.Save(ctx, c.key(ctx, key), value, ttl)
}
func (c *performanceCache) reset() { c.hits.Store(0); c.misses.Store(0); c.saves.Store(0) }

type latencyResult struct {
	Endpoint      string  `json:"endpoint"`
	Mode          string  `json:"mode"`
	Concurrency   int     `json:"concurrency"`
	Samples       int     `json:"samples"`
	P50MS         float64 `json:"p50Ms"`
	P95MS         float64 `json:"p95Ms"`
	Errors        int     `json:"errors"`
	CacheHits     int64   `json:"cacheHits"`
	CacheMisses   int64   `json:"cacheMisses"`
	CacheSaves    int64   `json:"cacheSaves"`
	PoolWaitCount int64   `json:"poolWaitCount"`
	PoolWaitMS    float64 `json:"poolWaitMs"`
	TargetMS      float64 `json:"targetMs"`
}

func latencySamples(client *http.Client, target string, concurrency, count int) ([]time.Duration, []error) {
	values := make([]time.Duration, count)
	errors := make([]error, count)
	var next atomic.Int64
	var group sync.WaitGroup
	for range concurrency {
		group.Go(func() {
			for {
				index := int(next.Add(1) - 1)
				if index >= count {
					return
				}
				start := time.Now()
				response, err := client.Get(target)
				if err != nil {
					errors[index] = err
					continue
				}
				body, readErr := io.ReadAll(response.Body)
				_ = response.Body.Close()
				values[index] = time.Since(start)
				if readErr != nil {
					errors[index] = readErr
					continue
				}
				var envelope struct{ Code string }
				if err := json.Unmarshal(body, &envelope); err != nil {
					errors[index] = err
					continue
				}
				if response.StatusCode != http.StatusOK || envelope.Code != "0000" {
					errors[index] = fmt.Errorf("unexpected response: HTTP %d/code %s", response.StatusCode, envelope.Code)
				}
			}
		})
	}
	group.Wait()
	return values, errors
}

func milliseconds(duration time.Duration) float64 {
	return math.Round(float64(duration)/float64(time.Millisecond)*1000) / 1000
}

func TestPublicAPILatencyBaseline(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	sqlDB, err := st.DB.DB()
	require.NoError(t, err)
	// Use the production default pool size so the test helper's five-connection default does not alter conclusions at concurrency 20.
	sqlDB.SetMaxOpenConns(30)
	sqlDB.SetMaxIdleConns(30)
	_, err = (&e2e.Service{Store: st, Objects: performanceObjects{}}).Run(ctx, config.Config{AppEnv: "dev", E2EAdminPassword: "performance-fixture-dev-only"})
	require.NoError(t, err)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	transport := &http.Transport{MaxIdleConns: 40, MaxIdleConnsPerHost: 40, MaxConnsPerHost: 40}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	results := []latencyResult{}
	endpoints := []struct {
		name, path string
		cached     bool
		target     float64
	}{
		{"home", "/home", true, 150},
		{"list", "/packages?kind=cask&size=24", false, 150},
		{"detail", "/packages/cask/visual-studio-code", true, 150},
		{"search", "/search?q=vscode&size=24", false, 200},
		{"suggest", "/search/suggest?q=vscode&limit=8", true, 150},
		{"rankings", "/rankings?kind=cask&period=30d&size=24", true, 150},
	}
	for _, endpoint := range endpoints {
		modes := []string{"direct"}
		if endpoint.cached {
			modes = []string{"hit", "miss"}
		}
		for _, mode := range modes {
			backend := &performanceCache{backend: cache.Redis{Client: st.Redis}, cold: mode == "miss"}
			searchService := search.New(ctx, st, backend, logger)
			app, err := httpserver.New(config.Config{}, logger, st, httpserver.Dependencies{Public: &public.Handler{
				Catalog: &catalog.PublicService{Store: st, Cache: backend}, Search: searchService,
			}})
			require.NoError(t, err)
			var sequence atomic.Uint64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				// Cache misses use a separate namespace per request to exercise real Redis GET/SET and origin reads.
				request = request.WithContext(context.WithValue(request.Context(), performanceRequestKey{}, sequence.Add(1)))
				app.Engine.ServeHTTP(w, request)
			}))
			for _, concurrency := range []int{1, 20} {
				_, warmErrors := latencySamples(client, server.URL+"/api/v1"+endpoint.path, concurrency, 40)
				for _, err := range warmErrors {
					require.NoError(t, err)
				}
				backend.reset()
				before := sqlDB.Stats()
				durations, sampleErrors := latencySamples(client, server.URL+"/api/v1"+endpoint.path, concurrency, 200)
				after := sqlDB.Stats()
				row := latencyResult{Endpoint: endpoint.name, Mode: mode, Concurrency: concurrency, Samples: len(durations),
					CacheHits: backend.hits.Load(), CacheMisses: backend.misses.Load(), CacheSaves: backend.saves.Load(),
					PoolWaitCount: after.WaitCount - before.WaitCount, PoolWaitMS: milliseconds(after.WaitDuration - before.WaitDuration), TargetMS: endpoint.target}
				for _, err := range sampleErrors {
					if err != nil {
						row.Errors++
						t.Error(err)
					}
				}
				slices.Sort(durations)
				row.P50MS = milliseconds(durations[int(math.Ceil(0.50*float64(len(durations))))-1])
				row.P95MS = milliseconds(durations[int(math.Ceil(0.95*float64(len(durations))))-1])
				switch mode {
				case "hit":
					require.Positive(t, row.CacheHits)
					require.Zero(t, row.CacheMisses)
				case "miss":
					require.Zero(t, row.CacheHits)
					require.Positive(t, row.CacheMisses)
					require.Positive(t, row.CacheSaves)
				case "direct":
					require.Zero(t, row.CacheHits+row.CacheMisses+row.CacheSaves)
				}
				results = append(results, row)
				t.Logf("%s/%s concurrency=%d p50=%.3fms p95=%.3fms errors=%d hits=%d misses=%d poolWait=%.3fms", row.Endpoint, row.Mode, row.Concurrency, row.P50MS, row.P95MS, row.Errors, row.CacheHits, row.CacheMisses, row.PoolWaitMS)
			}
			server.Close()
			searchService.Close()
		}
	}
	report := struct {
		MeasuredAt    time.Time       `json:"measuredAt"`
		GoVersion     string          `json:"goVersion"`
		Platform      string          `json:"platform"`
		CPUs          int             `json:"cpus"`
		Packages      int             `json:"packages"`
		PoolSize      int             `json:"poolSize"`
		WarmupPerCase int             `json:"warmupPerCase"`
		RateLimiter   bool            `json:"rateLimiter"`
		Rows          []latencyResult `json:"rows"`
	}{time.Now().UTC(), runtime.Version(), runtime.GOOS + "/" + runtime.GOARCH, runtime.NumCPU(), 60, 30, 40, false, results}
	data, err := json.MarshalIndent(report, "", "  ")
	require.NoError(t, err)
	const output = "../../tmp/performance/baseline.json"
	require.NoError(t, os.MkdirAll(filepath.Dir(output), 0o750))
	require.NoError(t, os.WriteFile(output, append(data, '\n'), 0o600))
	t.Log("performance report:", output)
	// Only the dedicated performance entry point checks latency targets; regular unit tests are independent of host load.
	for _, row := range results {
		if row.P95MS >= row.TargetMS {
			t.Errorf("%s/%s concurrency=%d p95=%.3fms exceeds target <%.0fms", row.Endpoint, row.Mode, row.Concurrency, row.P95MS, row.TargetMS)
		}
	}
}
