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
});
