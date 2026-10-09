package catalog

import (
	"math"
	"testing"

	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/stretchr/testify/require"
)

func TestAnalyticsOptionsAndOfficialTapAggregation(t *testing.T) {
	counts, err := Aggregate([]homebrew.AnalyticsItem{{Formula: "ripgrep", Count: "1,000"}, {Formula: "ripgrep --HEAD", Count: "200"}, {Formula: "homebrew/core/ripgrep", Count: "30"}, {Formula: "microsoft/git/microsoft-git", Count: "999"}, {Formula: "", Count: "bad"}}, "formula")
	require.NoError(t, err)
	require.Equal(t, map[string]int64{"ripgrep": 1230}, counts)
	counts, err = Aggregate([]homebrew.AnalyticsItem{{Cask: "homebrew/cask/visual-studio-code", Count: "42"}}, "cask")
	require.NoError(t, err)
	require.Equal(t, int64(42), counts["visual-studio-code"])
	_, err = Aggregate([]homebrew.AnalyticsItem{{Formula: "ripgrep", Count: "bad"}}, "formula")
	require.Error(t, err)
	require.InDelta(t, 0.7*math.Log(101)+0.3*math.Log(101), Popularity(100, 1200), 1e-10)
	require.Zero(t, Popularity(0, 0))
}
