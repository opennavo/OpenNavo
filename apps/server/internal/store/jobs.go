package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

func (s *Store) StartJobRun(ctx context.Context, jobType, trigger string, triggeredBy *int64) (int64, error) {
	var id int64
	if err := s.DB.WithContext(ctx).Raw("INSERT INTO sync_runs (job_type,trigger,triggered_by,status) VALUES (?,?,?,'running') RETURNING id", jobType, trigger, triggeredBy).Scan(&id).Error; err != nil {
		return 0, fmt.Errorf("start job run: %w", err)
	}
	return id, nil
}
func (s *Store) FinishJobRun(ctx context.Context, id int64, status string, stats map[string]any, errorMessage *string) error {
	encoded, err := json.Marshal(stats)
	if err != nil {
		return fmt.Errorf("encode job stats: %w", err)
	}
	if err := s.WithTx(ctx, func(tx *gorm.DB) error {
		var row struct{ JobType string }
		if err := tx.WithContext(ctx).Raw("UPDATE sync_runs SET status=?,stats=?::jsonb,error=?,finished_at=? WHERE id=? AND status='running' RETURNING job_type", status, string(encoded), errorMessage, time.Now().UTC(), id).Scan(&row).Error; err != nil {
			return err
		}
		if row.JobType == "" {
			return nil
		}
		source := ""
		if row.JobType == "changelog:fetch" {
			source, _ = stats["source"].(string)
			if source == "" {
				source = "unknown"
			}
		}
		return tx.WithContext(ctx).Exec(`INSERT INTO job_metrics(job_type,status,source,runs,last_finished_at) VALUES(?,?,?,1,now()) ON CONFLICT(job_type,status,source) DO UPDATE SET runs=job_metrics.runs+1,last_finished_at=EXCLUDED.last_finished_at`, row.JobType, status, source).Error
	}); err != nil {
		return fmt.Errorf("finish job run: %w", err)
	}
	return nil
}
