package changelog

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTagVersions(t *testing.T) {
	for tag, want := range map[string]string{"v1.2.3": "1.2.3", "V1.2": "1.2", "release-2.0.0-rc.1": "2.0.0-rc.1", "release/2.4": "2.4", "editor_3.1": "3.1", "editor-3.1": "3.1", "tip": "", "nightly": "", "latest": ""} {
		require.Equal(t, want, TagVersion(tag, "owner/editor"))
	}

}
func TestHomebrewCommitHistoryAndBottleExclusion(t *testing.T) {
	f := NewFetcher("test")
	f.HTTP.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "Casks/v/visual-studio-code.rb", r.URL.Query().Get("path"))
		return reply(200, `[{"sha":"abc","commit":{"message":"visual-studio-code 1.140.0\n\nBump","committer":{"date":"2026-09-30T01:00:00Z"}}},{"sha":"def","commit":{"message":"visual-studio-code: update to 1.139.0","author":{"date":"2026-09-23T01:00:00Z"}}},{"commit":{"message":"visual-studio-code: update 1.140.0 bottle."}},{"commit":{"message":"Unrelated cleanup"}}]`), nil
	})
	source := FetchSource{Type: "homebrew_commits", Config: map[string]any{"repo": "Homebrew/homebrew-cask", "path": "Casks/v/visual-studio-code.rb"}}
	result, err := f.Fetch(context.Background(), Candidate{Token: "visual-studio-code"}, source)
	require.NoError(t, err)
	require.Len(t, result.Versions, 2)
	require.Equal(t, "1.140.0", result.Versions[0].Version)
	require.False(t, result.Versions[1].CommittedAt.IsZero())
	since := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	source.Since = &since
	f.HTTP.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "2026-09-30T00:00:00Z", r.URL.Query().Get("since"))
		return reply(304, ""), nil
	})
	result, err = f.Fetch(context.Background(), Candidate{}, source)
	require.NoError(t, err)
	require.True(t, result.NotModified)
}
func TestFetchErrorsAndMarkdownSanitizing(t *testing.T) {
	f := NewFetcher("test")
	for _, source := range []FetchSource{{Type: "invalid"}, {Type: "github_releases", Config: map[string]any{"repo": "../bad"}}, {Type: "homebrew_commits", Config: map[string]any{"repo": "bad"}}, {Type: "sparkle", Config: map[string]any{"url": "http://127.0.0.1/private"}}, {Type: "webpage"}} {
		_, err := f.Fetch(context.Background(), Candidate{}, source)
		require.Error(t, err)
	}
	for _, typ := range []string{"github_releases", "homebrew_commits", "sparkle", "webpage"} {
		source := FetchSource{Type: typ, Config: map[string]any{"repo": "Homebrew/homebrew-cask", "path": "Casks/a/app.rb", "url": "https://example.com/feed", "urlTemplate": "https://example.com/{version}"}}
		for _, status := range []int{404, 403, 429} {
			f.HTTP.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
				r := reply(status, "invalid")
				r.Header.Set("X-Ratelimit-Reset", "9999999999")
				return r, nil
			})
			_, err := f.Fetch(context.Background(), Candidate{}, source)
			require.Error(t, err)
		}
		f.HTTP.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) { return reply(200, "invalid"), nil })
		_, err := f.Fetch(context.Background(), Candidate{}, source)
		require.Error(t, err)
	}
	source := FetchSource{Type: "github_releases", Config: map[string]any{"repo": "a/b"}}
	f.HTTP.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("network unavailable") })
	_, err := f.Fetch(context.Background(), Candidate{}, source)
	require.Error(t, err)
	normalized, hash := NormalizeMarkdown("<!-- comment -->\n<b>Text</b>\n\n\n![alt](https://example.com/img)\n`<T>`\n```cpp\n<T>\n```")
	require.Len(t, hash, 64)
	require.NotContains(t, normalized, "comment")
	require.NotContains(t, normalized, "<b>")
	require.Contains(t, normalized, "[Image: alt]")
	require.Contains(t, normalized, "`<T>`")
	require.Contains(t, normalized, "```cpp\n<T>")
	require.NotContains(t, normalized, "\n\n\n")
	large, _ := NormalizeMarkdown(strings.Repeat("中", 100000))
	require.LessOrEqual(t, len(large), 200*1024)
	require.True(t, strings.HasSuffix(large, "(Source text truncated because it is too long)"))
}
