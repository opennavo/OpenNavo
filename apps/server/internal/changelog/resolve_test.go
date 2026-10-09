package changelog

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func reply(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}
func TestResolveOnlyHomebrewWithoutRequests(t *testing.T) {
	r := NewResolver("test")
	r.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("resolve must not request upstream")
		return nil, nil
	})
	sources, _, err := r.Resolve(context.Background(), Candidate{Kind: "cask", Token: "app", Homepage: "https://github.com/example/app", RubySourcePath: "Casks/a/app.rb"})
	require.NoError(t, err)
	require.Len(t, sources, 1)
	require.Equal(t, "homebrew_commits", sources[0].Type)
	for _, typ := range []string{"github_releases", "sparkle", "webpage"} {
		f := NewFetcher("test")
		f.HTTP = r
		_, err := f.Fetch(context.Background(), Candidate{}, FetchSource{Type: typ})
		require.Error(t, err)
	}
}
