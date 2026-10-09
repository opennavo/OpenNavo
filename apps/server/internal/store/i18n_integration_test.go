//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestLocalizedContentSourceOnlyWritesAndFallback(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	pkg, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"localized","name":["Localized"],"version":"1"}`))
	require.NoError(t, err)
	require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: pkg}}))
	var pid int64
	require.NoError(t, st.DB.Raw("SELECT id FROM packages WHERE token='localized'").Scan(&pid).Error)
	require.NoError(t, st.DB.Exec(`INSERT INTO collections(id,slug,status) VALUES(1,'localized','published');
 INSERT INTO features(id,placement,target_type,url,status) VALUES(1,'home_hero','url','https://example.com','published');
 INSERT INTO assets(id,kind,storage_key,url,mime,bytes,sha256,width,height) VALUES(1,'screenshot','image','https://example.com/image.png','image/png',1,'hash',100,100);
 INSERT INTO desktop_releases(id,version,artifacts) VALUES(1,'1','[]');
 INSERT INTO mirrors(id,key,probe_url) VALUES(1,'localized','https://example.com');`).Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_screenshots(id,package_id,asset_id) VALUES(1,?,1);", pid).Error)
	require.NoError(t, st.DB.Exec("INSERT INTO collection_items(collection_id,package_id) VALUES(1,?)", pid).Error)
	for _, test := range []struct {
		entity, field string
		secondary     int64
	}{{"collection", "title", 0}, {"feature", "title", 0}, {"screenshot", "caption", 0}, {"collection_item", "note", pid}, {"desktop_release", "notes", 0}, {"mirror", "name", 0}} {
		body := map[string]any{"sourceLocale": "ja-JP", "i18n": map[string]any{"ja-JP": map[string]any{test.field: "日本語の原文"}}}
		require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error {
			return (&store.Store{DB: tx}).WriteLocalized(ctx, test.entity, 1, test.secondary, body, true)
		}), test.entity)
	}
	checks := []struct {
		label string
		load  func() (json.RawMessage, error)
	}{
		{"collection", func() (json.RawMessage, error) { return st.PublicCollection(ctx, "localized", "ru-RU", time.Now()) }},
		{"screenshots", func() (json.RawMessage, error) { return st.PublicScreenshots(ctx, pid, "es-ES") }},
		{"mirrors", func() (json.RawMessage, error) { return st.PublicMirrors(ctx, "pt-BR") }},
	}
	for _, test := range checks {
		raw, err := test.load()
		require.NoError(t, err, test.label)
		require.Contains(t, string(raw), "日本語の原文")
		require.Contains(t, string(raw), `"sourceLocale": "ja-JP"`)
	}
	require.NoError(t, st.DB.Exec("INSERT INTO mirror_i18n(mirror_id,locale,name,status,source_locale) VALUES(1,'en-US','Machine name','machine','ja-JP') ON CONFLICT(mirror_id,locale) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status").Error)
	for _, status := range []string{"pending", "failed"} {
		require.NoError(t, st.DB.Exec("UPDATE mirror_i18n SET status=? WHERE mirror_id=1 AND locale='en-US'", status).Error)
		raw, err := st.PublicMirrors(ctx, "en-US")
		require.NoError(t, err)
		require.Contains(t, string(raw), `"machineTranslated": true`)
		require.Contains(t, string(raw), "Machine name")
	}
	require.NoError(t, st.DB.Exec("UPDATE mirror_i18n SET status='manual',name='Human correction' WHERE mirror_id=1 AND locale='en-US'; UPDATE mirror_i18n SET status='pending' WHERE mirror_id=1 AND locale='en-US'").Error)
	raw, err := st.PublicMirrors(ctx, "en-US")
	require.NoError(t, err)
	require.Contains(t, string(raw), `"machineTranslated": false`)
	require.Contains(t, string(raw), "Human correction")
	features, err := st.PublicFeatures(ctx, "en-US", time.Now())
	require.NoError(t, err)
	require.Len(t, features, 1)
	require.Contains(t, string(features[0]), "日本語の原文")
	items, err := st.CollectionItems(ctx, "localized", "en-US")
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Contains(t, string(items[0]), "日本語の原文")
	desktop, err := st.DesktopRelease(ctx, 1)
	require.NoError(t, err)
	notes, machine := desktop.LocalizedNotes("zh-CN")
	require.Equal(t, "日本語の原文", notes)
	require.False(t, machine)
	require.Error(t, st.WriteLocalized(ctx, "collection", 1, 0, map[string]any{"sourceLocale": "ja-JP", "i18n": map[string]any{"en-US": map[string]any{"title": "Missing original"}}}, true))
	require.Error(t, st.WriteLocalized(ctx, "collection", 1, 0, map[string]any{"sourceLocale": "ja-JP", "i18n": map[string]any{"ja-JP": nil}}, true))
	require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error {
		return (&store.Store{DB: tx}).WriteLocalized(ctx, "collection", 1, 0, map[string]any{"sourceLocale": "ja-JP", "i18n": map[string]any{"ja-JP": map[string]any{"title": "日本語の原文"}, "en-US": nil}}, true)
	}))
}
