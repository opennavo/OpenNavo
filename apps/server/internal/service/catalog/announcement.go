package catalog

import (
	"encoding/json"

	"github.com/opennavo/opennavo/server/gen/publicapi"
	"github.com/opennavo/opennavo/server/internal/i18n"
)

// Treat historical non-object values as no announcement; project both the new admin enabled flag and legacy multilingual JSON here.
func decodeAnnouncement(raw json.RawMessage, locale string) *publicapi.Announcement {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil
	}
	if value, exists := object["enabled"]; exists {
		var enabled bool
		if json.Unmarshal(value, &enabled) != nil || !enabled {
			return nil
		}
	}
	source := string(i18n.AuthoringLocale)
	if value := object["sourceLocale"]; len(value) > 0 {
		_ = json.Unmarshal(value, &source)
	}
	selected := raw
	for _, code := range i18n.Fallback(locale, source) {
		if value := object[code]; len(value) > 0 && string(value) != "null" {
			selected = value
			break
		}
	}
	var announcement *publicapi.Announcement
	if json.Unmarshal(selected, &announcement) != nil || announcement == nil || announcement.Title == "" {
		return nil
	}
	// The dedicated announcement write endpoint has no id/level fields; supply the existing public contract's required display fields.
	if announcement.Id == "" {
		announcement.Id = "desktop.announcement"
	}
	if announcement.Level == "" {
		announcement.Level = publicapi.AnnouncementLevel("info")
	}
	announcement.SourceLocale = localePointer(source)
	if announcement.MachineTranslated == nil {
		announcement.MachineTranslated = boolPointer(false)
	}
	return announcement
}
