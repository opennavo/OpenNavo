package changelog

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSourceURLHasNoQueryOrCredentials(t *testing.T) {
	require.Equal(t, "https://api.github.com/repos/Homebrew/homebrew-cask/commits", SourceURL("homebrew_commits", map[string]any{"repo": "Homebrew/homebrew-cask", "path": "Casks/a/app.rb"}))
	require.Equal(t, "https://api.github.com/repos/iina/iina/releases", SourceURL("github_releases", map[string]any{"repo": "iina/iina"}))
	require.Empty(t, SourceURL("sparkle", map[string]any{"repo": "a/b"}))
	require.Empty(t, SourceURL("homebrew_commits", map[string]any{"repo": "a/b?token=x"}))
	require.Equal(t, "https://example.com/feed", RedactURL("https://user:ghp_secret@example.com/feed?access_token=ghp_secret#x"))
}
