package changelog

import (
	"net/url"
	"regexp"
)

var sourceRepo = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

// SourceURL is the upstream endpoint a source reads, safe for job stats and logs: scheme, host and path
// only. Queries (paths, since, pages) and any credentials are never included. Unknown types give "".
func SourceURL(sourceType string, config map[string]any) string {
	repo, _ := config["repo"].(string)
	if !sourceRepo.MatchString(repo) {
		return ""
	}
	path := ""
	switch sourceType {
	case "homebrew_commits":
		path = "/repos/" + repo + "/commits"
	case "github_releases":
		path = "/repos/" + repo + "/releases"
	default:
		return ""
	}
	return RedactURL("https://api.github.com" + path)
}

// RedactURL drops userinfo, query and fragment from a URL.
func RedactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}).String()
}
