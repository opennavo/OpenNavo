package homebrew

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

type trackedBody struct {
	io.Reader
	closed bool
}

func (body *trackedBody) Close() error { body.closed = true; return nil }

func TestConditionalCatalogStreaming(t *testing.T) {
	client := NewClient("https://example.com/api/", "test-agent")
	body := &trackedBody{Reader: strings.NewReader(`[{"token":"test","name":["Test"],"version":"1"}]`)}
	previous := Conditional{ETag: `"old"`, LastModified: "Sun, 04 Oct 2026 00:00:00 GMT"}
	client.HTTP = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		require.Equal(t, "/api/cask.json", request.URL.Path)
		require.Equal(t, "test-agent", request.Header.Get("User-Agent"))
		require.Equal(t, previous.ETag, request.Header.Get("If-None-Match"))
		require.Equal(t, previous.LastModified, request.Header.Get("If-Modified-Since"))
		return &http.Response{StatusCode: 200, Header: http.Header{"Etag": {`"new"`}, "Last-Modified": {"Mon, 05 Oct 2026 00:00:00 GMT"}}, Body: body}, nil
	})}
	var items []Package
	result, err := client.Stream(context.Background(), "cask", previous, func(item Package) error { items = append(items, item); return nil })
	require.NoError(t, err)
	require.True(t, body.closed)
	require.Equal(t, 1, result.Fetched)
	require.Len(t, items, 1)
	require.Equal(t, `"new"`, result.ETag)
	require.False(t, result.NotModified)
	client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 304, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	unchanged, err := client.Stream(context.Background(), "formula", result.Conditional, func(Package) error { t.Fatal("304 must not process an item"); return nil })
	require.NoError(t, err)
	require.True(t, unchanged.NotModified)
	require.Equal(t, result.Conditional, unchanged.Conditional)
}

func TestStreamingFailuresNeverReturnNewConditionalHeaders(t *testing.T) {
	for _, example := range []struct {
		Name, Body    string
		Status        int
		Limit, Length int64
		ConsumerError bool
	}{
		{"wrong_shape", `{}`, 200, CatalogLimit, -1, false},
		{"truncated_item", `[{"token":`, 200, CatalogLimit, -1, false},
		{"truncated_array", `[{"token":"test"}`, 200, CatalogLimit, -1, false},
		{"trailing_object", `[] {}`, 200, CatalogLimit, -1, false},
		{"bad_item", `[{"name":"bad"}]`, 200, CatalogLimit, -1, false},
		{"too_large_header", `[]`, 200, 1, 2, false},
		{"too_large_stream", `[{"token":"test"}]`, 200, 8, -1, false},
		{"too_large_whitespace", `[]          `, 200, 4, -1, false},
		{"upstream_failed", `[]`, 503, CatalogLimit, -1, false},
		{"consumer_failed", `[{"token":"test"}]`, 200, CatalogLimit, -1, true},
	} {
		t.Run(example.Name, func(t *testing.T) {
			client := NewClient("https://example.com", "test")
			client.Limit = example.Limit
			body := &trackedBody{Reader: strings.NewReader(example.Body)}
			client.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: example.Status, ContentLength: example.Length, Body: body, Header: http.Header{"Etag": {`"must-not-save"`}}}, nil
			})}
			result, err := client.Stream(context.Background(), "cask", Conditional{}, func(Package) error {
				if example.ConsumerError {
					return errors.New("database failed")
				}
				return nil
			})
			require.Error(t, err)
			require.Empty(t, result.ETag)
			require.True(t, body.closed)
		})
	}
	client := NewClient("https://example.com", "test")
	client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("transport failed") })
	_, err := client.Stream(context.Background(), "cask", Conditional{}, func(Package) error { return nil })
	require.Error(t, err)
	_, err = client.Stream(context.Background(), "invalid", Conditional{}, nil)
	require.Error(t, err)
	client.BaseURL = "://bad"
	_, err = client.Stream(context.Background(), "cask", Conditional{}, nil)
	require.Error(t, err)
	client.BaseURL = "http://127.0.0.1"
	_, err = client.Stream(context.Background(), "cask", Conditional{}, nil)
	require.Error(t, err)
}
