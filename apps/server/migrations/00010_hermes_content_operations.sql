-- +goose Up
-- Reuse existing glossary and translation settings without rebuilding or discarding data.
ALTER TABLE i18n_glossary ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE i18n_glossary ADD COLUMN created_by BIGINT REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE i18n_glossary ADD COLUMN updated_by BIGINT REFERENCES admin_users(id) ON DELETE SET NULL;
CREATE INDEX i18n_glossary_updated ON i18n_glossary(updated_at DESC,id DESC);
ALTER TABLE i18n_settings DROP COLUMN upstream_fallback;
-- Populate event columns only during new catalog syncs; never represent old history or content edits as new versions.
ALTER TABLE catalog_changes ADD COLUMN event_type TEXT CHECK(event_type IN ('created','updated','removed','renamed'));
ALTER TABLE catalog_changes ADD COLUMN version TEXT;
ALTER TABLE catalog_changes ADD COLUMN previous_version TEXT;
ALTER TABLE catalog_changes ADD COLUMN previous_token TEXT;
CREATE INDEX catalog_changes_operations ON catalog_changes(created_at DESC,seq DESC) WHERE event_type IS NOT NULL;
-- Do not forcibly delete or merge old editorial data; B3 maintains per-package/version uniqueness under the package lock.
CREATE INDEX releases_editorial_lookup ON releases(package_id,version) WHERE source='editorial' AND NOT hidden;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Hermes content metadata migration cannot be downgraded safely'; END $$;
-- +goose StatementEnd
