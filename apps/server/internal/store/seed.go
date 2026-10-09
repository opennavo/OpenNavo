package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opennavo/opennavo/server/internal/domain"
	"gorm.io/gorm"
)

func (s *Store) AdminExists(ctx context.Context, username string) (bool, error) {
	var count int64
	if username == "" {
		err := s.DB.WithContext(ctx).Raw("SELECT count(*) FROM admin_user_roles ur JOIN admin_roles r ON r.id=ur.role_id WHERE r.role_code='R_SUPER'").Scan(&count).Error
		return count > 0, err
	}
	err := s.DB.WithContext(ctx).Raw("SELECT count(*) FROM admin_users WHERE user_name = ?", username).Scan(&count).Error
	return count > 0, err
}
func (s *Store) Seed(ctx context.Context, data domain.SeedData, username, passwordHash string) error {
	return s.WithTx(ctx, func(tx *gorm.DB) error {
		exec := func(sql string, args ...any) error { return tx.Exec(sql, args...).Error }
		for _, category := range data.Categories {
			if err := exec(`INSERT INTO categories (slug,icon,applies_to,sort,hidden_by_default,source_locale) VALUES (?,?,?,?,?,'zh-CN') ON CONFLICT (slug) DO NOTHING`, category.Slug, category.Icon, category.AppliesTo, category.Sort, category.Hidden); err != nil {
				return fmt.Errorf("seed category: %w", err)
			}
			for locale, name := range map[string]string{"zh-CN": category.ZH, "en-US": category.EN} {
				if err := exec(`INSERT INTO category_i18n (category_id,locale,name,source_locale,status) SELECT id,?,?,'zh-CN',CASE WHEN ?='zh-CN' THEN 'source' ELSE 'manual' END FROM categories WHERE slug=? ON CONFLICT DO NOTHING`, locale, name, locale, category.Slug); err != nil {
					return fmt.Errorf("seed category locale: %w", err)
				}
			}
		}
		for _, role := range data.Roles {
			if err := exec(`INSERT INTO admin_roles (role_code,role_name,builtin) VALUES (?,?,TRUE) ON CONFLICT (role_code) DO NOTHING`, role.Code, role.Name); err != nil {
				return fmt.Errorf("seed role: %w", err)
			}
		}
		for _, permission := range data.Permissions {
			if err := exec(`INSERT INTO admin_permissions (code,name,group_name) VALUES (?,?,?) ON CONFLICT (code) DO NOTHING`, permission.Code, permission.Name, strings.SplitN(permission.Code, ":", 2)[0]); err != nil {
				return fmt.Errorf("seed permission: %w", err)
			}
			for _, role := range permission.Roles {
				if err := exec(`INSERT INTO admin_role_permissions (role_id,permission_code) SELECT id,? FROM admin_roles WHERE role_code=? ON CONFLICT DO NOTHING`, permission.Code, role); err != nil {
					return fmt.Errorf("seed permission binding: %w", err)
				}
			}
		}
		for _, mirror := range data.Mirrors {
			if err := exec(`INSERT INTO mirrors (key,api_domain,bottle_domain,brew_git_remote,core_git_remote,probe_url,sort,source_locale) VALUES (?,?,?,?,?,?,?,'zh-CN') ON CONFLICT (key) DO NOTHING`, mirror.Key, mirror.APIDomain, mirror.BottleDomain, mirror.BrewGitRemote, mirror.CoreGitRemote, mirror.ProbeURL, mirror.Sort); err != nil {
				return fmt.Errorf("seed mirror: %w", err)
			}
			for locale, name := range map[string]string{"zh-CN": mirror.ZH, "en-US": mirror.EN} {
				status := "manual"
				if locale == "zh-CN" {
					status = "source"
				}
				if err := exec("INSERT INTO mirror_i18n(mirror_id,locale,name,status,source_locale) SELECT id,?,?,?,'zh-CN' FROM mirrors WHERE key=? ON CONFLICT DO NOTHING", locale, name, status, mirror.Key); err != nil {
					return err
				}
			}
		}
		for _, entry := range data.Configs {
			if !json.Valid([]byte(entry.Value)) {
				return fmt.Errorf("invalid seed JSON for %s", entry.Key)
			}
			if err := exec(`INSERT INTO app_config (key,value,description) VALUES (?,?::jsonb,?) ON CONFLICT (key) DO NOTHING`, entry.Key, entry.Value, entry.Description); err != nil {
				return fmt.Errorf("seed config: %w", err)
			}
		}
		if passwordHash != "" {
			if err := exec(`INSERT INTO admin_users (user_name,password_hash,nick_name) VALUES (?,?,?) ON CONFLICT (user_name) DO NOTHING`, username, passwordHash, username); err != nil {
				return fmt.Errorf("seed bootstrap admin: %w", err)
			}
			if err := exec(`INSERT INTO admin_user_roles (user_id,role_id) SELECT u.id,r.id FROM admin_users u CROSS JOIN admin_roles r WHERE u.user_name=? AND r.role_code='R_SUPER' ON CONFLICT DO NOTHING`, username); err != nil {
				return fmt.Errorf("seed bootstrap role: %w", err)
			}
		}
		return nil
	})
}
