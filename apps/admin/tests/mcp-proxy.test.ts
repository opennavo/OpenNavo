// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/mcp';

const env = {
  MCP_ORIGIN: 'https://origin.test',
  MCP_ACCESS_CLIENT_ID: 'client-id.access',
  MCP_ACCESS_CLIENT_SECRET: 'client-secret'
};

function request(path = '/mcp', init?: RequestInit): Request {
  return new Request(`https://admin.test${path}`, init);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin MCP Pages Function', () => {
  it('only handles the exact MCP path', async () => {
    const response = await onRequest({ request: request('/mcp/other'), env });
    expect(response.status).toBe(404);
  });

  it('refuses to proxy without origin service credentials', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await onRequest({ request: request(), env: { MCP_ORIGIN: env.MCP_ORIGIN } });
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('streams the MCP request to the origin with a verified client address', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: message\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'set-cookie': 'access=secret',
          'cf-access-jwt-assertion': 'assertion'
        }
      })
    );
    const response = await onRequest({
      request: request('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer client-token',
          'content-type': 'application/json',
          cookie: 'admin-session=secret',
          'cf-access-client-id': 'browser-supplied',
          'cf-access-client-secret': 'browser-supplied',
          'cf-access-jwt-assertion': 'browser-supplied',
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.9',
          'x-real-ip': '198.51.100.9'
        },
        body: '{}'
      }),
      env
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cf-access-jwt-assertion')).toBeNull();

    const [target, init] = fetcher.mock.calls[0];
    expect(String(target)).toBe('https://origin.test/mcp');
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer client-token');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('cf-access-jwt-assertion')).toBeNull();
    expect(headers.get('cf-access-client-id')).toBe(env.MCP_ACCESS_CLIENT_ID);
    expect(headers.get('cf-access-client-secret')).toBe(env.MCP_ACCESS_CLIENT_SECRET);
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('x-real-ip')).toBe('203.0.113.7');
  });

  it('does not send a body for GET probes', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    await onRequest({ request: request('/mcp', { method: 'GET' }), env });
    const [, init] = fetcher.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it('returns a gateway error when the origin is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(502);
  });
});
