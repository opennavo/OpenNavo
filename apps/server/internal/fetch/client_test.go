package fetch

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSSRFAddressRules(t *testing.T) {
	for _, text := range []string{"127.0.0.1", "0.0.0.0", "0.1.2.3", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255", "192.0.0.1", "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "2001::1", "2002:7f00:1::"} {
		require.False(t, PublicAddress(netip.MustParseAddr(text)), text)
	}
	for _, text := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		require.True(t, PublicAddress(netip.MustParseAddr(text)), text)
	}
	require.False(t, PublicAddress(netip.Addr{}))
}

func TestURLAndRedirectRestrictions(t *testing.T) {
	for _, text := range []string{"file:///etc/passwd", "ftp://example.com", "http://localhost@8.8.8.8", "http://127.0.0.1", "http://[::1]", "http:///missing"} {
		target, err := url.Parse(text)
		require.NoError(t, err)
		require.Error(t, ValidateURL(target))
	}
	require.Error(t, ValidateURL(nil))
	target, err := url.Parse("https://example.com/icon.png")
	require.NoError(t, err)
	require.NoError(t, ValidateURL(target))
	client := NewClient(time.Second)
	require.NoError(t, client.CheckRedirect(&http.Request{URL: target}, []*http.Request{{}}))
	require.Error(t, client.CheckRedirect(&http.Request{URL: target}, make([]*http.Request, 6)))
	target.Host = "127.0.0.1"
	require.Error(t, client.CheckRedirect(&http.Request{URL: target}, []*http.Request{{}}))
	transport := client.Transport.(*http.Transport)
	require.Nil(t, transport.Proxy)
	for _, address := range []string{"127.0.0.1:80", "localhost:80", "malformed"} {
		_, err := transport.DialContext(context.Background(), "tcp", address)
		require.Error(t, err)
	}
}
