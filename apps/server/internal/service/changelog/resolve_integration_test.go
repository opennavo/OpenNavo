//go:build integration

package changelog_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	pipeline "github.com/opennavo/opennavo/server/internal/changelog"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/service/changelog"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type responseTransport func(*http.Request) (*http.Response, error)

func (f responseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestResolvePersistsSourcesAndProtectsManualAndDisabled(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"editor","version":"1","homepage":"https://github.com/example/editor","ruby_source_path":"Casks/e/editor.rb","tap_git_head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	var id int64
	require.NoError(t, st.DB.WithContext(ctx).Raw("SELECT id FROM packages WHERE token='editor'").Scan(&id).Error)
	resolver := pipeline.NewResolver("test")
	resolver.Client = &http.Client{Transport: responseTransport(func(r *http.Request) (*http.Response, error) {
		t.Fatal("resolve must not request upstream")
		return nil, nil
	})}
	svc := &changelog.Service{Store: st, Resolver: resolver}
	stats, err := svc.Resolve(ctx, id)
	require.NoError(t, err)
	require.Equal(t, 1, stats["sources"])
	require.NoError(t, st.DB.Exec(`INSERT INTO changelog_sources(package_id,type,config,priority,resolved_by) VALUES(?,'github_releases','{}',20,'auto'),(?,'sparkle','{}',30,'auto')`, id, id).Error)
	require.NoError(t, st.DB.WithContext(ctx).Exec("UPDATE changelog_sources SET enabled=false WHERE type='sparkle'").Error)
	require.NoError(t, st.DB.WithContext(ctx).Exec("UPDATE changelog_sources SET resolved_by='manual',config='{\"repo\":\"manual/repo\"}',priority=10 WHERE type='github_releases'").Error)
	stats, err = svc.Top(ctx, 1000)
	require.NoError(t, err)
	require.Equal(t, 1, stats["packages"])
	var preserved struct {
		ResolvedBy string
		Config     json.RawMessage
		Priority   int
	}
	require.NoError(t, st.DB.WithContext(ctx).Raw("SELECT resolved_by,config,priority FROM changelog_sources WHERE type='github_releases'").Scan(&preserved).Error)
	require.Equal(t, "manual", preserved.ResolvedBy)
	require.Contains(t, string(preserved.Config), "manual/repo")
	require.Equal(t, 10, preserved.Priority)
	var enabled bool
	require.NoError(t, st.DB.WithContext(ctx).Raw("SELECT enabled FROM changelog_sources WHERE type='sparkle'").Scan(&enabled).Error)
	require.False(t, enabled)
	_, err = svc.Resolve(ctx, 999)
	require.Error(t, err)
}
