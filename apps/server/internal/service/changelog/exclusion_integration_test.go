//go:build integration

package changelog_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	pipeline "github.com/opennavo/opennavo/server/internal/changelog"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/service/changelog"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestChangelogExclusionSkipsQueuedWorkAndPreservesHistory(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"excluded-app","version":"1.0","ruby_source_path":"Casks/e/excluded-app.rb"}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	var pid, sid int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE token='excluded-app'").Scan(&pid).Error)
	settings, err := st.PackageChangelogSettings(ctx, pid)
	require.NoError(t, err)
	require.False(t, settings.Excluded)
	_, err = st.SetPackageChangelogSettings(ctx, pid, true, store.AuditActor{})
	require.NoError(t, err)
	queue := &queuedSources{}
	svc := &changelog.Service{Store: st, Resolver: pipeline.NewResolver("test"), Fetcher: pipeline.NewFetcher("test"), Queue: queue}
	stats, err := svc.Resolve(ctx, pid)
	require.NoError(t, err)
	require.Equal(t, true, stats["skipped"])
	stats, err = svc.Schedule(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, stats["enqueued"])
	_, err = st.SetPackageChangelogSettings(ctx, pid, false, store.AuditActor{})
	require.NoError(t, err)
	_, err = svc.Resolve(ctx, pid)
	require.NoError(t, err)
	require.NoError(t, st.DB.Raw("SELECT id FROM changelog_sources WHERE package_id=?", pid).Scan(&sid).Error)
	requests := 0
	svc.Fetcher.HTTP.Client.Transport = responseTransport(func(*http.Request) (*http.Response, error) {
		requests++
		// Simulate an administrator excluding the app concurrently after the network request is sent.
		_, err := st.SetPackageChangelogSettings(ctx, pid, true, store.AuditActor{})
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`[{"sha":"test","commit":{"message":"excluded-app 0.9","committer":{"date":"2026-09-30T00:00:00Z"}}}]`))}, nil
	})
	_, err = svc.Fetch(ctx, sid)
	require.NoError(t, err)
	require.Equal(t, 1, requests)
	var versions int64
	require.NoError(t, st.DB.Table("package_versions").Where("package_id=?", pid).Count(&versions).Error)
	require.EqualValues(t, 1, versions)
	stats, err = svc.Fetch(ctx, sid)
	require.NoError(t, err)
	require.Equal(t, true, stats["skipped"])
	require.Equal(t, 1, requests)
	stats, err = svc.Schedule(ctx)
	require.NoError(t, err)
	require.Equal(t, 0, stats["enqueued"])
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	settings, err = st.PackageChangelogSettings(ctx, pid)
	require.NoError(t, err)
	require.True(t, settings.Excluded)
	_, err = st.SetPackageChangelogSettings(ctx, pid, false, store.AuditActor{})
	require.NoError(t, err)
	stats, err = svc.Schedule(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, stats["enqueued"])
	var audits int64
	require.NoError(t, st.DB.Table("audit_logs").Where("action=?", "UpdatePackageChangelogSettings").Count(&audits).Error)
	require.EqualValues(t, 4, audits)
}
