package urlnotify

import (
	"context"
	"strings"

	"github.com/opennavo/opennavo/server/internal/store"
)

// bingReportBackfill marks the one-time announcement of the pages Bing's 2026-11-24 SEO report
// listed as important but missing from IndexNow. The site key is write-only, so the worker
// announces them through the same outbox a content change uses instead of reading the secret.
const bingReportBackfill = "2026-11-24-bing-report"

var bingReportURLs = []struct{ Path, Locale string }{
	{"/zh/apps/moonlight", "zh-CN"},
	{"/ja/apps/executor", "ja-JP"},
	{"/zh/apps/audirvana", "zh-CN"},
	{"/apps/corretto@17/versions?page=2", "en-US"},
	{"/apps/dfu-blaster-pro", "en-US"},
}

// AnnounceBingReportURLs queues the report's missing URLs once. The outbox probes and announces
// them with the configured IndexNow key, so the worker never needs the secret itself.
func (n *Notifier) AnnounceBingReportURLs(ctx context.Context) error {
	var done bool
	if err := n.Store.DB.WithContext(ctx).Raw("SELECT EXISTS(SELECT 1 FROM indexnow_backfill WHERE name=?)", bingReportBackfill).Scan(&done).Error; err != nil || done {
		return err
	}
	settings, err := n.Store.SEOSettings(ctx)
	if err != nil {
		return err
	}
	if !settings.Settings.IndexNow.Enabled {
		// Leave the marker unset so a later worker start retries once the credential is enabled.
		return nil
	}
	base := strings.TrimSuffix(n.Config.WebBaseURL, "/")
	for _, entry := range bingReportURLs {
		note := store.URLNotification{
			URL:           base + entry.Path,
			Path:          entry.Path,
			Locale:        entry.Locale,
			Reason:        "index",
			Announce:      true,
			Robots:        "index, follow",
			CanonicalPath: entry.Path,
		}
		if err := store.QueueURLNotification(ctx, n.Store.DB, note); err != nil {
			return err
		}
	}
	return n.Store.DB.WithContext(ctx).Exec("INSERT INTO indexnow_backfill(name,completed_at) VALUES(?,now()) ON CONFLICT DO NOTHING", bingReportBackfill).Error
}
