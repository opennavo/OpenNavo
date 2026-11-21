const DEFAULT_ORIGIN = 'https://admin-origin.opennavo.com';
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const CLIENT_IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip'];

/**
 * Keep the private MCP endpoint on the admin hostname while the admin bundle is served by Pages.
 * Access bypasses only this exact path; the Function authenticates to the origin with a service
 * token, so the origin hostname stays unreachable without Cloudflare Access.
 */
export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  if (incoming.pathname !== '/mcp') {
    return new Response('Not Found', { status: 404 });
  }

  let origin;
  try {
    origin = new URL(env.MCP_ORIGIN || DEFAULT_ORIGIN);
  } catch {
    return new Response('Invalid MCP_ORIGIN', { status: 500 });
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
    return new Response('Invalid MCP_ORIGIN', { status: 500 });
  }

  const clientID = env.MCP_ACCESS_CLIENT_ID;
  const clientSecret = env.MCP_ACCESS_CLIENT_SECRET;
  if (!clientID || !clientSecret) {
    return new Response('MCP origin credentials are not configured', { status: 503 });
  }

  const target = new URL('/mcp', origin.origin);
  const headers = new Headers(request.headers);
  // MCP clients authenticate with their own Bearer token. Never forward admin Access cookies or
  // client-supplied service-token headers to the origin.
  headers.delete('cookie');
  headers.delete('cf-access-jwt-assertion');
  headers.delete('cf-access-client-id');
  headers.delete('cf-access-client-secret');
  headers.delete('host');
  headers.delete('content-length');

  // The API trusts client IPs only from its ingress. Replace any browser-supplied chain with
  // Cloudflare's verified client address so MCP IP allowlists see the real caller.
  const clientIP = request.headers.get('cf-connecting-ip');
  for (const name of CLIENT_IP_HEADERS) {
    headers.delete(name);
  }
  if (clientIP) {
    headers.set('x-forwarded-for', clientIP);
    headers.set('x-real-ip', clientIP);
  }
  headers.set('cf-access-client-id', clientID);
  headers.set('cf-access-client-secret', clientSecret);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (!METHODS_WITHOUT_BODY.has(request.method)) {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return new Response('MCP origin unavailable', { status: 502 });
  }

  const responseHeaders = new Headers(upstream.headers);
  // Access sets its own session cookies at the edge; do not expose them on the public admin host.
  responseHeaders.delete('set-cookie');
  for (const name of Array.from(responseHeaders.keys())) {
    if (name.toLowerCase().startsWith('cf-access-')) {
      responseHeaders.delete(name);
    }
  }

  const location = responseHeaders.get('Location');
  if (location) {
    try {
      const resolved = new URL(location, target);
      if (resolved.origin === origin.origin) {
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
