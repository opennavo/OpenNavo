// Keep this count stable: changing it requires expiring all sitemap caches together.
// Hashing tokens (rather than slicing a sorted URL list) keeps every language of an app
// in the same file even when other apps or translations are added or removed.
export const SITEMAP_BUCKET_COUNT = 8;
export const PACKAGE_SITEMAP_GROUPS = ['apps', 'fonts', 'versions'] as const;
export type PackageSitemapGroup = (typeof PACKAGE_SITEMAP_GROUPS)[number];

export function packageSitemapName(group: PackageSitemapGroup, token: string) {
  let hash = 2166136261;
  for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${group}-bucket-${(hash >>> 0) % SITEMAP_BUCKET_COUNT}`;
}

/**
 * The approved versions-sitemap pilot (#215, approved 2026-11-04), extended to the pages Bing's
 * 2026-11-24 SEO report marked as important. While the global versions sitemap is off, only these
 * apps' source-language release histories are listed, with no localized alternates.
 *
 * The API owns the rule: seo.VersionsSitemapPilotTokens feeds page decisions and the public site
 * settings (pages.versionsSitemapPilot). This copy is the default used before the API answers and
 * the shared fixture for tests; keep it matching the server list. Review the Bing recommendation
 * before adding entries.
 */
export const VERSIONS_SITEMAP_PILOT_TOKENS: ReadonlySet<string> = new Set([
  'dotnet-sdk',
  'google-chrome',
  'microsoft-openjdk@17',
  'zulu@25',
  'chitubox',
  'obs',
  'microsoft-outlook',
  'roblox',
  'vuescan',
  'zulu@11',
  'anydesk',
  'corretto@17',
  'omnissa-horizon-client',
  'zen@twilight',
  'temurin@11',
  'microsoft-edge',
  'burp-suite',
  'gimp',
  'mendeley-reference-manager',
  'opera-air',
  'qgis',
  'android-platform-tools',
  'pdf-expert@beta',
  'bitwarden',
  'sketchup'
]);
export const VERSIONS_SITEMAP_PILOT_BUCKETS: ReadonlySet<string> = new Set(
  [...VERSIONS_SITEMAP_PILOT_TOKENS].map(token => packageSitemapName('versions', token))
);
/** The original single-page pilot, kept for tests that assert one bucket. */
export const VERSIONS_SITEMAP_PILOT_TOKEN = 'dotnet-sdk';
export const VERSIONS_SITEMAP_PILOT_BUCKET = packageSitemapName('versions', VERSIONS_SITEMAP_PILOT_TOKEN);

export const packageSitemaps = Object.fromEntries(
  PACKAGE_SITEMAP_GROUPS.flatMap(group =>
    Array.from({ length: SITEMAP_BUCKET_COUNT }, (_, bucket) => [
      `${group}-bucket-${bucket}`,
      { includeAppSources: false, chunks: false as const }
    ])
  )
);
