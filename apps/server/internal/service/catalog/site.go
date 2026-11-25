package catalog

import (
	"context"
	"crypto/subtle"

	"github.com/opennavo/opennavo/server/internal/domain"
	"github.com/opennavo/opennavo/server/internal/seo"
	"github.com/opennavo/opennavo/server/internal/store"
)

// SiteSettings is the public subset of the admin SEO settings. It omits credentials
// and CDN identifiers; the web server uses it for metadata, analytics and robots.txt.
type SiteSettings struct {
	Revision     int64 `json:"revision"`
	Identity     any   `json:"identity"`
	Verification any   `json:"verification"`
	Analytics    any   `json:"analytics"`
	EdgeCache    any   `json:"edgeCache"`
	Crawlers     any   `json:"crawlers"`
	Pages        any   `json:"pages"`
}

// publicSitePages is the stored pages policy plus the code-approved versions pilot. The pilot list is
// not stored or editable: exposing it keeps the web sitemap generator and DecidePage on one rule.
type publicSitePages struct {
	store.SEOPagesSettings
	VersionsSitemapPilot []string `json:"versionsSitemapPilot"`
}

func publicSiteSettings(row store.SEOSettingsRow) SiteSettings {
	settings := row.Settings
	return SiteSettings{
		Revision:     row.Revision,
		Identity:     settings.Identity,
		Verification: settings.Verification,
		Analytics:    settings.Analytics,
		EdgeCache:    settings.EdgeCache,
		Crawlers:     settings.Crawlers,
		Pages:        publicSitePages{SEOPagesSettings: settings.Pages, VersionsSitemapPilot: seo.VersionsSitemapPilotTokens},
	}
}

func (s *PublicService) SiteSettings(ctx context.Context) (SiteSettings, error) {
	row, err := s.Store.SEOSettings(ctx)
	if err != nil {
		return SiteSettings{}, err
	}
	return publicSiteSettings(row), nil
}

// VerifyIndexNowKey confirms a requested /{key}.txt name without exposing the key
// through any listing endpoint. Disabled, unset or mismatched keys are all 404.
func (s *PublicService) VerifyIndexNowKey(ctx context.Context, key string) (map[string]string, error) {
	notFound := &domain.AppError{Code: domain.CodeNotFound, HTTPStatus: 404}
	row, err := s.Store.SEOSettings(ctx)
	if err != nil {
		return nil, err
	}
	if !row.Settings.IndexNow.Enabled || row.IndexNowKeyCiphertext == "" {
		return nil, notFound
	}
	stored, err := s.Secrets.DecryptSEOSecret("indexnow", row.IndexNowKeyCiphertext)
	if err != nil || subtle.ConstantTimeCompare([]byte(stored), []byte(key)) != 1 {
		return nil, notFound
	}
	return map[string]string{"key": stored}, nil
}
