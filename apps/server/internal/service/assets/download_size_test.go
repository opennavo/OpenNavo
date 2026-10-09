package assets

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type sizeTransport func(*http.Request) (*http.Response, error)

func (f sizeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestHEADHeadersRedirectLimitAndPerDomainRate(t *testing.T) {
	t.Run("headers", func(t *testing.T) {
		f := NewHEADFetcher("test-agent")
		f.Client.Transport = sizeTransport(func(r *http.Request) (*http.Response, error) {
			require.Equal(t, "HEAD", r.Method)
			require.Equal(t, "test-agent", r.Header.Get("User-Agent"))
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), ContentLength: 123, Header: http.Header{}}, nil
		})
		n, err := f.Size(context.Background(), "https://download.example.test/app.dmg")
		require.NoError(t, err)
		require.Equal(t, int64(123), *n)
		_, err = f.Size(context.Background(), "http://127.0.0.1/private")
		require.Error(t, err)
		f.Client.Transport = sizeTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), ContentLength: -1, Header: http.Header{}}, nil
		})
		n, err = f.Size(context.Background(), "https://download.example.test/app.dmg")
		require.NoError(t, err)
		require.Nil(t, n)
	})
	t.Run("redirects", func(t *testing.T) {
		f := NewHEADFetcher("test-agent")
		calls := 0
		f.Client.Transport = sizeTransport(func(*http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: 302, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{"Location": {fmt.Sprintf("https://hop%d.example.test/file", calls)}}}, nil
		})
		_, err := f.Size(context.Background(), "https://first.example.test/file")
		require.Error(t, err)
		require.Equal(t, 6, calls)
	})
	t.Run("domain", func(t *testing.T) {
		transport := &LimitedTransport{Base: sizeTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
		})}
		invoke := func(r *http.Request) error {
			response, err := transport.RoundTrip(r)
			if response != nil {
				_ = response.Body.Close()
			}
			return err
		}
		first, err := http.NewRequestWithContext(context.Background(), "HEAD", "https://one.example.test/file", nil)
		require.NoError(t, err)
		err = invoke(first)
		require.NoError(t, err)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		second := first.Clone(ctx)
		err = invoke(second)
		require.Error(t, err)
		other, err := http.NewRequestWithContext(ctx, "HEAD", "https://two.example.test/file", nil)
		require.NoError(t, err)
		err = invoke(other)
		require.NoError(t, err)
	})
}

// Even reading one byte is forbidden; cancel and close immediately when Range is ignored.
type unreadBody struct {
	t      *testing.T
	closed bool
}

func (b *unreadBody) Read([]byte) (int, error) {
	b.t.Fatal("download response body must not be read")
	return 0, io.EOF
}
func (b *unreadBody) Close() error { b.closed = true; return nil }
func TestRangeFallbackDoesNotDownloadBody(t *testing.T) {
	for _, tc := range []struct {
		status int
		header string
		found  bool
	}{{206, "bytes 0-0/987654", true}, {200, "", false}, {206, "bytes 0-0/*", false}, {206, "bytes 0-1/100", false}, {206, "bytes 0-0/0", false}, {206, "bytes 0-0/99999999999999999999", false}} {
		t.Run(fmt.Sprint(tc.status, tc.header), func(t *testing.T) {
			f := NewHEADFetcher("test")
			calls := 0
			body := &unreadBody{t: t}
			f.Client.Transport = sizeTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method == http.MethodHead {
					return &http.Response{StatusCode: 405, Body: http.NoBody, ContentLength: -1, Header: http.Header{}}, nil
				}
				require.Equal(t, "bytes=0-0", r.Header.Get("Range"))
				require.Equal(t, "identity", r.Header.Get("Accept-Encoding"))
				return &http.Response{StatusCode: tc.status, Body: body, Header: http.Header{"Content-Range": {tc.header}}}, nil
			})
			value, err := f.Size(context.Background(), "https://example.test/app.dmg")
			require.NoError(t, err)
			require.Equal(t, 2, calls)
			require.True(t, body.closed)
			if tc.found {
				require.NotNil(t, value)
				require.EqualValues(t, 987654, *value)
			} else {
				require.Nil(t, value)
			}
		})
	}
}
