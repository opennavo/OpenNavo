import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
import { useHermesStore } from '@/stores/hermes';
import HermesAgentProfiles from '@/components/hermes/HermesAgentProfiles.vue';
import { i18n } from '@/i18n';

function ok<T>(data: T) {
  return { status: 'ok' as const, data };
}

const profiles = [
  {
    name: 'default',
    displayName: null,
    path: '/tmp/hermes',
    isDefault: true,
    model: 'gpt-5.4',
    provider: 'openai-api',
    skillCount: 0,
    hasEnv: false,
    description: null,
    botTitle: null,
    distributionName: null,
    distributionVersion: null
  },
  {
    name: 'research',
    displayName: 'Research',
    path: '/tmp/hermes/profiles/research',
    isDefault: false,
    model: 'claude-sonnet-4.5',
    provider: 'anthropic',
    skillCount: 2,
    hasEnv: true,
    description: null,
    botTitle: null,
    distributionName: null,
    distributionVersion: null
  }
];

describe('Hermes profile manager', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(profiles));
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockResolvedValue(ok('You are Hermes.'));
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok({ providers: [], model: null, provider: null }));
  });

  it('lists profiles and loads the selected SOUL', async () => {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const wrapper = mount(HermesAgentProfiles, {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body
    });
    await flushPromises();
    expect(document.body.textContent).toContain('Research');
    const row = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Research'));
    expect(row).toBeTruthy();
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('You are Hermes.');
    wrapper.unmount();
  });
});
