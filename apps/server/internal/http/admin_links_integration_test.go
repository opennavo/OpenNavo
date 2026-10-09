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
	"github.com/opennavo/opennavo/server/internal/homebrew"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/admin"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/management"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestAdminWebURLsRespectVisibilityPublicationAndRuntimeBase(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	data, err := seeds.Load()
	require.NoError(t, err)
	hash, err := seed.HashPassword("admin-links-dev-only")
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "tester", hash))
	for _, input := range []struct{ kind, body string }{
		{"cask", `{"token":"visual-studio-code","version":"1.140.0","name":["Visual Studio Code"]}`},
		{"formula", `{"name":"node@24","full_name":"node@24","versions":{"stable":"24.19.0"}}`},
	} {
		pkg, err := homebrew.Normalize(input.kind, json.RawMessage(input.body))
		require.NoError(t, err)
		require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: pkg}}))
	}
	cfg := config.Config{JWTSecret: strings.Repeat("w", 32), JWTAccessTTL: time.Hour,
		JWTRefreshTTL: 24 * time.Hour, WebBaseURL: "https://store.opennavo.example/root/"}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "tester", "admin-links-dev-only", store.AuditActor{})
	require.NoError(t, err)
	svc := &management.Service{Store: st, Config: cfg}
	server, err := httpserver.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), st,
		httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: svc}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	get := func(path string, expectedCode ...string) json.RawMessage {
		t.Helper()
		r := httptest.NewRequest("GET", "/admin-api"+path, nil)
		r.Header.Set("Authorization", "Bearer "+pair.Token)
		w := httptest.NewRecorder()
		server.Engine.ServeHTTP(w, r)
		require.Equal(t, 200, w.Code)
		testutil.ValidateResponse(t, spec, "/admin-api", r, w)
		var envelope struct {
			Code string
			Data json.RawMessage
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
		code := "0000"
		if len(expectedCode) > 0 {
			code = expectedCode[0]
		}
		require.Equal(t, code, envelope.Code)
		return envelope.Data
	}
	checkURL := func(raw json.RawMessage, expected any) {
		t.Helper()
		var record map[string]any
		require.NoError(t, json.Unmarshal(raw, &record))
		value, present := record["webUrl"]
		require.True(t, present, "unavailable links must be explicit null")
		require.Equal(t, expected, value)
	}
	var pid int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE kind='cask'").Scan(&pid).Error)
	packagePath := "/packages/" + strconv.FormatInt(pid, 10)
	checkURL(get(packagePath), "https://store.opennavo.example/root/apps/visual-studio-code")
	require.NoError(t, st.DB.Exec("INSERT INTO package_meta(package_id,hidden) VALUES(?,true)", pid).Error)
	checkURL(get(packagePath), nil)
	require.NoError(t, st.DB.Exec("UPDATE package_meta SET hidden=false WHERE package_id=?", pid).Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET removed_at=now() WHERE id=?", pid).Error)
	checkURL(get(packagePath), nil)
	var formulaID int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE kind='formula'").Scan(&formulaID).Error)
	formulaPath := "/packages/" + strconv.FormatInt(formulaID, 10)
	require.JSONEq(t, "null", string(get(formulaPath, "1002")))
	require.NoError(t, st.DB.Exec("UPDATE packages SET disabled=true,deprecated=true WHERE id=?", formulaID).Error)
	require.JSONEq(t, "null", string(get(formulaPath, "1002")))

	for _, status := range []string{"draft", "published", "scheduled", "archived"} {
		var id int64
		require.NoError(t, st.DB.Raw("INSERT INTO collections(slug,status) VALUES(?,?) RETURNING id", "new-mac-"+status, status).Scan(&id).Error)
		require.NoError(t, st.DB.Exec("INSERT INTO collection_i18n(collection_id,locale,title) VALUES(?,'zh-CN','新 Mac')", id).Error)
		var expected any
		if status == "published" || status == "scheduled" {
			expected = "https://store.opennavo.example/root/collections/new-mac-" + status
		}
		checkURL(get("/collections/"+strconv.FormatInt(id, 10)), expected)
		var page struct{ Records []json.RawMessage }
		require.NoError(t, json.Unmarshal(get("/collections?status="+status), &page))
		require.Len(t, page.Records, 1)
		checkURL(page.Records[0], expected)
	}
	svc.Config.WebBaseURL = "https://next.opennavo.example"
	require.NoError(t, st.DB.Exec("UPDATE packages SET removed_at=NULL WHERE id=?", pid).Error)
	checkURL(get(packagePath), "https://next.opennavo.example/apps/visual-studio-code")
	require.JSONEq(t, "null", string(get(formulaPath, "1002")))
}
