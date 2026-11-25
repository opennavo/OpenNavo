-- +goose Up
-- Bing's 2026-11-24 report also lists this app's versions page as important. Its overview answers
-- index, follow but stays below the 50-installs sitemap threshold, so the versions pilot never sees
-- a sitemap record for it. The override only affects sitemap eligibility; editor decisions win.
-- +goose StatementBegin
WITH bing (token) AS (VALUES ('pdf-expert@beta'))
INSERT INTO package_meta (package_id, index_override, index_override_reason, index_override_at)
SELECT p.id,
       'index',
       'Bing Webmaster SEO report 2026-11-24: important versions page missing from sitemap',
       now()
FROM packages p
JOIN bing b ON b.token = p.token
WHERE p.removed_at IS NULL
ON CONFLICT (package_id) DO UPDATE
SET index_override = EXCLUDED.index_override,
    index_override_reason = EXCLUDED.index_override_reason,
    index_override_at = EXCLUDED.index_override_at
WHERE package_meta.index_override = 'auto';
-- +goose StatementEnd

-- The sitemap snapshot cache is keyed by the settings revision; bump it so the new override is
-- visible before the next deploy or cache expiry.
UPDATE seo_settings SET revision = revision + 1, updated_at = now() WHERE id = true;

-- +goose Down
-- +goose StatementBegin
UPDATE package_meta m
SET index_override = 'auto', index_override_reason = NULL, index_override_at = NULL
FROM packages p
WHERE m.package_id = p.id
  AND p.token = 'pdf-expert@beta'
  AND m.index_override = 'index'
  AND m.index_override_reason = 'Bing Webmaster SEO report 2026-11-24: important versions page missing from sitemap';
-- +goose StatementEnd

UPDATE seo_settings SET revision = revision + 1, updated_at = now() WHERE id = true;
