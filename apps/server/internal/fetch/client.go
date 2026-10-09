package fetch

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"time"
)

var blocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("::/96"), netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2002::/16"),
}

func PublicAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range blocked {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func ValidateURL(target *url.URL) error {
	if target == nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" || target.User != nil {
		return errors.New("unsupported upstream URL")
	}
	if address, err := netip.ParseAddr(target.Hostname()); err == nil && !PublicAddress(address) {
		return errors.New("upstream address is not public")
	}
	return nil
}

func NewClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
	}
	// Validate resolved addresses and connect directly to the IP to prevent DNS rebinding; do not bypass checks with environment proxies.
	transport.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
		return publicDial(ctx, network, target, net.DefaultResolver.LookupNetIP, dialer.DialContext)
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many upstream redirects")
		}
		return ValidateURL(request.URL)
	}}
}

// Injection is only for offline DNS and connection-boundary verification; production uses the default resolver and real dialer.
func publicDial(ctx context.Context, network, target string, lookup func(context.Context, string, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		return nil, errors.New("invalid upstream address")
	}
	addresses, err := lookup(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("resolve upstream: %w", err)
	}
	if len(addresses) == 0 {
		return nil, errors.New("upstream has no addresses")
	}
	for _, address := range addresses {
		if !PublicAddress(address) {
			return nil, errors.New("upstream DNS contains a non-public address")
		}
	}
	var connectionError error
	for _, address := range addresses {
		connection, err := dial(ctx, network, net.JoinHostPort(address.String(), port))
		if err == nil {
			return connection, nil
		}
		connectionError = err
	}
	return nil, fmt.Errorf("connect upstream: %w", connectionError)
}
