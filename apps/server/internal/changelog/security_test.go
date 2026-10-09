package changelog

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestChangelogResponseLimitIncludesChunkedAndInterruptedBodies(t *testing.T) {
	resolver := NewResolver("security-test")
	for _, length := range []int64{-1, 5, 1000} {
		resolver.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
			response := reply(200, strings.Repeat("a", 101))
			response.ContentLength = length
			return response, nil
		})
		_, _, _, err := resolver.readRequest(context.Background(), "https://example.com/notes", 100, nil)
		require.ErrorContains(t, err, "invalid upstream response")
	}
	resolver.Client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
		response := reply(200, "")
		response.Body = io.NopCloser(brokenReader{})
		return response, nil
	})
	_, _, _, err := resolver.readRequest(context.Background(), "https://example.com/notes", 100, nil)
	require.Error(t, err)
	for _, target := range []string{"file:///etc/passwd", "ftp://example.com", "http://169.254.169.254/meta", "http://[::ffff:127.0.0.1]/", "http://user@example.com/"} {
		_, _, _, err := resolver.readRequest(context.Background(), target, 100, nil)
		require.Error(t, err)
	}
}

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestGitHubDynamicTokenIsReadPerRequestAndNeverSentOutsideSecureGitHub(t *testing.T) {
	resolver := NewResolver("security-test")
	credential := "first-credential" // #nosec G101 -- Fictional credentials used by the offline Transport, not usable tokens.
	providerCalls, requests := 0, 0
	resolver.TokenProvider = func(context.Context) (string, error) {
		providerCalls++
		return credential, nil
	}
	resolver.Client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.URL.Scheme == "https" && req.URL.Host == "api.github.com" {
			expected := ""
			if credential != "" {
				expected = "Bearer " + credential
			}
			require.Equal(t, expected, req.Header.Get("Authorization"))
		} else {
			require.Empty(t, req.Header.Get("Authorization"))
		}
		return reply(200, "[]"), nil
	})
	for _, token := range []string{"first-credential", "replacement-credential", ""} {
		credential = token
		_, _, _, err := resolver.readRequest(context.Background(), "https://api.github.com/repos/Homebrew/homebrew-cask/commits", 100, nil)
		require.NoError(t, err)
	}
	require.Equal(t, 3, providerCalls)
	for _, target := range []string{"https://example.com/", "https://other.api.github.com/", "http://api.github.com/", "https://api.github.com:8443/"} {
		_, _, _, err := resolver.readRequest(context.Background(), target, 100, nil)
		require.NoError(t, err)
	}
	require.Equal(t, 3, providerCalls)
	previous := requests
	resolver.TokenProvider = func(context.Context) (string, error) { return "", errors.New("private-credential-echo") }
	_, _, _, err := resolver.readRequest(context.Background(), "https://api.github.com/", 100, nil)
	require.EqualError(t, err, "GitHub credential unavailable")
	require.Equal(t, previous, requests)
}

func TestGitHubRedirectDoesNotForwardPAT(t *testing.T) {
	resolver := NewResolver("security-test")
	resolver.TokenProvider = func(context.Context) (string, error) { return "unit-github-credential", nil }
	requests := 0
	resolver.Client.Transport = roundTrip(func(req *http.Request) (*http.Response, error) {
		requests++
		require.Equal(t, "api.github.com", req.URL.Host)
		require.Equal(t, "Bearer unit-github-credential", req.Header.Get("Authorization"))
		response := reply(http.StatusFound, "")
		response.Header.Set("Location", "https://other.api.github.com/steal")
		return response, nil
	})
	_, status, _, err := resolver.readRequest(context.Background(), "https://api.github.com/", 100, nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusFound, status)
	require.Equal(t, 1, requests)
}

func TestMarkdownRemovesMultilineHTMLAndPreservesAutomaticLinksAndCode(t *testing.T) {
	body, _ := NormalizeMarkdown("<!DOCTYPE html>\n<div\n class=\"release\">Changes</div>\n<script\n src=\"evil.js\">bad()</script>\n<https://example.com/notes> <user@example.com>\n`<T>`\n```html\n<div\n class=\"example\">\n```\nMore")
	require.NotContains(t, body, "<!DOCTYPE")
	require.NotContains(t, body, "<script")
	require.NotContains(t, body, "class=\"release\"")
	require.Contains(t, body, "Changes")
	require.Contains(t, body, "<https://example.com/notes> <user@example.com>")
	require.Contains(t, body, "`<T>`")
	require.Contains(t, body, "```html\n<div\n class=\"example\">\n```")
}
