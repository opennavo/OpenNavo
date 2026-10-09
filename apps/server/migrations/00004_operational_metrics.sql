-- +goose Up
-- Aggregate counters survive 90-day run-log cleanup so Prometheus counters never decrease.
CREATE TABLE job_metrics (
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  runs BIGINT NOT NULL DEFAULT 0 CHECK (runs >= 0),
  last_finished_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_type,status,source)
);
INSERT INTO job_metrics(job_type,status,source,runs,last_finished_at)
SELECT job_type,status,CASE WHEN job_type='changelog:fetch' THEN COALESCE(stats->>'source','unknown') ELSE '' END,count(*),max(finished_at)
FROM sync_runs WHERE finished_at IS NOT NULL AND status<>'running' GROUP BY 1,2,3;
ALTER TABLE llm_usage ADD COLUMN result TEXT NOT NULL DEFAULT 'succeeded' CHECK (result IN ('succeeded','failed'));
UPDATE llm_usage SET result=CASE WHEN finish_reason='stop' THEN 'succeeded' ELSE 'failed' END;

-- +goose Down
ALTER TABLE llm_usage DROP COLUMN result;
DROP TABLE job_metrics;
