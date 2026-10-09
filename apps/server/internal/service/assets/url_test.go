package assets

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type imageURLTransport func(*http.Request) (*http.Response, error)

func (f imageURLTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDownloadURLBoundary(t *testing.T) {
	for _, target := range []string{"http://example.com/icon.png", "https://127.0.0.1/icon", "https://[::1]/icon", "https://user:pass@example.com/icon", "file:///icon"} {
		t.Run(target, func(t *testing.T) {
			service := &Service{URLClient: &http.Client{Transport: imageURLTransport(func(*http.Request) (*http.Response, error) { t.Fatal("invalid URL reached network"); return nil, nil })}}
			if _, err := service.DownloadURL(context.Background(), target); err == nil {
				t.Fatal("invalid URL accepted")
			}
		})
	}
	for _, tc := range []struct {
		name, location, body string
		status               int
		size                 int64
		want                 bool
	}{
		{name: "success", body: "image bytes", status: 200, size: 11, want: true},
		{name: "status", status: 404},
		{name: "declared oversized", status: 200, size: 5*1024*1024 + 1},
		{name: "stream oversized", status: 200, size: -1, body: strings.Repeat("x", 5*1024*1024+1)},
		{name: "downgrade", status: 302, location: "http://example.com/icon"},
		{name: "private redirect", status: 302, location: "https://127.0.0.1/icon"},
		{name: "redirect loop", status: 302, location: "https://example.com/icon"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &Service{URLClient: &http.Client{Transport: imageURLTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Scheme != "https" || r.URL.Host != "example.com" {
					t.Fatal("unsafe destination")
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Location": {tc.location}}, Body: io.NopCloser(strings.NewReader(tc.body)), ContentLength: tc.size, Request: r}, nil
			})}}
			data, err := service.DownloadURL(context.Background(), "https://example.com/icon")
			if (err == nil) != tc.want {
				t.Fatalf("success = %v, want %v", err == nil, tc.want)
			}
			if tc.want && string(data) != tc.body {
				t.Fatal("body mismatch")
			}
		})
	}
}
