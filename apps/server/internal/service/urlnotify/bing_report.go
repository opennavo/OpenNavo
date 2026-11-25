package urlnotify

import (
	"context"
	"fmt"
	"strings"
)

// bingReportBackfill marks the one-time announcement of the pages Bing's 2026-11-24 SEO report
// listed as important but missing from IndexNow. The site key is write-only, so the worker
// submits them itself with the stored credential instead of exposing it to an external caller.
// The "-direct" suffix keeps it distinct from the outbox-based attempt that queued rows but could
// not prove they were announced.
const bingReportBackfill = "2026-11-24-bing-report-direct"

var bingReportURLs = []struct{ Path, Locale string }{
	{"/zh/apps/moonlight", "zh-CN"},
	{"/ja/apps/executor", "ja-JP"},
	{"/zh/apps/audirvana", "zh-CN"},
	{"/apps/corretto@17/versions?page=2", "en-US"},
	{"/apps/dfu-blaster-pro", "en-US"},
}

// AnnounceBingReportURLs submits the report's missing URLs once, directly through IndexNow. It is
// called on the notifier tick until its marker row commits, so a transient startup error retries.
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
		// Leave the marker unset so a later tick retries once the credential is enabled.
		return nil
	}
	base := strings.TrimSuffix(n.Config.WebBaseURL, "/")
	urls := make([]string, 0, len(bingReportURLs))
	for _, entry := range bingReportURLs {
		urls = append(urls, base+entry.Path)
	}
	status, announced := n.announce(ctx, settings, urls)
	if announced != len(urls) {
		return fmt.Errorf("indexnow report backfill: %s (%d/%d)", status, announced, len(urls))
	}
	return n.Store.DB.WithContext(ctx).Exec("INSERT INTO indexnow_backfill(name,completed_at) VALUES(?,now()) ON CONFLICT DO NOTHING", bingReportBackfill).Error
}
