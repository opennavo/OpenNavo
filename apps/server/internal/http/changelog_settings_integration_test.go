//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
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

func TestPackageChangelogSettingsContract(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	data, err := seeds.Load()
	require.NoError(t, err)
	hash, err := seed.HashPassword("isolated-test-password")
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "tester", hash))
	p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"test-app","version":"1.0"}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	var id int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE token='test-app'").Scan(&id).Error)
	cfg := config.Config{AppEnv: "dev", JWTSecret: strings.Repeat("a", 32), JWTAccessTTL: time.Hour, JWTRefreshTTL: 24 * time.Hour}
	authentication, err := auth.New(st, cfg)
	require.NoError(t, err)
	pair, err := authentication.Login(ctx, "tester", "isolated-test-password", store.AuditActor{})
	require.NoError(t, err)
	app, err := httpserver.New(cfg, slog.Default(), st, httpserver.Dependencies{Admin: &admin.Handler{Auth: authentication, Management: &management.Service{Store: st}}})
	require.NoError(t, err)
	spec, err := adminapi.GetSpec()
	require.NoError(t, err)
	for _, test := range []struct {
		method, body, code string
		excluded           bool
	}{
		{"GET", "", "0000", false}, {"PUT", `{"excluded":true}`, "0000", true}, {"GET", "", "0000", true}, {"PUT", `{}`, "1001", false}, {"PUT", `{"excluded":"yes"}`, "1001", false}, {"PUT", `{"excluded":false}`, "0000", false},
	} {
		req := httptest.NewRequest(test.method, fmt.Sprintf("/admin-api/packages/%d/changelog-settings", id), strings.NewReader(test.body))
		req.Header.Set("Authorization", "Bearer "+pair.Token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.Engine.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code)
		var out struct {
			Code string
			Data *store.ChangelogSettings
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		require.Equal(t, test.code, out.Code)
		if test.code == "0000" {
			require.NotNil(t, out.Data)
			require.Equal(t, test.excluded, out.Data.Excluded)
		}
		testutil.ValidateResponse(t, spec, "/admin-api", req, rec)
	}
}
