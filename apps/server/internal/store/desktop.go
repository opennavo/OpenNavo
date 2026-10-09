package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/opennavo/opennavo/server/internal/i18n"
	"gorm.io/gorm"
)

type DesktopRelease struct {
	SourceLocale                                         string
	I18n                                                 json.RawMessage
	ID                                                   int64
	Version, Channel, Status, MinMacos, NotesZH, NotesEN string
	Artifacts                                            json.RawMessage
	PubDate                                              *time.Time
	PublishedBy                                          *int64
	CreatedAt, UpdatedAt                                 time.Time
}

const DesktopJSON = `jsonb_build_object('id',d.id,'version',d.version,'channel',d.channel,'status',d.status,'minMacos',d.min_macos,'sourceLocale',d.source_locale,'i18n',COALESCE((SELECT jsonb_object_agg(t.locale,jsonb_build_object('notes',t.notes,'status',t.status,'sourceLocale',t.source_locale,'sourceHash',t.source_hash,'model',t.model,'translatedAt',t.translated_at)) FROM desktop_release_i18n t WHERE t.desktop_release_id=d.id),'{}'::jsonb),'artifacts',d.artifacts,'pubDate',d.pub_date,'publishedBy',u.user_name,'createTime',d.created_at)`
const DesktopFrom = `FROM desktop_releases d LEFT JOIN admin_users u ON u.id=d.published_by`

func (s *Store) DesktopRelease(ctx context.Context, id int64) (DesktopRelease, error) {
	var row DesktopRelease
	r := s.DB.WithContext(ctx).Raw("SELECT d.*, (SELECT jsonb_object_agg(i.locale,jsonb_build_object('notes',i.notes,'status',i.status,'machineTranslated',i.machine_translated)) FROM desktop_release_i18n i WHERE i.desktop_release_id=d.id) i18n FROM desktop_releases d WHERE id=?", id).Scan(&row)
	if r.Error != nil {
		return row, r.Error
	}
	if r.RowsAffected == 0 {
		return row, gorm.ErrRecordNotFound
	}
	return row, nil
}
func (s *Store) LatestDesktop(ctx context.Context, channel string, exclude int64) (DesktopRelease, error) {
	var row DesktopRelease
	r := s.DB.WithContext(ctx).Raw("SELECT d.*, (SELECT jsonb_object_agg(i.locale,jsonb_build_object('notes',i.notes,'status',i.status,'machineTranslated',i.machine_translated)) FROM desktop_release_i18n i WHERE i.desktop_release_id=d.id) i18n FROM desktop_releases d WHERE channel=? AND status='published' AND id<>? ORDER BY pub_date DESC,id DESC LIMIT 1", channel, exclude).Scan(&row)
	if r.Error != nil {
		return row, r.Error
	}
	if r.RowsAffected == 0 {
		return row, gorm.ErrRecordNotFound
	}
	return row, nil
}
func (s *Store) AdminDesktop(ctx context.Context, id int64) (json.RawMessage, error) {
	return s.JSONRow(ctx, "SELECT "+DesktopJSON+" AS data "+DesktopFrom+" WHERE d.id=?", id)
}

func (s *Store) RecentDesktopReleases(ctx context.Context, channel string) ([]DesktopRelease, error) {
	var rows []DesktopRelease
	err := s.DB.WithContext(ctx).Raw("SELECT d.*, (SELECT jsonb_object_agg(i.locale,jsonb_build_object('notes',i.notes,'status',i.status,'machineTranslated',i.machine_translated)) FROM desktop_release_i18n i WHERE i.desktop_release_id=d.id) i18n FROM desktop_releases d WHERE channel=? AND status='published' ORDER BY pub_date DESC,id DESC LIMIT 5", channel).Scan(&rows).Error
	return rows, err
}

func (r DesktopRelease) LocalizedNotes(locale string) (string, bool) {
	var values map[string]struct {
		Notes, Status     string
		MachineTranslated bool
	}
	if json.Unmarshal(r.I18n, &values) == nil {
		for _, code := range i18n.Fallback(locale, r.SourceLocale) {
			if v, ok := values[code]; ok && v.Notes != "" {
				return v.Notes, v.MachineTranslated
			}
		}
	}
	// Legacy pure-function fixtures have no database mappings; retain compatibility with their internal structure.
	if locale == "en-US" && r.NotesEN != "" {
		return r.NotesEN, false
	}
	if r.NotesZH != "" {
		return r.NotesZH, false
	}
	return r.NotesEN, false
}
