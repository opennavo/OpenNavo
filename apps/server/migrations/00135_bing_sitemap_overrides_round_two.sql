-- +goose Up
-- The Bing Webmaster SEO report of 2026-11-24 lists more important pages whose localized overview
-- is missing from the sitemaps. They already answer index, follow; the index override only makes
-- SitemapAppAllowed list every published language, without changing robots or canonical decisions.
-- Editors' explicit index or noindex decisions are preserved: only rows still on 'auto' change.
-- +goose StatementBegin
WITH bing (token) AS (VALUES
 ('quarkclouddrive'), ('captainplugins'), ('ev3-classroom'), ('freellmapi'), ('orbit'),
 ('firefox@esr'), ('paranoia-file-text-encryption'), ('loop'), ('trezor-bridge-app'),
 ('longbridge-pro'), ('resolume-arena'), ('removebg'), ('zen@twilight')
)
INSERT INTO package_meta (package_id, index_override, index_override_reason, index_override_at)
SELECT p.id,
       'index',
       'Bing Webmaster SEO report 2026-11-24: important page missing from sitemap',
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

-- The sitemap snapshot cache is keyed by the settings revision; bump it so the new overrides are
-- visible before the next deploy or cache expiry.
UPDATE seo_settings SET revision = revision + 1, updated_at = now() WHERE id = true;

-- +goose Down
-- +goose StatementBegin
WITH bing (token) AS (VALUES
 ('quarkclouddrive'), ('captainplugins'), ('ev3-classroom'), ('freellmapi'), ('orbit'),
 ('firefox@esr'), ('paranoia-file-text-encryption'), ('loop'), ('trezor-bridge-app'),
 ('longbridge-pro'), ('resolume-arena'), ('removebg'), ('zen@twilight')
)
UPDATE package_meta m
SET index_override = 'auto', index_override_reason = NULL, index_override_at = NULL
FROM packages p
JOIN bing b ON b.token = p.token
WHERE m.package_id = p.id
  AND m.index_override = 'index'
  AND m.index_override_reason = 'Bing Webmaster SEO report 2026-11-24: important page missing from sitemap';
-- +goose StatementEnd

UPDATE seo_settings SET revision = revision + 1, updated_at = now() WHERE id = true;
