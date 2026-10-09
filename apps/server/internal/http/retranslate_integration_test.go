//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/content"
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
	"gorm.io/gorm"
)

type retranslateTask struct {
	kind    string
	payload jobs.Payload
	meta    jobs.Metadata
}
type retranslateQueue struct{ tasks []retranslateTask }

func (q *retranslateQueue) Enqueue(_ context.Context, kind string, payload jobs.Payload, meta jobs.Metadata) (string, error) {
	q.tasks = append(q.tasks, retranslateTask{kind, payload, meta})
	return "test-id", nil
}
func (*retranslateQueue) Trigger(context.Context, string, int64) (string, error) {
	return "test-id", nil
}

type regenerationGateway struct{ calls, summaries int }

func (g *regenerationGateway) TranslateContent(_ context.Context, in llm.ContentInput) (llm.ContentOutput, llm.Usage, error) {
	g.calls++
	texts := map[string]string{"en-US": "The application manages your files", "zh-CN": "这款应用可以管理文件", "ja-JP": "ファイルを管理するアプリです", "es-ES": "La aplicación permite gestionar tus archivos", "pt-BR": "O aplicativo permite gerenciar seus arquivos", "ru-RU": "Приложение для управления файлами"}
	out := llm.ContentOutput{}
	for _, locale := range in.Targets {
		out[locale] = map[string]string{}
		for field := range in.Fields {
			out[locale][field] = texts[locale]
		}
	}
	return out, llm.Usage{}, nil
}

func TestHTTPRegenerateReleaseExecutesCurrentWorkerForUnchangedAndEditorialSources(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	hash, err := seed.HashPassword("test-password-strong")
	require.NoError(t, err)
	data, err := seeds.Load()
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "tester", hash))
	require.NoError(t, st.DB.Exec(`INSERT INTO packages(id,kind,token,full_token,tap,name,version,version_base,raw,raw_hash) VALUES(100,'cask','sample','sample','homebrew/cask','Sample','1','1','{}','hash')`).Error)
	cfg := config.Config{JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: time.Hour}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "tester", "test-password-strong", store.AuditActor{})
	require.NoError(t, err)
	q := &retranslateQueue{}
	svc := &management.Service{Store: st, Queue: q}
	server, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	gateway := &regenerationGateway{}
	worker := &contenttranslate.Service{Store: st, LLM: gateway, Model: "fake"}
	request := func(id int64, code string) {
		t.Helper()
		r := httptest.NewRequest("POST", "/admin-api/releases/"+strconv.FormatInt(id, 10)+"/retranslate", nil)
		r.Header.Set("Authorization", "Bearer "+pair.Token)
		w := httptest.NewRecorder()
		server.Engine.ServeHTTP(w, r)
		testutil.ValidateResponse(t, spec, "/admin-api", r, w)
		var out struct{ Code string }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		require.Equal(t, code, out.Code, w.Body.String())
	}
	for index, kind := range []string{"github_release", "editorial", "missing_summary"} {
		t.Run(kind, func(t *testing.T) {
			id := int64(101 + index)
			sourceLocale := "en-US"
			releaseKind := kind
			if kind == "editorial" {
				sourceLocale = "zh-CN"
			}
			if kind == "missing_summary" {
				releaseKind = "github_release"
			}
			require.NoError(t, st.DB.Exec(`INSERT INTO releases(id,package_id,source,source_key,version,body_markdown,body_hash,summary_source_hash,source_locale) VALUES(?,100,?,?,'1','The application manages files','same','same',?)`, id, releaseKind, kind, sourceLocale).Error)
			ref := content.Ref{Entity: "release", ID: id}
			if kind != "missing_summary" {
				summary := "The application manages files"
				if sourceLocale == "zh-CN" {
					summary = "这款应用可以管理文件"
				}
				require.NoError(t, st.DB.Exec("INSERT INTO release_i18n(release_id,locale,source_locale,status,summary,sections) VALUES(?,?,?,'source',?,'[]')", id, sourceLocale, sourceLocale, summary).Error)
				require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error { return (&store.Store{DB: tx}).ScheduleContentTranslation(ctx, ref) }))
				source, err := st.ReadContentSource(ctx, ref)
				require.NoError(t, err)
				_, err = worker.Run(ctx, ref, source.Hash)
				require.NoError(t, err)
				require.NoError(t, st.DB.Exec("UPDATE release_i18n SET status='manual' WHERE release_id=? AND locale<>?", id, sourceLocale).Error)
				if kind == "github_release" {
					require.NoError(t, st.DB.Exec("UPDATE release_i18n SET status='pending',source_hash=NULL WHERE release_id=? AND locale='zh-CN'", id).Error)
				}
			}
			require.NoError(t, st.DB.Exec("DELETE FROM job_outbox").Error)
			for attempt := 0; attempt < 2; attempt++ {
				q.tasks = nil
				before := gateway.calls
				if kind == "missing_summary" {
					request(id, "1006")
					require.Empty(t, q.tasks)
					require.Equal(t, before, gateway.calls)
					continue
				}
				request(id, "0000")
				require.Len(t, q.tasks, 1)
				task := q.tasks[0]
				require.Equal(t, "manual", task.meta.Trigger)
				require.NotNil(t, task.meta.TriggeredBy)

				require.Equal(t, "translate:content", task.kind)
				require.NotNil(t, task.payload.Content)
				require.Len(t, task.payload.SourceHash, 64)
				source, err := st.ReadContentSource(ctx, ref)
				require.NoError(t, err)
				require.Len(t, source.Targets, 5)
				require.Equal(t, source.Hash, task.payload.SourceHash)
				var original string
				require.NoError(t, st.DB.Raw("SELECT summary FROM release_i18n WHERE release_id=? AND locale=?", id, sourceLocale).Scan(&original).Error)
				_, err = worker.Run(ctx, *task.payload.Content, task.payload.SourceHash)
				require.NoError(t, err)
				require.Greater(t, gateway.calls, before)
				var count int64
				require.NoError(t, st.DB.Raw("SELECT count(*) FROM release_i18n WHERE release_id=? AND status='machine' AND source_hash=?", id, source.Hash).Scan(&count).Error)
				require.EqualValues(t, 5, count)
				var after string
				require.NoError(t, st.DB.Raw("SELECT summary FROM release_i18n WHERE release_id=? AND locale=?", id, sourceLocale).Scan(&after).Error)
				require.Equal(t, original, after)
			}
		})
	}
	require.Zero(t, gateway.summaries)
	require.NoError(t, st.DB.Exec("UPDATE i18n_settings SET enabled=false").Error)
	request(101, "1006")
}
