-- +goose Up
-- Reuse PostgreSQL for pending events so transient Redis failures cannot separate catalog commits from asynchronous jobs.
CREATE TABLE job_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unique_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE job_outbox;
