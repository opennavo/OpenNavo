import { proxyToApi } from './_shared/proxy.js';

const OAUTH_METADATA = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp'
]);

/**
 * MCP OAuth discovery starts at the admin hostname because the protected-resource metadata points
 * there. These exact paths must keep working while every other admin path stays behind Access.
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);
  if (OAUTH_METADATA.has(pathname)) {
    return proxyToApi(request, env);
  }
  return next();
}
