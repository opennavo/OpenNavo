package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/opennavo/opennavo/server/internal/content"
	"github.com/opennavo/opennavo/server/internal/domain"
	"gorm.io/gorm"
)

// Translate only existing source text; reject historical upstream records without translatable source text.
func (s *Store) RetranslateRelease(ctx context.Context, id int64, actorID *int64) error {
	settings, err := s.TranslationSettings(ctx)
	if err != nil {
		return err
	}
	var types []string
	if err := json.Unmarshal(settings.ContentTypes, &types); err != nil {
		return err
	}
	if !settings.Enabled || !containsText(types, "release") {
		return &domain.AppError{Code: domain.CodeInvalidState}
	}
	ref := content.Ref{Entity: "release", ID: id}
	source, err := s.ReadContentSource(ctx, ref)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	var key string
	if err == nil && len(content.Flatten(source.Fields)) > 0 {
		if err := s.ForceContentTranslation(ctx, ref); err != nil {
			return err
		}
		key = "translate:content:release:" + ref.Key()
	} else {
		return &domain.AppError{Code: domain.CodeInvalidState}
	}
	meta, _ := json.Marshal(map[string]any{"trigger": "manual", "triggeredBy": actorID})
	return s.DB.WithContext(ctx).Exec("UPDATE job_outbox SET payload=jsonb_set(payload,'{metadata}',?::jsonb) WHERE unique_key=?", string(meta), key).Error
}
