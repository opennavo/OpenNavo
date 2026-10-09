//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestCollectionPreviewLimitOrderVisibilityLocaleAndFallback(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	tokens := []string{"removed", "hidden", "ghostty", "ripgrep", "vscode", "node", "wezterm", "extra", "legacy"}
	for index, token := range tokens {
		kind, raw := "cask", `{"token":"`+token+`","version":"1"}`
		if token == "legacy" {
			kind, raw = "formula", `{"name":"legacy","versions":{"stable":"1"}}`
		}
		p, err := homebrew.Normalize(kind, json.RawMessage(raw))
		require.NoError(t, err)
		require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
		// ghostty/ripgrep share a sort value; use package_id for stable ordering.
		sort := index
		if token == "ripgrep" {
			sort = 2
		}
		require.NoError(t, st.DB.Exec("INSERT INTO collections(slug,status) VALUES('preview','published') ON CONFLICT DO NOTHING").Error)
		require.NoError(t, st.DB.Exec("INSERT INTO collection_items(collection_id,package_id,sort) SELECT c.id,p.id,? FROM collections c CROSS JOIN packages p WHERE c.slug='preview' AND p.token=?", sort, token).Error)
	}
	require.NoError(t, st.DB.Exec("INSERT INTO collection_i18n(collection_id,locale,title) SELECT id,'zh-CN','预览' FROM collections").Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET removed_at=now() WHERE token='removed'").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_meta(package_id,hidden) SELECT id,true FROM packages WHERE token='hidden'").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO assets(kind,storage_key,url,mime,bytes,sha256) VALUES('icon','preview/icon.png','https://cdn.example.test/icon.png','image/png',1,repeat('a',64))").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_meta(package_id,icon_asset_id,accent_color) SELECT p.id,a.id,'#4AA8FF' FROM packages p CROSS JOIN assets a WHERE p.token='ghostty'").Error)
	for locale, name := range map[string]string{"zh-CN": "幽灵终端", "en-US": "Ghostty Terminal"} {
		require.NoError(t, st.DB.Exec("INSERT INTO package_i18n(package_id,locale,display_name,status,source) SELECT id,?,?,'manual','human' FROM packages WHERE token='ghostty'", locale, name).Error)
		raw, err := st.PublicCollection(ctx, "preview", locale, time.Now())
		require.NoError(t, err)
		var detail publicapi.CollectionSummary
		require.NoError(t, json.Unmarshal(raw, &detail))
		require.NotNil(t, detail.PreviewItems)
		items := *detail.PreviewItems
		require.Len(t, items, 5)
		require.Equal(t, 6, detail.ItemCount)
		for _, item := range items {
			require.Equal(t, publicapi.PackageKindCask, item.Kind)
		}
		require.Len(t, detail.IconUrls, 5)
		for i, token := range []string{"ghostty", "ripgrep", "vscode", "node", "wezterm"} {
			require.Equal(t, token, items[i].Token)
			require.Equal(t, detail.IconUrls[i], items[i].IconUrl)
		}
		require.Equal(t, name, items[0].DisplayName)
		require.Equal(t, "#4AA8FF", *items[0].AccentColor)
		require.Equal(t, "ripgrep", items[1].DisplayName)
		require.Nil(t, items[1].IconUrl)
		require.Nil(t, items[1].AccentColor)
		rows, total, err := st.PublicCollections(ctx, locale, time.Now(), 1, 10)
		require.NoError(t, err)
		require.Equal(t, int64(1), total)
		require.JSONEq(t, string(raw), string(rows[0]))
	}
}
