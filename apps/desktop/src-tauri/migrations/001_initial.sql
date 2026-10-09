CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version, catalog_cursor, catalog_synced_at, snapshot_sha256

CREATE TABLE catalog_items (
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  data TEXT NOT NULL,                 -- CatalogItem JSON
  name TEXT NOT NULL,
  display_name_zh TEXT,
  summary_zh TEXT,
  summary_en TEXT,
  version TEXT NOT NULL,
  primary_category TEXT,
  popularity REAL NOT NULL DEFAULT 0,
  installs_30d INTEGER NOT NULL DEFAULT 0,
  installs_90d INTEGER,               -- The following statistics come from snapshot installs90d / installs365d / onRequest / downloadSize;
  installs_365d INTEGER,              -- missing fields in older snapshots remain NULL (unknown), sorted last in offline rankings.
  on_request_30d INTEGER,
  on_request_90d INTEGER,
  on_request_365d INTEGER,
  download_size INTEGER,              -- Bytes
  rank_30d INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  is_font INTEGER NOT NULL DEFAULT 0,
  is_library INTEGER NOT NULL DEFAULT 0,
  version_changed_at INTEGER NOT NULL,
  PRIMARY KEY (kind, token)
);
CREATE INDEX catalog_items_pop ON catalog_items (kind, popularity DESC);
CREATE INDEX catalog_items_installs ON catalog_items (kind, installs_30d DESC, installs_90d DESC, installs_365d DESC);
CREATE INDEX catalog_items_changed ON catalog_items (version_changed_at DESC);

CREATE VIRTUAL TABLE catalog_fts USING fts5(
  kind UNINDEXED, token, names, display_name, summary, pinyin,
  tokenize = 'trigram'
);

CREATE TABLE categories (slug TEXT PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  kind TEXT,
  token TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  trigger TEXT NOT NULL,
  state TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  error_code TEXT,
  error_message TEXT,
  exit_code INTEGER,
  log_path TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX tasks_state ON tasks (state, created_at);
CREATE INDEX tasks_finished ON tasks (finished_at DESC);
CREATE INDEX tasks_target ON tasks (kind, token, finished_at DESC);

CREATE TABLE ignored_updates (
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  version TEXT,                       -- NULL = ignore all versions
  until INTEGER,                      -- NULL = forever
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, token)
);

CREATE TABLE size_cache (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE icon_cache (app_path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, png_path TEXT NOT NULL);
CREATE TABLE search_history (q TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1);
