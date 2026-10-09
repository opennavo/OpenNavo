package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type Backend interface {
	Load(context.Context, string) ([]byte, error)
	Save(context.Context, string, []byte, time.Duration) error
}

func ReadThrough[T any](ctx context.Context, backend Backend, key string, ttl time.Duration, load func(context.Context) (T, error)) (T, error) {
	var value T
	if backend != nil {
		if data, err := backend.Load(ctx, key); err == nil && json.Unmarshal(data, &value) == nil {
			return value, nil
		}
	}
	value, err := load(ctx)
	if err != nil {
		return value, err
	}
	if backend != nil {
		if data, encodeErr := json.Marshal(value); encodeErr == nil {
			_ = backend.Save(ctx, key, data, ttl)
		}
	}
	return value, nil
}
func PublishInvalidation(ctx context.Context, client *redis.Client, patterns ...string) error {
	for _, pattern := range patterns {
		if !validPattern(pattern) {
			return errors.New("invalid cache pattern")
		}
	}
	data, err := json.Marshal(struct {
		Patterns []string `json:"patterns"`
	}{patterns})
	if err != nil {
		return err
	}
	return client.Publish(ctx, invalidationChannel(client), data).Err()
}

func invalidationChannel(client *redis.Client) string {
	// Redis pub/sub ignores the SELECT database number; non-default databases need separate channels.
	if client.Options().DB == 0 {
		return "cache:invalidate"
	}
	return fmt.Sprintf("cache:invalidate:db:%d", client.Options().DB)
}
func validPattern(pattern string) bool {
	return strings.HasPrefix(pattern, "c:") && len(pattern) > 2 && len(pattern) <= 256 && !strings.ContainsAny(pattern, "\r\n")
}
func Invalidate(ctx context.Context, client *redis.Client, patterns []string) error {
	for _, pattern := range patterns {
		if !validPattern(pattern) {
			return errors.New("invalid cache pattern")
		}
		var cursor uint64
		for {
			keys, next, err := client.Scan(ctx, cursor, pattern, 100).Result()
			if err != nil {
				return err
			}
			if len(keys) > 0 {
				if err := client.Unlink(ctx, keys...).Err(); err != nil {
					return err
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	return nil
}
func Subscribe(ctx context.Context, client *redis.Client, logger *slog.Logger, targets ...*redis.Client) (func(), error) {
	child, cancel := context.WithCancel(ctx)
	sub := client.Subscribe(child, invalidationChannel(client))
	if _, err := sub.Receive(child); err != nil {
		cancel()
		_ = sub.Close()
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = sub.Close() }()
		for {
			message, err := sub.ReceiveMessage(child)
			if err != nil {
				if child.Err() != nil {
					return
				}
				logger.WarnContext(child, "cache subscription unavailable")
				continue
			}
			var payload struct {
				Patterns []string `json:"patterns"`
			}
			if json.Unmarshal([]byte(message.Payload), &payload) != nil {
				continue
			}
			// Keep business-local authorization caches invalidated too. Publishers
			// stay on the business connection; disposable cache storage may differ.
			seen := map[*redis.Client]bool{}
			for _, target := range append([]*redis.Client{client}, targets...) {
				if target == nil || seen[target] {
					continue
				}
				seen[target] = true
				if err := Invalidate(child, target, payload.Patterns); err != nil && child.Err() == nil {
					logger.WarnContext(child, "cache invalidation failed")
				}
			}
		}
	}()
	return func() { cancel(); _ = sub.Close(); <-done }, nil
}
