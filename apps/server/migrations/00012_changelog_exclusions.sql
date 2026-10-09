-- +goose Up
-- Independent of raw Homebrew fields; catalog sync and source rebuilding must not overwrite administrator exclusions.
ALTER TABLE package_meta ADD COLUMN changelog_excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE package_meta DROP COLUMN changelog_excluded;
