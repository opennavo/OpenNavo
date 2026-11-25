//go:build integration

package urlnotify

import (
	"context"
	"testing"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestBingReportBackfillQueuesMissingURLsOnce(t *testing.T) {
	st := testutil.NewSEOStore(t)
	ctx := context.Background()
	require.NoError(t, st.DB.Exec(`UPDATE seo_settings SET settings=settings||'{"indexNow":{"enabled":true}}'::jsonb WHERE id=true`).Error)
	settings, err := st.SEOSettings(ctx)
	require.NoError(t, err)
	require.True(t, settings.Settings.IndexNow.Enabled, "IndexNow must be enabled for the backfill")
	n := &Notifier{Store: st, Config: config.Config{WebBaseURL: "https://site.example.test"}}

	require.NoError(t, n.AnnounceBingReportURLs(ctx))
	var count int64
	require.NoError(t, st.DB.Table("url_notify_outbox").Where("announce").Count(&count).Error)
	require.EqualValues(t, len(bingReportURLs), count)
	for _, entry := range bingReportURLs {
		var saved struct {
			Reason        string
			Robots        string
			CanonicalPath string
			Announce      bool
		}
		require.NoError(t, st.DB.Table("url_notify_outbox").
			Select("reason,robots,canonical_path,announce").
			Where("url=?", "https://site.example.test"+entry.Path).Scan(&saved).Error)
		require.Equal(t, "index", saved.Reason)
		require.Equal(t, "index, follow", saved.Robots)
		require.Equal(t, entry.Path, saved.CanonicalPath)
		require.True(t, saved.Announce)
	}

	// A second worker start must not duplicate the obligations.
	require.NoError(t, n.AnnounceBingReportURLs(ctx))
	require.NoError(t, st.DB.Table("url_notify_outbox").Where("announce").Count(&count).Error)
	require.EqualValues(t, len(bingReportURLs), count)
	var completed int64
	require.NoError(t, st.DB.Table("indexnow_backfill").Count(&completed).Error)
	require.EqualValues(t, 1, completed)
}
