import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Run after `pnpm --filter @opennavo/web build`. Exercise the real production
// renderer against synthetic API data, without a browser or production services.
test('SSR preserves literal @ in package routes and page-authored metadata', { timeout: 60000 }, async t => {
  const entry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url));
  await access(entry);
  const requestedTokens = new Set();
  let collectionState = 'empty';
  let collectionRequests = 0;
  const api = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const match = /^\/api\/v1\/packages\/cask\/([^/]+)(\/related)?$/.exec(path);
    let data;
    let status = 200;
    if (match && ['versioned-app@11', 'ordinary-app'].includes(match[1])) {
      const token = match[1];
      requestedTokens.add(token);
      data = match[2]
        ? []
        : {
            id: 1,
            kind: 'cask',
            token,
            displayName: 'Example App @11',
            names: ['Example App @11'],
            summary: 'Synthetic package summary',
            description: 'A synthetic package for SSR regression tests.',
            version: '11.0',
            versionChangedAt: '2026-01-01T00:00:00Z',
            tap: 'homebrew/cask',
            installCommand: `brew install --cask ${token}`,
            artifacts: { apps: ['Example.app'], pkgs: [], binaries: [], uninstallNotes: [] },
            installs: { d30: 10, d90: 20, d365: 30 },
            categories: [],
            tags: [],
            conflictsWith: { casks: [], formulae: [] },
            supports: { status: 'known', arm64: true, x86_64: true },
            platforms: [],
            screenshots: [],
            releaseCount: 0,
            releaseStats: { count30d: 0, cadence: 'unknown', brewLag: null },
            sourceUrl: 'https://example.test/source',
            formulaeUrl: 'https://example.test/package',
            sourceLocale: 'en-US',
            machineTranslated: false
          };
    } else if (path === '/api/v1/collections') {
      collectionRequests++;
      status = collectionState === 'error' ? 503 : 200;
      const records =
        collectionState === 'published'
          ? [
              {
                slug: 'recovery-check',
                title: 'Collection recovery marker',
                subtitle: 'Fixture',
                itemCount: 0,
                iconUrls: [],
                previewItems: [],
                sourceLocale: 'en-US',
                updatedAt: '2026-01-01T00:00:00Z'
              }
            ]
          : [];
      data = status === 200 ? { current: 1, size: 24, total: records.length, records } : null;
    } else {
      status = 404;
      data = null;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: status === 200 ? '0000' : '4040', msg: 'fixture', data }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise(resolve => api.close(resolve)));
  const apiBase = `http://127.0.0.1:${api.address().port}/api/v1`;
  // Nitro treats PORT=0 as its default port; reserve a free local port instead.
  const reservation = createPortReservation();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = String(reservation.address().port);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: port,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: port,
      NITRO_UNIX_SOCKET: '',
      NUXT_API_BASE_INTERNAL: apiBase,
      NUXT_PUBLIC_API_BASE: apiBase,
      NUXT_REDIS_URL: '',
      NUXT_PUBLIC_SITE_URL: 'https://example.test',
      NUXT_PUBLIC_I18N_BASE_URL: 'https://example.test',
      NUXT_PUBLIC_CDN_BASE: 'https://example.test/assets'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  const exited = once(child, 'exit');
  child.stderr.on('data', chunk => {
    logs += chunk;
  });
  t.after(async () => {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SSR did not start: ${logs}`)), 15000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`SSR exited: ${logs}`));
    });
    child.stdout.on('data', chunk => {
      logs += chunk;
      const url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
  for (const prefix of ['', '/zh', '/ja', '/es', '/pt', '/ru']) {
    await t.test(`${prefix || '/en (root)'} versioned detail`, async () => {
      const path = `${prefix}/apps/versioned-app@11`;
      const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
      const html = await response.text();
      assert.equal(response.status, 200, `${path}\n${logs}`);
      assert.match(html, /<title>[^<]*Example App @11[^<]*OpenNavo<\/title>/);
      assert.match(html, /<h1\b[^>]*>Example App @11<\/h1>/);
      assert.ok(html.includes('brew install --cask versioned-app@11'));
      assert.ok(html.includes(`https://example.test${path}`), 'canonical URL retains the version suffix');
    });
  }
  for (const path of ['/apps/ordinary-app', '/apps/versioned-app@11/details']) {
    await t.test(path, async () => {
      const response = await fetch(`${origin}${path}`, { headers: { accept: 'text/html' } });
      assert.equal(response.status, 200, logs);
      assert.match(await response.text(), /<title>[^<]*Example App @11[^<]*OpenNavo<\/title>/);
    });
  }
  await t.test('unknown versioned package remains a 404', async () => {
    const response = await fetch(`${origin}/apps/missing-app@0`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404, logs);
    assert.match(await response.text(), /<title>[^<]+<\/title>/);
  });
  for (const path of ['/collections', '/zh/collections', '/zh/collections/']) {
    await t.test(`${path} does not retain empty or failed responses`, async () => {
      for (const state of ['empty', 'published', 'error', 'published']) {
        collectionState = state;
        const before = collectionRequests;
        const response = await fetch(`${origin}${path}`);
        const html = await response.text();
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.status, state === 'error' ? 503 : 200);
        if (state === 'error') assert.equal(response.headers.get('retry-after'), '5');
        assert.ok(collectionRequests > before, 'each render must recheck current collection data');
        assert.equal(html.includes('Collection recovery marker'), state === 'published');
      }
    });
  }
  assert.deepEqual([...requestedTokens].sort(), ['ordinary-app', 'versioned-app@11']);
});
