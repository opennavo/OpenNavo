const DEFAULT_API_ORIGIN = 'https://api.opennavo.com';
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

/**
 * Proxy an admin request to the API origin while preserving method, path, query, body and
 * Authorization. Both /admin-api/* and the protocol /oauth/* endpoints use this function so the
 * browser keeps the Pages origin.
 */
export async function proxyToApi(request, env) {
  const incoming = new URL(request.url);
  const configured = env.ADMIN_API_ORIGIN || DEFAULT_API_ORIGIN;

  let apiOrigin;
  try {
    apiOrigin = new URL(configured);
  } catch {
    return new Response('Invalid ADMIN_API_ORIGIN', { status: 500 });
  }
  if (apiOrigin.protocol !== 'https:' && apiOrigin.protocol !== 'http:') {
    return new Response('Invalid ADMIN_API_ORIGIN', { status: 500 });
  }

  const basePath = apiOrigin.pathname === '/' ? '' : apiOrigin.pathname.replace(/\/$/, '');
  const target = new URL(basePath + incoming.pathname + incoming.search, apiOrigin.origin);
  const headers = new Headers(request.headers);
  // Admin authentication is a Bearer token. Do not forward Access cookies or assertions to the
  // API origin, where they are not needed and would widen the credential's exposure.
  headers.delete('cookie');
  headers.delete('cf-access-jwt-assertion');
  // The API only trusts client-IP headers from its configured ingress. Replace any browser-supplied
  // chain with Cloudflare's verified client address; otherwise audit logs and rate limits would
  // record the shared Pages egress address instead of the administrator's address.
  const clientIP = request.headers.get('cf-connecting-ip');
  for (const name of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip']) {
    headers.delete(name);
  }
  if (clientIP) {
    headers.set('x-forwarded-for', clientIP);
    headers.set('x-real-ip', clientIP);
  }
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!METHODS_WITHOUT_BODY.has(request.method)) {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return new Response('Admin API unavailable', { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  const location = responseHeaders.get('Location');
  if (location) {
    try {
      const resolved = new URL(location, target);
      if (resolved.origin === apiOrigin.origin) {
        responseHeaders.set('Location', resolved.pathname + resolved.search);
      }
    } catch {
      // Preserve an opaque Location value.
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
