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

function seedPanelConnection() {
  localStorage.setItem(
    'ONV_HERMES_PROFILES_V1',
    JSON.stringify({
      version: 1,
      activeProfileId: 'panel-1',
      profiles: [
        { id: 'local', name: 'Local Mac', kind: 'local', endpoint: '', status: 'connected', version: '0.23.3', latency: null, models: 0 },
        {
          id: 'panel-1',
          name: 'Panel',
          kind: 'panel',
          endpoint: 'http://panel.test:9119',
          status: 'connected',
          version: '0.23.3',
          latency: 12,
          models: 1
        }
      ],
      states: {}
    })
  );
}

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

  it('writes the soul again when a create did not store it', async () => {
    vi.spyOn(commands, 'hermesAgentProfileCreate').mockResolvedValue(ok(null));
    let stored = 'You are Hermes.';
    const save = vi.spyOn(commands, 'hermesAgentProfileSoulSave').mockImplementation(async (_connectionId, _url, _name, content) => {
      stored = content;
      return ok(null);
    });
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockImplementation(async () => ok(stored));

    const store = useHermesStore();
    await store.createAgentProfile('xdx', null, 'You are XDX.');

    // The host ignored the create-time `soul`; the readback caught it and wrote the file.
    expect(save).toHaveBeenCalledWith(null, null, 'xdx', 'You are XDX.');
  });

  it('binds the first chat of a created profile to that profile', async () => {
    seedPanelConnection();
    vi.spyOn(commands, 'hermesAgentProfileCreate').mockResolvedValue(ok(null));
    let stored = 'You are XDX.';
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockImplementation(async () => ok(stored));
    vi.spyOn(commands, 'hermesAgentProfileSoulSave').mockImplementation(async (_connectionId, _url, _name, content) => {
      stored = content;
      return ok(null);
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue(
      ok({ text: 'Hello', sessionId: 'stored-1', liveSessionId: null, usage: null, interrupted: false })
    );
    const store = useHermesStore();

    await store.createAgentProfile('xdx', 'default', 'You are XDX.');
    await store.send('hello');

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ profile: 'xdx' }));
  });

  it('does not switch to a created profile whose soul could not be stored', async () => {
    seedPanelConnection();
    vi.spyOn(commands, 'hermesAgentProfileCreate').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesAgentProfileSoulSave').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockResolvedValue(ok('You are Hermes.'));

    const store = useHermesStore();

    await expect(store.createAgentProfile('xdx', null, 'You are XDX.')).rejects.toThrow(/SOUL\.md/);
    expect(store.activeAgentProfileName).toBe('default');
  });

  it('rejects a save the host does not actually store', async () => {
    vi.spyOn(commands, 'hermesAgentProfileSoulSave').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockResolvedValue(ok('You are Hermes.'));

    const store = useHermesStore();

    await expect(store.saveAgentProfileSoul('research', 'A different identity')).rejects.toThrow(/SOUL\.md/);
  });

  it('saves the SOUL and starts a new chat from the profile editor', async () => {
    let stored = 'You are Hermes.';
    vi.spyOn(commands, 'hermesAgentProfileSoulSave').mockImplementation(async (_connectionId, _url, _name, content) => {
      stored = content;
      return ok(null);
    });
    vi.spyOn(commands, 'hermesAgentProfileSoul').mockImplementation(async () => ok(stored));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    store.conversations.push({ id: 'old-chat', messages: [], updatedAt: 1 });
    store.activeId = 'old-chat';
    const wrapper = mount(HermesAgentProfiles, {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body
    });
    await flushPromises();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'New identity';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    const button = [...document.querySelectorAll('button')].find(candidate =>
      ['Save & new chat', '保存并开始新对话'].includes(candidate.textContent?.trim() ?? '')
    );
    expect(button).toBeTruthy();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(commands.hermesAgentProfileSoulSave).toHaveBeenCalledWith(null, null, 'default', 'New identity');
    expect(store.activeId).toBeNull();
    wrapper.unmount();
  });
});
