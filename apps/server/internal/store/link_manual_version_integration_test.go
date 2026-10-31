//go:build integration

package store_test

import (
	"context"
	"testing"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// A link without a release source takes a hand-set version, recorded like a synced one; a sourced
// link ignores it because sync owns the version.
func TestLinkManualVersion(t *testing.T) {
	st := testutil.NewSEOStore(t)
	ctx := context.Background()
	homepage := "https://example.com/board"
	text := func(v string) *string { return &v }
	write := func(id int64, in domain.LinkInput) int64 {
		t.Helper()
		require.NoError(t, st.DB.Transaction(func(tx *gorm.DB) error {
			var err error
			id, err = (&store.Store{DB: tx}).WriteLinkApp(ctx, id, in)
			return err
		}))
		return id
	}
	type event struct{ EventType, Version, Before *string }
	events := func(id int64) []event {
		t.Helper()
		var rows []event
		require.NoError(t, st.DB.Raw("SELECT event_type,version,previous_version AS before FROM catalog_changes WHERE package_id=? AND reason='link' ORDER BY seq", id).Scan(&rows).Error)
		return rows
	}
	versions := func(id int64) []string {
		t.Helper()
		var rows []string
		require.NoError(t, st.DB.Raw("SELECT version FROM package_versions WHERE package_id=? ORDER BY version", id).Scan(&rows).Error)
		return rows
	}

	input := domain.LinkInput{Token: "manual-board", Name: "Manual Board", Homepage: &homepage, SourceLocale: "en-US"}
	id := write(0, input)
	input.Version = text("1.0.6")
	write(id, input)
	input.Version = text("1.0.7")
	write(id, input)
	input.Version = text("1.0.7")
	write(id, input)
	row, err := st.LinkApp(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "1.0.7", *row.Version)
	require.Equal(t, []string{"1.0.6", "1.0.7"}, versions(id))
	require.Equal(t, []event{
		{EventType: text("created")},
		{EventType: text("updated"), Version: text("1.0.6")},
		{EventType: text("updated"), Version: text("1.0.7"), Before: text("1.0.6")},
		{Version: text("1.0.7")},
	}, events(id))

	repo := "owner/board"
	input.GithubRepo, input.Version = &repo, text("2.0")
	write(id, input)
	row, err = st.LinkApp(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "1.0.7", *row.Version, "a sourced link keeps the synced version")
}
