package changelog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type FetchSource struct {
	ID                 int64
	Type               string
	Config             map[string]any
	ETag, LastModified string
	Since              *time.Time
}
type BrewVersion struct {
	Version, SHA string
	CommittedAt  time.Time
}
type FetchResult struct {
	Versions           []BrewVersion
	NotModified        bool
	ETag, LastModified string
}
type Fetcher struct{ HTTP *Resolver }

func NewFetcher(agent string) *Fetcher               { return &Fetcher{HTTP: NewResolver(agent)} }
func configText(m map[string]any, key string) string { v, _ := m[key].(string); return v }
func (f *Fetcher) get(ctx context.Context, target string, limit int64, source FetchSource) ([]byte, int, http.Header, error) {
	headers := http.Header{}
	if source.ETag != "" {
		headers.Set("If-None-Match", source.ETag)
	}
	if source.LastModified != "" {
		headers.Set("If-Modified-Since", source.LastModified)
	}
	return f.HTTP.readRequest(ctx, target, limit, headers)
}
func (f *Fetcher) Fetch(ctx context.Context, p Candidate, source FetchSource) (FetchResult, error) {
	switch source.Type {
	case "homebrew_commits":
		return f.commits(ctx, p, source)
	default:
		return FetchResult{}, errors.New("unsupported changelog source")
	}
}
func checkStatus(status int, headers http.Header) error {
	if status == 200 || status == 304 {
		return nil
	}
	if (status == 403 || status == 429) && headers.Get("X-Ratelimit-Reset") != "" {
		epoch, _ := strconv.ParseInt(headers.Get("X-Ratelimit-Reset"), 10, 64)
		reset := time.Unix(epoch, 0)
		if reset.Before(time.Now()) {
			reset = time.Now().Add(time.Hour)
		}
		return &RateLimitError{Reset: reset}
	}
	return &StatusError{Status: status}
}

type StatusError struct{ Status int }

func (e *StatusError) Error() string { return fmt.Sprintf("upstream changelog status %d", e.Status) }

var versionTag = regexp.MustCompile(`\d+(?:[.]\d+)*(?:[-.]?(?:alpha|beta|rc|preview)[.]?\d*)?`)

func TagVersion(tag, repo string) string {
	if tag == "tip" || tag == "nightly" || !strings.ContainsAny(tag, "0123456789") {
		return ""
	}
	name := repo
	if parts := strings.Split(repo, "/"); len(parts) > 1 {
		name = parts[len(parts)-1]
	}
	for _, prefix := range []string{"release-", "release/", name + "-", name + "_", "v", "V"} {
		tag = strings.TrimPrefix(tag, prefix)
	}
	return versionTag.FindString(tag)
}

func (f *Fetcher) commits(ctx context.Context, p Candidate, s FetchSource) (FetchResult, error) {
	out := FetchResult{Versions: []BrewVersion{}}
	repo, path := configText(s.Config, "repo"), configText(s.Config, "path")
	if repo != "Homebrew/homebrew-cask" && repo != "Homebrew/homebrew-core" {
		return out, errors.New("invalid Homebrew repository")
	}
	if !rubySafe.MatchString(path) || strings.Contains(path, "..") {
		return out, errors.New("invalid Homebrew source path")
	}
	params := url.Values{"path": {path}, "per_page": {"100"}}
	if s.Since != nil {
		params.Set("since", s.Since.Format(time.RFC3339))
		s.ETag = ""
		s.LastModified = ""
	}
	entries, result, err := f.commitPages(ctx, repo, params, s)
	if err != nil {
		return out, err
	}
	out = result
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(p.Token) + `(?: |: update to )(\S+)$`)
	for _, e := range entries {
		title := strings.SplitN(e.Commit.Message, "\n", 2)[0]
		m := pattern.FindStringSubmatch(title)
		if m == nil {
			continue
		}
		version := m[1]
		if TagVersion(version, p.Token) == "" {
			continue
		}
		date := e.Commit.Committer.Date
		if date.IsZero() {
			date = e.Commit.Author.Date
		}
		out.Versions = append(out.Versions, BrewVersion{Version: version, SHA: e.SHA, CommittedAt: date})
	}
	return out, nil
}

// Read at most 100 commits per initial page; on 5xx, reduce page size and restart at page one to avoid losing history.
// Persist only after the entire pass succeeds; paginated responses do not reuse single-page conditional caching.
type commitEntry struct {
	SHA    string
	Commit struct {
		Message   string
		Committer struct{ Date time.Time }
		Author    struct{ Date time.Time }
	}
}

func (f *Fetcher) commitPages(ctx context.Context, repo string, params url.Values, source FetchSource) ([]commitEntry, FetchResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var last error
	for _, size := range []int{100, 10, 1} {
		entries, result, err := f.commitPageSize(ctx, repo, params, source, size)
		if err == nil {
			return entries, result, nil
		}
		last = err
		var status *StatusError
		if !errors.As(err, &status) || status.Status < 500 || status.Status > 599 || ctx.Err() != nil {
			break
		}
		source.ETag, source.LastModified = "", ""
	}
	return nil, FetchResult{}, last
}
func (f *Fetcher) commitPageSize(ctx context.Context, repo string, params url.Values, source FetchSource, size int) ([]commitEntry, FetchResult, error) {
	result := FetchResult{Versions: []BrewVersion{}}
	entries := []commitEntry{}
	seen := map[string]bool{}
	params.Set("per_page", strconv.Itoa(size))
	for page := 1; page <= 100/size; page++ {
		params.Set("page", strconv.Itoa(page))
		target := "https://api.github.com/repos/" + repo + "/commits?" + params.Encode()
		body, status, headers, err := f.get(ctx, target, 5<<20, source)
		if err != nil {
			return nil, result, err
		}
		if err := checkStatus(status, headers); err != nil {
			return nil, result, err
		}
		if size == 100 {
			result.ETag, result.LastModified = headers.Get("ETag"), headers.Get("Last-Modified")
			if status == 304 {
				result.NotModified = true
				return entries, result, nil
			}
		} else if status == 304 {
			return nil, result, &Error{Kind: "invalid_json"}
		}
		var batch []commitEntry
		if err := json.Unmarshal(body, &batch); err != nil || batch == nil {
			return nil, result, &Error{Kind: "invalid_json"}
		}
		for _, entry := range batch {
			if entry.SHA != "" && seen[entry.SHA] {
				continue
			}
			seen[entry.SHA] = true
			entries = append(entries, entry)
			if len(entries) == 100 {
				return entries, result, nil
			}
		}
		if len(batch) < size || !strings.Contains(headers.Get("Link"), `rel="next"`) {
			break
		}
		source.ETag, source.LastModified = "", ""
	}
	return entries, result, nil
}
