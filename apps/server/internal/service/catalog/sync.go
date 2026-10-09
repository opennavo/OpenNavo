package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/opennavo/opennavo/server/internal/cache"
	"github.com/opennavo/opennavo/server/internal/homebrew"
	"github.com/opennavo/opennavo/server/internal/jobs"
	"github.com/opennavo/opennavo/server/internal/store"
	"github.com/redis/go-redis/v9"
)

type Source interface {
	Stream(context.Context, string, homebrew.Conditional, func(homebrew.Package) error) (homebrew.StreamResult, error)
}
type Queue interface {
	Enqueue(context.Context, string, jobs.Payload, jobs.Metadata) (string, error)
}
type Service struct {
	Store  *store.Store
	Source Source
	Queue  Queue
}
type Stats struct {
	Kind           string `json:"kind"`
	Fetched        int    `json:"fetched"`
	Inserted       int    `json:"inserted"`
	Updated        int    `json:"updated"`
	VersionChanged int    `json:"versionChanged"`
	Removed        int    `json:"removed"`
	Renamed        int    `json:"renamed"`
	Unchanged      int    `json:"unchanged"`
	DurationMs     int64  `json:"durationMs"`
	NotModified    bool   `json:"notModified"`
	Renormalized   int    `json:"renormalized"`
}

func (s *Service) Run(ctx context.Context) (map[string]any, error) {
	stats := map[string]any{}
	err := s.Store.WithAdvisoryLock(ctx, "catalog:sync", func(ctx context.Context) error {
		queued, err := s.dispatch(ctx)
		if err != nil {
			return err
		}
		kinds := []Stats{}
		for _, kind := range []string{"cask"} {
			result, err := s.syncKind(ctx, kind)
			kinds = append(kinds, result)
			stats["kinds"] = kinds
			if err != nil {
				for _, kindStats := range kinds {
					if kindStats.Inserted+kindStats.Updated+kindStats.Removed > 0 {
						stats["partial"] = true
						break
					}
				}
				return fmt.Errorf("sync %s: %w", kind, err)
			}
		}
		count, err := s.dispatch(ctx)
		queued += count
		stats["enqueued"] = queued
		if err != nil {
			stats["partial"] = true
		}
		return err
	})
	// Committed catalog batches must invalidate browse caches even if a later batch fails.
	invalidateCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if cacheErr := cache.PublishInvalidation(invalidateCtx, s.Store.Redis, "c:pkg:*", "c:home:*", "c:rank:*", "c:cat:*", "c:sug:*"); cacheErr != nil {
		err = errors.Join(err, fmt.Errorf("invalidate catalog cache: %w", cacheErr))
	}
	return stats, err
}

func (s *Service) dispatch(ctx context.Context) (int, error) {
	return s.Store.DispatchOutbox(ctx, func(ctx context.Context, taskType string, raw json.RawMessage) error {
		payload, metadata, err := jobs.DecodeOutbox(raw)
		if err != nil {
			return fmt.Errorf("decode outbox: %w", err)
		}
		_, err = s.Queue.Enqueue(ctx, taskType, payload, metadata)
		return jobs.OutboxDeliveryError(taskType, err)
	})
}

func (s *Service) syncKind(ctx context.Context, kind string) (stats Stats, resultError error) {
	stats = Stats{Kind: kind}
	started := time.Now()
	defer func() { stats.DurationMs = time.Since(started).Milliseconds() }()
	rows, err := s.Store.CatalogRows(ctx, kind)
	if err != nil {
		return stats, err
	}
	if err := s.renormalize(ctx, rows, &stats); err != nil {
		return stats, err
	}
	var previous homebrew.Conditional
	data, err := s.Store.Redis.Get(ctx, "etag:homebrew:"+kind).Bytes()
	if err != nil && !errors.Is(err, redis.Nil) {
		return stats, fmt.Errorf("read catalog validator: %w", err)
	}
	if err == nil {
		if err := json.Unmarshal(data, &previous); err != nil {
			return stats, fmt.Errorf("decode catalog validator: %w", err)
		}
	}
	for _, row := range rows {
		if row.RemovedAt == nil && row.NormalizationVersion != fmt.Sprint(homebrew.CaskNormalizationVersion) {
			previous = homebrew.Conditional{}
			break
		}
	}
	spool, err := newCatalogSpool()
	if err != nil {
		return stats, err
	}
	defer func() { _ = spool.close() }()
	seen := map[string]bool{}
	result, err := s.Source.Stream(ctx, kind, previous, func(item homebrew.Package) error {
		if item.Kind != "cask" {
			return errors.New("catalog source returned unsupported kind")
		}
		if seen[item.Token] {
			return errors.New("duplicate token in catalog")
		}
		seen[item.Token] = true
		return spool.append(item.Raw)
	})
	stats.Fetched = result.Fetched
	stats.NotModified = result.NotModified
	if err != nil || result.NotModified {
		return stats, err
	}
	// Validate the download and all entries before writing; keep only token sets and lightweight hash maps in memory.
	if err := spool.rewind(); err != nil {
		return stats, err
	}
	batch := make([]store.CatalogMutation, 0, 500)
	flush := func() error {
		if err := s.Store.ApplyCatalogBatch(ctx, batch); err != nil {
			return err
		}
		for _, mutation := range batch {
			if mutation.Previous == nil {
				stats.Inserted++
			} else {
				stats.Updated++
				if mutation.Previous.Version != mutation.Package.Version {
					stats.VersionChanged++
				}
				if mutation.RenamedFrom != "" {
					stats.Renamed++
				}
			}
		}
		batch = batch[:0]
		return nil
	}
	renamed := map[int64]bool{}
	for {
		item, err := spool.next()
		if errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return stats, fmt.Errorf("read catalog spool: %w", err)
		}
		old := rows[item.Token]
		oldToken := ""
		if old == nil {
			for _, token := range item.OldTokens {
				if candidate := rows[token]; candidate != nil && !seen[token] && !renamed[candidate.ID] {
					old = candidate
					oldToken = token
					renamed[old.ID] = true
					break
				}
			}
		}
		if old != nil && old.RawHash == item.RawHash && old.RemovedAt == nil && oldToken == "" && old.NormalizationVersion == fmt.Sprint(homebrew.CaskNormalizationVersion) {
			stats.Unchanged++
			continue
		}
		batch = append(batch, store.CatalogMutation{Package: item, Previous: old, RenamedFrom: oldToken})
		if len(batch) == 500 {
			if err := flush(); err != nil {
				return stats, err
			}
		}
	}
	if err := flush(); err != nil {
		return stats, err
	}
	removed := make([]*store.CatalogRow, 0, 500)
	for token, row := range rows {
		if seen[token] || renamed[row.ID] || row.RemovedAt != nil {
			continue
		}
		removed = append(removed, row)
		if len(removed) == 500 {
			if err := s.Store.RemoveCatalogRows(ctx, removed); err != nil {
				return stats, err
			}
			stats.Removed += len(removed)
			removed = removed[:0]
		}
	}
	if err := s.Store.RemoveCatalogRows(ctx, removed); err != nil {
		return stats, err
	}
	stats.Removed += len(removed)
	encoded, err := json.Marshal(result.Conditional)
	if err != nil {
		return stats, fmt.Errorf("encode catalog validator: %w", err)
	}
	if err := s.Store.Redis.Set(ctx, "etag:homebrew:"+kind, encoded, 0).Err(); err != nil {
		return stats, fmt.Errorf("save catalog validator: %w", err)
	}
	return stats, nil
}

func (s *Service) renormalize(ctx context.Context, rows map[string]*store.CatalogRow, stats *Stats) error {
	spool, err := newCatalogSpool()
	if err != nil {
		return err
	}
	defer func() { _ = spool.close() }()
	if err := s.Store.VisitOutdatedCasks(ctx, fmt.Sprint(homebrew.CaskNormalizationVersion), func(raw json.RawMessage) error {
		item, err := homebrew.Normalize("cask", raw)
		if err != nil {
			return fmt.Errorf("renormalize stored cask: %w", err)
		}
		old := rows[item.Token]
		if old == nil || old.Version != item.Version {
			return errors.New("stored cask definition differs from catalog identity or version")
		}
		return spool.append(item.Raw)
	}); err != nil {
		return err
	}
	if err := spool.rewind(); err != nil {
		return err
	}
	batch := make([]store.CatalogMutation, 0, 500)
	flush := func() error {
		if err := s.Store.ApplyCatalogBatch(ctx, batch); err != nil {
			return err
		}
		for _, mutation := range batch {
			mutation.Previous.NormalizationVersion = fmt.Sprint(homebrew.CaskNormalizationVersion)
			mutation.Previous.RawHash = mutation.Package.RawHash
			stats.Updated++
			stats.Renormalized++
		}
		batch = batch[:0]
		return nil
	}
	for {
		item, err := spool.next()
		if errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return fmt.Errorf("read normalization spool: %w", err)
		}
		batch = append(batch, store.CatalogMutation{Package: item, Previous: rows[item.Token]})
		if len(batch) == 500 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	return flush()
}

func RunOnce(ctx context.Context, service *Service) (map[string]any, error) {
	var stats map[string]any
	var serviceError error
	handler := jobs.WrapHandler(service.Store, service.Store.Redis, func(ctx context.Context, _ jobs.Payload) (map[string]any, error) {
		var err error
		stats, err = service.Run(ctx)
		serviceError = err
		return stats, err
	}, jobs.Metadata{Trigger: "manual"})
	task, _, err := jobs.NewTask("catalog:sync", jobs.Payload{})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	err = handler(ctx, task)
	if serviceError != nil {
		return stats, fmt.Errorf("catalog service: %w", serviceError)
	}
	return stats, err
}
