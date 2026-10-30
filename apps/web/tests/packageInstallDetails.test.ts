// @vitest-environment jsdom
import { computed, createSSRApp, h, ref, resolveComponent } from 'vue';
import type { Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PackageInstall from '../app/components/package/PackageInstall.vue';
import PackageInstallDetailsContent from '../app/components/package/PackageInstallDetailsContent.vue';
import type { PackagePage } from '../app/utils/packageFacts';
import { siteMessage } from '../server/utils/siteCopy';
import production from './fixtures/packageFaq.production.json';

const t = (key: string, named?: Record<string, unknown>) =>
  siteMessage('en-US', key, named as Record<string, string | number>);
const pkg = () => {
  const value = structuredClone(production.packages.iterm2) as unknown as PackagePage;
  // The production fixture predates the formulae.brew.sh link the real API always sends.
  value.formulaeUrl = `https://formulae.brew.sh/cask/${value.token}`;
  return value;
};

beforeEach(() => {
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('resolveComponent', resolveComponent);
  vi.stubGlobal('useI18n', () => ({ t, locale: ref('en-US') }));
  vi.stubGlobal('useLocalePath', () => (path: string) => path);
  vi.stubGlobal('useToasts', () => ({ push: vi.fn() }));
  vi.stubGlobal('toAppLocale', () => 'en-US');
});
afterEach(() => vi.unstubAllGlobals());

async function render(component: Component, props: Record<string, unknown>) {
  const app = createSSRApp({ render: () => h(component, props) });
  app.component('NuxtLink', {
    props: ['to'],
    setup:
      (linkProps, { slots }) =>
      () =>
        h('a', { href: linkProps.to }, slots.default?.())
  });
  const page = document.createElement('div');
  page.innerHTML = await renderToString(app);
  return page;
}

it('does not link the redirected details tab and keeps the body same-page reachable', async () => {
  const value = pkg();
  value.indexing = { detailsRedirect: true } as PackagePage['indexing'];
  const page = await render(PackageInstall, { pkg: value });
  const details = [...page.querySelectorAll('a')].find(link => link.textContent?.includes('Install Details'));
  expect(details?.getAttribute('href')).toBe('#install-details');
  expect(page.innerHTML).not.toContain('/apps/iterm2/details');
});

it('keeps linking install details when the server does not redirect it', async () => {
  const page = await render(PackageInstall, { pkg: pkg() });
  const details = [...page.querySelectorAll('a')].find(link => link.textContent?.includes('Install Details'));
  expect(details?.getAttribute('href')).toBe('/apps/iterm2/details#requirements');
});

it('renders requirements, downloads, checksums and caveats in the shared details body', async () => {
  const value = pkg();
  value.facts = {
    ...value.facts,
    overview: { ...value.facts.overview, caveats: 'Back up your settings before updating.' }
  };
  const page = await render(PackageInstallDetailsContent, { pkg: value });
  expect(page.querySelector('[data-testid="package-install-details"]')).not.toBeNull();
  const requirements = page.querySelector('[data-testid="package-requirements"]');
  expect(requirements?.textContent).toContain('iterm2.com/downloads');
  expect(requirements?.textContent).toContain(value.facts.overview.sha256!.slice(0, 12));
  expect(page.textContent).toContain('Back up your settings before updating.');
});

it('keeps a summary download and checksum visible when no requirements row has them', async () => {
  const value = pkg();
  value.facts = { ...value.facts, requirements: [] };
  const page = await render(PackageInstallDetailsContent, { pkg: value });
  expect(page.textContent).toContain(value.facts.overview.downloadUrl!);
  expect(page.textContent).toContain(value.facts.overview.sha256!);
});

it.each([
  {
    name: 'disabled',
    fields: { homebrewStatus: { state: 'disabled', reason: 'discontinued' }, disabled: false },
    command: false,
    notice: 'Homebrew has disabled this package: discontinued'
  },
  {
    name: 'deprecated',
    fields: { homebrewStatus: { state: 'deprecated', reason: 'unmaintained' }, disabled: false },
    command: true,
    notice: 'Homebrew has deprecated this package: unmaintained'
  },
  {
    name: 'paused',
    fields: { homebrewStatus: { state: 'active', reason: null }, disabled: true, disable: { reason: 'stale' } },
    command: true,
    notice: 'No new version for more than 90 days'
  }
])('applies the overview lifecycle guard to the details command: $name', async ({ fields, command, notice }) => {
  const value = { ...pkg(), ...fields } as PackagePage;
  const page = await render(PackageInstallDetailsContent, { pkg: value });
  expect(page.textContent).toContain(notice);
  expect(page.textContent?.includes('brew install --cask iterm2')).toBe(command);
  expect(page.querySelector('[data-testid="package-install-notice"]')).not.toBeNull();
});
