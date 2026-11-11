//go:build integration

package store_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/internal/testutil"
)

// A `new` submission becomes a real link package on publish: catalog row, i18n
// text, curated meta, location and Discover pick all land together.
func TestDeveloperPublishCreatesLinkPackageAndPick(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewSEOStore(t)

	payload := json.RawMessage(`{
		"name": "Hyperfocus Timer",
		"summary": "A tiny focus timer for macOS.",
		"description": "Focus sessions with a menu bar timer.",
		"developer": "Example Studio",
		"homepage": "https://example.com/hyperfocus",
		"repoUrl": "https://github.com/example/hyperfocus",
		"downloadUrl": "https://example.com/hyperfocus/download.dmg",
		"iconUrl": "https://example.com/icon.png",
		"countryCode": "US",
		"city": "Seattle",
		"cityKey": "seattle",
		"region": "americas",
		"lat": 47.6062,
		"lng": -122.3321,
		"remote": true
	}`)
	row, err := st.CreateDeveloperSubmission(ctx, store.DeveloperSubmissionInput{
		Kind:         "new",
		SourceKind:   "github",
		SourceURL:    "https://github.com/example/hyperfocus",
		Payload:      payload,
		ContactEmail: "dev@example.com",
	})
	require.NoError(t, err)
	require.NotZero(t, row.ID)
	require.Len(t, row.PublicToken, 32, "receipt token is a random 32-char hex string")

	found, err := st.DeveloperSubmissionByToken(ctx, row.PublicToken)
	require.NoError(t, err)
	require.Equal(t, row.ID, found.ID)

	parsed := store.ParseDeveloperPayload(row.Payload)
	parsed.SourceURL = row.SourceURL
	packageID, err := st.CreateLinkPackageFromPayload(ctx, parsed)
	require.NoError(t, err)

	pkg, err := st.PublicPackage(ctx, "link", "hyperfocus-timer", "en-US")
	require.NoError(t, err)
	require.Equal(t, "Hyperfocus Timer", pkg.Name)
	require.NotNil(t, pkg.I18n.Summary)
	require.Equal(t, "A tiny focus timer for macOS.", *pkg.I18n.Summary)
	require.NotNil(t, pkg.Meta.Developer)
	require.Equal(t, "Example Studio", *pkg.Meta.Developer)
	require.Equal(t, "https://example.com/icon.png", *pkg.IconURL)

	require.NoError(t, st.UpsertPackageLocation(ctx, packageID, "US", "Seattle", "seattle", "americas", 47.6062, -122.3321, true, "self", "approved", "self_reported", "", nil))
	require.NoError(t, st.SetDeveloperPick(ctx, packageID, &row.ID, "A calm timer that stays out of the way.", 1, true))

	picks, err := st.DeveloperPicks(ctx, 4)
	require.NoError(t, err)
	require.NotEmpty(t, picks)
	require.Equal(t, packageID, picks[0].PackageID)

	note := "Approved after a quick look."
	updated, err := st.UpdateDeveloperSubmission(ctx, row.ID, "published", &note, row.Payload, &packageID, nil)
	require.NoError(t, err)
	require.Equal(t, "published", updated.Status)
	require.Equal(t, packageID, *updated.PackageID)

	require.NoError(t, st.AppendDeveloperSubmissionEvent(ctx, row.ID, "published", &note, "admin"))
	events, err := st.DeveloperSubmissionEvents(ctx, row.ID)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, "published", events[0].Status)

}

// Claim updates land on the existing package and never touch Homebrew-owned versions.
func TestDeveloperPublishAppliesClaimToExistingPackage(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewSEOStore(t)

	require.NoError(t, st.DB.Exec(`INSERT INTO packages(id,kind,token,full_token,tap,name,names,desc_en,version,version_base,raw,raw_hash,source_locale)
VALUES(1201,'cask','ghostty','ghostty','homebrew/cask','Ghostty',ARRAY['Ghostty'],'old summary','1.2.0','1.2.0','{}','fixture','en-US')`).Error)

	payload := store.ParseDeveloperPayload(json.RawMessage(`{"summary":"Fast, native terminal for macOS.","developer":"Ghostty","version":"9.9.9"}`))
	require.NoError(t, st.ApplyDeveloperPayload(ctx, 1201, payload))

	pkg, err := st.PublicPackage(ctx, "cask", "ghostty", "en-US")
	require.NoError(t, err)
	require.NotNil(t, pkg.I18n.Summary)
	require.Equal(t, "Fast, native terminal for macOS.", *pkg.I18n.Summary)
	require.NotNil(t, pkg.Meta.Developer)
	require.Equal(t, "Ghostty", *pkg.Meta.Developer)
	require.Equal(t, "1.2.0", pkg.Version, "a cask keeps its Homebrew version")
}

// Rejected leads and old timeline rows age out; active submissions stay.
func TestDeveloperRetentionPrunesRejectedLeadsAndOldEvents(t *testing.T) {
	ctx := context.Background()
	st := testutil.NewSEOStore(t)

	rejected, err := st.CreateDeveloperSubmission(ctx, store.DeveloperSubmissionInput{
		Kind: "new", SourceURL: "https://example.com/rejected", ContactEmail: "rejected@example.com",
	})
	require.NoError(t, err)
	kept, err := st.CreateDeveloperSubmission(ctx, store.DeveloperSubmissionInput{
		Kind: "new", SourceURL: "https://example.com/kept", ContactEmail: "kept@example.com",
	})
	require.NoError(t, err)

	require.NoError(t, st.DB.Exec(`UPDATE developer_submissions SET status='rejected', updated_at=now()-interval '400 days' WHERE id=?`, rejected.ID).Error)
	require.NoError(t, st.DB.Exec(`UPDATE developer_submissions SET updated_at=now()-interval '400 days' WHERE id=?`, kept.ID).Error)
	require.NoError(t, st.AppendDeveloperSubmissionEvent(ctx, rejected.ID, "rejected", nil, "admin"))
	require.NoError(t, st.AppendDeveloperSubmissionEvent(ctx, kept.ID, "submitted", nil, "developer"))
	require.NoError(t, st.DB.Exec(`UPDATE developer_submission_events SET created_at=now()-interval '400 days'`).Error)

	before := time.Now().Add(-store.DeveloperRetention)
	removed, err := st.PruneDeveloperSubmissions(ctx, before)
	require.NoError(t, err)
	require.EqualValues(t, 1, removed)

	events, err := st.PruneDeveloperSubmissionEvents(ctx, before)
	require.NoError(t, err)
	require.EqualValues(t, 1, events)

	remaining, err := st.DeveloperSubmission(ctx, kept.ID)
	require.NoError(t, err)
	require.Equal(t, kept.ID, remaining.ID)
	gone, err := st.DeveloperSubmission(ctx, rejected.ID)
	require.NoError(t, err)
	require.Zero(t, gone.ID)
}
