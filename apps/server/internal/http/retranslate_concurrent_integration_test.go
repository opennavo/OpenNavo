//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/jobs"
	"github.com/opennavo/opennavo/server/internal/llm"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/contenttranslate"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

type blockedRegenerationGateway struct {
	calls   atomic.Int32
	entered chan int
	release chan struct{}
}

func (g *blockedRegenerationGateway) TranslateContent(ctx context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	call := int(g.calls.Add(1))
	g.entered <- call
	if call == 1 {
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, llm.Usage{}, ctx.Err()
		}
	}
	return (&regenerationGateway{}).TranslateContent(ctx, in)
}

func TestHTTPRegenerateDuringActiveAsynqTranslationRetainsLatestRequest(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	hash, err := seed.HashPassword("test-password-strong")
	require.NoError(t, err)
	data, err := seeds.Load()
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "tester", hash))
	require.NoError(t, st.DB.Exec(`INSERT INTO packages(id,kind,token,full_token,tap,name,version,version_base,raw,raw_hash) VALUES(100,'cask','sample','sample','homebrew/cask','Sample','1','1','{}','hash')`).Error)
	require.NoError(t, st.DB.Exec(`INSERT INTO releases(id,package_id,source,source_key,version,source_locale) VALUES(101,100,'editorial','concurrent','1','zh-CN')`).Error)
	require.NoError(t, st.DB.Exec(`INSERT INTO release_i18n(release_id,locale,source_locale,status,summary,sections) VALUES(101,'zh-CN','zh-CN','source','这款应用可以管理文件','[]')`).Error)
	cfg := config.Config{JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: time.Hour}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "tester", "test-password-strong", store.AuditActor{})
	require.NoError(t, err)
	queue := &jobs.Enqueuer{Client: asynq.NewClientFromRedisClient(st.Redis), Redis: st.Redis}
	svc := &management.Service{Store: st, Queue: queue}
	server, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	gateway := &blockedRegenerationGateway{entered: make(chan int, 10), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(gateway.release) }) }
	translator := &contenttranslate.Service{Store: st, LLM: gateway, Model: "fake"}
	mux := asynq.NewServeMux()
	mux.Handle("translate:content", jobs.WrapHandler(st, st.Redis, func(ctx context.Context, p jobs.Payload) (map[string]any, error) {
		return translator.Run(ctx, *p.Content, p.SourceHash)
	}))
	worker := asynq.NewServerFromRedisClient(st.Redis, asynq.Config{Concurrency: 2, Queues: map[string]int{"llm": 1}, TaskCheckInterval: 10 * time.Millisecond, ShutdownTimeout: time.Second})
	require.NoError(t, worker.Start(mux))
	t.Cleanup(func() { release(); worker.Shutdown() })
	request := func() {
		t.Helper()
		r := httptest.NewRequest("POST", "/admin-api/releases/101/retranslate", nil)
		r.Header.Set("Authorization", "Bearer "+pair.Token)
		w := httptest.NewRecorder()
		server.Engine.ServeHTTP(w, r)
		var out struct{ Code string }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		require.Equal(t, "0000", out.Code, w.Body.String())
	}
	request()
	select {
	case call := <-gateway.entered:
		require.Equal(t, 1, call)
	case <-time.After(10 * time.Second):
		t.Fatal("first translation did not enter gateway")
	}
	// Two consecutive requests for the same source while an old job runs must still persist the latest request.
	request()
	request()
	var pending, outbox int64
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM release_i18n WHERE release_id=101 AND status='pending'").Scan(&pending).Error)
	require.EqualValues(t, 5, pending)
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM job_outbox WHERE job_type='translate:content'").Scan(&outbox).Error)
	require.EqualValues(t, 1, outbox)
	// Simulate the worker's periodic delivery recovery; retain the outbox during duplicate delivery too.
	dispatch := func() (int, error) {
		return st.DispatchOutbox(ctx, func(ctx context.Context, kind string, raw json.RawMessage) error {
			p, m, err := jobs.DecodeOutbox(raw)
			if err != nil {
				return err
			}
			_, err = queue.Enqueue(ctx, kind, p, m)
			return jobs.OutboxDeliveryError(kind, err)
		})
	}
	require.NoError(t, st.DB.Exec("UPDATE job_outbox SET available_at=clock_timestamp()").Error)
	delivered, err := dispatch()
	require.NoError(t, err)
	require.Zero(t, delivered)
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM job_outbox").Scan(&outbox).Error)
	require.EqualValues(t, 1, outbox)
	release()
	require.Eventually(t, func() bool {
		var stale int64
		return st.DB.Raw("SELECT count(*) FROM sync_runs WHERE job_type='translate:content' AND status='succeeded' AND (stats->>'stale')::int=5 AND (stats->>'translated')::int=0").Scan(&stale).Error == nil && stale == 1
	}, 10*time.Second, 20*time.Millisecond)
	require.Eventually(t, func() bool {
		_, err := dispatch()
		if err != nil {
			return false
		}
		var translated int64
		return st.DB.Raw("SELECT count(*) FROM release_i18n WHERE release_id=101 AND status='machine' AND source_hash IS NOT NULL").Scan(&translated).Error == nil && translated == 5
	}, 10*time.Second, 20*time.Millisecond)
	require.EqualValues(t, 2, gateway.calls.Load())
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM job_outbox").Scan(&outbox).Error)
	require.Zero(t, outbox)
	var manual int64
	require.Eventually(t, func() bool {
		return st.DB.Raw("SELECT count(*) FROM sync_runs WHERE job_type='translate:content' AND trigger='manual' AND triggered_by IS NOT NULL AND status='succeeded' AND (stats->>'translated')::int=5").Scan(&manual).Error == nil && manual == 1
	}, 5*time.Second, 20*time.Millisecond)
}
