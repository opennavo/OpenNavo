package e2e

import (
	"context"
	"testing"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/stretchr/testify/require"
)

func TestProductionAndInvalidPasswordRejectBeforeIO(t *testing.T) {
	service := &Service{}
	_, err := service.Run(context.Background(), config.Config{AppEnv: "prod"})
	require.ErrorContains(t, err, "forbidden in prod")
	_, err = service.Run(context.Background(), config.Config{AppEnv: "dev", E2EAdminPassword: "short"})
	require.ErrorContains(t, err, "at least 10")
}
