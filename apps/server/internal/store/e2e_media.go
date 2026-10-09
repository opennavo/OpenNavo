package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/opennavo/opennavo/server/seeds"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func e2eNullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func e2eJSON(value json.RawMessage) clause.Expr {
	if len(value) == 0 {
		value = json.RawMessage(`{}`)
	}
	return gorm.Expr("?::jsonb", string(value))
}

func e2eAssets(ctx context.Context, tx *gorm.DB, media []seeds.E2EAsset, actor int64, anchor time.Time) (map[string]int64, error) {
	result := map[string]int64{}
	for _, asset := range media {
		if _, err := e2eUpsert(ctx, tx, "assets", []string{"storage_key"}, map[string]any{"storage_key": asset.Key, "kind": asset.Kind, "url": asset.URL, "mime": asset.MIME, "width": asset.Width, "height": asset.Height, "bytes": asset.Bytes, "sha256": asset.SHA256, "created_by": actor, "created_at": anchor}); err != nil {
			return nil, err
		}
		id, err := e2eID(ctx, tx, "assets", "storage_key=?", asset.Key)
		if err != nil {
			return nil, err
		}
		result[asset.Kind+"/"+asset.Token+"/"+asset.Theme] = id
	}
	return result, nil
}

func e2eMediaContent(ctx context.Context, tx *gorm.DB, data seeds.E2EData, ids, media map[string]int64, actor int64, anchor time.Time) error {
	for index, asset := range data.Media {
		if asset.Kind != "screenshot" {
			continue
		}
		id := media[asset.Kind+"/"+asset.Token+"/"+asset.Theme]
		if err := tx.WithContext(ctx).Exec(`INSERT INTO package_screenshots(package_id,asset_id,sort,theme,created_at,source_locale) SELECT ?,?,?,?,?,'zh-CN' WHERE NOT EXISTS(SELECT 1 FROM package_screenshots WHERE package_id=? AND asset_id=?)`, ids[asset.Token], id, index, asset.Theme, anchor, ids[asset.Token], id).Error; err != nil {
			return err
		}
		var screenshotID int64
		if err := tx.WithContext(ctx).Raw("SELECT id FROM package_screenshots WHERE package_id=? AND asset_id=?", ids[asset.Token], id).Scan(&screenshotID).Error; err != nil {
			return err
		}
		for locale, caption := range map[string]string{"zh-CN": asset.CaptionZH, "en-US": asset.CaptionEN} {
			status := "manual"
			if locale == "zh-CN" {
				status = "source"
			}
			if _, err := e2eUpsert(ctx, tx, "screenshot_i18n", []string{"screenshot_id", "locale"}, map[string]any{"screenshot_id": screenshotID, "locale": locale, "caption": caption, "source_locale": "zh-CN", "status": status}); err != nil {
				return err
			}
		}

	}
	if cover := media["cover/new-mac/dark"]; cover != 0 {
		if err := tx.WithContext(ctx).Exec("UPDATE collections SET cover_asset_id=? WHERE slug='new-mac' AND cover_asset_id IS DISTINCT FROM ?", cover, cover).Error; err != nil {
			return err
		}
	}
	for _, release := range data.Desktop {
		if _, err := e2eUpsert(ctx, tx, "desktop_releases", []string{"version", "channel"}, map[string]any{"source_locale": "zh-CN", "version": release.Version, "channel": "stable", "status": "published", "min_macos": "13.0", "artifacts": e2eJSON(release.Artifacts), "pub_date": release.PubDate, "published_by": actor, "created_at": anchor, "updated_at": anchor}); err != nil {
			return err
		}
		var releaseID int64
		if err := tx.WithContext(ctx).Raw("SELECT id FROM desktop_releases WHERE version=? AND channel='stable'", release.Version).Scan(&releaseID).Error; err != nil {
			return err
		}
		for locale, notes := range map[string]string{"zh-CN": release.NotesZH, "en-US": release.NotesEN} {
			status := "manual"
			if locale == "zh-CN" {
				status = "source"
			}
			if _, err := e2eUpsert(ctx, tx, "desktop_release_i18n", []string{"desktop_release_id", "locale"}, map[string]any{"desktop_release_id": releaseID, "locale": locale, "notes": notes, "source_locale": "zh-CN", "status": status}); err != nil {
				return err
			}
		}

	}
	return nil
}
