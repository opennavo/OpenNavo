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

func TestAnalyticsCountsAndCategoryRequests(t *testing.T) {
	for text, want := range map[string]int64{"0": 0, "12": 12, "90,995": 90995, "1,234,567": 1234567} {
		count, err := ParseCount(text)
		require.NoError(t, err)
		require.Equal(t, want, count)
	}
	for _, text := range []string{"", "-1", "1,23", "1 000", "1.2", "2147483648", "x"} {
		_, err := ParseCount(text)
		require.Error(t, err)
	}
	for _, category := range []string{"cask", "install", "install-on-request"} {
		client := NewClient("https://example.com/api", "test-agent")
		body := &trackedBody{Reader: strings.NewReader(`{"items":[{"cask":"visual-studio-code","count":"90,995"}]}`)}
		client.HTTP.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			path := category
			if category == "cask" {
				path += "-install"
			}
			require.Equal(t, "/api/analytics/"+path+"/30d.json", request.URL.Path)
			require.Equal(t, "test-agent", request.Header.Get("User-Agent"))
			return &http.Response{StatusCode: 200, Body: body, ContentLength: -1}, nil
		})
		data, err := client.FetchAnalytics(context.Background(), category, "30d")
		require.NoError(t, err)
		require.Len(t, data.Items, 1)
		require.True(t, body.closed)
	}
}

func TestAnalyticsFailures(t *testing.T) {
	for _, example := range []struct {
		Body          string
		Status        int
		Limit, Length int64
	}{
		{`{}`, 200, CatalogLimit, -1}, {`invalid`, 200, CatalogLimit, -1}, {`{"items":[]} {}`, 200, CatalogLimit, -1},
		{`{"items":[]}    `, 200, 12, -1}, {`{}`, 503, CatalogLimit, -1}, {`{}`, 200, 1, 2},
	} {
		client := NewClient("https://example.com", "test")
		client.Limit = example.Limit
		client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: example.Status, Body: io.NopCloser(strings.NewReader(example.Body)), ContentLength: example.Length}, nil
		})
		_, err := client.FetchAnalytics(context.Background(), "cask", "30d")
		require.Error(t, err)
	}
	client := NewClient("https://example.com", "test")
	_, err := client.FetchAnalytics(context.Background(), "bad", "30d")
	require.Error(t, err)
	_, err = client.FetchAnalytics(context.Background(), "cask", "1d")
	require.Error(t, err)
	client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("network failed") })
	_, err = client.FetchAnalytics(context.Background(), "cask", "30d")
	require.Error(t, err)
	client.BaseURL = ":bad"
	_, err = client.FetchAnalytics(context.Background(), "cask", "30d")
	require.Error(t, err)
	client.BaseURL = "http://127.0.0.1"
	_, err = client.FetchAnalytics(context.Background(), "cask", "30d")
	require.Error(t, err)
}
