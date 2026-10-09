//go:build integration

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/service/catalog"
	"github.com/opennavo/opennavo/server/internal/service/desktop"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func verifyPageData(t *testing.T, st *store.Store, objects memoryObjects) {
	t.Helper()
	ctx := context.Background()
	public := &catalog.PublicService{Store: st}
	detail, err := public.Detail(ctx, "cask", "visual-studio-code", "zh-CN")
	require.NoError(t, err)
	require.Equal(t, "Microsoft", *detail.Developer)
	require.NotEmpty(t, *detail.Caveats)
	require.Equal(t, "brew install --cask visual-studio-code", detail.InstallCommand)
	require.Equal(t, 8, detail.ReleaseCount)
	require.NotNil(t, detail.ReleaseStats)
	require.NotEmpty(t, *detail.LatestRelease.Summary)
	require.Len(t, detail.Screenshots, 2)
	for _, shot := range detail.Screenshots {
		image, err := png.Decode(bytes.NewReader(objects[strings.TrimPrefix(shot.Url, objects.URL(""))]))
		require.NoError(t, err)
		require.Equal(t, 1280, image.Bounds().Dx())
		require.Equal(t, 800, image.Bounds().Dy())
	}
	payload := objects[strings.TrimPrefix(*detail.DownloadUrl, objects.URL(""))]
	require.Equal(t, int64(len(payload)), *detail.DownloadSize)
	require.Equal(t, fixtureHash(payload), *detail.DownloadSha256)
	require.Contains(t, detail.SourceUrl, "/Casks/v/visual-studio-code.rb")
	deps, err := public.Dependencies(ctx, "formula", "node", "zh-CN", 2, "")
	require.Error(t, err)
	require.Empty(t, deps.Dependencies)
	deps, err = public.Dependencies(ctx, "formula", "zlib", "zh-CN", 2, "")
	require.Error(t, err)
	require.Empty(t, deps.Dependencies)
	deps, err = public.Dependencies(ctx, "cask", "visual-studio-code", "zh-CN", 2, "")
	require.NoError(t, err)
	require.Equal(t, []string{"ripgrep"}, deps.DependsOn.Formulae)
	require.Len(t, deps.ConflictsWith.Casks, 1)
	detail, err = public.Detail(ctx, "formula", "openssl@3", "en-US")
	require.Error(t, err)
	require.Empty(t, detail.Token)
	lookup, err := public.Lookup(ctx, []publicapi.PackageRef{{Kind: "cask", Token: "visual-studio-code"}, {Kind: "cask", Token: "ghostty"}}, "zh-CN")
	require.NoError(t, err)
	for _, row := range lookup {
		require.True(t, row.Found)
		require.NotNil(t, row.AutoUpdates)
		require.NotEmpty(t, *row.LatestRelease.Summary)
	}
	verifyChecksumSources(t, st, public)
	verifyDesktopHistory(t, st, objects)
}

func verifyChecksumSources(t *testing.T, st *store.Store, public *catalog.PublicService) {
	t.Helper()
	ctx := context.Background()
	for _, sample := range []struct {
		kind, token, raw string
		want             *string
	}{
		{"cask", "visual-studio-code", `{"sha256":"no_check"}`, nil},
		{"cask", "visual-studio-code", `{"sha256":"bad"}`, nil},
		{"cask", "visual-studio-code", `{"sha256":"` + strings.Repeat("A", 64) + `"}`, stringPointer(strings.Repeat("a", 64))},
		{"formula", "node", `{}`, nil},
		{"formula", "node", `{"urls":{"stable":{"checksum":"` + strings.Repeat("A", 64) + `"}}}`, stringPointer(strings.Repeat("a", 64))},
	} {
		require.NoError(t, st.DB.Exec("UPDATE packages SET raw=?::jsonb WHERE kind=? AND token=?", sample.raw, sample.kind, sample.token).Error)
		detail, err := public.Detail(ctx, sample.kind, sample.token, "zh-CN")
		if sample.kind == "formula" {
			require.Error(t, err)
			require.Nil(t, detail.DownloadSha256)
			continue
		}
		require.NoError(t, err)
		require.Equal(t, sample.want, detail.DownloadSha256)
	}
}

func stringPointer(value string) *string { return &value }

func verifyDesktopHistory(t *testing.T, st *store.Store, objects memoryObjects) {
	t.Helper()
	ctx := context.Background()
	service := &desktop.Service{Store: st}
	for _, locale := range []string{"zh-CN", "en-US"} {
		latest, err := service.Latest(ctx, "stable", locale)
		require.NoError(t, err)
		require.Equal(t, "0.3.0", latest.Version)
		require.Len(t, *latest.RecentReleases, 5)
		require.Equal(t, latest.Version, (*latest.RecentReleases)[0].Version)
		for _, row := range *latest.RecentReleases {
			if locale == "en-US" {
				require.Contains(t, row.Notes, "Test release")
			} else {
				require.Contains(t, row.Notes, "测试版本")
			}
		}
		download := latest.Downloads[0]
		payload := objects[strings.TrimPrefix(download.Url, objects.URL(""))]
		require.Equal(t, int64(len(payload)), download.Bytes)
		require.Equal(t, fixtureHash(payload), download.Sha256)
	}
	// Older history, other channels and unpublished versions must not displace the current channel's five records.
	artifacts, err := json.Marshal([]map[string]any{{"target": "dmg-universal", "url": objects.URL("desktop/test.dmg"), "sha256": strings.Repeat("a", 64), "bytes": 1}})
	require.NoError(t, err)
	for index, row := range []struct{ version, channel, status string }{{"0.0.9", "stable", "published"}, {"9.0.0", "beta", "published"}, {"9.0.1", "stable", "draft"}, {"9.0.2", "stable", "rolled_back"}} {
		date := time.Date(2026, 1, 1, 0, 0, index, 0, time.UTC)
		if index > 0 {
			date = date.AddDate(1, 0, 0)
		}
		require.NoError(t, st.DB.Exec("INSERT INTO desktop_releases(version,channel,status,min_macos,artifacts,pub_date) VALUES(?,?,?,'13.0',?::jsonb,?)", row.version, row.channel, row.status, string(artifacts), date).Error)
	}
	require.NoError(t, st.DB.Exec("INSERT INTO desktop_release_i18n(desktop_release_id,locale,notes,status,source_locale) SELECT id,'zh-CN','中文','source','zh-CN' FROM desktop_releases ON CONFLICT DO NOTHING; INSERT INTO desktop_release_i18n(desktop_release_id,locale,notes,status,source_locale) SELECT id,'en-US','English','manual','zh-CN' FROM desktop_releases ON CONFLICT DO NOTHING").Error)
	latest, err := service.Latest(ctx, "stable", "zh-CN")
	require.NoError(t, err)
	require.Len(t, *latest.RecentReleases, 5)
	require.Equal(t, "0.1.0", (*latest.RecentReleases)[4].Version)
	latest, err = service.Latest(ctx, "beta", "en-US")
	require.NoError(t, err)
	require.Len(t, *latest.RecentReleases, 1)
	require.Equal(t, "9.0.0", latest.Version)
}
