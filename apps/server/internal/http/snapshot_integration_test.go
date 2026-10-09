//go:build integration

package httpserver_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/service/snapshot"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestSnapshotAndIncrementalContracts(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"sample","version":"1"}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	svc := &snapshot.Service{Store: st, Objects: memoryObjects{}}
	_, err = svc.Build(ctx)
	require.NoError(t, err)
	server, err := httpserver.New(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), st, httpserver.Dependencies{Public: &public.Handler{Snapshot: svc}})
	require.NoError(t, err)
	spec, err := publicapi.GetSpec()
	require.NoError(t, err)
	call := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/v1"+path, nil)
		w := httptest.NewRecorder()
		server.Engine.ServeHTTP(w, r)
		testutil.ValidateResponse(t, spec, "/api/v1", r, w)
		return w
	}
	require.Equal(t, 200, call("/catalog/snapshot").Code)
	require.Equal(t, 200, call("/catalog/changes?since=0&limit=1").Code)
	require.NoError(t, st.DB.WithContext(ctx).Exec(`UPDATE catalog_changes SET created_at=now()-interval '15 days'`).Error)
	_, err = st.PruneCatalogChanges(ctx, time.Now().Add(-14*24*time.Hour))
	require.NoError(t, err)
	w := call("/catalog/changes?since=0")
	require.Equal(t, 410, w.Code)
	require.Contains(t, w.Body.String(), "1201")
}
