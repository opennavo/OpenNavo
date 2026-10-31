package changelog

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Fixtures are the first page (per_page=5) of GET /repos/{repo}/releases recorded anonymously on 2026-10-31,
// trimmed to the fields the fetcher reads. They carry no credentials.
func fixtureFetcher(t *testing.T, file string, header http.Header) (*Fetcher, *int) {
	t.Helper()
	body, err := os.ReadFile("testdata/github_releases/" + file) //nolint:gosec // file comes only from the fixed fixture names in this package.
	require.NoError(t, err)
	calls := 0
	f := NewFetcher("test")
	f.HTTP.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "api.github.com", r.URL.Host)
		require.Equal(t, "100", r.URL.Query().Get("per_page"))
		response := reply(http.StatusOK, string(body))
		for key, values := range header {
			response.Header[key] = values
		}
		return response, nil
	})
	return f, &calls
}

func TestGitHubReleasesRecordedApps(t *testing.T) {
	for _, tc := range []struct {
		file, repo string
		versions   []string
		prerelease map[string]bool
	}{
		{"rectangle.json", "rxhanson/Rectangle", []string{"2.0.4", "2.0.3", "2.0.2", "2.0.1", "2.0"}, nil},
		{"iina.json", "iina/iina", []string{"1.5.0", "1.5.0-beta2", "1.5.0-beta1", "1.4.4", "1.4.3"}, map[string]bool{"1.5.0-beta2": true, "1.5.0-beta1": true}},
		{"stats.json", "exelban/stats", []string{"3.0.23", "3.0.22", "3.0.21", "3.0.20", "3.0.19"}, nil},
		{"monitorcontrol.json", "MonitorControl/MonitorControl", []string{"4.4.0", "4.3.3", "4.3.2", "4.2.0", "4.1.0"}, nil},
		{"maccy.json", "p0deje/Maccy", []string{"2.8.0", "2.7.1", "2.7.0", "2.6.1", "2.6.0"}, nil},
	} {
		t.Run(tc.repo, func(t *testing.T) {
			f, _ := fixtureFetcher(t, tc.file, http.Header{"Etag": {`W/"recorded"`}})
			result, err := f.Fetch(context.Background(), Candidate{}, FetchSource{Type: "github_releases", Config: map[string]any{"repo": tc.repo}})
			require.NoError(t, err)
			require.Equal(t, `W/"recorded"`, result.ETag)
			require.Len(t, result.Releases, len(tc.versions))
			for i, release := range result.Releases {
				require.Equal(t, tc.versions[i], release.Version)
				require.Equal(t, tc.prerelease[release.Version], release.Prerelease)
				require.NotEmpty(t, release.Body, release.Tag)
				require.Len(t, release.BodyHash, 64)
				require.NotNil(t, release.PublishedAt)
				require.True(t, strings.HasPrefix(release.SourceURL, "https://github.com/"+tc.repo+"/releases/"), release.SourceURL)
				require.NotContains(t, release.Body, "<script")
			}
		})
	}
}

func TestGitHubReleasesSkipDraftsAndSanitize(t *testing.T) {
	f := NewFetcher("test")
	long := strings.Repeat("a", 300*1024)
	f.HTTP.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		return reply(200, `[{"tag_name":"v3.0","draft":true,"body":"secret"},
{"tag_name":"v2.0-rc.1","prerelease":true,"name":"RC","body":"<script>alert(1)</script>**rc**","published_at":"2026-10-01T00:00:00Z","html_url":"https://evil.example/x"},
{"tag_name":"nightly","body":"n"},
{"tag_name":"app-1.9","name":"`+strings.Repeat("t", 400)+`","body":"`+long+`","published_at":"2026-09-01T00:00:00Z"}]`), nil
	})
	result, err := f.Fetch(context.Background(), Candidate{}, FetchSource{Type: "github_releases", Config: map[string]any{"repo": "owner/app"}})
	require.NoError(t, err)
	require.Len(t, result.Releases, 2)
	rc := result.Releases[0]
	require.Equal(t, "2.0-rc.1", rc.Version)
	require.True(t, rc.Prerelease)
	require.Equal(t, "alert(1)**rc**", rc.Body)
	require.Equal(t, "https://github.com/owner/app/releases/tag/v2.0-rc.1", rc.SourceURL)
	old := result.Releases[1]
	require.Equal(t, "1.9", old.Version)
	require.LessOrEqual(t, len(old.Body), 200*1024)
	require.Contains(t, old.Body, "truncated")
	require.Len(t, []rune(old.Title), releaseTitleMaxRune)
}

func TestGitHubReleasesConditionalRequest(t *testing.T) {
	f := NewFetcher("test")
	f.HTTP.Client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		require.Equal(t, `W/"old"`, r.Header.Get("If-None-Match"))
		return reply(http.StatusNotModified, ""), nil
	})
	result, err := f.Fetch(context.Background(), Candidate{}, FetchSource{Type: "github_releases", ETag: `W/"old"`, Config: map[string]any{"repo": "iina/iina"}})
	require.NoError(t, err)
	require.True(t, result.NotModified)
	require.Empty(t, result.Releases)
	require.Equal(t, `W/"old"`, result.ETag)
}

func TestGitHubReleasesPauseOnLowQuota(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	reset := now.Add(30 * time.Minute)
	f, calls := fixtureFetcher(t, "stats.json", http.Header{"X-Ratelimit-Remaining": {"400"}, "X-Ratelimit-Limit": {"5000"}, "X-Ratelimit-Reset": {strconv.FormatInt(reset.Unix(), 10)}})
	f.Now = func() time.Time { return now }
	source := FetchSource{Type: "github_releases", Config: map[string]any{"repo": "exelban/stats"}}
	result, err := f.Fetch(context.Background(), Candidate{}, source)
	require.NoError(t, err, "the response already paid for is still used")
	require.Len(t, result.Releases, 5)
	_, err = f.Fetch(context.Background(), Candidate{}, source)
	var rate *RateLimitError
	require.True(t, errors.As(err, &rate))
	require.Equal(t, reset.Unix(), rate.Reset.Unix())
	require.Equal(t, 1, *calls, "paused fetch must not spend a request")
	f.Now = func() time.Time { return reset.Add(time.Second) }
	_, err = f.Fetch(context.Background(), Candidate{}, source)
	require.NoError(t, err)
	require.Equal(t, 2, *calls)
}

func TestGitHubReleasesRateLimitResponses(t *testing.T) {
	reset := time.Now().Add(time.Hour).Unix()
	for _, header := range []http.Header{
		{"X-Ratelimit-Remaining": {"0"}, "X-Ratelimit-Reset": {strconv.FormatInt(reset, 10)}},
		{"Retry-After": {"60"}},
	} {
		f := NewFetcher("test")
		f.HTTP.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
			response := reply(http.StatusForbidden, "")
			response.Header = header
			return response, nil
		})
		_, err := f.Fetch(context.Background(), Candidate{}, FetchSource{Type: "github_releases", Config: map[string]any{"repo": "a/b"}})
		var rate *RateLimitError
		require.True(t, errors.As(err, &rate), header)
	}
}

func TestReleaseTagNormalization(t *testing.T) {
	for tag, want := range map[string]string{"v1.5.0": "1.5.0", "V2.0": "2.0", "2.8.0": "2.8.0", "v1.5.0-beta2": "1.5.0-beta2",
		"release-3.1": "3.1", "Rectangle-0.86": "0.86", "desktop-v1.2.3": "1.2.3", "nightly": "", "latest": ""} {
		require.Equal(t, want, ReleaseVersion(tag, "owner/Rectangle"), tag)
	}
	for left, right := range map[string]string{"2.0": "2.0.0", "v1.4.4": "1.4.4", "1.2.3,456": "1.2.3", "3.0-RC1": "3.0.0-rc1"} {
		require.Equal(t, VersionKey(left), VersionKey(right), left)
	}
	require.NotEqual(t, VersionKey("1.10"), VersionKey("1.1"))
	require.NotEqual(t, VersionKey("2.0-beta1"), VersionKey("2.0"))
}

func TestResolveGitHubReleasesFromVerifiedRepo(t *testing.T) {
	r := NewResolver("test")
	r.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("resolve must not request upstream")
		return nil, nil
	})
	sources, stats, err := r.Resolve(context.Background(), Candidate{Kind: "cask", Token: "iina", RubySourcePath: "Casks/i/iina.rb", GitHubRepo: "iina/iina"})
	require.NoError(t, err)
	require.Len(t, sources, 2)
	require.Equal(t, "github_releases", sources[1].Type)
	require.Equal(t, "iina/iina", sources[1].Config["repo"])
	require.Equal(t, true, stats["github"])
	sources, _, err = r.Resolve(context.Background(), Candidate{Kind: "formula", Token: "x", GitHubRepo: "bad/../repo"})
	require.NoError(t, err)
	require.Empty(t, sources)
	sources, _, err = r.Resolve(context.Background(), Candidate{Kind: "link", Token: "x", GitHubRepo: "owner/app"})
	require.NoError(t, err)
	require.Len(t, sources, 1)
}
