//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/opennavo/opennavo/server/seeds"
	"github.com/stretchr/testify/require"
)

func TestPublicCategoryCountsDeduplicateDescendantsAndFilterPackages(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	data, err := seeds.Load()
	require.NoError(t, err)
	require.NoError(t, st.Seed(ctx, data, "", ""))
	require.NoError(t, st.DB.Exec("INSERT INTO categories(slug,parent_id,icon,visible) SELECT 'e2e-child',id,'lucide:code-xml',true FROM categories WHERE slug='developer-tools'").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO categories(slug,parent_id,icon,visible) SELECT 'e2e-nested',id,'lucide:code-xml',true FROM categories WHERE slug='e2e-child'").Error)
	for _, token := range []string{"overlapping", "nested-only", "hidden", "removed", "disabled"} {
		p, err := homebrew.Normalize("cask", json.RawMessage(`{"token":"`+token+`","version":"1"}`))
		require.NoError(t, err)
		require.NoError(t, st.ApplyCatalogBatch(ctx, []store.CatalogMutation{{Package: p}}))
	}
	require.NoError(t, st.DB.Exec("INSERT INTO package_categories(package_id,category_id,is_primary,source) SELECT p.id,c.id,true,'human' FROM packages p CROSS JOIN categories c WHERE c.slug='e2e-nested'").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_categories(package_id,category_id,is_primary,source) SELECT p.id,c.id,false,'human' FROM packages p CROSS JOIN categories c WHERE p.token='overlapping' AND c.slug IN('developer-tools','e2e-child')").Error)
	require.NoError(t, st.DB.Exec("INSERT INTO package_meta(package_id,hidden) SELECT id,true FROM packages WHERE token='hidden'").Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET disabled=true WHERE token='disabled'").Error)
	require.NoError(t, st.DB.Exec("UPDATE packages SET removed_at=now() WHERE token='removed'").Error)
	for _, locale := range []string{"zh-CN", "en-US"} {
		rows, err := st.PublicCategories(ctx, locale)
		require.NoError(t, err)
		counts := map[string]int{}
		for _, row := range rows {
			counts[row.Slug] = row.PackageCount
		}
		for _, slug := range []string{"developer-tools", "e2e-child", "e2e-nested"} {
			require.Equal(t, 2, counts[slug], slug)
		}
		require.Equal(t, 0, counts["fonts"])
	}
}
