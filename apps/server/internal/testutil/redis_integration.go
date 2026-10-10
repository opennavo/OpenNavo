//go:build integration

package testutil

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// RedisWithoutPublish keeps reads and writes working while real Redis rejects
// invalidation publications, reproducing failures after a database commit.
func RedisWithoutPublish(t *testing.T, client *redis.Client) *redis.Client {
	t.Helper()
	require.NoError(t, client.Do(context.Background(), "ACL", "SETUSER", "no-publish", "on", ">isolated-test-only", "~*", "&*", "+@all", "-publish").Err())
	options := *client.Options()
	options.Username = "no-publish"
	options.Password = "isolated-test-only"
	restricted := redis.NewClient(&options)
	t.Cleanup(func() { require.NoError(t, restricted.Close()) })
	return restricted
}
