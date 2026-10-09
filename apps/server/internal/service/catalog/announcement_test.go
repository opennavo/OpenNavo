package catalog

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAnnouncementProjectionRejectsMalformedAndDisabledValues(t *testing.T) {
	for _, raw := range []string{"null", "[]", `[null,{"title":"旧公告"}]`, `"text"`, "123", "true", `{}`, `{"enabled":false,"title":"关闭"}`, `{"enabled":"invalid","title":"错误"}`} {
		require.Nil(t, decodeAnnouncement(json.RawMessage(raw), "zh-CN"), raw)
	}
}
func TestAnnouncementProjectionPreservesLegacyAndCompletesDedicatedFormat(t *testing.T) {
	legacy := decodeAnnouncement(json.RawMessage(`{"id":"legacy-id","level":"warning","title":"Legacy","url":"https://example.com"}`), "zh-CN")
	require.NotNil(t, legacy)
	require.Equal(t, "legacy-id", legacy.Id)
	require.Equal(t, "warning", string(legacy.Level))
	require.Equal(t, "https://example.com", *legacy.Url)
	localized := decodeAnnouncement(json.RawMessage(`{"sourceLocale":"en-US","en-US":{"id":"legacy-i18n","level":"info","title":"English"}}`), "ja-JP")
	require.NotNil(t, localized)
	require.Equal(t, "English", localized.Title)
	require.Equal(t, "en-US", string(*localized.SourceLocale))
	current := decodeAnnouncement(json.RawMessage(`{"enabled":true,"sourceLocale":"zh-CN","title":"新公告","body":"正文"}`), "zh-CN")
	require.NotNil(t, current)
	require.Equal(t, "desktop.announcement", current.Id)
	require.Equal(t, "info", string(current.Level))
	require.Equal(t, "新公告", current.Title)
}
