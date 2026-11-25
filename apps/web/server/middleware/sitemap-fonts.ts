import { createError, defineEventHandler, setHeader } from 'h3';
import { packageSitemapName, VERSIONS_SITEMAP_PILOT_TOKENS } from '../../shared/utils/sitemapBuckets';
import { getSiteSettings } from '../utils/siteSettings';

const DISABLED_BUCKET = /^\/__sitemap__\/(fonts|versions)-bucket-\d+\.xml$/;
const UNCACHEABLE = ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control'] as const;

// Run before the sitemap response cache, including cached XML from an earlier enabled configuration.
export default defineEventHandler(async event => {
  const path = event.path.split('?', 1)[0] ?? '';
  const group = DISABLED_BUCKET.exec(path)?.[1];
  if (!group) return;

  const settings = await getSiteSettings();
  // Same list the API applies in page decisions; the shared copy answers while the API is unreachable.
  const pilotPaths = new Set(
    (settings.pages.versionsSitemapPilot ?? [...VERSIONS_SITEMAP_PILOT_TOKENS]).map(
      token => `/__sitemap__/${packageSitemapName('versions', token)}.xml`
    )
  );
  const enabled =
    group === 'fonts' ? settings.pages.fontsSitemap : settings.pages.versionsSitemap || pilotPaths.has(path);
  if (enabled) return;

  // H3 may send a thrown error directly without running Nitro's beforeResponse hooks.
  for (const header of UNCACHEABLE) setHeader(event, header, 'no-store');
  throw createError({ statusCode: 410, statusMessage: 'Sitemap gone' });
});
