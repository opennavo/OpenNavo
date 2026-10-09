-- +goose Up
CREATE TABLE github_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    token_ciphertext TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO github_settings(id) VALUES(TRUE);
INSERT INTO admin_permissions(code,name,group_name) VALUES('system:github:edit','GitHub settings','system') ON CONFLICT(code) DO NOTHING;
INSERT INTO admin_role_permissions(role_id,permission_code) SELECT id,'system:github:edit' FROM admin_roles WHERE role_code='R_ADMIN' ON CONFLICT DO NOTHING;

-- +goose Down
DELETE FROM admin_role_permissions WHERE permission_code='system:github:edit';
DELETE FROM admin_permissions WHERE code='system:github:edit';
DROP TABLE github_settings;
