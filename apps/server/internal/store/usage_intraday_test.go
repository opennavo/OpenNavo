package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestUsageIntradayBeijingBoundaries(t *testing.T) {
	for _, tc := range []struct {
		at   string
		date string
		hour int
	}{
		{"2026-10-28T15:59:59Z", "2026-10-28", 23},
		{"2026-10-28T16:00:00Z", "2026-10-29", 0},
		{"2026-10-28T16:59:59Z", "2026-10-29", 0},
		{"2026-10-28T17:00:00Z", "2026-10-29", 1},
	} {
		t.Run(tc.at, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, tc.at)
			require.NoError(t, err)
			report := usageIntraday(now, tc.date, []usageHourCount{{Hour: 0, Web: 2, Desktop: 3}})
			require.Equal(t, tc.date, report.Date)
			require.Equal(t, "Asia/Shanghai", report.TimeZone)
			require.Equal(t, now.UTC(), report.AsOf)
			require.Len(t, report.Hours, 24)
			for hour, entry := range report.Hours {
				require.Equal(t, hour, entry.Hour)
				if hour > tc.hour {
					require.Nil(t, entry.Web)
					require.Nil(t, entry.Desktop)
					require.Nil(t, entry.CumulativeWeb)
					require.Nil(t, entry.CumulativeDesktop)
					continue
				}
				require.EqualValues(t, 2, *entry.CumulativeWeb)
				require.EqualValues(t, 3, *entry.CumulativeDesktop)
				if hour > 0 {
					require.Zero(t, *entry.Web)
					require.Zero(t, *entry.Desktop)
				}
			}
		})
	}
}

func TestUsageIntradayPastDateIncludesEveryHour(t *testing.T) {
	now, err := time.Parse(time.RFC3339, "2026-10-29T03:00:00Z") // Oct 29 11:00 Beijing.
	require.NoError(t, err)
	report := usageIntraday(now, "2026-10-28", []usageHourCount{{Hour: 9, Web: 2, Desktop: 3}})
	require.Equal(t, "2026-10-28", report.Date)
	for hour, entry := range report.Hours {
		require.NotNil(t, entry.Web, "hour %d", hour)
		require.NotNil(t, entry.Desktop, "hour %d", hour)
		require.NotNil(t, entry.CumulativeWeb, "hour %d", hour)
		require.NotNil(t, entry.CumulativeDesktop, "hour %d", hour)
	}
	require.Zero(t, *report.Hours[8].CumulativeWeb)
	require.EqualValues(t, 2, *report.Hours[9].CumulativeWeb)
	require.EqualValues(t, 3, *report.Hours[9].CumulativeDesktop)
	require.EqualValues(t, 2, *report.Hours[23].CumulativeWeb)
	require.EqualValues(t, 3, *report.Hours[23].CumulativeDesktop)
}
