package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/opennavo/opennavo/server/seeds"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (s *Store) E2EUsers(ctx context.Context) ([]AuthUser, error) {
	names := []string{}
	for _, account := range seeds.E2EAccounts() {
		names = append(names, account.Username)
	}
	var users []AuthUser
	err := s.DB.WithContext(ctx).Table("admin_users").Where("user_name IN ?", names).Find(&users).Error
	return users, err
}

// e2eUpsert accepts only column names defined here; unchanged content is not updated, so repeated runs create no catalog deltas.
func e2eUpsert(ctx context.Context, tx *gorm.DB, table string, keys []string, values map[string]any) (bool, error) {
	columns := []clause.Column{}
	for _, key := range keys {
		columns = append(columns, clause.Column{Name: key})
	}
	updates, previous, incoming := []string{}, []string{}, []string{}
	for column := range values {
		if !slices.Contains(keys, column) {
			updates = append(updates, column)
		}
	}
	slices.Sort(updates)
	for _, column := range updates {
		previous = append(previous, `"`+table+`"."`+column+`"`)
		incoming = append(incoming, `EXCLUDED."`+column+`"`)
	}
	conflict := clause.OnConflict{Columns: columns, DoUpdates: clause.AssignmentColumns(updates), Where: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "ROW(" + strings.Join(previous, ",") + ") IS DISTINCT FROM ROW(" + strings.Join(incoming, ",") + ")"}}}}
	result := tx.WithContext(ctx).Table(table).Clauses(conflict).Create(values)
	return result.RowsAffected > 0, result.Error
}
func e2eID(ctx context.Context, tx *gorm.DB, table, condition string, args ...any) (int64, error) {
	var id int64
	err := tx.WithContext(ctx).Table(table).Select("id").Where(condition, args...).Scan(&id).Error
	if err == nil && id == 0 {
		err = fmt.Errorf("missing e2e row in %s", table)
	}
	return id, err
}
func e2eArray(values []string) clause.Expr {
	// []string is always encodable; convert JSON parameters to arrays instead of concatenating array elements.
	data, _ := json.Marshal(values)
	return gorm.Expr("ARRAY(SELECT jsonb_array_elements_text(?::jsonb))", string(data))
}
func e2eDigest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func (s *Store) SeedE2E(ctx context.Context, data seeds.E2EData, hashes map[string]string) error {
	return s.WithTx(ctx, func(tx *gorm.DB) error {
		if err := LockCatalogWrites(ctx, tx); err != nil {
			return err
		}
		anchor := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
		super, err := e2eAccounts(ctx, tx, hashes, anchor)
		if err != nil {
			return err
		}
		media, err := e2eAssets(ctx, tx, data.Media, super, anchor)
		if err != nil {
			return err
		}
		ids := map[string]int64{}
		ranks := map[string]int{"cask": 0, "formula": 0}
		allIDs := []int64{}
		for index, p := range data.Packages {
			font, library := p.Category == "fonts", p.Category == "libraries"
			var rank *int
			if !font {
				ranks[p.Kind]++
				r := ranks[p.Kind]
				rank = &r
			}
			raw, err := json.Marshal(p)
			if err != nil {
				return fmt.Errorf("encode e2e package: %w", err)
			}
			tap := "homebrew/cask"
			if p.Kind == "formula" {
				tap = "homebrew/core"
			}
			installs := (100 - index) * 1000
			onRequest := 0
			if p.Kind == "formula" {
				onRequest = installs * 8 / 10
				if library {
					onRequest = installs / 10
				}
			}
			changedAt := anchor.Add(-time.Duration(index) * time.Hour)
			values := map[string]any{"kind": p.Kind, "token": p.Token, "full_token": p.Token, "tap": tap, "name": p.Name, "names": e2eArray([]string{p.Name, p.DisplayName}), "desc_en": "Deterministic E2E fixture for " + p.Name, "homepage": p.Homepage, "version": p.Version, "version_base": p.Version, "artifacts": gorm.Expr("?::jsonb", string(p.Artifacts)), "raw": gorm.Expr("?::jsonb", string(raw)), "raw_hash": e2eDigest(raw), "is_font": font, "is_library": library, "auto_updates": p.Kind == "cask" && !font, "deprecated": false, "disabled": false, "removed_at": nil, "installs_30d": installs, "installs_90d": installs * 4, "installs_365d": installs * 14, "on_request_30d": onRequest, "on_request_90d": onRequest * 4, "on_request_365d": onRequest * 14, "rank_30d": rank, "popularity": 10 - float64(index)/10, "version_changed_at": changedAt, "first_seen_at": anchor.Add(-60 * 24 * time.Hour), "updated_at": anchor}
			values["download_url"], values["download_size"], values["license"], values["caveats"], values["min_macos"] = p.DownloadURL, p.DownloadSize, e2eNullable(p.License), e2eNullable(p.Caveats), "13.0"
			values["dependencies"], values["conflicts_with"] = e2eJSON(p.Dependencies), e2eJSON(p.ConflictsWith)
			values["keg_only"], values["names"] = p.Token == "openssl@3", e2eArray(append([]string{p.Name, p.DisplayName}, p.Aliases...))
			changed, err := e2eUpsert(ctx, tx, "packages", []string{"kind", "token"}, values)
			if err != nil {
				return fmt.Errorf("seed e2e package %s: %w", p.Token, err)
			}
			id, err := e2eID(ctx, tx, "packages", "kind=? AND token=?", p.Kind, p.Token)
			if err != nil {
				return err
			}
			ids[p.Token] = id
			allIDs = append(allIDs, id)
			meta := map[string]any{"package_id": id, "hidden": false, "editor_choice": index < 12, "tags": e2eArray([]string{p.Category}), "notes": "OpenNavo E2E fixture", "updated_at": anchor, "developer": e2eNullable(p.Developer), "repo_url": e2eNullable(p.RepoURL)}
			theme := "dark"
			if p.Token == "wechat" {
				theme = "light"
			}
			if asset := media["icon/"+p.Token+"/"+theme]; asset != 0 {
				meta["icon_asset_id"], meta["icon_source"] = asset, "manual"
			}
			metaChanged, err := e2eUpsert(ctx, tx, "package_meta", []string{"package_id"}, meta)
			if err != nil {
				return err
			}
			changed = changed || metaChanged
			for _, locale := range []string{"zh-CN", "en-US"} {
				name, summary, description := p.Name, "Deterministic E2E fixture for "+p.Name, "Offline test data; versions and analytics are fixed fixtures."
				if locale == "zh-CN" {
					name, summary, description = p.DisplayName, p.Summary, "## "+p.DisplayName+"\n\n"+p.Summary+"。\n\n这是离线端到端测试数据，版本与安装量为固定样本。"
				}
				status := "manual"
				if locale == "en-US" {
					status = "source"
				}
				updated, err := e2eUpsert(ctx, tx, "package_i18n", []string{"package_id", "locale"}, map[string]any{"package_id": id, "locale": locale, "display_name": name, "summary": summary, "description": description, "status": status, "source": "human", "updated_at": anchor})
				if err != nil {
					return err
				}
				changed = changed || updated
			}
			category, err := e2eID(ctx, tx, "categories", "slug=?", p.Category)
			if err != nil {
				return err
			}
			removed := tx.WithContext(ctx).Exec("DELETE FROM package_categories WHERE package_id=? AND category_id<>?", id, category)
			if removed.Error != nil {
				return removed.Error
			}
			updated, err := e2eUpsert(ctx, tx, "package_categories", []string{"package_id", "category_id"}, map[string]any{"package_id": id, "category_id": category, "is_primary": true, "source": "human", "confidence": 1.0})
			if err != nil {
				return err
			}
			changed = changed || updated || removed.RowsAffected > 0
			if _, err := e2eUpsert(ctx, tx, "package_versions", []string{"package_id", "version"}, map[string]any{"package_id": id, "version": p.Version, "version_base": p.Version, "first_seen_at": changedAt, "brew_committed_at": changedAt}); err != nil {
				return err
			}
			if _, err := e2eUpsert(ctx, tx, "analytics_snapshots", []string{"package_id", "snapshot_date"}, map[string]any{"package_id": id, "snapshot_date": anchor, "installs_30d": installs, "installs_90d": installs * 4, "installs_365d": installs * 14, "on_request_30d": onRequest, "rank_30d": rank}); err != nil {
				return err
			}
			if changed {
				if err := tx.WithContext(ctx).Exec("INSERT INTO catalog_changes(package_id,kind,token,op,reason) VALUES(?,?,?,'upsert','content')", id, p.Kind, p.Token).Error; err != nil {
					return err
				}
			}
		}
		if err := e2eReleases(ctx, tx, data.Releases, ids, super, anchor); err != nil {
			return err
		}
		if err := e2eContent(ctx, tx, data, ids, super, anchor); err != nil {
			return err
		}
		if err := e2eMediaContent(ctx, tx, data, ids, media, super, anchor); err != nil {
			return err
		}
		if err := e2eAdminContent(ctx, tx, data.SearchDate, ids, anchor); err != nil {
			return err
		}
		return UpdateSearchIndex(ctx, tx, allIDs)
	})
}

func e2eAccounts(ctx context.Context, tx *gorm.DB, hashes map[string]string, anchor time.Time) (int64, error) {
	var super int64
	for _, account := range seeds.E2EAccounts() {
		var previous AuthUser
		if err := tx.WithContext(ctx).Raw("SELECT * FROM admin_users WHERE user_name=? FOR UPDATE", account.Username).Scan(&previous).Error; err != nil {
			return 0, err
		}
		if _, err := e2eUpsert(ctx, tx, "admin_users", []string{"user_name"}, map[string]any{"user_name": account.Username, "password_hash": hashes[account.Username], "nick_name": account.Username, "status": "1", "failed_logins": 0, "locked_until": nil, "updated_at": anchor}); err != nil {
			return 0, err
		}
		id, err := e2eID(ctx, tx, "admin_users", "user_name=?", account.Username)
		if err != nil {
			return 0, err
		}
		if previous.ID != 0 && previous.PasswordHash != hashes[account.Username] {
			if err := tx.WithContext(ctx).Exec("UPDATE admin_users SET session_version=session_version+1 WHERE id=?", id).Error; err != nil {
				return 0, err
			}
			if err := tx.WithContext(ctx).Exec("UPDATE admin_refresh_tokens SET revoked_at=now() WHERE user_id=? AND revoked_at IS NULL", id).Error; err != nil {
				return 0, err
			}
		}
		if err := tx.WithContext(ctx).Exec("DELETE FROM admin_user_roles WHERE user_id=? AND role_id<>(SELECT id FROM admin_roles WHERE role_code=?)", id, account.Role).Error; err != nil {
			return 0, err
		}
		if err := tx.WithContext(ctx).Exec("INSERT INTO admin_user_roles(user_id,role_id) SELECT ?,id FROM admin_roles WHERE role_code=? ON CONFLICT DO NOTHING", id, account.Role).Error; err != nil {
			return 0, err
		}
		if account.Role == "R_SUPER" {
			super = id
		}
	}
	return super, nil
}

func e2eReleases(ctx context.Context, tx *gorm.DB, releases []seeds.E2ERelease, ids map[string]int64, reviewer int64, anchor time.Time) error {
	for _, release := range releases {
		source := release.Source
		if source == "" {
			source = "manual"
		}
		id := ids[release.Token]
		url := "https://code.visualstudio.com/updates/v" + strings.ReplaceAll(release.Version, ".", "_")
		if release.Token == "ghostty" {
			url = "https://ghostty.org/docs/install/release-notes/" + release.Version
		}
		hash := e2eDigest([]byte(release.BodyEN))
		if _, err := e2eUpsert(ctx, tx, "releases", []string{"package_id", "source", "source_key"}, map[string]any{"package_id": id, "source": source, "source_key": "e2e:" + release.Version, "version": release.Version, "title": release.Version + " release notes", "published_at": release.PublishedAt, "source_url": url, "body_markdown": release.BodyEN, "body_hash": hash, "hidden": false, "updated_at": anchor}); err != nil {
			return err
		}
		releaseID, err := e2eID(ctx, tx, "releases", "package_id=? AND source=? AND source_key=?", id, source, "e2e:"+release.Version)
		if err != nil {
			return err
		}
		var reviewedBy *int64
		var reviewedAt *time.Time
		if release.Status == "manual" {
			reviewedBy, reviewedAt = &reviewer, &anchor
		}
		for _, locale := range []string{"zh-CN", "en-US"} {
			body, summary, status, sections := release.BodyZH, release.Summary, release.Status, string(release.Sections)
			localeReviewedBy, localeReviewedAt := reviewedBy, reviewedAt
			if locale == "en-US" {
				body, summary, status = release.BodyEN, "Improve usability and stability.", "source"
				sections = `[{"area":"Improvements","items":["Improve keyboard navigation and rendering performance."]},{"area":"Fixes","items":["Fix session restoration issues."]}]`
				localeReviewedBy, localeReviewedAt = &reviewer, &anchor
			}
			if _, err := e2eUpsert(ctx, tx, "release_i18n", []string{"release_id", "locale"}, map[string]any{"release_id": releaseID, "locale": locale, "summary": summary, "sections": gorm.Expr("?::jsonb", sections), "body_markdown": body, "status": status, "source_hash": hash, "reviewed_by": localeReviewedBy, "reviewed_at": localeReviewedAt, "updated_at": anchor}); err != nil {
				return err
			}
		}
		if _, err := e2eUpsert(ctx, tx, "package_versions", []string{"package_id", "version"}, map[string]any{"package_id": id, "version": release.Version, "version_base": release.Version, "first_seen_at": release.PublishedAt.Add(time.Hour), "brew_committed_at": release.PublishedAt.Add(time.Hour), "brew_commit_sha": e2eDigest([]byte(release.Token + ":" + release.Version))[:40]}); err != nil {
			return err
		}
	}
	return nil
}

func e2eContent(ctx context.Context, tx *gorm.DB, data seeds.E2EData, ids map[string]int64, actor int64, anchor time.Time) error {
	if _, err := e2eUpsert(ctx, tx, "collections", []string{"slug"}, map[string]any{"source_locale": "zh-CN", "slug": "new-mac", "status": "published", "publish_at": anchor.Add(-30 * 24 * time.Hour), "unpublish_at": nil, "sort": 0, "created_by": actor, "updated_at": anchor}); err != nil {
		return err
	}
	collection, err := e2eID(ctx, tx, "collections", "slug='new-mac'")
	if err != nil {
		return err
	}
	for _, locale := range []string{"zh-CN", "en-US"} {
		title, subtitle := "新 Mac 必装", "从开发、沟通到日常效率"
		if locale == "en-US" {
			title, subtitle = "New Mac essentials", "Tools for development, communication and productivity"
		}
		status := "manual"
		if locale == "zh-CN" {
			status = "source"
		}
		if _, err := e2eUpsert(ctx, tx, "collection_i18n", []string{"collection_id", "locale"}, map[string]any{"source_locale": "zh-CN", "collection_id": collection, "locale": locale, "title": title, "subtitle": subtitle, "body": subtitle, "status": status}); err != nil {
			return err
		}
	}
	items := []int64{}
	for index, token := range data.Collection {
		items = append(items, ids[token])
		if _, err := e2eUpsert(ctx, tx, "collection_items", []string{"collection_id", "package_id"}, map[string]any{"source_locale": "zh-CN", "collection_id": collection, "package_id": ids[token], "sort": index}); err != nil {
			return err
		}
		for locale, note := range map[string]string{"zh-CN": "新 Mac 常用工具", "en-US": "An everyday Mac tool"} {
			status := "manual"
			if locale == "zh-CN" {
				status = "source"
			}
			if _, err := e2eUpsert(ctx, tx, "collection_item_i18n", []string{"collection_id", "package_id", "locale"}, map[string]any{"collection_id": collection, "package_id": ids[token], "locale": locale, "note": note, "source_locale": "zh-CN", "status": status}); err != nil {
				return err
			}
		}

	}
	if err := tx.WithContext(ctx).Exec("DELETE FROM collection_items WHERE collection_id=? AND package_id NOT IN ?", collection, items).Error; err != nil {
		return err
	}
	var feature int64
	if err := tx.WithContext(ctx).Raw("SELECT id FROM features WHERE placement='home_hero' AND target_type='package' AND package_id=? AND created_by=? ORDER BY id LIMIT 1", ids["ghostty"], actor).Scan(&feature).Error; err != nil {
		return err
	}
	if feature == 0 {
		if err := tx.WithContext(ctx).Raw("INSERT INTO features(placement,target_type,package_id,status,sort,created_by,updated_at,source_locale) VALUES('home_hero','package',?,'published',0,?,?,'zh-CN') RETURNING id", ids["ghostty"], actor, anchor).Scan(&feature).Error; err != nil {
			return err
		}
	} else if err := tx.WithContext(ctx).Exec("UPDATE features SET status='published',starts_at=NULL,ends_at=NULL,sort=0,updated_at=? WHERE id=? AND (status<>'published' OR starts_at IS NOT NULL OR ends_at IS NOT NULL OR sort<>0)", anchor, feature).Error; err != nil {
		return err
	}
	for _, locale := range []string{"zh-CN", "en-US"} {
		badge, title, subtitle, label := "本周精选", "Ghostty 1.3", "终端，本该这么快。", "查看详情"
		if locale == "en-US" {
			badge, subtitle, label = "Featured", "A fast, native terminal.", "View details"
		}
		status := "manual"
		if locale == "zh-CN" {
			status = "source"
		}
		if _, err := e2eUpsert(ctx, tx, "feature_i18n", []string{"feature_id", "locale"}, map[string]any{"source_locale": "zh-CN", "feature_id": feature, "locale": locale, "badge": badge, "title": title, "subtitle": subtitle, "body": subtitle, "cta_label": label, "status": status}); err != nil {
			return err
		}
	}
	for _, terms := range data.Synonyms {
		if err := tx.WithContext(ctx).Exec("INSERT INTO search_synonyms(terms,enabled,created_by) SELECT ?,true,? WHERE NOT EXISTS(SELECT 1 FROM search_synonyms WHERE terms=?)", e2eArray(terms), actor, e2eArray(terms)).Error; err != nil {
			return err
		}
	}
	for _, feedback := range data.Feedback {
		var id int64
		if err := tx.WithContext(ctx).Raw("SELECT id FROM feedback WHERE contact='e2e@opennavo.example' AND content=? ORDER BY id LIMIT 1", feedback.Content).Scan(&id).Error; err != nil {
			return err
		}
		if id == 0 {
			if err := tx.WithContext(ctx).Exec("INSERT INTO feedback(type,package_id,content,contact,platform,app_version,status,created_at) VALUES(?,?,?,'e2e@opennavo.example',?,'0.0.0-e2e',?,?)", feedback.Type, ids[feedback.Token], feedback.Content, feedback.Platform, feedback.Status, anchor).Error; err != nil {
				return err
			}
		} else if _, err := e2eUpsert(ctx, tx, "feedback", []string{"id"}, map[string]any{"id": id, "type": feedback.Type, "package_id": ids[feedback.Token], "content": feedback.Content, "contact": "e2e@opennavo.example", "platform": feedback.Platform, "app_version": "0.0.0-e2e", "status": feedback.Status, "created_at": anchor}); err != nil {
			return err
		}
	}
	return nil
}
