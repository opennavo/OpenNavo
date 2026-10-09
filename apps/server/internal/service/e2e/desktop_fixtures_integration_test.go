//go:build integration

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/config"
	httpserver "github.com/opennavo/opennavo/server/internal/http"
	"github.com/opennavo/opennavo/server/internal/http/public"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/service/snapshot"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type fixtureReady struct{}

func (fixtureReady) Ready(context.Context) error { return nil }

func TestDesktopFixturesMatchSeedAndProductionSerialization(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	objects := memoryObjects{}
	_, err := (&Service{Store: st, Objects: objects}).Run(ctx, config.Config{AppEnv: "dev", E2EAdminPassword: "e2e-isolated-dev-only"}) //nolint:gosec // Explicit development fixture password, used only in temporary databases on random ports.
	require.NoError(t, err)
	// Rebuild snapshots only in the temporary test database; fixed generation times allow byte-for-byte comparisons.
	require.NoError(t, st.DB.Exec("DELETE FROM catalog_snapshots").Error)
	// Fixed Japanese offline fixtures write only to testcontainers; they call no translation service and never backfill the development database.
	require.NoError(t, st.DB.Exec("INSERT INTO package_i18n(package_id,locale,source_locale,source,status,display_name,summary) SELECT id,'ja-JP','en-US','human','manual','日本語エディター','ソースコードの編集' FROM packages WHERE token='visual-studio-code'").Error)
	clear(objects)
	snapshots := &snapshot.Service{Store: st, Objects: objects, Now: func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }}
	_, err = snapshots.Build(ctx)
	require.NoError(t, err)
	var latest publicapi.CatalogSnapshotInfo
	require.NoError(t, json.Unmarshal(objects["snapshots/latest.json"], &latest))
	var compressed []byte
	for key, data := range objects {
		if strings.HasPrefix(key, "snapshots/base-v2-") {
			compressed = data
		}
	}

	// Simulate updates, deletion and a second page after the snapshot so clients can verify cursor continuation fully.
	require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error {
		if err := store.LockCatalogWrites(ctx, tx); err != nil {
			return err
		}
		for _, change := range []struct{ token, version, op string }{{"visual-studio-code", "1.140.1", "upsert"}, {"font-jetbrains-mono", "", "delete"}, {"ghostty", "1.3.1", "upsert"}, {"wechat", "4.0.7", "upsert"}} {
			query := "UPDATE packages SET version=?,version_changed_at='2026-10-02T00:00:00Z' WHERE token=?"
			args := []any{change.version, change.token}
			if change.op == "delete" {
				query, args = "UPDATE packages SET removed_at='2026-10-02T00:00:00Z' WHERE token=?", []any{change.token}
			}
			if err := tx.WithContext(ctx).Exec(query, args...).Error; err != nil {
				return err
			}
			if err := tx.WithContext(ctx).Exec("INSERT INTO catalog_changes(package_id,kind,token,op,reason) SELECT id,kind,token,?,'content' FROM packages WHERE token=?", change.op, change.token).Error; err != nil {
				return err
			}
		}
		return nil
	}))
	server, err := httpserver.New(config.Config{AppEnv: "dev", WebBaseURL: "https://opennavo.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)), fixtureReady{}, httpserver.Dependencies{Public: &public.Handler{Snapshot: snapshots, Catalog: &catalog.PublicService{Store: st, WebBaseURL: "https://opennavo.example"}}})
	require.NoError(t, err)
	spec, err := publicapi.GetSpec()
	require.NoError(t, err)
	call := func(path string, status int) []byte {
		request := httptest.NewRequest(http.MethodGet, "/api/v1"+path, nil)
		reply := httptest.NewRecorder()
		server.Engine.ServeHTTP(reply, request)
		require.Equal(t, status, reply.Code, reply.Body.String())
		testutil.ValidateResponse(t, spec, "/api/v1", request, reply)
		// Save actual response bodies rather than assembling failure messages or fields manually.
		var compact bytes.Buffer
		require.NoError(t, json.Compact(&compact, reply.Body.Bytes()))
		return compact.Bytes()
	}
	files := map[string][]byte{
		"catalog.json.gz":    compressed,
		"latest.json":        objects["snapshots/latest.json"],
		"snapshot.json":      call("/catalog/snapshot", 200),
		"changes-page.json":  call("/catalog/changes?since=60&limit=3", 200),
		"changes-final.json": call("/catalog/changes?since=63&limit=3", 200),
		"changes-empty.json": call("/catalog/changes?since=64&limit=3", 200),
		"client-config.json": call("/config/client?platform=desktop&version=0.1.0&locale=zh-CN", 200),
	}
	for _, locale := range []string{"en-US", "zh-CN", "ja-JP", "es-ES", "pt-BR", "ru-RU"} {
		for key, data := range objects {
			if strings.HasPrefix(key, "snapshots/text-v2-"+locale+"-") {
				files["text-"+locale+".json.gz"] = data
			}
		}
	}
	require.NoError(t, st.DB.Exec("INSERT INTO app_config(key,value) VALUES('catalog.retentionCursor','60'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value").Error)
	files["changes-expired.json"] = call("/catalog/changes?since=0&limit=3&locale=zh-CN", 410)
	directory := filepath.Join("..", "..", "..", "testdata", "desktop", "v2")
	if os.Getenv("UPDATE_DESKTOP_FIXTURES") == "1" {
		require.NoError(t, os.MkdirAll(directory, 0o750))
		for name, data := range files {
			require.NoError(t, os.WriteFile(filepath.Join(directory, name), data, 0o600))
		}
	}
	for name, data := range files {
		previous, err := os.ReadFile(filepath.Join(directory, name)) //nolint:gosec // directory is a fixed fixture directory; name comes only from the finite file set generated by this test.
		require.NoError(t, err, "run node tooling/scripts/tasks/server.mjs desktop-fixtures after intentional format changes")
		require.Equal(t, previous, data, name+": current seeded serialization differs from committed fixture")
	}
}
