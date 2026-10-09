package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFixtureRejectsDevelopmentAndNonlocalDatabase(t *testing.T) {
	prefix := "G-0123456789"
	require.NoError(t, validate("dev", "postgres://test@127.0.0.1:55432/opennavo_e2e", prefix))
	for _, database := range []string{"postgres://test@127.0.0.1:55432/opennavo", "postgres://test@remote:55432/opennavo_e2e", "postgres://test@127.0.0.1:5432/opennavo_e2e", ""} {
		require.Error(t, validate("dev", database, prefix))
	}
	require.Error(t, validate("prod", "postgres://test@127.0.0.1:55432/opennavo_e2e", prefix))
	require.Error(t, validate("dev", "postgres://test@127.0.0.1:55432/opennavo_e2e", "F3-0123456789"))
}
