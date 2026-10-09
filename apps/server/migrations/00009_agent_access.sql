-- +goose Up
-- Remove only old source permissions and associations; preserve sources, versions and historical notes.
DELETE FROM admin_role_permissions WHERE permission_code IN ('changelog:source:edit','changelog:fetch');
DELETE FROM admin_permissions WHERE code IN ('changelog:source:edit','changelog:fetch');
INSERT INTO admin_permissions(code,name,group_name) VALUES
('dashboard:view','View dashboard','dashboard'),
('catalog:package:view','View packages','catalog'),
('catalog:package:edit','Edit package details, categories, visibility and recommendations','catalog'),
('catalog:package:resync','Resynchronize','catalog'),
('catalog:asset:upload','Upload icons and screenshots','catalog'),
('catalog:category:edit','Edit categories','catalog'),
('content:collection:edit','Edit collections','content'),
('content:collection:publish','Publish/unpublish collections','content'),
('content:feature:edit','Edit featured placements','content'),
('changelog:release:edit','Hide releases and edit source text','changelog'),
('translation:review','Edit and review translations','translation'),
('ops:job:view','View jobs','ops'),
('ops:job:trigger','Trigger jobs manually','ops'),
('ops:search:view','Search insights','ops'),
('ops:search:edit','Manage synonyms','ops'),
('ops:feedback:handle','Handle feedback','ops'),
('release:desktop:edit','Edit client releases','release'),
('release:desktop:publish','Publish/roll back clients','release'),
('system:config:edit','Remote configuration and mirrors','system'),
('system:user:edit','Manage administrators','system'),
('system:role:edit','Roles and permissions','system'),
('system:audit:view','Audit logs','system'),
('i18n:settings','Translation AI settings','i18n'),
('content:glossary:edit','Manage glossary','content'),
('agent:log:view','Agent and AI logs','agent'),
('content:revision:restore','Content revisions and restoration','content'),
('agent:manage','Agent access management','agent'),
('content:announcement:edit','Client announcements','content'),
('release:desktop:notes','Client release notes','release')
ON CONFLICT(code) DO NOTHING;
INSERT INTO admin_roles(role_code,role_name,role_desc,builtin) VALUES('R_AGENT','Agent','Internal machine account; cannot log in to the admin console',true) ON CONFLICT(role_code) DO UPDATE SET builtin=true;
DELETE FROM admin_role_permissions WHERE role_id=(SELECT id FROM admin_roles WHERE role_code='R_AGENT');
INSERT INTO admin_role_permissions(role_id,permission_code) SELECT r.id,p FROM admin_roles r CROSS JOIN unnest(ARRAY['dashboard:view','catalog:package:view','catalog:package:edit','catalog:package:resync','catalog:asset:upload','catalog:category:edit','content:collection:edit','content:collection:publish','content:feature:edit','content:glossary:edit','changelog:release:edit','translation:review','ops:job:view','ops:job:trigger','ops:search:view','ops:search:edit','ops:feedback:handle','agent:log:view','content:revision:restore','content:announcement:edit','release:desktop:notes']::text[]) AS p WHERE r.role_code='R_AGENT';
ALTER TABLE admin_users ADD COLUMN is_machine BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE agent_clients (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
 enabled BOOLEAN NOT NULL DEFAULT true,
 created_by BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE agent_settings (
 id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
 enabled BOOLEAN NOT NULL DEFAULT true,
 calls_per_minute INTEGER NOT NULL DEFAULT 120 CHECK(calls_per_minute BETWEEN 1 AND 10000),
 writes_per_day INTEGER NOT NULL DEFAULT 3000 CHECK(writes_per_day BETWEEN 1 AND 1000000),
 llm_ops_per_day INTEGER NOT NULL DEFAULT 1000 CHECK(llm_ops_per_day BETWEEN 1 AND 1000000),
 batch_limit INTEGER NOT NULL DEFAULT 100 CHECK(batch_limit BETWEEN 1 AND 100),
 policy_version BIGINT NOT NULL DEFAULT 1 CHECK(policy_version>0),
 updated_by BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO agent_settings(id) VALUES(true);
CREATE TABLE agent_tokens (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 client_id BIGINT NOT NULL REFERENCES agent_clients(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 token_prefix TEXT NOT NULL CHECK(length(token_prefix)=8 AND left(token_prefix,4)='onv_'),
 permissions TEXT[] NOT NULL DEFAULT ARRAY['dashboard:view','catalog:package:view','catalog:package:edit','catalog:package:resync','catalog:asset:upload','catalog:category:edit','content:collection:edit','content:collection:publish','content:feature:edit','content:glossary:edit','changelog:release:edit','translation:review','ops:job:view','ops:job:trigger','ops:search:view','ops:search:edit','ops:feedback:handle','agent:log:view','content:revision:restore','content:announcement:edit','release:desktop:notes']::text[] CHECK(permissions <@ ARRAY['dashboard:view','catalog:package:view','catalog:package:edit','catalog:package:resync','catalog:asset:upload','catalog:category:edit','content:collection:edit','content:collection:publish','content:feature:edit','content:glossary:edit','changelog:release:edit','translation:review','ops:job:view','ops:job:trigger','ops:search:view','ops:search:edit','ops:feedback:handle','agent:log:view','content:revision:restore','content:announcement:edit','release:desktop:notes']::text[] AND cardinality(permissions)<=21),
 allow_delete BOOLEAN NOT NULL DEFAULT true,
 ip_allowlist CIDR[] NOT NULL DEFAULT '{}' CHECK(cardinality(ip_allowlist)<=100),
 expires_at TIMESTAMPTZ DEFAULT now()+interval '90 days',
 revoked_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 last_used_ip INET,
 created_by BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(expires_at IS NULL OR expires_at>created_at)
);
CREATE INDEX agent_tokens_client ON agent_tokens(client_id,id DESC);
CREATE INDEX agent_tokens_expiry ON agent_tokens(expires_at) WHERE revoked_at IS NULL;
CREATE TABLE agent_call_logs (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 128),
 client_id BIGINT REFERENCES agent_clients(id) ON DELETE SET NULL,
 client_name TEXT NOT NULL DEFAULT '',
 token_id BIGINT REFERENCES agent_tokens(id) ON DELETE SET NULL,
 token_prefix TEXT NOT NULL DEFAULT '' CHECK(length(token_prefix)<=8),
 tool TEXT NOT NULL CHECK(length(tool)<=128),
 operation_id TEXT NOT NULL CHECK(length(operation_id)<=128),
 objects JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(objects)='array'),
 code TEXT NOT NULL CHECK(code IN ('0000','1001','1002','1003','1004','1005','1006','1007','1101','1102','1201','1301','1302','5000','7777','7778','8888','8889')),
 duration_ms BIGINT NOT NULL DEFAULT 0 CHECK(duration_ms>=0),
 dry_run BOOLEAN NOT NULL DEFAULT false,
 params_summary JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(params_summary)='object'),
 result_summary JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(result_summary)='object'),
 is_write BOOLEAN NOT NULL DEFAULT false,
 llm_operation BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_call_logs_client_time ON agent_call_logs(client_id,created_at DESC,id DESC);
CREATE INDEX agent_call_logs_time ON agent_call_logs(created_at DESC,id DESC);
CREATE INDEX agent_call_logs_tool ON agent_call_logs(tool,created_at DESC);
CREATE INDEX agent_call_logs_code ON agent_call_logs(code,created_at DESC);
CREATE INDEX agent_call_logs_objects ON agent_call_logs USING GIN(objects);
ALTER TABLE translation_logs ADD COLUMN request_id TEXT;
ALTER TABLE translation_logs ADD COLUMN actor_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE translation_logs ADD COLUMN agent_client_id BIGINT REFERENCES agent_clients(id) ON DELETE SET NULL;
ALTER TABLE translation_logs ADD COLUMN fields TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX translation_logs_request ON translation_logs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX translation_logs_created ON translation_logs(created_at DESC,id DESC);
CREATE INDEX translation_logs_target_locales ON translation_logs USING GIN(target_locales);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'Agent credentials and audit history cannot be downgraded safely'; END $$;
-- +goose StatementEnd
