-- Migrate only the client SQLite database, not the server development database; leave task and history tables unchanged.
CREATE TABLE catalog_texts (kind TEXT NOT NULL, token TEXT NOT NULL, locale TEXT NOT NULL, display_name TEXT, summary TEXT, PRIMARY KEY(kind,token,locale), FOREIGN KEY(kind,token) REFERENCES catalog_items(kind,token) ON DELETE CASCADE);
INSERT INTO catalog_texts SELECT p.kind,p.token,j.key,json_extract(p.data,'$.displayName.' || '"' || j.key || '"'),json_extract(p.data,'$.summary.' || '"' || j.key || '"') FROM catalog_items p,json_each(p.data,'$.displayName') j WHERE j.value IS NOT NULL;
INSERT INTO catalog_texts SELECT p.kind,p.token,j.key,NULL,j.value FROM catalog_items p,json_each(p.data,'$.summary') j WHERE j.value IS NOT NULL ON CONFLICT(kind,token,locale) DO UPDATE SET summary=excluded.summary;
CREATE TABLE category_texts (slug TEXT NOT NULL, locale TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(slug,locale), FOREIGN KEY(slug) REFERENCES categories(slug) ON DELETE CASCADE);
INSERT INTO category_texts SELECT c.slug,j.key,j.value FROM categories c,json_each(c.data,'$.name') j WHERE j.value IS NOT NULL;
ALTER TABLE catalog_items DROP COLUMN display_name_zh;
ALTER TABLE catalog_items DROP COLUMN summary_zh;
ALTER TABLE catalog_items DROP COLUMN summary_en;
ALTER TABLE catalog_items ADD COLUMN text_cursor INTEGER NOT NULL DEFAULT 0;
-- Existing JSON containing a third language must remain searchable offline after migration.
DELETE FROM catalog_fts;
INSERT INTO catalog_fts(rowid,kind,token,names,display_name,summary,pinyin)
SELECT p.rowid,p.kind,p.token,COALESCE((SELECT group_concat(value,' ') FROM json_each(p.data,'$.names')),'') || ' ' || COALESCE((SELECT group_concat(value,' ') FROM json_each(p.data,'$.binaries')),''),COALESCE((SELECT group_concat(display_name,' ') FROM catalog_texts t WHERE t.kind=p.kind AND t.token=p.token),''),COALESCE((SELECT group_concat(summary,' ') FROM catalog_texts t WHERE t.kind=p.kind AND t.token=p.token),''),json_extract(p.data,'$.pinyin') FROM catalog_items p;
