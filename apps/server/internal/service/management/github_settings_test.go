package management

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGitHubSettingsRejectConflictingActionsAndUnsafeHeaderValues(t *testing.T) {
	for _, body := range []map[string]any{{}, {"token": ""}, {"token": "fixture-token"}, {"clearToken": true}, {"token": "", "clearToken": true}} {
		require.NoError(t, validateGitHubSettings(body))
	}
	for _, body := range []map[string]any{
		{"token": "fixture-token", "clearToken": true},
		{"token": " leading"}, {"token": "trailing "}, {"token": "line\nbreak"},
		{"token": "line\rbreak"}, {"token": "tab\tbreak"}, {"token": "delete\x7f"},
		{"token": "令牌"}, {"token": strings.Repeat("x", 4097)},
		{"token": nil}, {"token": 123}, {"clearToken": "true"}, {"clearToken": nil},
	} {
		require.Error(t, validateGitHubSettings(body))
	}
}
