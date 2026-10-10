// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TARGETS,
  artifactUrl,
  githubArtifactUrl,
  channelOf,
  releaseBody,
  renderCask,
  versionFromTag
} from '../scripts/release-lib.mjs';

// M5-03: release artifact names, draft registration payloads, and cask rendering (06 §15, 03 §13.3).
const scripts = resolve(__dirname, '../scripts');
const template = readFileSync(resolve(__dirname, '../packaging/homebrew/opennavo.rb.tmpl'), 'utf8');
const sha = 'a'.repeat(64);

describe('Versions and channels', () => {
  it('Parse tag versions and route prereleases to beta', () => {
    expect(versionFromTag('desktop-v0.3.0')).toBe('0.3.0');
    expect(channelOf('0.3.0')).toBe('stable');
    expect(() => versionFromTag('0.3.0')).toThrow();
    expect(githubArtifactUrl('acme/opennavo', '0.3.0-beta.1', 'OpenNavo_x64.app.tar.gz')).toBe(
      'https://github.com/acme/opennavo/releases/download/desktop-v0.3.0-beta.1/OpenNavo_x64.app.tar.gz'
    );
    expect(channelOf('0.3.0-beta.1')).toBe('beta');
    expect(() => versionFromTag('desktop-v0.3')).toThrow();
    expect(artifactUrl('https://cdn.example/desktop/', '0.3.0', 'OpenNavo_aarch64.app.tar.gz')).toBe(
      'https://cdn.example/desktop/0.3.0/OpenNavo_aarch64.app.tar.gz'
    );
  });
});

describe('Draft registration', () => {
  const artifact = (target: string, signature: string | null) => ({
    target,
    url: `https://cdn.example/desktop/0.3.0/${target}`,
    signature,
    bytes: 10,
    sha256: sha
  });

  it('Build complete three-target payloads without DMG signatures', () => {
    const body = releaseBody({
      version: '0.3.0',
      channel: 'stable',
      notesEn: 'Fix application startup.',
      artifacts: [artifact('darwin-aarch64', 'sig-a'), artifact('darwin-x86_64', null), artifact('dmg-universal', 'x')]
    });
    expect(body.minMacos).toBe('13.0');
    expect(body).not.toHaveProperty('notesZh');
    expect(body.sourceLocale).toBe('en-US');
    expect(body.i18n).toEqual({ 'en-US': { notes: 'Fix application startup.' } });
    expect(body.artifacts.find(item => item.target === 'dmg-universal')?.signature).toBeNull();
    expect(body.artifacts.find(item => item.target === 'darwin-aarch64')?.signature).toBe('sig-a');
  });

  it('Reject missing targets and invalid versions', () => {
    expect(() =>
      releaseBody({
        version: '0.3.0',
        channel: 'stable',
        artifacts: [artifact('darwin-aarch64', null)]
      })
    ).toThrow(/missing artifacts/);
    expect(() => releaseBody({ version: 'latest', channel: 'stable', artifacts: [] })).toThrow();
  });
});

describe('Cask template', () => {
  it('Replace placeholders, omit introductory comments, reject invalid values', () => {
    const cask = renderCask(template, {
      version: '0.3.0',
      sha256: sha,
      downloadUrl: 'https://github.com/acme/opennavo/releases/download/desktop-v0.3.0/OpenNavo_0.3.0_universal.dmg',
      manifestUrl: 'https://cdn.opennavo.com/desktop/stable/latest.json',
      homepage: 'https://opennavo.example/'
    });
    expect(cask.startsWith('cask "opennavo" do')).toBe(true);
    expect(cask).toContain('version "0.3.0"');
    expect(cask).toContain(`sha256 "${sha}"`);
    expect(cask).toContain(
      'url "https://github.com/acme/opennavo/releases/download/desktop-v0.3.0/OpenNavo_0.3.0_universal.dmg"'
    );
    expect(cask).not.toContain('{{');
    expect(() =>
      renderCask(template, {
        version: '0.3.0',
        sha256: 'zz',
        downloadUrl: 'https://a.b',
        manifestUrl: 'https://a.b',
        homepage: 'https://a.b'
      })
    ).toThrow();
    expect(() =>
      renderCask(template, {
        version: '0.3.0',
        sha256: sha,
        downloadUrl: 'https://a.b/"; system "x',
        manifestUrl: 'https://a.b',
        homepage: 'https://a.b'
      })
    ).toThrow();
  });
});

describe('Artifact collection and cask rendering commands', () => {
  it('Collect updater archives, signatures, and DMG from Tauri bundles, then render cask', () => {
    const root = mkdtempSync(join(tmpdir(), 'opennavo-release-'));
    const out = join(root, 'out');
    const app = join(root, 'aarch64', 'macos');
    const dmg = join(root, 'universal', 'dmg');
    mkdirSync(app, { recursive: true });
    mkdirSync(dmg, { recursive: true });
    writeFileSync(join(app, 'OpenNavo.app.tar.gz'), 'archive');
    writeFileSync(join(app, 'OpenNavo.app.tar.gz.sig'), 'signature-text\n');
    writeFileSync(join(dmg, 'OpenNavo_0.3.0_universal.dmg'), 'disk image');
    const run = (args: string[]) => execFileSync('node', args, { encoding: 'utf8' });

    run([
      join(scripts, 'release-artifacts.mjs'),
      '--target',
      'darwin-aarch64',
      '--version',
      '0.3.0',
      '--base-url',
      'https://cdn.opennavo.example/desktop',
      '--bundle-dir',
      join(root, 'aarch64'),
      '--out',
      out
    ]);
    run([
      join(scripts, 'release-artifacts.mjs'),
      '--target',
      'dmg-universal',
      '--version',
      '0.3.0',
      '--base-url',
      'https://cdn.opennavo.example/desktop',
      '--bundle-dir',
      join(root, 'universal'),
      '--out',
      out
    ]);

    const updater = JSON.parse(readFileSync(join(out, 'darwin-aarch64.json'), 'utf8'));
    expect(updater).toMatchObject({
      target: 'darwin-aarch64',
      file: TARGETS['darwin-aarch64'].file('0.3.0'),
      url: 'https://cdn.opennavo.example/desktop/0.3.0/OpenNavo_aarch64.app.tar.gz',
      signature: 'signature-text',
      bytes: 7
    });
    const image = JSON.parse(readFileSync(join(out, 'dmg-universal.json'), 'utf8'));
    expect(image.signature).toBeNull();
    expect(image.file).toBe('OpenNavo_0.3.0_universal.dmg');

    const caskPath = join(root, 'Casks', 'opennavo.rb');
    run([join(scripts, 'render-cask.mjs'), '--dir', out, '--version', '0.3.0', '--out', caskPath]);
    expect(readFileSync(caskPath, 'utf8')).toContain(`sha256 "${image.sha256}"`);
  });
});
