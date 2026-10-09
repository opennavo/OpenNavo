-- +goose Up
ALTER TABLE i18n_settings ADD COLUMN base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE i18n_settings ADD COLUMN api_key_ciphertext TEXT NOT NULL DEFAULT '';
INSERT INTO admin_permissions(code,name,group_name) VALUES('i18n:settings','Translation AI settings','system') ON CONFLICT(code) DO NOTHING;
INSERT INTO admin_role_permissions(role_id,permission_code) SELECT id,'i18n:settings' FROM admin_roles WHERE role_code='R_ADMIN' ON CONFLICT DO NOTHING;

-- +goose Down
DELETE FROM admin_role_permissions WHERE permission_code='i18n:settings';
DELETE FROM admin_permissions WHERE code='i18n:settings';
ALTER TABLE i18n_settings DROP COLUMN api_key_ciphertext;
ALTER TABLE i18n_settings DROP COLUMN base_url;
