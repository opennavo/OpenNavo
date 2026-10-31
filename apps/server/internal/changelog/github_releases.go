package changelog

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// GitHub release notes are external Markdown. They are stored through NormalizeMarkdown (HTML stripped,
// capped at 200 KB, matching releases.body_markdown) and rendered by @opennavo/ui's markdown-it (html:false)
// + DOMPurify pipeline, exactly like the other upstream release sources.
const (
	releasesPerPage     = 100
	releasesMaxBody     = 8 << 20 // One page of 100 releases with long notes and asset lists.
	releaseTitleMaxRune = 300
	// GitHubQuotaReserve pauses github_releases fetches once the remaining primary quota falls to this
	// fraction of the limit, leaving the rest for Homebrew commit history and source facts (#64 keeps
	// the same last-tenth reserve).
	githubQuotaReserveDivisor = 10
	// Without a limit header the pause starts below this many remaining requests.
	githubQuotaFloor = 100
)

// Release is one published GitHub release mapped to a package version.
type Release struct {
	Tag, Version, Title, SourceURL string
	Body, BodyHash                 string
	Prerelease                     bool
	PublishedAt                    *time.Time
}

type githubRelease struct {
	TagName     string     `json:"tag_name"`
	Name        string     `json:"name"`
	Body        string     `json:"body"`
	HTMLURL     string     `json:"html_url"`
	Draft       bool       `json:"draft"`
	Prerelease  bool       `json:"prerelease"`
	PublishedAt *time.Time `json:"published_at"`
}

// quotaGuard remembers the last GitHub primary quota this fetcher saw so a low quota pauses the
// next github_releases fetch before it spends a request.
type quotaGuard struct {
	mu               sync.Mutex
	remaining, limit int64
	reset            time.Time
	known            bool
}

func (q *quotaGuard) observe(headers http.Header) {
	remaining, err := strconv.ParseInt(headers.Get("X-Ratelimit-Remaining"), 10, 64)
	if err != nil || remaining < 0 {
		return
	}
	limit, err := strconv.ParseInt(headers.Get("X-Ratelimit-Limit"), 10, 64)
	if err != nil || limit < 0 {
		limit = -1
	}
	reset := time.Time{}
	if epoch, err := strconv.ParseInt(headers.Get("X-Ratelimit-Reset"), 10, 64); err == nil && epoch > 0 {
		reset = time.Unix(epoch, 0)
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.remaining, q.limit, q.reset, q.known = remaining, limit, reset, true
}

// paused returns the reset time while the remaining quota is inside the reserve.
func (q *quotaGuard) paused(now time.Time) (time.Time, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.known || q.reset.IsZero() || !q.reset.After(now) {
		return time.Time{}, false
	}
	floor := int64(githubQuotaFloor)
	if q.limit > 0 {
		floor = q.limit / githubQuotaReserveDivisor
	}
	if q.remaining > floor {
		return time.Time{}, false
	}
	return q.reset, true
}

var githubRepoName = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

// GitHubReleasesSource builds the source for a package whose public GitHub repository was verified by
// the source facts job (#64: homepage, cask URL or recorded repository, checked public via the API).
func GitHubReleasesSource(p Candidate) (Source, bool) {
	repo := strings.TrimSpace(p.GitHubRepo)
	if !githubRepoName.MatchString(repo) || strings.Contains(repo, "..") {
		return Source{}, false
	}
	return Source{Type: "github_releases", Priority: 20, Config: map[string]any{"repo": repo}}, true
}

func (f *Fetcher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *Fetcher) releases(ctx context.Context, s FetchSource) (FetchResult, error) {
	out := FetchResult{Versions: []BrewVersion{}, Releases: []Release{}}
	repo := configText(s.Config, "repo")
	if !githubRepoName.MatchString(repo) || strings.Contains(repo, "..") {
		return out, errors.New("invalid GitHub repository")
	}
	if reset, paused := f.quota.paused(f.now()); paused {
		return out, &RateLimitError{Reset: reset}
	}
	headers := http.Header{}
	if s.ETag != "" {
		// A 304 costs no primary quota. The list embeds asset download counters, so busy repositories
		// still change ETag often; unchanged notes are then deduplicated by body hash in the store.
		headers.Set("If-None-Match", s.ETag)
	}
	target := "https://api.github.com/repos/" + repo + "/releases?" + url.Values{"per_page": {strconv.Itoa(releasesPerPage)}}.Encode()
	body, status, responseHeaders, err := f.HTTP.readRequest(ctx, target, releasesMaxBody, headers)
	if responseHeaders != nil {
		f.quota.observe(responseHeaders)
	}
	if err != nil {
		return out, err
	}
	if err := checkStatus(status, responseHeaders); err != nil {
		return out, err
	}
	out.ETag = responseHeaders.Get("ETag")
	if status == http.StatusNotModified {
		out.NotModified = true
		if out.ETag == "" {
			out.ETag = s.ETag
		}
		return out, nil
	}
	var batch []githubRelease
	if err := json.Unmarshal(body, &batch); err != nil || batch == nil {
		return out, &Error{Kind: "invalid_json"}
	}
	// The token can read private repositories, and the source facts job only notices a repository that turned
	// private on its next run. Changed notes (a 200, not a 304) are written only after the repository itself
	// still reports public; a private one answers like a missing one (404) and nothing is stored.
	if private, err := f.repoPrivate(ctx, repo); err != nil {
		return out, err
	} else if private {
		return FetchResult{Versions: []BrewVersion{}, Releases: []Release{}}, &StatusError{Status: http.StatusNotFound}
	}
	seen, versions := map[string]bool{}, map[string]bool{}
	for _, item := range batch {
		// Drafts are unpublished; prereleases are kept and flagged (releases.is_prerelease), which the
		// version timeline already shows with a "Prerelease" chip.
		if item.Draft || item.TagName == "" || seen[item.TagName] {
			continue
		}
		version := ReleaseVersion(item.TagName, repo)
		if version == "" {
			continue
		}
		seen[item.TagName] = true
		if item.Prerelease && !IsPrereleaseVersion(version) {
			// GitHub marks it a prerelease but the tag looks final (v1.0.0): never attach it to the stable
			// version's history.
			version += "-prerelease"
		}
		// Tags that normalize to one version (v2.0 and 2.0.0) keep only the newest release, so the
		// timeline shows one entry per version.
		if key := VersionKey(version); versions[key] {
			continue
		} else {
			versions[key] = true
		}
		release := Release{Tag: truncateRunes(item.TagName, 255), Version: version, Prerelease: item.Prerelease,
			Title: truncateRunes(strings.TrimSpace(item.Name), releaseTitleMaxRune), SourceURL: releaseURL(repo, item)}
		if item.PublishedAt != nil && !item.PublishedAt.IsZero() {
			published := item.PublishedAt.UTC()
			release.PublishedAt = &published
		}
		if strings.TrimSpace(item.Body) != "" {
			release.Body, release.BodyHash = NormalizeMarkdown(item.Body)
		}
		out.Releases = append(out.Releases, release)
	}
	return out, nil
}

// Version parsing is a whitelist. A tag is an optional word prefix (release-, desktop-v, the repository name)
// and a numeric core (1.2.3), followed by at most one suffix:
//   - a known pre-release suffix (-rc1, -beta.2, -pre.1, -prerelease, -dev3, .alpha, -preview, and the
//     Python-style 2.0b3 / 1.0a1 directly after the core): kept, and the version counts as a pre-release;
//   - "+build" metadata: dropped;
//   - any other word after a separator (-hotfix, -patch1, _final) or a single letter directly after the core
//     (OpenSSL-style 1.1.1w, 2.0.0a): kept verbatim, so it never merges into the base version.
//
// Anything else (hash-like 3a4f9c1, a prefix that is itself a pre-release word such as Beta-2) is not a
// version: the release is skipped rather than attached to a guessed version.
const prereleaseWord = `(?:alpha|beta|rc|preview|prerelease|pre|dev)`

var (
	releaseTagPattern     = regexp.MustCompile(`^((?:[a-z][a-z0-9]*[-_/])*)v?(\d+(?:\.\d+)*)(.*)$`)
	prereleaseSuffix      = regexp.MustCompile(`^(?:[-._]?` + prereleaseWord + `(?:[.-]?\d+)*|[ab]\d+(?:\.\d+)*)$`)
	otherSuffix           = regexp.MustCompile(`^(?:[-._][a-z][a-z0-9]*(?:[.-][a-z0-9]+)*|[a-z])$`)
	prereleasePrefixWords = regexp.MustCompile(`(?:^|[-_/])` + prereleaseWord + `\d*[-_/]`)
)

// parseVersion splits a lowercased tag into prefix, numeric core and suffix ("+build" dropped).
func parseVersion(tag string) (prefix, core, suffix string, ok bool) {
	m := releaseTagPattern.FindStringSubmatch(tag)
	if m == nil {
		return "", "", "", false
	}
	prefix, core, suffix = m[1], m[2], m[3]
	if i := strings.IndexByte(suffix, '+'); i >= 0 {
		suffix = suffix[:i]
	}
	if suffix != "" && !prereleaseSuffix.MatchString(suffix) && !otherSuffix.MatchString(suffix) {
		return "", "", "", false
	}
	return prefix, core, suffix, true
}

// ReleaseVersion normalizes a release tag to a package version: lowercased, "v", "release-" and repository
// name prefixes stripped, suffixes kept (v3.0-RC1 -> 3.0-rc1, v2.0b3 -> 2.0b3, v1.2.3-hotfix -> 1.2.3-hotfix,
// 1.1.1w -> 1.1.1w). Tags that are not a version return "".
func ReleaseVersion(tag, repo string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if tag == "tip" || tag == "nightly" || !strings.ContainsAny(tag, "0123456789") {
		return ""
	}
	name := strings.ToLower(repo)
	if parts := strings.Split(name, "/"); len(parts) > 1 {
		name = parts[len(parts)-1]
	}
	for _, prefix := range []string{"release-", "release/", name + "-", name + "_"} {
		if prefix != "-" && prefix != "_" {
			tag = strings.TrimPrefix(tag, prefix)
		}
	}
	prefix, core, suffix, ok := parseVersion(tag)
	if !ok || prereleasePrefixWords.MatchString(prefix) {
		return ""
	}
	return core + suffix
}

// IsPrereleaseVersion reports whether a normalized version carries a known pre-release suffix.
func IsPrereleaseVersion(version string) bool {
	_, _, suffix, ok := parseVersion(strings.ToLower(strings.TrimSpace(strings.SplitN(version, ",", 2)[0])))
	return ok && suffix != "" && prereleaseSuffix.MatchString(suffix)
}

// VersionKey compares a release version with a package version: case-insensitive, build suffix after a
// comma dropped (Homebrew "1.2,345"), trailing ".0" components ignored (tag 2.0 matches 2.0.0), every
// suffix significant (3.0-rc1 never matches 3.0, -pre never matches -prerelease). Values without a
// numeric version (Homebrew "latest") have no key and return "".
func VersionKey(version string) string {
	version = strings.ToLower(strings.TrimSpace(strings.SplitN(version, ",", 2)[0]))
	if i := strings.IndexByte(version, '+'); i >= 0 {
		version = version[:i]
	}
	version = strings.TrimPrefix(version, "v")
	if version == "" || version[0] < '0' || version[0] > '9' {
		return ""
	}
	core, suffix := version, ""
	if i := strings.IndexFunc(version, func(r rune) bool { return (r < '0' || r > '9') && r != '.' }); i >= 0 {
		core, suffix = version[:i], strings.TrimLeft(version[i:], "-._")
	}
	core = strings.TrimRight(core, ".")
	for strings.HasSuffix(core, ".0") {
		core = strings.TrimSuffix(core, ".0")
	}
	if suffix != "" {
		return core + "-" + suffix
	}
	return core
}

// repoPrivate reads the repository's visibility with the same request path and quota guard as the release list.
func (f *Fetcher) repoPrivate(ctx context.Context, repo string) (bool, error) {
	body, status, headers, err := f.HTTP.readRequest(ctx, "https://api.github.com/repos/"+repo, 1<<20, http.Header{})
	if headers != nil {
		f.quota.observe(headers)
	}
	if err != nil {
		return false, err
	}
	if err := checkStatus(status, headers); err != nil {
		return false, err
	}
	var meta struct {
		Private    *bool  `json:"private"`
		Visibility string `json:"visibility"`
	}
	if err := json.Unmarshal(body, &meta); err != nil || meta.Private == nil {
		return false, &Error{Kind: "invalid_json"}
	}
	return *meta.Private || (meta.Visibility != "" && meta.Visibility != "public"), nil
}

func releaseURL(repo string, item githubRelease) string {
	prefix := "https://github.com/" + repo + "/releases/"
	if strings.HasPrefix(strings.ToLower(item.HTMLURL), strings.ToLower(prefix)) {
		if u, err := url.Parse(item.HTMLURL); err == nil && u.Scheme == "https" && strings.EqualFold(u.Host, "github.com") && u.User == nil {
			return item.HTMLURL
		}
	}
	return prefix + "tag/" + url.PathEscape(item.TagName)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}
