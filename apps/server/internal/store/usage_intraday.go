package store

import (
	"context"
	"time"

	"github.com/opennavo/opennavo/server/internal/domain"
)

type UsageHour struct {
	Hour              int    `json:"hour"`
	Web               *int64 `json:"web"`
	Desktop           *int64 `json:"desktop"`
	CumulativeWeb     *int64 `json:"cumulativeWeb"`
	CumulativeDesktop *int64 `json:"cumulativeDesktop"`
}

type UsageIntraday struct {
	Date     string      `json:"date"`
	TimeZone string      `json:"timeZone"`
	AsOf     time.Time   `json:"asOf"`
	Hours    []UsageHour `json:"hours"`
}

type usageHourCount struct {
	Hour         int
	Web, Desktop int64
}

// UsageIntraday uses exactly the daily rows counted by UsageOverview's active
// series. Each (day, platform, anonymous_id) contributes once, at its earliest
// observation; offline events may move it earlier, while later activity cannot.
// An empty date means today; future dates are rejected.
func (s *Store) UsageIntraday(ctx context.Context, now time.Time, date string) (UsageIntraday, error) {
	local := now.In(usageZone)
	today := local.Format(time.DateOnly)
	if date == "" {
		date = today
	}
	selected, err := time.ParseInLocation(time.DateOnly, date, usageZone)
	if err != nil || selected.After(local) {
		return UsageIntraday{}, domain.Rejected("parameter_invalid:date")
	}
	var counts []usageHourCount
	err = s.DB.WithContext(ctx).Raw(`SELECT EXTRACT(HOUR FROM first_active_at AT TIME ZONE 'Asia/Shanghai')::int AS "hour",
 count(*) FILTER(WHERE platform='web') web,count(*) FILTER(WHERE platform='desktop') desktop
 FROM usage_daily WHERE day=?::date GROUP BY 1 ORDER BY 1`, date).Scan(&counts).Error
	return usageIntraday(now, date, counts), err
}

func usageIntraday(now time.Time, date string, counts []usageHourCount) UsageIntraday {
	local := now.In(usageZone)
	result := UsageIntraday{Date: date, TimeZone: "Asia/Shanghai", AsOf: now.UTC(), Hours: make([]UsageHour, 24)}
	byHour := [24]usageHourCount{}
	for _, count := range counts {
		byHour[count.Hour] = count
	}
	// Only today has hours that have not happened yet; a past day is complete.
	last := 23
	if date == local.Format(time.DateOnly) {
		last = local.Hour()
	}
	var web, desktop int64
	for hour := range result.Hours {
		entry := UsageHour{Hour: hour}
		if hour <= last {
			count := byHour[hour]
			web += count.Web
			desktop += count.Desktop
			entry.Web, entry.Desktop = &count.Web, &count.Desktop
			// Each point owns its values; the running totals continue to change.
			entry.CumulativeWeb, entry.CumulativeDesktop = new(web), new(desktop)
		}
		result.Hours[hour] = entry
	}
	return result
}
