-- +goose Up
-- Prose is indexed separately to preserve name/pinyin ranking and autocomplete.
ALTER TABLE packages ADD COLUMN search_content TEXT NOT NULL DEFAULT '';
UPDATE packages p SET search_content=lower(normalize(coalesce((
  SELECT string_agg(concat_ws(' ',t.summary,t.description),' ' ORDER BY t.locale)
  FROM package_i18n t WHERE t.package_id=p.id
),''),NFKC));
CREATE INDEX packages_search_content_trgm ON packages USING gin (search_content gin_trgm_ops);

-- +goose Down
ALTER TABLE packages DROP COLUMN search_content;
