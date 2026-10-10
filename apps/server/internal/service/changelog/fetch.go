package changelog

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	pipeline "github.com/opennavo/opennavo/server/internal/changelog"
	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/jobs"
)

type Enqueuer interface {
	Enqueue(context.Context, string, jobs.Payload, jobs.Metadata) (string, error)
}

func interval(rank *int) time.Duration {
	if rank != nil && *rank <= 200 {
		return 3 * time.Hour
	}
	if rank != nil && *rank <= 1000 {
		return 12 * time.Hour
	}
	return 48 * time.Hour
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func (s *Service) Fetch(ctx context.Context, id int64) (map[string]any, error) {
	if err := s.Store.DispatchCacheInvalidations(ctx); err != nil {
		return nil, err
	}
	state, err := s.Store.ChangelogState(ctx, id)
	if err != nil {
		return nil, err
	}
	if state.Excluded || !state.Enabled {
		return map[string]any{"skipped": true, "reason": "excluded_or_disabled"}, nil
	}
	var settings map[string]any
	if err := json.Unmarshal(state.Config, &settings); err != nil {
		return nil, err
	}
	p, err := s.Store.ChangelogCandidate(ctx, state.PackageID)
	if err != nil {
		return nil, err
	}
	source := pipeline.FetchSource{ID: state.ID, Type: state.Type, Config: settings}
	if state.ETag != nil {
		source.ETag = *state.ETag
	}
	if state.LastModified != nil {
		source.LastModified = *state.LastModified
	}
	if state.Type == "homebrew_commits" && state.LastFetchedAt != nil && (state.LastStatus == "ok" || state.LastStatus == "not_modified") {
		since := state.LastFetchedAt.Add(-24 * time.Hour)
		source.Since = &since
	}
	result, err := s.Fetcher.Fetch(ctx, p, source)
	if err != nil {
		status, next := "error", s.now().Add(time.Duration(math.Pow(2, float64(min(state.FailCount+1, 8))))*time.Hour)
		if next.After(s.now().Add(7 * 24 * time.Hour)) {
			next = s.now().Add(7 * 24 * time.Hour)
		}
		var rate *pipeline.RateLimitError
		var httpError *pipeline.StatusError
		if errors.As(err, &rate) {
			status, next = "rate_limited", rate.Reset
		} else if errors.As(err, &httpError) && httpError.Status == 404 {
			status = "not_found"
		}
		if saveErr := s.Store.ChangelogFailure(ctx, id, status, pipeline.FailureMessage(err), next); saveErr != nil {
			return nil, saveErr
		}
		category, httpStatus := pipeline.Failure(err)
		return map[string]any{"status": status, "source": state.Type, "errorCategory": category, "httpStatus": httpStatus}, err
	}
	changed, err := s.Store.SaveFetchedChangelog(ctx, state, result, s.now().Add(interval(state.Rank30d)), s.now())
	if err != nil {
		return nil, err
	}
	if err := s.Store.DispatchCacheInvalidations(ctx); err != nil {
		return nil, err
	}
	if s.Queue != nil {
		if _, err := s.Store.DispatchOutbox(ctx, func(ctx context.Context, typ string, raw json.RawMessage) error {
			payload, meta, err := jobs.DecodeOutbox(raw)
			if err != nil {
				return err
			}
			_, err = s.Queue.Enqueue(ctx, typ, payload, meta)
			return jobs.OutboxDeliveryError(typ, err)
		}); err != nil {
			return nil, err
		}
	}
	return map[string]any{"versions": len(result.Versions), "notModified": result.NotModified, "source": state.Type, "changed": changed}, nil
}
func (s *Service) Schedule(ctx context.Context) (map[string]any, error) {
	candidates, err := s.Store.UnresolvedHomebrewSources(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range candidates {
		if _, err := s.resolve(ctx, p); err != nil {
			return nil, err
		}
	}
	ids, err := s.Store.ChangelogDue(ctx, s.now())
	if err != nil {
		return nil, err
	}
	queued := 0
	for _, id := range ids {
		_, err := s.Queue.Enqueue(ctx, "changelog:fetch", jobs.Payload{SourceID: id}, jobs.Metadata{Trigger: "event"})
		if err != nil {
			var app *domain.AppError
			if errors.As(err, &app) && app.Code == domain.CodeInvalidState {
				continue
			}
			return nil, err
		}
		queued++
	}
	return map[string]any{"sources": len(ids), "enqueued": queued}, nil
}
