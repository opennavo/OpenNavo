package e2e

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/config"
	"github.com/opennavo/opennavo/server/internal/service/auth"
	"github.com/opennavo/opennavo/server/internal/service/seed"
	"github.com/opennavo/opennavo/server/internal/service/snapshot"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/opennavo/opennavo/server/seeds"
)

type Service struct {
	Store   *store.Store
	Objects snapshot.Objects
	Now     func() time.Time
}

func (s *Service) Run(ctx context.Context, cfg config.Config) (map[string]any, error) {
	if cfg.AppEnv == "prod" {
		return nil, errors.New("seed-e2e is forbidden in prod")
	}
	if len(cfg.E2EAdminPassword) < 10 {
		return nil, errors.New("E2E_ADMIN_PASSWORD must contain at least 10 characters")
	}
	var stats map[string]any
	err := s.Store.WithAdvisoryLock(ctx, "seed:e2e", func(ctx context.Context) error {
		base, err := seeds.Load()
		if err != nil {
			return err
		}
		if err := s.Store.Seed(ctx, base, "", ""); err != nil {
			return err
		}
		users, err := s.Store.E2EUsers(ctx)
		if err != nil {
			return err
		}
		hashes := map[string]string{}
		for _, user := range users {
			if auth.VerifyPassword(cfg.E2EAdminPassword, user.PasswordHash) {
				hashes[user.UserName] = user.PasswordHash
			}
		}
		for _, account := range seeds.E2EAccounts() {
			if hashes[account.Username] == "" {
				hash, err := seed.HashPassword(cfg.E2EAdminPassword)
				if err != nil {
					return err
				}
				hashes[account.Username] = hash
			}
		}
		data, err := seeds.LoadE2E()
		if err != nil {
			return err
		}
		now := time.Now()
		if s.Now != nil {
			now = s.Now()
		}
		// Search insights use relative calendar dates so the 7-day tab does not remain empty once fixed fixtures age out.
		data.SearchDate = now.UTC().Truncate(24 * time.Hour)
		if err := s.prepareMedia(ctx, &data); err != nil {
			return err
		}
		if err := s.Store.SeedE2E(ctx, data, hashes); err != nil {
			return fmt.Errorf("seed e2e fixtures: %w", err)
		}
		if err := cache.Invalidate(ctx, s.Store.Redis, []string{"c:*"}); err != nil {
			return err
		}
		if err := cache.PublishInvalidation(ctx, s.Store.Redis, "c:*"); err != nil {
			return err
		}
		// Permission caches are keyed by user ID and must also be invalidated after tests reset roles.
		for _, user := range users {
			if err := s.Store.Redis.Del(ctx, fmt.Sprintf("admin:perm:%d:%d", user.ID, user.SessionVersion)).Err(); err != nil {
				return err
			}
		}
		stats, err = (&snapshot.Service{Store: s.Store, Objects: s.Objects}).Build(ctx)
		if err != nil {
			return err
		}
		stats["fixturePackages"], stats["fixtureReleases"], stats["fixtureAccounts"] = len(data.Packages), len(data.Releases), len(seeds.E2EAccounts())
		return nil
	})
	return stats, err
}
