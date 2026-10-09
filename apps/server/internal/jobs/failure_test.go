package jobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"syscall"
	"testing"

	"github.com/hibiken/asynq"
	"github.com/opennavo/opennavo/server/internal/changelog"
	"github.com/stretchr/testify/require"
)

func TestFailureDiagnosticsPreserveCategoriesWithoutSecrets(t *testing.T) {
	const secret = "secret-upstream-token"
	for _, tc := range []struct {
		name, category string
		err            error
	}{
		{"disk_full", "storage_full", &os.PathError{Op: "write", Path: "/tmp/" + secret, Err: syscall.ENOSPC}},
		{"quota", "storage_full", syscall.EDQUOT},
		{"permission", "permission_denied", os.ErrPermission},
		{"read_only", "read_only_filesystem", syscall.EROFS},
		{"io", "storage_io", syscall.EIO},
		{"deadline", "deadline_exceeded", context.DeadlineExceeded},
		{"canceled", "canceled", context.Canceled},
		{"network", "network_error", &net.OpError{Op: "dial", Net: secret, Err: syscall.ECONNREFUSED}},
		{"timeout", "network_timeout", &net.DNSError{Name: secret, IsTimeout: true}},
		{"github_500", "upstream_server_error", &changelog.StatusError{Status: 500}},
		{"github_auth", "upstream_unauthorized", &changelog.StatusError{Status: 401}},
		{"github_quota", "upstream_rate_limited", &changelog.RateLimitError{}},
		{"github_read", "response_read_failed", &changelog.Error{Kind: "response_read_failed", Cause: errors.New(secret)}},
		{"github_timeout", "deadline_exceeded", &changelog.Error{Kind: "connection_failed", Cause: context.DeadlineExceeded}},
		{"unknown", "unknown", errors.New(secret + " no space left on device")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
			t.Cleanup(func() { slog.SetDefault(previous) })
			ledger := &testLedger{}
			err := WrapHandler(ledger, nil, func(context.Context, Payload) (map[string]any, error) {
				return nil, fmt.Errorf("%s: %w", secret, errors.Join(tc.err, asynq.SkipRetry))
			})(context.Background(), asynq.NewTask("catalog:sync", []byte(`{}`)))
			require.ErrorIs(t, err, asynq.SkipRetry)
			require.Equal(t, "failed", ledger.status)
			require.NotContains(t, err.Error(), secret)
			require.NotContains(t, *ledger.message, secret)
			require.NotContains(t, output.String(), secret)
			require.Contains(t, output.String(), `"errorCategory":"`+tc.category+`"`)
			require.Contains(t, output.String(), `"jobType":"catalog:sync"`)
			require.Contains(t, output.String(), `"runId":1`)
			if tc.category != "unknown" {
				require.Contains(t, err.Error(), "("+tc.category+")")
				require.Contains(t, *ledger.message, "("+tc.category+")")
			}
		})
	}
}
