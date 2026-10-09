import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import MirrorSettings from '@/components/settings/MirrorSettings.vue';
import { useMirrorOptions } from '@/composables/useMirrorOptions';
import { i18n } from '@/i18n';
import type { MirrorProbe } from '@/ipc/bindings';
import { commands } from '@/ipc/client';
import { startLocalState, useSettingsStore } from '@/stores';
import { setup } from './helpers';

// Settings download sources and shared source list (first-launch-onboarding §3.3, D2).
const remote = vi.hoisted(() => ({ config: null as unknown }));
vi.mock('@/composables/useClientConfig', () => ({
  fetchClientConfig: async () => {
    if (!remote.config) throw new Error('offline');
    return remote.config;
  }
}));

const mirror = (key: string, recommended = false) => ({
  key,
  name: key.toUpperCase(),
  probeUrl: `https://${key}.example/api/formula.jws.json`,
  recommended,
  apiDomain: `https://${key}.example/api`,
  bottleDomain: `https://${key}.example/bottles`,
  brewGitRemote: `https://${key}.example/brew.git`,
  coreGitRemote: `https://${key}.example/core.git`
});

const radios = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

beforeEach(() => {
  remote.config = { mirrors: [mirror('tuna', true), mirror('ustc')] };
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountSettings() {
  const context = await setup('/settings/mirrors');
  await startLocalState();
  mount(MirrorSettings, { global: { plugins: [context.pinia, context.router, i18n] }, attachTo: document.body });
  await flushPromises();
}

describe('Settings: download sources', () => {
  it('Prepend built-in official when absent, distinguish fastest/recommended, save full selected URLs', async () => {
    await mountSettings();
    expect(radios().map(item => item.textContent)).toEqual([
      expect.stringContaining('官方源'),
      expect.stringContaining('TUNA'),
      expect.stringContaining('USTC')
    ]);
    const [official, tuna, ustc] = radios();
    expect(official?.getAttribute('aria-checked')).toBe('true');
    expect(tuna?.textContent).toContain('最快');
    expect(tuna?.textContent).toContain('推荐');
    expect(ustc?.textContent).not.toContain('推荐');
    ustc?.click();
    await flushPromises();
    expect(useSettingsStore().value?.mirror).toEqual({
      key: 'ustc',
      apiDomain: 'https://ustc.example/api',
      bottleDomain: 'https://ustc.example/bottles',
      brewGitRemote: 'https://ustc.example/brew.git',
      coreGitRemote: 'https://ustc.example/core.git'
    });
  });

  it('Official remains selectable with mirror-load errors and retry guidance', async () => {
    remote.config = null;
    await mountSettings();
    expect(radios()).toHaveLength(1);
    expect(document.body.textContent).toContain('暂时拿不到镜像列表');
    remote.config = { mirrors: [mirror('tuna')] };
    [...document.body.querySelectorAll('button')].find(item => item.textContent?.trim() === '重试')?.click();
    await vi.waitFor(() => expect(radios()).toHaveLength(2));
  });
});

describe('Settings: copy terminal environment', () => {
  const envText = () => document.body.querySelector('pre')?.textContent;

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // jsdom has no clipboard: use an observable implementation; copied text must match the displayed text.
  async function clickCopy() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    [...document.body.querySelectorAll('button')].find(item => item.textContent?.includes('复制终端环境变量'))?.click();
    await flushPromises();
    return writeText;
  }

  it('Official source unsets four variables on separate lines', async () => {
    await mountSettings();
    const expected = [
      'unset HOMEBREW_API_DOMAIN',
      'unset HOMEBREW_BOTTLE_DOMAIN',
      'unset HOMEBREW_BREW_GIT_REMOTE',
      'unset HOMEBREW_CORE_GIT_REMOTE'
    ].join('\n');
    expect(envText()).toBe(expected);
    expect(await clickCopy()).toHaveBeenCalledWith(expected);
  });

  it('Mirrors export one variable per line with single-quoted URLs', async () => {
    await mountSettings();
    radios()[2]?.click();
    await flushPromises();
    const expected = [
      "export HOMEBREW_API_DOMAIN='https://ustc.example/api'",
      "export HOMEBREW_BOTTLE_DOMAIN='https://ustc.example/bottles'",
      "export HOMEBREW_BREW_GIT_REMOTE='https://ustc.example/brew.git'",
      "export HOMEBREW_CORE_GIT_REMOTE='https://ustc.example/core.git'"
    ].join('\n');
    expect(envText()).toBe(expected);
    expect(await clickCopy()).toHaveBeenCalledWith(expected);
  });

  it('Export only configured URLs and escape embedded quotes', async () => {
    await mountSettings();
    await useSettingsStore().update('mirror', {
      key: 'custom',
      apiDomain: "https://mirror.example/api?q='value'",
      bottleDomain: null,
      brewGitRemote: null,
      coreGitRemote: null
    });
    await flushPromises();
    expect(envText()).toBe("export HOMEBREW_API_DOMAIN='https://mirror.example/api?q='\\''value'\\'''");
  });
});

describe('Slow official-source suggestions', () => {
  async function suggestionFor(probes: MirrorProbe[]) {
    await setup();
    vi.spyOn(commands, 'mirrorProbe').mockResolvedValue({ status: 'ok', data: probes });
    let state: ReturnType<typeof useMirrorOptions> | undefined;
    const Probe = defineComponent({
      setup() {
        state = useMirrorOptions();
        return () => h('div');
      }
    });
    mount(Probe, { global: { plugins: [i18n] } });
    await state?.load();
    await state?.probe();
    return state?.suggestion.value;
  }
  const result = (key: string, latencyMs: number | null): MirrorProbe => ({
    key,
    ok: latencyMs !== null,
    latencyMs,
    status: latencyMs === null ? null : 200,
    error: latencyMs === null ? 'timeout' : null
  });

  it('Suggest fastest mirror when official exceeds 1,500 ms and mirrors are faster', async () => {
    const suggestion = await suggestionFor([result('official', 2400), result('tuna', 40), result('ustc', 30)]);
    expect(suggestion?.option.key).toBe('ustc');
    expect(suggestion?.officialMs).toBe(2400);
  });

  it('Suggest a reachable mirror when official probing fails', async () => {
    const suggestion = await suggestionFor([result('official', null), result('tuna', 40), result('ustc', null)]);
    expect(suggestion?.option.key).toBe('tuna');
    expect(suggestion?.officialMs).toBeNull();
  });

  it('No suggestion below 1,500 ms or when mirrors fail/are slower', async () => {
    expect(await suggestionFor([result('official', 1500), result('tuna', 40)])).toBeUndefined();
    expect(await suggestionFor([result('official', 2400), result('tuna', null)])).toBeUndefined();
    expect(await suggestionFor([result('official', 1600), result('tuna', 1800)])).toBeUndefined();
  });
});
