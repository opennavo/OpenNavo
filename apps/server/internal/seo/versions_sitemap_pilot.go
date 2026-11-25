package seo

// VersionsSitemapPilotTokens is the approved versions-sitemap pilot (#215, approved 2026-11-04),
// extended to the pages Bing's 2026-11-24 SEO report marked as important. While the global versions
// sitemap is off, these apps' English versions pages stay listed: DecidePage applies the list and the
// public site settings expose it, so the web sitemap generator lists exactly the URLs page decisions
// mark inSitemap.
//
// Keep this list explicit and review the Bing recommendation before adding entries. It mirrors
// VERSIONS_SITEMAP_PILOT_TOKENS in apps/web/shared/utils/sitemapBuckets.ts, which the web keeps only as
// the fallback used before the API answers.
var VersionsSitemapPilotTokens = []string{
	"dotnet-sdk",
	"google-chrome",
	"microsoft-openjdk@17",
	"zulu@25",
	"chitubox",
	"obs",
	"microsoft-outlook",
	"roblox",
	"vuescan",
	"zulu@11",
	"anydesk",
	"corretto@17",
	"omnissa-horizon-client",
	"zen@twilight",
	"temurin@11",
	"microsoft-edge",
	"burp-suite",
	"gimp",
	"mendeley-reference-manager",
	"opera-air",
	"qgis",
	"android-platform-tools",
	"pdf-expert@beta",
	"bitwarden",
	"sketchup",
}

// VersionsSitemapPilotLocale is the only language the pilot lists; its pages carry no alternates.
const VersionsSitemapPilotLocale = "en-US"

var versionsSitemapPilot = func() map[string]struct{} {
	tokens := make(map[string]struct{}, len(VersionsSitemapPilotTokens))
	for _, token := range VersionsSitemapPilotTokens {
		tokens[token] = struct{}{}
	}
	return tokens
}()

// IsVersionsSitemapPilot reports whether an app is on the approved versions-sitemap pilot.
func IsVersionsSitemapPilot(token string) bool {
	_, ok := versionsSitemapPilot[token]
	return ok
}
