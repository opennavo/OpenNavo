import { flushPromises, shallowMount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPage from '@/pages/AssistantPage.vue';
import HermesProfiles from '@/components/hermes/HermesProfiles.vue';
import HermesGatewayModal from '@/components/hermes/HermesGatewayModal.vue';
import { IpcError, commands } from '@/ipc/client';
import { i18n } from '@/i18n';
import { useHermesStore } from '@/stores/hermes';
import { setup } from './helpers';

const PROFILES_KEY = 'ONV_HERMES_PROFILES_V1';
const wrappers: VueWrapper[] = [];

function seedOfflinePanel() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify({
      version: 1,
      activeProfileId: 'panel-1',
      profiles: [
        {
          id: 'local',
          name: 'Local Mac',
          kind: 'local',
          endpoint: '',
          status: 'connected',
          version: '0.23.3',
          latency: null,
          models: 0
        },
        {
          id: 'panel-1',
          name: 'ubHermes',
          kind: 'panel',
          endpoint: 'http://100.64.0.9:9119',
          status: 'offline',
          version: '0.23.3',
          latency: 121,
          models: 1,
          error: 'Could not reach the gateway.'
        }
      ],
      states: {}
    })
  );
}

function seedExpiredPanel() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify({
      version: 1,
      activeProfileId: 'panel-1',
      profiles: [
        {
          id: 'local',
          name: 'Local Mac',
          kind: 'local',
          endpoint: '',
          status: 'connected',
          version: '0.23.3',
          latency: null,
          models: 0
        },
        {
          id: 'panel-1',
          name: 'ubHermes',
          kind: 'panel',
          endpoint: 'http://100.64.0.9:9119',
          status: 'error',
          version: '0.23.3',
          latency: 121,
          models: 1,
          error: 'Unauthorized'
        }
      ],
      states: {}
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  window.history.replaceState(null, '', '/?mock=hermes-ready');
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Hermes panel re-login', () => {
  it('Opens the sign-in sheet when the connection list asks to re-login', async () => {
    seedExpiredPanel();
    const { pinia, router } = await setup('/assistant');
    const wrapper = shallowMount(AssistantPage, {
      global: { plugins: [pinia, router, i18n] },
      attachTo: document.body
    });
    wrappers.push(wrapper);
    await flushPromises();
    const store = useHermesStore();
    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;

    wrapper.findComponent(HermesProfiles).vm.$emit('relogin', panel);
    await flushPromises();

    const modal = wrapper.findComponent(HermesGatewayModal);
    expect(modal.props('open')).toBe(true);
    expect(modal.props('reloginId')).toBe('panel-1');
    expect(modal.props('initialName')).toBe('ubHermes');
    expect(modal.props('initialUrl')).toBe('http://100.64.0.9:9119');
  });

  it('Shows a panel sign-in prompt instead of the local install gate', async () => {
    seedExpiredPanel();
    const { pinia, router } = await setup('/assistant');
    const expired = new IpcError({
      code: 'E_HERMES_PANEL_AUTH',
      message: 'Hermes Panel session expired. Sign in again.',
      detail: 'Unauthorized'
    });
    vi.spyOn(commands, 'hermesAgentProfiles').mockRejectedValue(expired);
    vi.spyOn(commands, 'hermesConnectionProbe').mockRejectedValue(expired);
    const wrapper = shallowMount(AssistantPage, {
      global: { plugins: [pinia, router, i18n] },
      attachTo: document.body
    });
    wrappers.push(wrapper);
    await flushPromises();

    // A signed-out panel is not a Mac missing its local runtime.
    expect(wrapper.text()).toContain('Hermes Panel 连接不可用');
    expect(wrapper.text()).toContain('Unauthorized');
    expect(wrapper.text()).not.toContain('本机 Hermes 尚未安装');
  });

  it('Keeps the conversation and offers a retry while the panel is unreachable', async () => {
    seedOfflinePanel();
    const { pinia, router } = await setup('/assistant');
    const unreachable = new IpcError({
      code: 'E_HERMES_PROBE',
      message: 'Could not reach the gateway.',
      detail: 'operation timed out'
    });
    vi.spyOn(commands, 'hermesAgentProfiles').mockRejectedValue(unreachable);
    vi.spyOn(commands, 'hermesConnectionProbe').mockRejectedValue(unreachable);
    const wrapper = shallowMount(AssistantPage, {
      global: { plugins: [pinia, router, i18n] },
      attachTo: document.body
    });
    wrappers.push(wrapper);
    await flushPromises();

    // A transient drop keeps the transcript: only a rejected session takes the whole page.
    expect(wrapper.text()).not.toContain('Hermes Panel 连接不可用');
    expect(wrapper.text()).toContain('Hermes Panel 暂时无法连接');
    expect(wrapper.find('[data-hermes-panel-offline]').exists()).toBe(true);
    // `shallowMount` drops the button's slot, so the retry affordance is found by attribute.
    expect(wrapper.find('[data-hermes-panel-retry]').exists()).toBe(true);

    // The welcome suggestions sit under the offline banner; they must not bypass its guard.
    const store = useHermesStore();
    const send = vi.spyOn(store, 'send');
    const suggestions = wrapper.findAll('[data-hermes-suggestion]');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every(button => (button.element as HTMLButtonElement).disabled)).toBe(true);
    await suggestions[0]!.trigger('click');
    expect(send).not.toHaveBeenCalled();

    // A disabled primary must not advertise Enter; the hint drops the ↵ prefix while offline.
    await wrapper.find('textarea').setValue('hello');
    expect(wrapper.text()).not.toContain('↵');

    // Clear the store's retry timer so it cannot fire after this test restores the mocks.
    vi.mocked(commands.hermesConnectionProbe).mockResolvedValue({
      status: 'ok',
      data: { ok: true, latencyMs: 4, version: '0.23.3', profiles: 1 }
    } as never);
    await store.retryConnections();
  });
});
