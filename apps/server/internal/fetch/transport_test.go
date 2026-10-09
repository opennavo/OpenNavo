package fetch

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDNSBoundaryRejectsMixedAddressesAndPinsValidatedIP(t *testing.T) {
	ctx := context.Background()
	for _, addresses := range [][]netip.Addr{
		{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("169.254.169.254")},
		{netip.MustParseAddr("::ffff:10.0.0.1")}, {},
	} {
		dialed := false
		_, err := publicDial(ctx, "tcp", "public.example:443", func(context.Context, string, string) ([]netip.Addr, error) { return addresses, nil },
			func(context.Context, string, string) (net.Conn, error) {
				dialed = true
				return nil, errors.New("unexpected dial")
			})
		require.Error(t, err)
		require.False(t, dialed)
	}
	resolved, attempts := 0, []string{}
	_, err := publicDial(ctx, "tcp", "public.example:443", func(_ context.Context, network, host string) ([]netip.Addr, error) {
		resolved++
		require.Equal(t, "ip", network)
		require.Equal(t, "public.example", host)
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("2606:4700:4700::1111")}, nil
	}, func(_ context.Context, _, target string) (net.Conn, error) {
		attempts = append(attempts, target)
		return nil, errors.New("offline dial fixture")
	})
	require.Error(t, err)
	require.Equal(t, 1, resolved)
	require.Equal(t, []string{"8.8.8.8:443", "[2606:4700:4700::1111]:443"}, attempts)
}

func TestLiveHTTPRedirectLimitPrivateRedirectAndTotalTimeout(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch r.URL.Path {
		case "/private":
			http.Redirect(w, r, "http://169.254.169.254/meta", http.StatusFound)
		case "/slow":
			select {
			case <-r.Context().Done():
			case <-time.After(time.Second):
			}
		case "/redirect":
			hops, _ := strconv.Atoi(r.URL.Query().Get("hops"))
			if hops > 0 {
				http.Redirect(w, r, "http://public.example/redirect?hops="+strconv.Itoa(hops-1), http.StatusFound)
				return
			}
			_, _ = io.WriteString(w, "done")
		}
	}))
	defer server.Close()
	client := NewClient(100 * time.Millisecond)
	transport := client.Transport.(*http.Transport)
	defer transport.CloseIdleConnections()
	transport.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
		return publicDial(ctx, network, target, func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}, func(ctx context.Context, network, pinned string) (net.Conn, error) {
			if !strings.HasPrefix(pinned, "8.8.8.8:") {
				return nil, errors.New("unpinned DNS")
			}
			// The only connection stub targets a test server on a random port; no external requests are sent.
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		})
	}
	response, err := client.Get("http://public.example/redirect?hops=5")
	require.NoError(t, err)
	data, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.Equal(t, "done", string(data))
	require.Equal(t, int64(6), requests.Load())
	requestError := func(target string) error {
		response, err := client.Get(target)
		if response != nil {
			_ = response.Body.Close()
		}
		return err
	}
	err = requestError("http://public.example/redirect?hops=6")
	require.ErrorContains(t, err, "too many upstream redirects")
	before := requests.Load()
	err = requestError("http://public.example/private")
	require.ErrorContains(t, err, "not public")
	require.Equal(t, before+1, requests.Load())
	err = requestError("http://public.example/slow")
	var timedOut net.Error
	require.ErrorAs(t, err, &timedOut)
	require.True(t, timedOut.Timeout())
}
