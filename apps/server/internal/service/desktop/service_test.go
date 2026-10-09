package desktop

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestManifestRequiresBothSignedUpdaterTargets(t *testing.T) {
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.FixedZone("database-local", 8*60*60))
	artifact := func(target string, signature any) map[string]any {
		return map[string]any{"target": target, "signature": signature, "url": "https://github.com/example/opennavo/releases/download/desktop-v0.0.1/app.tar.gz", "bytes": 42, "sha256": strings.Repeat("a", 64)}
	}
	for _, tc := range []struct {
		name  string
		rows  []map[string]any
		valid bool
	}{
		{"one architecture", []map[string]any{artifact("darwin-aarch64", "public-signature")}, false},
		{"unsigned", []map[string]any{artifact("darwin-aarch64", nil), artifact("darwin-x86_64", "public-signature")}, false},
		{"duplicate target", []map[string]any{artifact("darwin-aarch64", "public-signature"), artifact("darwin-aarch64", "public-signature")}, false},
		{"both architectures", []map[string]any{artifact("darwin-aarch64", "public-signature"), artifact("darwin-x86_64", "public-signature"), artifact("dmg-universal", nil)}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.rows)
			require.NoError(t, err)
			manifest, err := Generate(store.DesktopRelease{Version: "0.0.1", NotesEN: "English", PubDate: &now, Artifacts: raw})
			if !tc.valid {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Len(t, manifest.Platforms, 2)
			require.Equal(t, "https://github.com/example/opennavo/releases/download/desktop-v0.0.1/app.tar.gz", manifest.Platforms["darwin-aarch64"].URL)
			require.Equal(t, "English", manifest.Notes)
			require.Equal(t, time.UTC, manifest.PubDate.Location())
			encoded, err := json.Marshal(manifest)
			require.NoError(t, err)
			require.Contains(t, string(encoded), `"pub_date":"2026-10-04T16:00:00Z"`)
		})
	}
}
