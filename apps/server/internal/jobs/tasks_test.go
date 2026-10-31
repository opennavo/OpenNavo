package jobs

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestScheduledJobsReleaseUniquenessWithinAboutOnePeriod(t *testing.T) {
	for _, tc := range []struct {
		cron string
		want time.Duration
	}{
		{"*/5 * * * *", 20 * time.Minute},
		{"*/2 * * * *", 20 * time.Minute},
		{"20,50 * * * *", 29 * time.Minute},
		{"35 * * * *", 59 * time.Minute},
		{"10 */6 * * *", 6*time.Hour - time.Minute},
		{"0 3 * * *", 23 * time.Hour},
		{"", 24 * time.Hour},
	} {
		require.Equal(t, tc.want, uniqueTTL(Definition{Type: "fixture", Cron: tc.cron}), tc.cron)
	}
	for _, definition := range Definitions {
		ttl := uniqueTTL(definition)
		require.GreaterOrEqual(t, ttl, 20*time.Minute, definition.Type)
		if definition.Cron != "" {
			require.Less(t, ttl, 24*time.Hour, definition.Type)
		}
	}
	definition, err := DefinitionFor("github-release:snapshot")
	require.NoError(t, err)
	require.Equal(t, 20*time.Minute, uniqueTTL(definition), "the hourly lock must expire before the extra 23:59 tick")
}

func TestChangelogFetchLockLastsOneRun(t *testing.T) {
	for _, definition := range Definitions {
		if definition.Type != "changelog:fetch" {
			continue
		}
		require.Zero(t, definition.Retries, "next_fetch_at owns retries and backoff")
		require.Equal(t, 20*time.Minute, uniqueTTL(definition))
		return
	}
	t.Fatal("changelog:fetch is not defined")
}
