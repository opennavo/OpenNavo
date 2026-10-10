-- +goose Up
-- Local catalog policy is independent of Homebrew's disabled flag.
ALTER TABLE packages ADD COLUMN stale_disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE packages DROP COLUMN stale_disabled;
