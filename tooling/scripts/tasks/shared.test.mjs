import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentEnvironment } from './shared.mjs';

test('local settings override examples while explicit environment wins', t => {
  const root = mkdtempSync(join(tmpdir(), 'opennavo-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(
    join(root, 'apps/server/.env.example'),
    'DATABASE_URL=example\nLLM_ENABLED=false\nJWT_SECRET=example\nLLM_API_KEY=\n'
  );
  writeFileSync(
    join(root, 'apps/server/.env.local'),
    'export DATABASE_URL="local=value"\nLLM_ENABLED=true # local\nJWT_SECRET="local # value"\nLLM_MODEL=\n'
  );
  const env = developmentEnvironment(root, { JWT_SECRET: 'explicit', PATH: '/usr/bin' });
  assert.equal(env.DATABASE_URL, 'local=value');
  assert.equal(env.LLM_ENABLED, 'true');
  assert.equal(env.JWT_SECRET, 'explicit');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.LLM_MODEL, '');
  assert.equal(Object.hasOwn(env, 'LLM_API_KEY'), false);
  assert.equal(developmentEnvironment(root, {}).JWT_SECRET, 'local # value');
});

test('a fresh checkout needs no local environment file', t => {
  const root = mkdtempSync(join(tmpdir(), 'opennavo-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(join(root, 'apps/server/.env.example'), 'LLM_ENABLED=false\nLLM_API_KEY=\n');
  assert.deepEqual(developmentEnvironment(root, {}), { LLM_ENABLED: 'false' });
});
