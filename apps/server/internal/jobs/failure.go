package jobs

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"

	"github.com/opennavo/opennavo/server/internal/changelog"
)

// Extract fixed categories only from error types; third-party responses, URLs, paths and credentials must never enter job ledgers or logs.
func failureCategory(err error) string {
	switch {
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return "storage_full"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied"
	case errors.Is(err, syscall.EROFS):
		return "read_only_filesystem"
	case errors.Is(err, syscall.EIO):
		return "storage_io"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "network_timeout"
	}
	var operationError *net.OpError
	if errors.As(err, &operationError) {
		return "network_error"
	}
	category, _ := changelog.Failure(err)
	return category
}
