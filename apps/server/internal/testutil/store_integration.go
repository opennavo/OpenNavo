//go:build integration

package testutil

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/migrations"
	"github.com/pressly/goose/v3"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func NewStore(t *testing.T) *store.Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pg, err := postgres.Run(ctx, "postgres:18", postgres.WithDatabase("opennavo_test"), postgres.WithUsername("opennavo"), postgres.WithPassword("isolated-test-only"), postgres.BasicWaitStrategies())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, pg.Terminate(context.Background())) })
	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	rdb, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: testcontainers.ContainerRequest{Image: "public.ecr.aws/docker/library/redis:8", ExposedPorts: []string{"6379/tcp"}, WaitingFor: wait.ForAll(wait.ForLog("Ready to accept connections"), wait.ForListeningPort("6379/tcp"))}, Started: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, rdb.Terminate(context.Background())) })
	host, err := rdb.Host(ctx)
	require.NoError(t, err)
	port, err := rdb.MappedPort(ctx, "6379/tcp")
	require.NoError(t, err)
	st, err := store.Open(ctx, config.Config{DatabaseURL: dsn, RedisURL: fmt.Sprintf("redis://%s:%s/0", host, port.Port()), DBMaxOpenConns: 5})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, st.Close()) })
	sqlDB, err := st.DB.DB()
	require.NoError(t, err)
	goose.SetBaseFS(migrations.Files)
	require.NoError(t, goose.SetDialect("postgres"))
	require.NoError(t, goose.UpContext(ctx, sqlDB, "."))
	return st
}
