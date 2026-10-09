package cache

import (
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestInvalidationChannelIncludesNonDefaultRedisDatabase(t *testing.T) {
	for number, expected := range map[int]string{0: "cache:invalidate", 9: "cache:invalidate:db:9", 10: "cache:invalidate:db:10"} {
		client := redis.NewClient(&redis.Options{DB: number})
		require.Equal(t, expected, invalidationChannel(client))
		require.NoError(t, client.Close())
	}
}
