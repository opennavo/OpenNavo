package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type Redis struct{ Client *redis.Client }

func (r Redis) Load(ctx context.Context, key string) ([]byte, error) {
	return r.Client.Get(ctx, key).Bytes()
}
func (r Redis) Save(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	// Query caches are disposable and must not admit unbounded entries or TTLs.
	if len(value) > 512*1024 {
		return r.Client.Unlink(ctx, key).Err()
	}
	if ttl <= 0 || ttl > time.Hour {
		ttl = time.Hour
	}
	return r.Client.Set(ctx, key, value, ttl).Err()
}
