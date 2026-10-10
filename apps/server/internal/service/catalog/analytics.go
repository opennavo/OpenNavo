package catalog

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/jobs"
	"github.com/opennavo/opennavo/server/internal/store"
)

type AnalyticsSource interface {
	FetchAnalytics(context.Context, string, string) (homebrew.Analytics, error)
}
type AnalyticsService struct {
	Store    *store.Store
	Source   AnalyticsSource
	Queue    Queue
	Now      func() time.Time
	Location *time.Location
}

func Popularity(installs30d, installs365d int64) float64 {
	return 0.7*math.Log1p(float64(installs30d)) + 0.3*math.Log1p(float64(installs365d)/12)
}

func Aggregate(items []homebrew.AnalyticsItem, kind string) (map[string]int64, error) {
	counts := map[string]int64{}
	for _, item := range items {
		name := item.Formula
		if kind == "cask" {
			name = item.Cask
		}
		words := strings.Fields(name)
		if len(words) == 0 {
			continue
		}
		name = words[0]
		if strings.Contains(name, "/") {
			tap := "homebrew/core/"
			if kind == "cask" {
				tap = "homebrew/cask/"
			}
			if !strings.HasPrefix(name, tap) {
				continue
			}
			name = strings.TrimPrefix(name, tap)
		}
		count, err := homebrew.ParseCount(item.Count)
		if err != nil {
			return nil, fmt.Errorf("invalid %s analytics: %w", kind, err)
		}
		counts[name] += count
	}
	return counts, nil
}

func (s *AnalyticsService) Run(ctx context.Context) (map[string]any, error) {
	stats := map[string]any{}
	err := s.Store.WithAdvisoryLock(ctx, "analytics:sync", func(ctx context.Context) error {
		catalogService := &Service{Store: s.Store, Queue: s.Queue}
		if _, err := catalogService.dispatch(ctx); err != nil {
			return err
		}
		var counts [3]map[string]int64
		for i, period := range []string{"30d", "90d", "365d"} {
			data, err := s.Source.FetchAnalytics(ctx, "cask", period)
			if err != nil {
				return fmt.Errorf("fetch cask %s: %w", period, err)
			}
			counts[i], err = Aggregate(data.Items, "cask")
			if err != nil {
				return err
			}
		}
		packages, err := s.Store.AnalyticsPackages(ctx)
		if err != nil {
			return err
		}
		rows := make([]domain.AnalyticsRow, 0, len(packages))
		for _, pkg := range packages {
			row := domain.AnalyticsRow{ID: pkg.ID, Installs30d: counts[0][pkg.Token], Installs90d: counts[1][pkg.Token], Installs365d: counts[2][pkg.Token]}
			row.Popularity = Popularity(row.Installs30d, row.Installs365d)
			rows = append(rows, row)
		}
		now := time.Now().UTC()
		if s.Now != nil {
			now = s.Now().UTC()
		}
		location := time.UTC
		if s.Location != nil {
			location = s.Location
		}
		date := now.In(location).Format("2006-01-02")
		if err := s.Store.ApplyAnalytics(ctx, rows, date); err != nil {
			return err
		}
		stats["packages"], stats["libraries"], stats["snapshotDate"] = len(rows), 0, date
		if err := cache.PublishInvalidation(ctx, s.Store.Redis, "c:pkg:*", "c:home:*", "c:rank:*", "c:sug:*", "c:dep:*", "c:related:*"); err != nil {
			return fmt.Errorf("invalidate analytics cache: %w", err)
		}
		queued, err := catalogService.dispatch(ctx)
		stats["enqueued"] = queued
		if err != nil {
			stats["partial"] = true
		}
		return err
	})
	return stats, err
}

func RunAnalyticsOnce(ctx context.Context, service *AnalyticsService) (map[string]any, error) {
	var stats map[string]any
	var serviceError error
	handler := jobs.WrapHandler(service.Store, service.Store.Redis, func(ctx context.Context, _ jobs.Payload) (map[string]any, error) {
		stats, serviceError = service.Run(ctx)
		return stats, serviceError
	}, jobs.Metadata{Trigger: "manual"})
	task, _, err := jobs.NewTask("analytics:sync", jobs.Payload{})
	if err != nil {
		return nil, err
	}
	err = handler(ctx, task)
	if serviceError != nil {
		return stats, serviceError
	}
	return stats, err
}
