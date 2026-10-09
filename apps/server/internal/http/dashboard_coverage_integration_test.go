//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/adminapi"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/content"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/i18n"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestDashboardCoverageAllEligibleAppsAndFreshSixLocaleContent(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	password, err := seed.HashPassword("dashboard-test-password")
	require.NoError(t, err)
	seedData, err := seeds.Load()
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, seedData, "dashboard-tester", password))
	// Keep 1,001 valid apps so apps outside the popularity ranking enter both numerator and denominator.
	require.NoError(t, st.DB.Exec(`INSERT INTO packages(kind,token,full_token,tap,name,version,version_base,popularity,raw,raw_hash)
 SELECT CASE WHEN n=1006 THEN 'formula' ELSE 'cask' END,'coverage-'||n,'coverage-'||n,
 CASE WHEN n=1006 THEN 'homebrew/core' ELSE 'homebrew/cask' END,'Coverage '||n,'1','1',1007-n,'{}',repeat('a',64)
 FROM generate_series(1,1006) n`).Error)
	var packages []struct {
		ID    int64
		Token string
	}
	require.NoError(t, st.DB.Table("packages").Select("id,token").Find(&packages).Error)
	ids := map[string]int64{}
	for _, pkg := range packages {
		ids[pkg.Token] = pkg.ID
	}
	complete := func(id int64, locale string) {
		t.Helper()
		require.NoError(t, st.DB.Exec("UPDATE packages SET source_locale=? WHERE id=?", locale, id).Error)
		require.NoError(t, st.DB.Exec(`INSERT INTO package_i18n(package_id,locale,display_name,summary,description,status,source,source_locale)
 VALUES(?,?,'Coverage','Summary','Description','source','human',?) ON CONFLICT(package_id,locale)
 DO UPDATE SET display_name=EXCLUDED.display_name,summary=EXCLUDED.summary,description=EXCLUDED.description,source='human'`, id, locale, locale).Error)
		if id == ids["coverage-1006"] {
			// Formula is only an exclusion fixture and does not pass through the Cask content translation pipeline.
			return
		}
		require.NoError(t, st.ScheduleContentTranslation(ctx, content.Ref{Entity: "package", ID: id}))
		source, sourceErr := st.ReadContentSource(ctx, content.Ref{Entity: "package", ID: id})
		require.NoError(t, sourceErr)
		require.NoError(t, st.DB.Exec(`UPDATE package_i18n SET summary='Summary',description='Description',
	 source_locale=?,source_hash=?,status=CASE WHEN locale=? THEN 'source' WHEN locale='en-US' THEN 'manual' ELSE 'machine' END WHERE package_id=?`, locale, source.Hash, locale, id).Error)
		var count int64
		require.NoError(t, st.DB.Table("package_i18n").Where("package_id=?", id).Count(&count).Error)
		require.Equal(t, int64(len(i18n.Locales)), count)
	}
	tailID := ids["coverage-1001"]
	complete(tailID, "zh-CN")
	complete(ids["coverage-1000"], "en-US")
	for _, token := range []string{"coverage-1002", "coverage-1003", "coverage-1004", "coverage-1005", "coverage-1006"} {
		complete(ids[token], "zh-CN")
	}
	require.NoError(t, st.DB.Exec("UPDATE packages SET is_font=true WHERE token='coverage-1002'").Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET disabled=true WHERE token='coverage-1003'").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_meta(package_id,hidden) VALUES(?,true)", ids["coverage-1004"]).Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET removed_at=now() WHERE token='coverage-1005'").Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET deprecated=true WHERE token='coverage-1000'").Error)
	for _, token := range []string{"coverage-1", "coverage-1001", "coverage-1002", "coverage-1003", "coverage-1004", "coverage-1005", "coverage-1006"} {
		require.NoError(t, st.DB.Exec("INSERT INTO releases(package_id,source,source_key,version,title) VALUES(?,'editorial',?,'1','Latest notes')", ids[token], token).Error)
	}
	require.NoError(t, st.DB.Exec("INSERT INTO releases(package_id,source,source_key,version,title,hidden) VALUES(?,'editorial','hidden','1','Hidden',true),(?,'editorial','old','0.9','Older',false),(?,'manual','legacy','1','Legacy',false)", ids["coverage-2"], ids["coverage-3"], ids["coverage-4"]).Error)
	cfg := config.Config{JWTSecret: strings.Repeat("c", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: 24 * time.Hour, LLMModel: "gpt-6-luna", LLMMonthlyTokenBudget: 30000000}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "dashboard-tester", "dashboard-test-password", store.AuditActor{})
	require.NoError(t, err)
	svc := &management.Service{Store: st, Config: cfg}
	app, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	coverage := func() map[string]adminapi.Ratio {
		t.Helper()
		req := httptest.NewRequest("GET", "/admin-api/dashboard/overview", nil)
		req.Header.Set("Authorization", "Bearer "+pair.Token)
		rec := httptest.NewRecorder()
		app.Engine.ServeHTTP(rec, req)
		testutil.ValidateResponse(t, spec, "/admin-api", req, rec)
		var response struct {
			Code string
			Data struct{ Coverage map[string]adminapi.Ratio }
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		require.Equal(t, "0000", response.Code)
		require.Len(t, response.Data.Coverage, 5)
		return response.Data.Coverage
	}
	got := coverage()
	for _, key := range []string{"zhSummary", "primaryCategory", "icon", "latestVersionNotes", "sixLocaleContent"} {
		require.Contains(t, got, key)
		require.Equal(t, 1001, got[key].Total, key)
	}
	require.Equal(t, 2, got["latestVersionNotes"].Done)
	require.Equal(t, 2, got["sixLocaleContent"].Done)
	for _, tc := range []struct{ name, query string }{
		{"missing language with display fallback", "DELETE FROM package_i18n WHERE package_id=? AND locale='ja-JP'"},
		{"missing summary", "UPDATE package_i18n SET summary=NULL WHERE package_id=? AND locale='ja-JP'"},
		{"blank description", "UPDATE package_i18n SET description=E' \\t\\n' WHERE package_id=? AND locale='ja-JP'"},
		{"pending text", "UPDATE package_i18n SET status='pending' WHERE package_id=? AND locale='ja-JP'"},
		{"failed text", "UPDATE package_i18n SET status='failed' WHERE package_id=? AND locale='ja-JP'"},
		{"outdated translation", "UPDATE package_i18n SET source_hash='old' WHERE package_id=? AND locale='ja-JP'"},
		{"unknown freshness", "UPDATE package_i18n SET source_hash=NULL WHERE package_id=? AND locale='ja-JP'"},
		{"previous source language", "UPDATE package_i18n SET source_locale='en-US' WHERE package_id=? AND locale='ja-JP'"},
		{"source changed before scheduling", "UPDATE package_i18n SET summary='Changed' WHERE package_id=? AND locale='zh-CN'"},
		{"homebrew source", "UPDATE package_i18n SET source='homebrew' WHERE package_id=? AND locale='zh-CN'"},
		{"source language changed", "UPDATE packages SET source_locale='ja-JP' WHERE id=?"},
		{"missing source metadata", "DELETE FROM content_translation_sources WHERE entity='package' AND object_key=?::bigint::text"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, st.DB.Exec(tc.query, tailID).Error)
			require.Equal(t, 1, coverage()["sixLocaleContent"].Done)
			complete(tailID, "zh-CN")
			require.Equal(t, 2, coverage()["sixLocaleContent"].Done)
		})
	}
	t.Run("current version changes", func(t *testing.T) {
		require.NoError(t, st.DB.Exec("UPDATE packages SET version='2',version_base='2' WHERE id=?", tailID).Error)
		require.Equal(t, 1, coverage()["latestVersionNotes"].Done)
	})
	t.Run("empty eligible catalog", func(t *testing.T) {
		require.NoError(t, st.DB.Exec("UPDATE packages SET disabled=true WHERE kind='cask'").Error)
		for key, ratio := range coverage() {
			require.Zero(t, ratio.Done, key)
			require.Zero(t, ratio.Total, key)
		}
	})
}
