//go:build integration

package catalog

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/testutil"
	"github.com/stretchr/testify/require"
)

type testAnalyticsSource struct {
	Fail  bool
	Calls []string
}

func (s *testAnalyticsSource) FetchAnalytics(_ context.Context, category, period string) (homebrew.Analytics, error) {
	s.Calls = append(s.Calls, category)
	if s.Fail {
		return homebrew.Analytics{}, errors.New("upstream failed")
	}
	switch category {
	case "cask":
		return homebrew.Analytics{Items: []homebrew.AnalyticsItem{{Cask: "app", Count: "100"}, {Cask: "font-test", Count: "9,000"}, {Cask: "disabled", Count: "800"}}}, nil
	case "install":
		return homebrew.Analytics{Items: []homebrew.AnalyticsItem{{Formula: "library", Count: "1,000"}, {Formula: "library --HEAD", Count: "200"}, {Formula: "tool", Count: "50"}}}, nil
	default:
		return homebrew.Analytics{Items: []homebrew.AnalyticsItem{{Formula: "library", Count: "100"}, {Formula: "tool", Count: "10"}}}, nil
	}
}

func TestAnalyticsRanksLibraryClassificationDailySnapshotAndAtomicFailure(t *testing.T) {
	st := testutil.NewStore(t)
	ctx := context.Background()
	source := &testSource{Data: map[string][]string{"cask": {`{"token":"app","version":"1"}`, `{"token":"font-test","version":"1"}`, `{"token":"disabled","version":"1","disabled":true}`}, "formula": {`{"name":"library","versions":{"stable":"1"}}`, `{"name":"tool","versions":{"stable":"1"}}`}}, Previous: map[string]homebrew.Conditional{}}
	queue := &testQueue{}
	_, err := (&Service{Store: st, Source: source, Queue: queue}).Run(ctx)
	require.NoError(t, err)
	// Retain historical Formula rows, but installation analytics jobs must neither recalculate nor sync them.
	require.NoError(t, st.DB.Exec(`INSERT INTO packages(kind,token,name,version,is_library,installs_30d,installs_90d,installs_365d,full_token,tap,version_base,raw,raw_hash) VALUES ('formula','library','Library','1',true,1200,1200,1200,'library','homebrew/core','1','{}','legacy'),('formula','tool','Tool','1',false,50,50,50,'tool','homebrew/core','1','{}','legacy')`).Error)
	var before int64
	require.NoError(t, st.DB.WithContext(ctx).Table("catalog_changes").Count(&before).Error)
	location, err := time.LoadLocation("Asia/Shanghai")
	require.NoError(t, err)
	analytics := &testAnalyticsSource{}
	service := &AnalyticsService{Store: st, Source: analytics, Queue: queue, Location: location, Now: func() time.Time { return time.Date(2026, 10, 4, 17, 0, 0, 0, time.UTC) }}
	stats, err := RunAnalyticsOnce(ctx, service)
	require.NoError(t, err)
	require.Equal(t, 3, stats["packages"])
	require.Equal(t, []string{"cask", "cask", "cask"}, analytics.Calls)
	require.Equal(t, 0, stats["libraries"])
	require.Equal(t, "2026-10-05", stats["snapshotDate"])
	var rows []struct {
		Token        string
		Rank30d      *int  `gorm:"column:rank_30d"`
		Installs30d  int64 `gorm:"column:installs_30d"`
		Installs90d  int64 `gorm:"column:installs_90d"`
		Installs365d int64 `gorm:"column:installs_365d"`
		OnRequest30d int64 `gorm:"column:on_request_30d"`
		Popularity   float64
		IsLibrary    bool
	}
	require.NoError(t, st.DB.WithContext(ctx).Raw("SELECT token,rank_30d,installs_30d,installs_90d,installs_365d,on_request_30d,popularity,is_library FROM packages").Scan(&rows).Error)
	for _, row := range rows {
		switch row.Token {
		case "app":
			require.NotNil(t, row.Rank30d)
			require.Equal(t, 1, *row.Rank30d)
			require.Equal(t, int64(100), row.Installs30d)
		case "font-test", "disabled":
			require.Nil(t, row.Rank30d)
		case "library":
			require.True(t, row.IsLibrary)
			require.Equal(t, int64(1200), row.Installs30d)
			require.Equal(t, int64(1200), row.Installs90d)
			require.Equal(t, int64(1200), row.Installs365d)
			require.Zero(t, row.Popularity)
		case "tool":
			require.False(t, row.IsLibrary)
		}
	}
	var snapshotCount int64
	require.NoError(t, st.DB.WithContext(ctx).Table("analytics_snapshots").Count(&snapshotCount).Error)
	require.Equal(t, int64(3), snapshotCount)
	_, err = service.Run(ctx)
	require.NoError(t, err)
	require.NoError(t, st.DB.WithContext(ctx).Table("analytics_snapshots").Count(&snapshotCount).Error)
	require.Equal(t, int64(3), snapshotCount)
	var after int64
	require.NoError(t, st.DB.WithContext(ctx).Table("catalog_changes").Count(&after).Error)
	require.Equal(t, before, after)
	require.Contains(t, queue.Events, fmt.Sprintf("snapshot:build:%d:%d", 0, 0))
	analytics.Fail = true
	_, err = service.Run(ctx)
	require.Error(t, err)
	var count int64
	require.NoError(t, st.DB.WithContext(ctx).Raw("SELECT installs_30d FROM packages WHERE token='library'").Scan(&count).Error)
	require.Equal(t, int64(1200), count)
}
