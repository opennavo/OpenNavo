-- +goose Up
-- One-time announcements that no catalog change triggers: a row means the named backfill ran.
CREATE TABLE indexnow_backfill (
    name         TEXT PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL
);

-- +goose Down
DROP TABLE indexnow_backfill;
