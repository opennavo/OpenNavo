//go:build integration

package contenttranslate

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestClearingSourceRemovesTranslationsAndRejectsOldResults(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	seedContents(t, st)
	ref := content.Ref{Entity: "screenshot", ID: 100}
	source := schedule(t, ctx, st, ref)
	svc := Service{Store: st, LLM: &fakeTranslator{Run: validFake}, Model: "fake"}
	_, err := svc.Run(ctx, ref, source.Hash)
	require.NoError(t, err)
	require.NoError(t, st.DB.Exec("UPDATE screenshot_i18n SET caption='Changed source caption' WHERE screenshot_id=100 AND locale='en-US'").Error)
	pending := schedule(t, ctx, st, ref)
	require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error {
		return (&store.Store{DB: tx}).WriteLocalized(ctx, "screenshot", 100, 0, map[string]any{"sourceLocale": "en-US", "i18n": map[string]any{"en-US": map[string]any{"caption": nil}}}, false)
	}))
	var count int64
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM screenshot_i18n WHERE screenshot_id=100 AND caption IS NOT NULL").Scan(&count).Error)
	require.Zero(t, count)
	require.NoError(t, st.DB.Raw("SELECT count(*) FROM job_outbox WHERE unique_key='translate:content:screenshot:100'").Scan(&count).Error)
	require.Zero(t, count)
	applied, err := st.ApplyContentTranslation(ctx, pending, "ja-JP", map[string]string{"caption": "古い説明"}, "fake")
	require.NoError(t, err)
	require.False(t, applied)
	// Restoring identical source text must regenerate translations, without being blocked by deduplication records from before clearing.
	require.NoError(t, st.WithTx(ctx, func(tx *gorm.DB) error {
		return (&store.Store{DB: tx}).WriteLocalized(ctx, "screenshot", 100, 0, map[string]any{"sourceLocale": "en-US", "i18n": map[string]any{"en-US": map[string]any{"caption": "The application manages files"}}}, false)
	}))
	restored, err := st.ReadContentSource(ctx, ref)
	require.NoError(t, err)
	require.Equal(t, source.Hash, restored.Hash)
	require.Len(t, restored.Targets, 5)
}

func TestClearingUpstreamSummaryPreservesReferenceBody(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	seedContents(t, st)
	require.NoError(t, st.DB.Exec("UPDATE releases SET source='github_release' WHERE id=100").Error)
	ref := content.Ref{Entity: "release", ID: 100}
	schedule(t, ctx, st, ref)
	require.NoError(t, st.DB.Exec("UPDATE release_i18n SET body_markdown='Reference body' WHERE release_id=100 AND locale='ja-JP'").Error)
	require.NoError(t, st.DB.Exec("UPDATE release_i18n SET title=NULL,summary=NULL,sections='[]' WHERE release_id=100 AND locale='en-US'").Error)
	schedule(t, ctx, st, ref)
	var row struct {
		BodyMarkdown string
		Summary      *string
		Sections     json.RawMessage
	}
	require.NoError(t, st.DB.Raw("SELECT body_markdown,summary,sections FROM release_i18n WHERE release_id=100 AND locale='ja-JP'").Scan(&row).Error)
	require.Equal(t, "Reference body", row.BodyMarkdown)
	require.Nil(t, row.Summary)
	require.JSONEq(t, "[]", string(row.Sections))
}

func TestAdminStaleUsesCurrentSourceContentHash(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewStore(t)
	seedContents(t, st)
	svc := Service{Store: st, LLM: &fakeTranslator{Run: validFake}, Model: "fake"}
	for _, entity := range []string{"package", "release"} {
		t.Run(entity, func(t *testing.T) {
			ref := content.Ref{Entity: entity, ID: 100}
			source := schedule(t, ctx, st, ref)
			_, err := svc.Run(ctx, ref, source.Hash)
			require.NoError(t, err)
			read := func() []struct {
				Locale string
				Stale  bool
			} {
				t.Helper()
				var raw json.RawMessage
				var err error
				if entity == "package" {
					raw, err = st.AdminPackage(ctx, 100)
				} else {
					raw, err = st.AdminRelease(ctx, 100)
				}
				require.NoError(t, err)
				var detail struct {
					I18n []struct {
						Locale string
						Stale  bool
					}
				}
				require.NoError(t, json.Unmarshal(raw, &detail))
				return detail.I18n
			}
			rows := read()
			require.Len(t, rows, 6)
			for _, row := range rows {
				require.False(t, row.Stale, row.Locale)
			}
			spec := content.Registry[entity]
			require.NoError(t, st.DB.Table(spec.Table).Where(spec.Key+"=? AND locale='en-US'", 100).Update("summary", "Changed source summary").Error)
			for _, row := range read() {
				require.True(t, row.Stale, row.Locale)
			}
			require.NoError(t, st.StampContentHash(ctx, ref, "ja-JP"))
			for _, row := range read() {
				require.Equal(t, row.Locale != "ja-JP", row.Stale, row.Locale)
			}
		})
	}
}
