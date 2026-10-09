// Smoke test: call getPackage against Prism public mock (make mock, 4010), verifying typed client envelope decoding.
import { describe, expect, it } from 'vitest';
import { createPublicClient, unwrap } from '../src';
import type { PackageDetail } from '../src';

const baseUrl = process.env.PRISM_PUBLIC_URL ?? 'http://127.0.0.1:4010';

describe('Prism 4010', () => {
  it('getPackage returns correctly typed data', async () => {
    const api = createPublicClient({ baseUrl, locale: 'zh-CN', platform: 'web', version: '0.0.0' });
    const pkg: PackageDetail = await unwrap(
      api.GET('/packages/{kind}/{token}', { params: { path: { kind: 'cask', token: 'visual-studio-code' } } })
    );
    expect(pkg.kind).toBe('cask');
    expect(typeof pkg.token).toBe('string');
    expect(typeof pkg.name).toBe('string');
    expect(pkg.installCommand).toMatch(/^brew install --(cask|formula) /);
  });
});
