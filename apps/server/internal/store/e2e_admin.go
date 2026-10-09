package store

import (
	"context"
	"time"

	"gorm.io/gorm"
)

func e2eAdminContent(ctx context.Context, tx *gorm.DB, day time.Time, ids map[string]int64, anchor time.Time) error {
	if day.IsZero() {
		day = anchor
	}
	queries := []struct {
		query, token string
		days, count  int
	}{
		{"vscode", "visual-studio-code", 1, 3}, {"vscode", "", 2, 3},
		{"微信", "wechat", 1, 1}, {"rg", "ripgrep", 2, 1},
		{"e2e-no-result", "", 1, 0}, {"e2e-no-result", "", 3, 0},
		{"e2e-monthly-zero", "", 9, 0}, {"e2e-quarter-zero", "", 40, 0},
	}
	for i, q := range queries {
		var clicked, position any
		if q.token != "" {
			clicked, position = ids[q.token], 1
		}
		// Negative IDs are reserved for fixed statistics fixtures and do not consume real query sequences; repeated seeds preserve IDs.
		if _, err := e2eUpsert(ctx, tx, "search_queries", []string{"id"}, map[string]any{"id": -int64(i + 1), "query": q.query, "normalized": q.query, "locale": "zh-CN", "platform": "web", "result_count": q.count, "clicked_package_id": clicked, "clicked_position": position, "created_at": day.AddDate(0, 0, -q.days)}); err != nil {
			return err
		}
	}
	return nil
}
