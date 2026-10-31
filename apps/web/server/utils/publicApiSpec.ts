export const PUBLIC_API = 'https://api.opennavo.com';
export const PUBLIC_API_BASE = `${PUBLIC_API}/api/v1`;

// apps/server/internal/http/server.go registers the public spec at /api/v1/openapi.yaml.
const PUBLIC_API_SPEC_PATHS = new Map([['/api/v1', '/api/v1/openapi.yaml']]);
const PUBLIC_API_SPEC_URL = `${PUBLIC_API_BASE}/openapi.yaml`;

/** Resolve only the production API origin and registered public specification paths. */
export function publicApiSpecUrl(apiBase?: string): string {
  try {
    const url = new URL(apiBase ?? '');
    const specPath = PUBLIC_API_SPEC_PATHS.get(url.pathname.replace(/\/+$/, ''));
    if (
      url.origin !== PUBLIC_API ||
      // Check the raw authority too: URL normalization removes :443 and empty userinfo.
      !/^https:\/\/api\.opennavo\.com(?:[/?#]|$)/i.test(apiBase ?? '') ||
      specPath === undefined
    )
      return PUBLIC_API_SPEC_URL;
    return `${PUBLIC_API}${specPath}`;
  } catch {
    return PUBLIC_API_SPEC_URL;
  }
}
