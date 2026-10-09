-- +goose Up
-- Change defaults only: existing source languages and translated content remain intact.
ALTER TABLE categories ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE collections ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE features ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE package_screenshots ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE collection_items ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE desktop_releases ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE mirrors ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE category_i18n ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE collection_i18n ALTER COLUMN source_locale SET DEFAULT 'en-US';
ALTER TABLE feature_i18n ALTER COLUMN source_locale SET DEFAULT 'en-US';

-- Preserve the historical Chinese source convention, including accepted null/empty values,
-- before changing fallbacks for newly authored content.
UPDATE app_config SET value = value || '{"sourceLocale":"zh-CN"}'::jsonb
WHERE key IN ('site.about', 'desktop.announcement')
  AND jsonb_typeof(value) = 'object'
  AND COALESCE(value->>'sourceLocale', '') = '';

-- +goose Down
ALTER TABLE categories ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE collections ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE features ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE package_screenshots ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE collection_items ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE desktop_releases ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE mirrors ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE category_i18n ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE collection_i18n ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
ALTER TABLE feature_i18n ALTER COLUMN source_locale SET DEFAULT 'zh-CN';
-- Keep explicit source metadata: removing it could relabel content authored after migration.
