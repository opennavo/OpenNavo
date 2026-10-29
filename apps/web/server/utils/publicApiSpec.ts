export const PUBLIC_API = 'https://api.opennavo.com';
export const PUBLIC_API_BASE = `${PUBLIC_API}/api/v1`;

/** Resolve the public specification URL from an HTTPS API base. */
export function publicApiSpecUrl(apiBase?: string): string {
  try {
    const url = new URL(apiBase ?? '');
    if (url.protocol !== 'https:') return `${PUBLIC_API_BASE}/openapi.yaml`;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/openapi.yaml`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return `${PUBLIC_API_BASE}/openapi.yaml`;
  }
}
