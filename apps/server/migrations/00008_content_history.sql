-- +goose Up
-- Revisions have no foreign keys to business objects and remain reviewable after deletion; independent trash retention must not be truncated to the latest 50 revisions.
ALTER TABLE audit_logs ADD COLUMN request_id TEXT;
CREATE INDEX audit_logs_request ON audit_logs(request_id) WHERE request_id IS NOT NULL;
-- Request manifests survive per-object 50-revision truncation; undo must verify that every revision for the call remains available.
CREATE TABLE content_revision_requests (
 request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
 revision_count INTEGER NOT NULL DEFAULT 0 CHECK(revision_count>=0),
 reversible BOOLEAN NOT NULL DEFAULT true,
 actor_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE content_revisions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entity TEXT NOT NULL CHECK(entity IN ('package','release','category','collection','feature','screenshot','collection_item','desktop_release','mirror','announcement','synonym','glossary','feedback','asset')),
 object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 200),
 version BIGINT NOT NULL CHECK(version>0),
 locale TEXT CHECK(locale IN ('en-US','zh-CN','ja-JP','es-ES','pt-BR','ru-RU')),
 action TEXT NOT NULL CHECK(action IN ('create','update','delete','restore','translate')),
 operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
 required_permissions TEXT[] NOT NULL CHECK(cardinality(required_permissions)>0),
 asset_ids BIGINT[] NOT NULL DEFAULT '{}',
 actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','agent','system')),
 actor_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 actor_name TEXT NOT NULL DEFAULT '',
 request_id TEXT NOT NULL REFERENCES content_revision_requests(request_id) ON DELETE RESTRICT,
 before_data JSONB,
 after_data JSONB,
 before_hash TEXT CHECK(before_hash ~ '^[0-9a-f]{64}$'),
 after_hash TEXT CHECK(after_hash ~ '^[0-9a-f]{64}$'),
 affected_urls JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(affected_urls)='array'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(entity,object_key,version),
 CHECK(before_data IS NOT NULL OR after_data IS NOT NULL)
);
CREATE INDEX content_revisions_assets ON content_revisions USING GIN(asset_ids);
CREATE INDEX content_revisions_request ON content_revisions(request_id,id DESC);
CREATE INDEX content_revisions_created ON content_revisions(created_at DESC,id DESC);
CREATE TABLE content_trash (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entity TEXT NOT NULL CHECK(entity IN ('category','collection','feature','synonym','glossary','screenshot')),
 object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 200),
 label TEXT NOT NULL DEFAULT '',
 snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 snapshot_hash TEXT NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
 asset_ids BIGINT[] NOT NULL DEFAULT '{}',
 actor_type TEXT NOT NULL CHECK(actor_type IN ('admin','agent','system')),
 actor_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 actor_name TEXT NOT NULL DEFAULT '',
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 affected_urls JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(affected_urls)='array'),
 deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 days',
 restored_at TIMESTAMPTZ,
 restored_by_request_id TEXT,
 CHECK(expires_at>deleted_at),
 CHECK((restored_at IS NULL)=(restored_by_request_id IS NULL))
);
CREATE UNIQUE INDEX content_trash_live_object ON content_trash(entity,object_key) WHERE restored_at IS NULL;
CREATE INDEX content_trash_expiry ON content_trash(expires_at);
CREATE INDEX content_trash_request ON content_trash(request_id);
CREATE INDEX content_trash_assets ON content_trash USING GIN(asset_ids);
-- Whole-request undo idempotency markers are independent of log retention; the business layer validates the full revision chain and writes in the same transaction.
CREATE TABLE content_request_reverts (
 request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
 reverted_by_request_id TEXT NOT NULL UNIQUE CHECK(length(reverted_by_request_id) BETWEEN 1 AND 128),
 actor_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(request_id<>reverted_by_request_id)
);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Content history cannot be downgraded without losing recoverable data'; END $$;
-- +goose StatementEnd
