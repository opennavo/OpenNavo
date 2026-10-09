import { describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR, createPublicClient, isApiError, unwrap } from '../src';

type Handler = (request: Request) => Response | Promise<Response>;

function setup(handler: Handler, options: Partial<Parameters<typeof createPublicClient>[0]> = {}) {
  const requests: Request[] = [];
  const api = createPublicClient({
    baseUrl: 'https://api.test/api/v1',
    fetch: async input => {
      const request = input instanceof Request ? input : new Request(input);
      requests.push(request);
      return handler(request);
    },
    ...options
  });
  return { api, requests };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const getPackage = (api: ReturnType<typeof setup>['api']) =>
  api.GET('/packages/{kind}/{token}', { params: { path: { kind: 'cask', token: 'visual-studio-code' } } });

describe('createPublicClient', () => {
  it('Send language/client headers', async () => {
    let locale: 'zh-CN' | 'en-US' = 'zh-CN';
    const { api, requests } = setup(() => json(200, { code: '0000', msg: 'ok', data: null }), {
      locale: () => locale,
      platform: 'desktop',
      version: '0.3.0'
    });
    await unwrap(api.GET('/home'));
    locale = 'en-US';
    await unwrap(api.GET('/home'));
    expect(requests.map(request => request.headers.get('Accept-Language'))).toEqual(['zh-CN', 'en-US']);
    expect(requests[0]?.headers.get('X-Client-Platform')).toBe('desktop');
    expect(requests[0]?.headers.get('X-Client-Version')).toBe('0.3.0');
    expect(requests[0]?.url).toBe('https://api.test/api/v1/home');
  });

  it('Omit optional headers when unspecified', async () => {
    const { api, requests } = setup(() => json(200, { code: '0000', msg: 'ok', data: null }), { locale: 'en-US' });
    await unwrap(api.GET('/home'));
    expect(requests[0]?.headers.get('Accept-Language')).toBe('en-US');
    expect(requests[0]?.headers.get('X-Client-Platform')).toBeNull();
    expect(requests[0]?.headers.get('X-Client-Version')).toBeNull();

    const bare = setup(() => json(200, { code: '0000', msg: 'ok', data: null }));
    await unwrap(bare.api.GET('/home'));
    expect(bare.requests[0]?.headers.get('Accept-Language')).toBeNull();
  });

  it('Path and query parameters', async () => {
    const { api, requests } = setup(() => json(200, { code: '0000', msg: 'ok', data: { records: [] } }));
    await unwrap(api.GET('/search', { params: { query: { q: '微信', current: 2, size: 24 } } }));
    expect(new URL(requests[0]?.url ?? '').searchParams.get('q')).toBe('微信');
    expect(new URL(requests[0]?.url ?? '').searchParams.get('current')).toBe('2');
  });
});

describe('unwrap', () => {
  it('Return data on success', async () => {
    const { api } = setup(() => json(200, { code: '0000', msg: 'ok', data: { token: 'visual-studio-code' } }));
    const pkg = await unwrap(getPackage(api));
    expect(pkg.token).toBe('visual-studio-code');
  });

  it('Throw ApiError with business/status codes and request ID', async () => {
    const { api } = setup(() =>
      json(404, { code: '1002', msg: '找不到这个包', data: null }, { 'X-Request-Id': 'req-1' })
    );
    const error = await unwrap(getPackage(api)).catch((reason: unknown) => reason);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ code: '1002', msg: '找不到这个包', status: 404, requestId: 'req-1' });
    expect((error as ApiError).isNotFound).toBe(true);
    expect((error as ApiError).isNetworkError).toBe(false);
  });

  it('HTTP 200 with business code other than 0000 still fails', async () => {
    const { api } = setup(() => json(200, { code: '1005', msg: '请求过于频繁', data: null }));
    await expect(unwrap(getPackage(api))).rejects.toMatchObject({ code: '1005', status: 200, requestId: null });
  });

  it('Nonstandard error responses map status to generic business codes', async () => {
    const html = (status: number) => () =>
      new Response('<html>Bad Gateway</html>', { status, headers: { 'Content-Type': 'text/html' } });
    await expect(unwrap(getPackage(setup(html(502)).api))).rejects.toMatchObject({
      code: '5000',
      msg: 'HTTP 502',
      status: 502
    });
    await expect(unwrap(getPackage(setup(html(404)).api))).rejects.toMatchObject({ code: '1002', status: 404 });
  });

  it('Network failures become network business codes', async () => {
    const offline = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = await unwrap(getPackage(offline.api)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: NETWORK_ERROR, status: 0, msg: 'Failed to fetch' });
    expect((error as ApiError).isNetworkError).toBe(true);
    expect((error as ApiError).cause).toBeInstanceOf(TypeError);

    const odd = setup(() => Promise.reject('connection reset'));
    await expect(unwrap(getPackage(odd.api))).rejects.toMatchObject({ code: NETWORK_ERROR, msg: 'connection reset' });
  });

  it('Read non-JSON Brewfile responses as text', async () => {
    const { api } = setup(() => new Response('cask "ghostty"\n', { headers: { 'Content-Type': 'text/plain' } }));
    const { data } = await api.GET('/collections/{slug}/brewfile', {
      params: { path: { slug: 'new-mac' } },
      parseAs: 'text'
    });
    expect(data).toBe('cask "ghostty"\n');
  });
});
