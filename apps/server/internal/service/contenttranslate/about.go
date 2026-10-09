package contenttranslate

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/opennavo/opennavo/server/internal/about"
	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/i18n"
	"github.com/opennavo/opennavo/server/internal/llm"
	"gorm.io/gorm"
)

// About text uses the existing queue, gateway settings and billing; no new content table or Agent access to system settings is added.
func (s *Service) runAbout(ctx context.Context, hash string) (map[string]any, error) {
	stats := map[string]any{"entity": "about", "calls": 0}
	read := func(db *gorm.DB) (about.Config, error) {
		var raw string
		if err := db.WithContext(ctx).Raw("SELECT value::text FROM app_config WHERE key=?", about.Key).Scan(&raw).Error; err != nil {
			return about.Config{}, err
		}
		return about.Parse([]byte(raw))
	}
	c, err := read(s.Store.DB)
	if err != nil {
		return stats, err
	}
	if c.SourceHash() != hash {
		stats["skipped"] = "stale"
		return stats, nil
	}
	targets := []string{}
	for _, locale := range i18n.Locales {
		if string(locale) != c.SourceLanguage() {
			targets = append(targets, string(locale))
		}
	}
	input := llm.ContentInput{SourceLocale: c.SourceLanguage(), Targets: targets, Fields: c.SourceFields(), Protected: []string{"OpenNavo", "Homebrew", "Brewfile"}}
	output, usage, err := s.call(ctx, input)
	stats["calls"] = len(usage.Attempts)
	stats["tokens"] = usage.Tokens()
	if err != nil {
		return stats, err
	}
	err = s.Store.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Recheck source text after locking configuration so in-flight translations cannot overwrite new administrator edits.
		if err := tx.Exec("SELECT key FROM app_config WHERE key=? FOR UPDATE", about.Key).Error; err != nil {
			return err
		}
		latest, err := read(tx)
		if err != nil {
			return err
		}
		if latest.SourceHash() != hash {
			stats["skipped"] = "stale"
			return nil
		}
		latest.ApplyTranslations(output)
		raw, err := json.Marshal(latest)
		if err != nil {
			return err
		}
		return tx.Exec("UPDATE app_config SET value=?::jsonb,updated_at=clock_timestamp() WHERE key=?", string(raw), about.Key).Error
	})
	if err != nil {
		return stats, fmt.Errorf("save about translation: %w", err)
	}
	if s.Store.Redis != nil {
		err = cache.PublishInvalidation(ctx, s.Store.Redis, "c:cfg:client:*")
	}
	return stats, err
}
