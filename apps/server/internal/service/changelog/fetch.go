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

// fetchLease is how long a source enqueued by the schedule stays claimed. Its next_fetch_at moves this far
// ahead at enqueue, so later ticks cannot enqueue it again while the task waits in a backlog; the fetch
// itself then sets the real next_fetch_at (interval on success, backoff on failure). Only a task that is
// lost without running waits out the lease.
const fetchLease = 2 * time.Hour

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

// Fetch reads one changelog source. Every outcome (success, failure, timeout, cancellation) reports which
// source it was: source_id, package_token, source_url (scheme, host and path only: no query, no
// credentials) and attempt, the 1-based consecutive attempt counted from changelog_sources.fail_count.
func (s *Service) Fetch(ctx context.Context, id int64) (map[string]any, error) {
	observed := map[string]any{"source_id": id}
	stats, err := s.fetch(ctx, id, observed)
	if _, known := observed["package_token"]; !known {
		// Early exits (a source outside the fetchable scope such as sparkle/webpage, a missing package,
		// a store error) still say which source and package it was when the row exists.
		if identity, lookupErr := s.Store.ChangelogSourceIdentity(context.WithoutCancel(ctx), id); lookupErr == nil {
			var settings map[string]any
			_ = json.Unmarshal(identity.Config, &settings)
			observed["attempt"], observed["source"], observed["package_token"] = identity.FailCount+1, identity.Type, identity.Token
			observed["source_url"] = pipeline.SourceURL(identity.Type, settings)
		}
	}
	for _, key := range []string{"package_token", "source_url", "attempt"} {
		if _, set := observed[key]; !set {
			observed[key] = nil
		}
	}
	if stats == nil {
		stats = map[string]any{}
	}
	for key, value := range observed {
		if _, set := stats[key]; !set {
			stats[key] = value
		}
	}
	if err != nil && stats["errorCategory"] == nil {
		category, httpStatus := pipeline.Failure(err)
		stats["errorCategory"] = category
		if httpStatus != 0 {
			stats["httpStatus"] = httpStatus
		}
	}
	return stats, err
}

func (s *Service) fetch(ctx context.Context, id int64, observed map[string]any) (map[string]any, error) {
	if err := s.Store.DispatchCacheInvalidations(ctx); err != nil {
		return nil, err
	}
	state, err := s.Store.ChangelogState(ctx, id)
	if err != nil {
		return nil, err
	}
	observed["attempt"] = state.FailCount + 1
	observed["source"] = state.Type
	p, err := s.Store.ChangelogCandidate(ctx, state.PackageID)
	if err != nil {
		return nil, err
	}
	observed["package_token"] = p.Token
	var settings map[string]any
	if err := json.Unmarshal(state.Config, &settings); err != nil {
		return nil, err
	}
	observed["source_url"] = pipeline.SourceURL(state.Type, settings)
	if state.Excluded || !state.Enabled {
		return map[string]any{"skipped": true, "reason": "excluded_or_disabled"}, nil
	}
	source := pipeline.FetchSource{ID: state.ID, Type: state.Type, Config: settings}
	if state.ETag != nil {
		source.ETag = *state.ETag
	}
	if state.LastModified != nil {
		source.LastModified = *state.LastModified
	}
	// An incremental window can miss a version published before first import.
	// Until that exact version's date is known, fetch the bounded full history.
	// The "latest" marker has no version commit date to backfill.
	if state.Type == "homebrew_commits" && state.CurrentVersion != "latest" && (state.CurrentVersionCommittedAt == nil || state.CurrentVersionCommittedAt.IsZero() || state.CurrentVersionCommittedAt.After(s.now())) {
		source.ETag, source.LastModified = "", ""
	} else if state.Type == "homebrew_commits" && state.LastFetchedAt != nil && (state.LastStatus == "ok" || state.LastStatus == "not_modified") {
		since := state.LastFetchedAt.UTC().Add(-24 * time.Hour)
		source.Since = &since
	}
	result, err := s.Fetcher.Fetch(ctx, p, source)
	if err != nil && errors.Is(err, context.Canceled) {
		// A worker shutdown cancels the run and asynq requeues it: not an upstream failure, so the backoff
		// and fail_count stay as they were. The source becomes due again right away.
		write, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if saveErr := s.Store.ChangelogCanceled(write, id, s.now()); saveErr != nil {
			return nil, saveErr
		}
		category, _ := pipeline.Failure(err)
		return map[string]any{"status": "canceled", "source": state.Type, "errorCategory": category}, err
	}
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
		// Record the failure even after a timeout ended the run context, within its own deadline.
		write, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if saveErr := s.Store.ChangelogFailure(write, id, status, pipeline.FailureMessage(err), next); saveErr != nil {
			return nil, saveErr
		}
		category, httpStatus := pipeline.Failure(err)
		return map[string]any{"status": status, "source": state.Type, "errorCategory": category, "httpStatus": httpStatus}, err
	}
	changed, lifecycle, err := s.Store.SaveFetchedChangelogWithLifecycle(ctx, state, result, s.now().Add(interval(state.Rank30d)), s.now())
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
	return map[string]any{"versions": len(result.Versions), "releases": len(result.Releases), "notModified": result.NotModified, "source": state.Type, "changed": changed, "autoDisabled": lifecycle.AutoDisabled, "reactivated": lifecycle.Reactivated, "missingVersionDate": lifecycle.MissingVersionDate}, nil
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
	// Claim due sources by moving next_fetch_at past the lease before enqueueing, so a backlog longer
	// than the task's uniqueness lock cannot enqueue the same source on the next tick.
	ids, err := s.Store.ClaimChangelogDue(ctx, s.now(), s.now().Add(fetchLease))
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
