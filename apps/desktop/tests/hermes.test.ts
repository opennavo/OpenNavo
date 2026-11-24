import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHermesStore } from '@/stores/hermes';
import { HERMES_PROVIDER_MAP, hermesProviderSlug, pickOfficialProvider } from '@/hermes/providers';
import { useToasts } from '@/composables/useToasts';
import { IpcError, commands } from '@/ipc/client';

const eventMock = vi.hoisted(() => {
  type EventPayload = Record<string, unknown>;
  const listeners: { event: string; handler: (event: { payload: EventPayload }) => void }[] = [];
  return {
    listeners,
    listen: vi.fn(async (event: string, handler: (event: { payload: EventPayload }) => void) => {
      listeners.push({ event, handler });
      return () => undefined;
    })
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: eventMock.listen }));

const STORAGE_KEY = 'ONV_HERMES_STATE_V2';
const PROFILES_KEY = 'ONV_HERMES_PROFILES_V1';

const PANEL_CATALOG = {
  providers: [
    {
      slug: 'custom',
      name: 'Custom',
      is_current: true,
      authenticated: false,
      models: ['grok-4.7'],
      total_models: 1
    },
    {
      slug: 'custom:newapi',
      name: 'newapi',
      is_current: true,
      authenticated: true,
      models: ['grok-4.6', 'grok-4.3'],
      total_models: 2
    }
  ],
  model: 'grok-4.7',
  provider: 'custom'
};

const PANEL_AGENT_PROFILES = [
  {
    name: 'default',
    displayName: null,
    path: '/tmp/hermes',
    isDefault: true,
    model: 'grok-4.7',
    provider: 'custom',
    skillCount: 0,
    hasEnv: false,
    description: null,
    botTitle: null,
    distributionName: null,
    distributionVersion: null
  }
];

function panelLoginMocks() {
  vi.spyOn(commands, 'hermesPanelLogout').mockResolvedValue({ status: 'ok', data: null });
  vi.spyOn(commands, 'hermesPanelLogin').mockResolvedValue({
    status: 'ok',
    data: { baseUrl: 'http://panel.tail1234.ts.net:9119', provider: 'basic' }
  });
  vi.spyOn(commands, 'hermesConnectionProbe').mockResolvedValue({
    status: 'ok',
    data: { ok: true, latencyMs: 4, version: '0.23.3', profiles: 1 }
  });
  vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
    status: 'ok',
    data: PANEL_CATALOG
  });
}

function seedPanelProfile() {
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
          version: '0.23.0',
          latency: null,
          models: 0
        },
        {
          id: 'panel-1',
          name: 'Panel',
          kind: 'panel',
          endpoint: 'http://panel.tail1234.ts.net:9119',
          status: 'connected',
          version: '0.23.0',
          latency: 12,
          models: 2
        }
      ],
      states: {}
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  eventMock.listeners.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('Hermes conversation store', () => {
  it('Migrates old full-control state to safe Mac defaults', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mac: {
          enabled: true,
          level: 'full',
          terminal: true,
          screen: true,
          files: true,
          install: true,
          cron: true,
          confirmWrites: false
        },
        conversations: [],
        activeId: null
      })
    );
    const store = useHermesStore();
    expect(store.mac.enabled).toBe(false);
    expect(store.mac.level).toBe('open');
    expect(store.mac.confirmWrites).toBe(true);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      version: number;
      mac: { enabled: boolean };
    };
    expect(saved.version).toBe(3);
    expect(saved.mac.enabled).toBe(false);
  });

  it('Restores per-profile history and disables Mac controls on a remote profile', () => {
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    });
    const store = useHermesStore();
    store.conversations.push({
      id: 'local-conversation',
      messages: [{ id: 'local-message', role: 'user', text: 'local', at: 1 }],
      updatedAt: 1
    });
    store.activeId = 'local-conversation';
    store.profiles.push({
      id: 'remote-test',
      name: 'Remote test',
      kind: 'remote',
      endpoint: 'wss://remote.test/api/ws',
      status: 'connected',
      version: '0.23.0',
      latency: 12,
      models: 2
    });
    store.switchProfile('remote-test');
    expect(store.remoteActive).toBe(true);
    expect(store.messages).toHaveLength(0);
    expect(store.mac.enabled).toBe(false);
    store.switchProfile('local');
    expect(store.remoteActive).toBe(false);
    expect(store.messages[0]?.text).toBe('local');
  });

  it('Persists profile color and default route', () => {
    const store = useHermesStore();
    store.setAgentProfileColor('work', '#123456');
    store.setAgentProfileDefault('work');
    const raw = JSON.parse(localStorage.getItem('ONV_HERMES_PROFILES_V1') ?? '{}') as {
      profileColors?: Record<string, string>;
      defaultAgentProfiles?: Record<string, string>;
    };
    expect(raw.profileColors?.work).toBe('#123456');
    expect(raw.defaultAgentProfiles?.local).toBe('work');
  });

  it('Interrupts a remote turn with the id and route it had before clearing them', () => {
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    });
    const store = useHermesStore();
    store.profiles.push({
      id: 'remote-test',
      name: 'Remote test',
      kind: 'remote',
      endpoint: 'wss://remote.test/api/ws',
      status: 'connected',
      version: '0.23.0',
      latency: 12,
      models: 2
    });
    store.switchProfile('remote-test');
    store.conversations.push({
      id: 'remote-chat',
      messages: [{ id: 'remote-message', role: 'user', text: 'remote', at: 1 }],
      updatedAt: 1,
      liveSessionId: 'live-1'
    });
    store.activeId = 'remote-chat';
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);

    store.stopThinking();

    expect(interrupt).toHaveBeenCalledWith('live-1', 'wss://remote.test/api/ws', 'remote-test');
    expect(store.active?.liveSessionId).toBeUndefined();
  });

  it('Selects a notification conversation without stopping the active turn', async () => {
    const store = useHermesStore();
    store.conversations.push(
      {
        id: 'finished-chat',
        messages: [{ id: 'finished-message', role: 'user', text: 'finished', at: 1 }],
        updatedAt: 1
      },
      {
        id: 'running-chat',
        messages: [{ id: 'running-message', role: 'user', text: 'running', at: 2 }],
        updatedAt: 2,
        liveSessionId: 'live-2'
      }
    );
    store.activeId = 'running-chat';
    const interrupt = vi.spyOn(commands, 'hermesInterrupt');
    const stop = vi.spyOn(commands, 'hermesStop');

    await expect(store.revealConversation('finished-chat')).resolves.toBe(true);

    expect(store.activeId).toBe('finished-chat');
    expect(interrupt).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('Ignores a history read that finishes after another profile took over', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    const deferred = new Map<string, (value: unknown) => void>();
    vi.spyOn(commands, 'hermesHistoryLoad').mockImplementation(
      profile =>
        new Promise(resolve => {
          deferred.set(profile ?? 'default', resolve);
        }) as never
    );
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();

    const first = store.loadHistory('default');
    // Let the first read reach the backend before the switch supersedes it.
    await Promise.resolve();
    await Promise.resolve();
    const second = store.loadHistory('work');
    await Promise.resolve();
    await Promise.resolve();
    deferred.get('work')!({
      status: 'ok',
      data: JSON.stringify({
        conversations: [{ id: 'work-chat', messages: [], updatedAt: 2 }],
        activeId: 'work-chat'
      })
    });
    await second;
    expect(store.conversations.map(item => item.id)).toEqual(['work-chat']);

    // The older request returns last and must not overwrite the profile that owns the store.
    deferred.get('default')!({
      status: 'ok',
      data: JSON.stringify({
        conversations: [{ id: 'default-chat', messages: [], updatedAt: 1 }],
        activeId: 'default-chat'
      })
    });
    await first;
    expect(store.conversations.map(item => item.id)).toEqual(['work-chat']);
    expect(store.activeId).toBe('work-chat');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('Keeps conversations isolated per Hermes profile', () => {
    const store = useHermesStore();
    store.conversations.push({
      id: 'default-chat',
      messages: [{ id: 'default-message', role: 'user', text: 'default', at: 1 }],
      updatedAt: 1
    });
    store.activeId = 'default-chat';
    store.switchAgentProfile('work');
    expect(store.activeAgentProfileName).toBe('work');
    expect(store.messages).toHaveLength(0);
    store.conversations.push({
      id: 'work-chat',
      messages: [{ id: 'work-message', role: 'user', text: 'work', at: 2 }],
      updatedAt: 2
    });
    store.activeId = 'work-chat';
    store.switchAgentProfile('default');
    expect(store.activeAgentProfileName).toBe('default');
    expect(store.messages[0]?.text).toBe('default');
  });

  it('Drops a saved API key when the agent profile changes', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'reply', sessionId: 'session-1', liveSessionId: null, usage: null, interrupted: false }
    });
    const store = useHermesStore();
    await store.loadRuntime();
    // A key the sheet saved while profile `default` was active. Keeping it in the store made
    // the next turn in another profile write it into that profile's `.env`.
    store.setApiKey('sk-profile-default');
    await store.switchAgentProfile('work');
    expect(store.activeAgentProfileName).toBe('work');
    expect(store.apiKey).toBe('');
    store.newChat();
    await store.send('hello');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ apiKey: null, profile: 'work' }));
  });

  it('Switches to a profile on another connection in one step', () => {
    const store = useHermesStore();
    store.profiles.push({
      id: 'fleet-remote',
      name: 'Fleet remote',
      kind: 'remote',
      endpoint: 'wss://fleet.test/api/ws',
      status: 'connected',
      version: '0.23.0',
      latency: 10,
      models: 2
    });
    store.switchToAgentProfile('fleet-remote', 'research');
    expect(store.activeProfileId).toBe('fleet-remote');
    expect(store.activeAgentProfileName).toBe('research');
    expect(store.remoteActive).toBe(true);
  });

  it('Sends the remote gateway and profile with a remote chat request', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: false,
        installed: false,
        version: null,
        expectedVersion: '0.19.0',
        path: null,
        dataPath: '/tmp/OpenNavoData',
        computerUse: false,
        outdated: false,
        message: null
      }
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'Remote reply', sessionId: 'remote-session', liveSessionId: null, usage: null, interrupted: false }
    });
    localStorage.setItem(
      'ONV_HERMES_PROFILES_V1',
      JSON.stringify({
        version: 1,
        activeProfileId: 'remote-test',
        profiles: [
          {
            id: 'local',
            name: 'Local Mac',
            kind: 'local',
            endpoint: '',
            status: 'connected',
            version: '0.23.0',
            latency: null,
            models: 0
          },
          {
            id: 'remote-test',
            name: 'Panel test',
            kind: 'panel',
            endpoint: 'wss://remote.test/api/ws',
            status: 'connected',
            version: '0.23.0',
            latency: 12,
            models: 2
          }
        ],
        states: {}
      })
    );
    const store = useHermesStore();
    await store.send('Use the remote gateway');
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: 'wss://remote.test/api/ws',
        profileId: 'remote-test',
        panelAuth: true,
        macEnabled: false,
        macTerminal: false,
        macScreen: false,
        macFiles: false,
        macCron: false
      })
    );
    expect(store.messages.at(-1)?.text).toBe('Remote reply');
  });

  it('Aligns a panel profile to the authenticated provider row', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    const store = useHermesStore();

    await store.loadModelOptions(false);

    // `custom` is a stale, unauthenticated row with one saved model. The endpoint that
    // actually answers is the scoped `custom:newapi` row, so a new profile must not inherit
    // the stale model or card-level provider id.
    expect(store.model.provider).toBe('custom');
    expect(store.model.model).toBe('grok-4.6');
  });

  it('Sends the scoped panel provider slug instead of the provider card id', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'Panel reply', sessionId: 'panel-session', liveSessionId: null, usage: null, interrupted: false }
    });
    const store = useHermesStore();
    await store.loadModelOptions(false);

    await store.send('Use the working endpoint');

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'custom:newapi',
        model: 'grok-4.6'
      })
    );
  });

  it('Repairs a stale saved model before the next panel turn', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'Panel reply', sessionId: 'panel-session', liveSessionId: null, usage: null, interrupted: false }
    });
    const store = useHermesStore();
    await store.loadModelOptions(false);
    store.saveModel({ ...store.model, provider: 'custom', model: 'grok-4.7' });

    await store.send('Use the repaired endpoint');

    expect(store.model.model).toBe('grok-4.6');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom:newapi', model: 'grok-4.6' }));
  });

  it('Does not treat a model provider 401 as an expired panel session', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    vi.spyOn(commands, 'hermesChat').mockRejectedValue(
      new IpcError({
        code: 'E_HERMES_GATEWAY_STREAM',
        message: 'custom rejected your API key',
        detail: 'Provider said: HTTP 401: Invalid token'
      })
    );
    const store = useHermesStore();
    await store.loadModelOptions(false);

    await store.send('Trigger the provider error');

    expect(store.panelAuthExpired).toBeNull();
  });

  it('Retries the first turn once by resuming the session a provider 401 just created', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    let calls = 0;
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(async input => {
      calls += 1;
      const session = eventMock.listeners.filter(listener => listener.event === 'hermes-session').at(-1);
      session?.handler({
        payload: {
          requestId: input.requestId,
          liveSessionId: calls === 1 ? 'live-new' : 'live-new',
          sessionId: 'stored-new',
          resumed: calls > 1
        }
      });
      if (calls === 1) {
        throw new IpcError({
          code: 'E_HERMES_GATEWAY_STREAM',
          message: "custom rejected your API key, so the model can't be reached.",
          detail: 'Provider said: HTTP 401: Invalid token'
        });
      }
      return {
        status: 'ok' as const,
        data: {
          text: 'Recovered after resume',
          sessionId: 'stored-new',
          liveSessionId: 'live-new',
          usage: null,
          interrupted: false
        }
      };
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadModelOptions(false);
    store.newChat();
    useToasts().clear();

    await store.send('Who are you?');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(store.messages.at(-1)?.text).toBe('Recovered after resume'));

    expect(chat.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'stored-new' });
    expect(store.messages.filter(entry => entry.role === 'user')).toHaveLength(1);
    expect(store.messages.filter(entry => entry.role === 'assistant')).toHaveLength(1);
    expect(useToasts().items.value.some(toast => toast.tone === 'danger')).toBe(false);
  });

  it('Keeps a queued message behind a first-turn retry', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    let calls = 0;
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(async input => {
      calls += 1;
      const session = eventMock.listeners.filter(listener => listener.event === 'hermes-session').at(-1);
      session?.handler({
        payload: {
          requestId: input.requestId,
          liveSessionId: `live-${calls}`,
          sessionId: 'stored-new',
          resumed: calls > 1,
          busyInputMode: 'queue'
        }
      });
      if (calls === 1) {
        throw new IpcError({
          code: 'E_HERMES_GATEWAY_STREAM',
          message: "custom rejected your API key, so the model can't be reached.",
          detail: 'Provider said: HTTP 401: Invalid token'
        });
      }
      return {
        status: 'ok' as const,
        data: {
          text: calls === 2 ? 'Retry reply' : 'Queued reply',
          sessionId: 'stored-new',
          liveSessionId: `live-${calls}`,
          usage: null,
          interrupted: false
        }
      };
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadModelOptions(false);
    store.newChat();

    const first = store.send('first');
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    // The first turn is parked on its retry delay with the turn still live, so the next message
    // cannot start: the queue policy holds it until the retry's turn settles.
    await store.send('next');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(3), { timeout: 3_000 });
    await first;
    await vi.waitFor(() =>
      expect(store.messages.filter(entry => entry.role === 'assistant').map(entry => entry.text)).toEqual([
        'Retry reply',
        'Queued reply'
      ])
    );

    expect(chat.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'stored-new', prompt: 'first' });
    expect(chat.mock.calls[2]?.[0]).toMatchObject({ prompt: 'next' });
  });

  it('Does not retry a provider 401 when the turn resumed an existing session', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockRejectedValue(
      new IpcError({
        code: 'E_HERMES_GATEWAY_STREAM',
        message: 'custom rejected your API key',
        detail: 'Provider said: HTTP 401: Invalid token'
      })
    );
    const store = useHermesStore();
    await store.loadModelOptions(false);
    store.conversations.push({ id: 'resume-chat', messages: [], updatedAt: 1, sessionId: 'stored-old' });
    store.activeId = 'resume-chat';

    await store.send('Use the stored session');
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(useToasts().items.value.some(toast => toast.title === 'Hermes Panel')).toBe(true);
  });

  it('Still asks for a panel login when the panel session itself expired', async () => {
    seedPanelProfile();
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    vi.spyOn(commands, 'hermesChat').mockRejectedValue(
      new IpcError({
        code: 'E_HERMES_PANEL_AUTH',
        message: 'Hermes Panel session is missing. Sign in again.',
        detail: null
      })
    );
    const store = useHermesStore();
    await store.loadModelOptions(false);

    await store.send('Trigger the panel auth error');

    expect(store.panelAuthExpired).toBe('panel-1');
    // A missing session has no detail; the message is the only useful thing to show.
    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.error).toBe('Hermes Panel session is missing. Sign in again.');
  });

  it('Keeps a rejected panel session out of the connected state during a probe', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesConnectionProbe').mockRejectedValue(
      new IpcError({
        code: 'E_HERMES_PANEL_AUTH',
        message: 'Hermes Panel session expired. Sign in again.',
        detail: 'Unauthorized'
      })
    );
    const store = useHermesStore();

    await store.probeConnections();

    // The panel's public /api/status still answers when the session is dead; the profile must
    // stay on "sign in again" instead of flipping back to connected every minute.
    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.status).toBe('error');
    expect(panel.error).toBe('Unauthorized');
    expect(store.panelAuthExpired).toBe('panel-1');
  });

  it('Ignores a probe that answers after the panel signed in again', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let rejectStaleProbe: (reason: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesConnectionProbe')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStaleProbe = reject;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { ok: true, latencyMs: 4, version: '0.23.3', profiles: 1 }
      } as never);
    vi.spyOn(commands, 'hermesPanelLogout').mockResolvedValue({ status: 'ok', data: null });
    vi.spyOn(commands, 'hermesPanelLogin').mockResolvedValue({
      status: 'ok',
      data: { baseUrl: 'http://panel.tail1234.ts.net:9119', provider: 'basic' }
    });
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue({
      status: 'ok',
      data: [
        {
          name: 'default',
          displayName: null,
          path: '/tmp/hermes',
          isDefault: true,
          model: 'grok-4.7',
          provider: 'custom',
          skillCount: 0,
          hasEnv: false,
          description: null,
          botTitle: null,
          distributionName: null,
          distributionVersion: null
        }
      ]
    });
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: PANEL_CATALOG
    });
    const store = useHermesStore();

    const probing = store.probeConnections();
    await store.reloginPanel('panel-1', 'http://panel.tail1234.ts.net:9119', 'admin', 'secret');
    // The probe's request left before the sign-in; its 401 must not undo the new session.
    rejectStaleProbe(
      new IpcError({
        code: 'E_HERMES_PANEL_AUTH',
        message: 'Hermes Panel session expired. Sign in again.',
        detail: 'Unauthorized'
      })
    );
    await probing;

    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.status).toBe('connected');
    expect(panel.error).toBeUndefined();
    expect(store.panelAuthExpired).toBeNull();

    // The next launch reads this record: it must not restore the pre-login error state.
    const persisted = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as {
      profiles?: { id: string; status: string; error?: string }[];
    };
    const saved = persisted.profiles?.find(profile => profile.id === 'panel-1');
    expect(saved?.status).toBe('connected');
    expect(saved?.error).toBeUndefined();
  });

  it('Retries a transient probe failure instead of leaving the panel offline', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.useFakeTimers();
    const probe = vi
      .spyOn(commands, 'hermesConnectionProbe')
      .mockRejectedValueOnce(
        new IpcError({
          code: 'E_HERMES_PROBE',
          message: 'Could not reach the gateway.',
          detail: 'operation timed out'
        })
      )
      .mockResolvedValue({
        status: 'ok',
        data: { ok: true, latencyMs: 7, version: '0.23.4', profiles: 1 }
      } as never);
    const store = useHermesStore();

    await store.probeConnections();
    let panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    // The real reason is kept for the rail; "Connection probe failed" could not be acted on.
    expect(panel.status).toBe('offline');
    expect(panel.error).toBe('Could not reach the gateway.');

    await vi.advanceTimersByTimeAsync(5_000);
    panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(probe).toHaveBeenCalledTimes(2);
    expect(panel.status).toBe('connected');
    expect(panel.version).toBe('0.23.4');
    expect(panel.error).toBeUndefined();
  });

  it('Runs a manual retry after the probe that was already in flight', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.useFakeTimers();
    let rejectFirst: (reason: unknown) => void = () => undefined;
    const probe = vi
      .spyOn(commands, 'hermesConnectionProbe')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { ok: true, latencyMs: 6, version: '0.23.4', profiles: 1 }
      } as never);
    const store = useHermesStore();

    const first = store.probeConnections();
    expect(probe).toHaveBeenCalledTimes(1);

    // The click must not start a second concurrent request while the slow one is still waiting.
    const retried = store.retryConnections();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    rejectFirst(
      new IpcError({
        code: 'E_HERMES_PROBE',
        message: 'Could not reach the gateway.',
        detail: 'operation timed out'
      })
    );
    await first;
    // Its teardown scheduled the 5 s backoff; the follow-up replaces it instead of waiting.
    await retried;
    expect(probe).toHaveBeenCalledTimes(2);
    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.status).toBe('connected');
    expect(panel.error).toBeUndefined();
    // A successful follow-up leaves no backoff behind: nothing probes again on its own.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('Does not rewrite the stored profiles when a probe only changes latency', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesConnectionProbe').mockResolvedValue({
      status: 'ok',
      data: { ok: true, latencyMs: 999, version: '0.23.0', profiles: 1 }
    } as never);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const store = useHermesStore();
    setItem.mockClear();

    await store.probeConnections();

    // Latency is live telemetry: persisting it rewrote ~2 MB of JSON every minute.
    expect(setItem.mock.calls.filter(([key]) => key === PROFILES_KEY)).toHaveLength(0);
  });

  it('Ignores a profile list that answers after the panel signed in again', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let rejectStaleProfiles: (reason: unknown) => void = () => undefined;
    let panelCalls = 0;
    vi.spyOn(commands, 'hermesAgentProfiles').mockImplementation(((connectionId: string | null) => {
      if (connectionId !== 'panel-1') return Promise.resolve({ status: 'ok', data: [] });
      panelCalls += 1;
      if (panelCalls === 1) {
        return new Promise((_resolve, reject) => {
          rejectStaleProfiles = reject;
        });
      }
      return Promise.resolve({ status: 'ok', data: PANEL_AGENT_PROFILES });
    }) as never);
    panelLoginMocks();
    const store = useHermesStore();

    const loading = store.loadAllAgentProfiles();
    await store.reloginPanel('panel-1', 'http://panel.tail1234.ts.net:9119', 'admin', 'secret');
    // The list read left before the sign-in; its 401 must not undo the new session.
    rejectStaleProfiles(
      new IpcError({
        code: 'E_HERMES_PANEL_AUTH',
        message: 'Hermes Panel session expired. Sign in again.',
        detail: 'Unauthorized'
      })
    );
    await loading;

    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.status).toBe('connected');
    expect(panel.error).toBeUndefined();
    expect(store.panelAuthExpired).toBeNull();
  });

  it('Ignores panel history that answers after the panel signed in again', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let rejectStaleHistory: (reason: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesPanelHistory').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStaleHistory = reject;
        }) as never
    );
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue({
      status: 'ok',
      data: PANEL_AGENT_PROFILES
    });
    panelLoginMocks();
    const store = useHermesStore();

    const loading = store.loadPanelHistory();
    await store.reloginPanel('panel-1', 'http://panel.tail1234.ts.net:9119', 'admin', 'secret');
    // The page read left before the sign-in; its 401 must not reopen the sign-in sheet.
    rejectStaleHistory(
      new IpcError({
        code: 'E_HERMES_PANEL_AUTH',
        message: 'Hermes Panel session expired. Sign in again.',
        detail: 'Unauthorized'
      })
    );
    await loading;

    const panel = store.profiles.find(profile => profile.id === 'panel-1')!;
    expect(panel.status).toBe('connected');
    expect(panel.error).toBeUndefined();
    expect(store.panelAuthExpired).toBeNull();
  });

  it('Does not cache panel history that succeeded after the panel signed in again', async () => {
    seedPanelProfile();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let resolveStaleHistory: (value: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesPanelHistory').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveStaleHistory = resolve;
        }) as never
    );
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue({
      status: 'ok',
      data: PANEL_AGENT_PROFILES
    });
    panelLoginMocks();
    const store = useHermesStore();

    const loading = store.loadPanelHistory();
    await store.reloginPanel('panel-1', 'http://panel.tail1234.ts.net:9119', 'admin', 'secret');
    // A page served under the old session must not become the new session's cache: otherwise the
    // next open of history trusts it instead of reading the slice from the signed-in panel.
    resolveStaleHistory({
      status: 'ok',
      data: JSON.stringify({
        sessions: [
          {
            id: 'stale-session',
            display_name: null,
            title: 'Before re-login',
            preview: 'Old page',
            message_count: 2,
            runtime_revision: 3,
            runtime_generation: 1,
            started_at: 1_700_000_000,
            last_activity_at: 1_700_000_500,
            last_active: 1_700_000_400
          }
        ],
        total: 1,
        hasMore: false,
        degraded: false
      })
    });
    await loading;

    expect(store.conversations.some(item => item.id === 'stale-session')).toBe(false);
    expect(store.panelSlices['panel-1::default']?.recents?.loaded).toBe(false);
  });

  it('Starts with an empty desktop history', () => {
    const store = useHermesStore();
    expect(store.conversations).toHaveLength(0);
    expect(store.activeId).toBeNull();
    expect(store.messages).toHaveLength(0);
    expect(store.history).toHaveLength(0);
  });

  it('Creates a new conversation from a typed prompt and appends a deterministic reply', async () => {
    vi.useFakeTimers();
    const store = useHermesStore();
    store.newChat();
    expect(store.activeId).toBeNull();
    store.send('磁盘快满了，看看能清什么。');
    expect(store.thinking).toBe(true);
    expect(store.activeId).not.toBeNull();
    expect(store.messages).toHaveLength(1);
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(store.thinking).toBe(false);
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]?.card).toBe('cleanup');
    expect(store.history[0]?.id).toBe(store.activeId);
  });

  it('Renames, deletes and clears local conversations', async () => {
    vi.useFakeTimers();
    const store = useHermesStore();
    store.send('hello');
    vi.advanceTimersByTime(600);
    await nextTick();
    const id = store.activeId;
    expect(id).toBeTruthy();
    store.renameConversation(id!, 'Renamed chat');
    expect(store.conversations.find((item: { id: string }) => item.id === id)?.title).toBe('Renamed chat');
    store.deleteConversation(id!);
    expect(store.conversations).toHaveLength(0);
    expect(store.activeId).toBeNull();
    store.send('another');
    vi.advanceTimersByTime(600);
    await nextTick();
    store.clearHistory();
    expect(store.conversations).toHaveLength(0);
    expect(store.activeId).toBeNull();
  });

  it('Persists model, effort and Mac control settings across store instances', async () => {
    const store = useHermesStore();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', effort: 'high' });
    store.saveMac({ ...store.mac, enabled: false, level: 'guarded', confirmWrites: true });
    await nextTick();
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw ?? '{}') as { model: { provider: string; effort: string }; mac: { enabled: boolean } };
    expect(saved.model).toMatchObject({ provider: 'openai', effort: 'high' });
    expect(saved.mac.enabled).toBe(false);

    setActivePinia(createPinia());
    const restored = useHermesStore();
    expect(restored.model.model).toBe('GPT-5.6');
    expect(restored.model.effort).toBe('high');
    expect(restored.mac.enabled).toBe(false);
    expect(restored.mac.confirmWrites).toBe(true);
  });

  it('Uses the bundled runtime when it reports ready and resumes its session', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'Real Hermes reply', sessionId: 'session-1', liveSessionId: null, usage: null, interrupted: false }
    });
    const store = useHermesStore();
    await store.loadRuntime();
    expect(store.runtimeReady).toBe(true);
    store.newChat();
    await store.send('Do something on this Mac');
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Do something on this Mac',
        sessionId: null,
        provider: 'nous',
        model: 'nousresearch/hermes-4-405b',
        controlLevel: 'open',
        macEnabled: false,
        macTerminal: false,
        macScreen: false,
        macFiles: false,
        macCron: false
      })
    );
    expect(store.messages.at(-1)?.text).toBe('Real Hermes reply');
    expect(store.active?.sessionId).toBe('session-1');
    expect(store.thinking).toBe(false);
  });

  it('Renders gateway deltas into the assistant message before the final reply', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finish: (value: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    const sending = store.send('Stream this answer');
    for (
      let attempt = 0;
      attempt < 20 && !eventMock.listeners.some(listener => listener.event === 'hermes-chunk');
      attempt++
    ) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(eventMock.listeners.some(listener => listener.event === 'hermes-chunk')).toBe(true);
    const handler = eventMock.listeners.find(listener => listener.event === 'hermes-chunk')!.handler;
    handler({ payload: { requestId, delta: 'Hello' } });
    handler({ payload: { requestId, delta: ' world' } });
    await nextTick();
    expect(store.messages.at(-1)?.text).toBe('Hello world');
    expect(store.messages.at(-1)?.streaming).toBe(true);
    finish({
      status: 'ok',
      data: { text: 'Hello world', sessionId: 'stored-1', liveSessionId: null, usage: null, interrupted: false }
    });
    await sending;
    expect(store.messages.at(-1)?.text).toBe('Hello world');
    expect(store.messages.at(-1)?.streaming).toBe(false);
    expect(store.active?.sessionId).toBe('stored-1');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('Keeps a streamed preamble when the gateway stops the turn', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finish: (value: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    const notify = vi.spyOn(commands, 'hermesNotifyReply').mockResolvedValue({ status: 'ok', data: null });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    const sending = store.send('check the ads');
    await vi.waitFor(() => expect(eventMock.listeners.some(listener => listener.event === 'hermes-chunk')).toBe(true));
    eventMock.listeners
      .find(listener => listener.event === 'hermes-chunk')!
      .handler({
        payload: { requestId, delta: '可以按时间段投放，我先核对。' }
      });
    finish({
      status: 'ok',
      data: {
        text: '',
        sessionId: 'stopped-1',
        liveSessionId: null,
        usage: null,
        interrupted: true
      }
    });
    await sending;
    expect(store.messages.at(-1)?.text).toBe('可以按时间段投放，我先核对。');
    expect(store.messages.at(-1)?.interrupted).toBe(true);
    expect(store.messages.at(-1)?.streaming).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('Keeps a resumed session id provisional until the turn succeeds', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finish: (value: unknown) => void = () => undefined;
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadRuntime();
    store.conversations.push({ id: 'resume-chat', messages: [], updatedAt: 1, sessionId: 'stored-old' });
    store.activeId = 'resume-chat';
    const sending = store.send('Continue');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    const session = eventMock.listeners.find(listener => listener.event === 'hermes-session')!.handler;

    session({ payload: { requestId, liveSessionId: 'live-new', sessionId: 'stored-new', resumed: true } });
    await nextTick();
    expect(store.active?.sessionId).toBe('stored-old');
    expect(store.mediaSessionId).toBe('stored-new');

    finish({
      status: 'ok',
      data: { text: 'done', sessionId: 'stored-new', liveSessionId: 'live-new', usage: null, interrupted: false }
    });
    await sending;
    expect(store.active?.sessionId).toBe('stored-new');
    expect(store.mediaSessionId).toBe('stored-new');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('Adopts a replacement session when resume failed', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadRuntime();
    store.conversations.push({ id: 'replacement-chat', messages: [], updatedAt: 1, sessionId: 'stored-old' });
    store.activeId = 'replacement-chat';
    void store.send('Start over');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    const session = eventMock.listeners.find(listener => listener.event === 'hermes-session')!.handler;

    session({ payload: { requestId, liveSessionId: 'live-new', sessionId: 'stored-new', resumed: false } });
    await nextTick();
    expect(store.active?.sessionId).toBe('stored-new');
    expect(store.mediaSessionId).toBe('stored-new');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('Shows one card at a time and records what the runtime did with it', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const respond = vi.spyOn(commands, 'hermesAskRespond').mockResolvedValue({ status: 'ok', data: null });
    let turnRequestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      turnRequestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    eventMock.listeners.length = 0;
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('Run the migration');
    await vi.waitFor(() => expect(turnRequestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-ask-settled')).toBe(true)
    );
    const ask = eventMock.listeners.find(listener => listener.event === 'hermes-ask')!.handler;
    const settled = eventMock.listeners.find(listener => listener.event === 'hermes-ask-settled')!.handler;

    // Two requests can be open together (a clarify behind an approval); the card shows the first.
    ask({
      payload: {
        requestId: 'srq-1',
        turnRequestId,
        kind: 'approval',
        deadline: null,
        params: { command: 'rm -rf build', choices: ['once', 'deny'] }
      }
    });
    ask({
      payload: {
        requestId: 'srq-2',
        turnRequestId,
        kind: 'clarify',
        deadline: null,
        params: { questions: [{ qid: 'q1', question: 'Which database?' }] }
      }
    });
    await nextTick();
    expect(store.approvalRequest?.command).toBe('rm -rf build');
    expect(store.clarifyRequest).toBeNull();

    await store.respondApproval('once');
    expect(respond).toHaveBeenCalledWith('srq-1', { kind: 'approval', choice: 'once' });
    await nextTick();
    // Answering discloses the next card instead of leaving the queue stuck.
    expect(store.approvalRequest).toBeNull();
    expect(store.clarifyRequest?.questions[0]?.question).toBe('Which database?');

    // The settled event is what puts the decision in the transcript.
    settled({
      payload: {
        requestId: 'srq-1',
        turnRequestId,
        kind: 'approval',
        outcome: 'allowed',
        scope: 'once',
        summary: 'rm -rf build',
        count: null
      }
    });
    await nextTick();
    expect(store.messages.at(-1)?.decisions?.[0]).toMatchObject({
      outcome: 'allowed',
      scope: 'once',
      summary: 'rm -rf build'
    });

    // A withdrawn question tears the card down without inventing a decision from the user.
    settled({
      payload: {
        requestId: 'srq-2',
        turnRequestId,
        kind: 'clarify',
        outcome: 'cancelled',
        scope: null,
        summary: 'Which database?',
        count: null
      }
    });
    await nextTick();
    expect(store.clarifyRequest).toBeNull();
    expect(store.messages.at(-1)?.decisions?.at(-1)?.outcome).toBe('cancelled');

    // Vault prompts keep their own fields and answer shapes.
    ask({
      payload: {
        requestId: 'srq-3',
        turnRequestId,
        kind: 'vault-save-login',
        deadline: null,
        params: { origin: 'https://example.com', site: 'example.com' }
      }
    });
    await nextTick();
    expect(store.vaultSaveLoginRequest).toMatchObject({
      origin: 'https://example.com',
      site: 'example.com'
    });
    await store.respondVaultSaveLogin('user@example.com', 'hunter2');
    expect(respond).toHaveBeenCalledWith('srq-3', {
      kind: 'vaultSaveLogin',
      identifier: 'user@example.com',
      password: 'hunter2'
    });

    ask({
      payload: {
        requestId: 'srq-4',
        turnRequestId,
        kind: 'vault-code',
        deadline: null,
        params: { site: 'example.com', hint: 'Authenticator' }
      }
    });
    await nextTick();
    expect(store.vaultCodeRequest?.hint).toBe('Authenticator');
    await store.respondVaultCode('123456');
    expect(respond).toHaveBeenCalledWith('srq-4', { kind: 'secret', value: '123456' });
  });

  it('Does not let an earlier stop fallback kill the next turn', async () => {
    vi.useFakeTimers();
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const pending: Array<(value: unknown) => void> = [];
    vi.spyOn(commands, 'hermesChat').mockImplementation(
      () =>
        new Promise(resolve => {
          pending.push(resolve);
        }) as never
    );
    const stop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('first turn');
    expect(pending).toHaveLength(1);
    await store.stop();
    store.stopThinking();
    const stopsBeforeNewTurn = stop.mock.calls.length;
    void store.send('second turn');
    expect(pending).toHaveLength(2);
    vi.advanceTimersByTime(1_200);
    expect(stop.mock.calls.length).toBe(stopsBeforeNewTurn);
    expect(store.thinking).toBe(true);
    pending[1]!({
      status: 'ok',
      data: { text: 'second reply', sessionId: 'session-2', liveSessionId: null, usage: null, interrupted: false }
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.thinking).toBe(false);
    expect(store.messages.at(-1)?.text).toBe('second reply');
  });

  it('Finalizes a hung stop without reporting a runtime failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const pending: Array<(value: unknown) => void> = [];
    vi.spyOn(commands, 'hermesChat').mockImplementation(
      () =>
        new Promise(resolve => {
          pending.push(resolve);
        }) as never
    );
    vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const toasts = useToasts();
    toasts.clear();
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('hang');
    await store.stop();
    vi.advanceTimersByTime(10_000);
    expect(store.thinking).toBe(false);
    expect(store.stopping).toBe(false);
    expect(store.messages.at(-1)?.interrupted).toBe(true);
    expect(store.messages.at(-1)?.text).toBe('');
    pending[0]!({ status: 'error', error: { code: 'E_HERMES_STOPPED', message: 'stopped', detail: null } });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.messages.at(-1)?.interrupted).toBe(true);
    expect(store.messages.at(-1)?.text).toBe('');
    expect(toasts.items.value.some(item => item.tone === 'danger')).toBe(false);
  });

  it('Re-enables the composer after stopping a local demo reply', async () => {
    vi.useFakeTimers();
    const store = useHermesStore();
    store.newChat();
    void store.send('demo reply');
    expect(store.thinking).toBe(true);
    await store.stop();
    expect(store.stopping).toBe(true);
    vi.advanceTimersByTime(600);
    expect(store.thinking).toBe(false);
    expect(store.stopping).toBe(false);
  });

  it('Sends a steer with the running execution generation', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesChat').mockImplementation(() => new Promise(() => undefined) as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    expect(store.thinking).toBe(true);
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('steer this');

    expect(steer).toHaveBeenCalledWith('live-1', 7, 'steer this', null, null);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(true);
  });

  it('Redirects the live turn by default', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesChat').mockImplementation(() => new Promise(() => undefined) as never);
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('use the api');

    expect(redirect).toHaveBeenCalledWith('live-1', 'use the api', null, null);
    expect(steer).not.toHaveBeenCalled();
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'use the api' && !entry.steering)).toBe(true);
  });

  it('Seals the assistant above a redirect and opens a new bubble below it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    const chunk = eventMock.listeners.find(listener => listener.event === 'hermes-chunk')!;
    expect(chunk).toBeDefined();
    chunk.handler({ payload: { requestId, delta: 'before' } });

    await store.send('use the api');

    const sealed = store.messages.find(entry => entry.role === 'assistant')!;
    expect(sealed.text).toBe('before');
    expect(sealed.streaming).toBe(false);

    chunk.handler({ payload: { requestId, delta: 'after' } });

    expect(store.messages.map(entry => `${entry.role}:${entry.text ?? ''}`)).toEqual([
      'user:initial turn',
      'assistant:before',
      'user:use the api',
      'assistant:after'
    ]);
  });

  it('Queues a rejected redirect as the next turn', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'rejected', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('use the api');

    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'use the api')).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'use the api' });
  });

  it('Falls back to steer when the runtime cannot redirect', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesChat').mockImplementation(() => new Promise(() => undefined) as never);
    const redirect = vi
      .spyOn(commands, 'hermesRedirect')
      .mockRejectedValue(new Error('agent does not support active-turn redirect'));
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('use the api');

    expect(redirect).toHaveBeenCalledWith('live-1', 'use the api', null, null);
    expect(steer).toHaveBeenCalledWith('live-1', 7, 'use the api', null, null);
    expect(store.messages.some(entry => entry.text === 'use the api' && entry.steering)).toBe(true);
  });

  it("Waits for this turn's generation before redirecting", async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    // What the previous turn left behind: the new turn has not claimed a generation yet.
    store.active!.liveSessionId = 'old-live';

    await store.send('use the api');

    expect(redirect).not.toHaveBeenCalled();

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'new-live',
        sessionId: 'stored-1',
        executionGeneration: 7
      }
    });

    await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('new-live', 'use the api', null, null));
    expect(redirect).not.toHaveBeenCalledWith('old-live', 'use the api', null, null);
  });

  it('Uses the busy mode that arrives while a correction is parked', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));

    await store.send('use the api');

    expect(redirect).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-1',
        sessionId: 'stored-1',
        executionGeneration: 7,
        busyInputMode: 'steer'
      }
    });

    await vi.waitFor(() => expect(steer).toHaveBeenCalledWith('live-1', 7, 'use the api', null, null));
    expect(redirect).not.toHaveBeenCalled();
    expect(store.messages.some(entry => entry.text === 'use the api' && entry.steering)).toBe(true);
  });

  it('Queues a parked correction when the session reports queue mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(input => {
        requestId = input.requestId;
        return new Promise(resolve => {
          finishTurn = resolve;
        }) as never;
      })
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));

    await store.send('use the api');

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-1',
        sessionId: 'stored-1',
        executionGeneration: 7,
        busyInputMode: 'queue'
      }
    });

    await vi.waitFor(() => expect(store.messages.some(entry => entry.text === 'use the api')).toBe(false));
    expect(redirect).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'use the api' });
  });

  it("Clears the previous turn's busy mode when a new turn starts", async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('turn one');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.busyMode = 'steer';
    store.stopThinking();
    void store.send('turn two');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(store.active!.busyMode).toBeUndefined();

    await store.send('correction');

    expect(steer).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-2',
        sessionId: 'stored-2',
        executionGeneration: 9,
        busyInputMode: 'interrupt'
      }
    });

    await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('live-2', 'correction', null, null));
    expect(steer).not.toHaveBeenCalled();
  });

  it('Queues a parked correction when an approval card is open', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(input => {
        requestId = input.requestId;
        return new Promise(resolve => {
          finishTurn = resolve;
        }) as never;
      })
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));

    await store.send('use the api');

    const ask = eventMock.listeners.find(listener => listener.event === 'hermes-ask')!.handler;
    ask({
      payload: {
        requestId: 'srq-1',
        turnRequestId: requestId,
        kind: 'approval',
        deadline: null,
        params: { command: 'rm -rf build', choices: ['once', 'deny'] }
      }
    });

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-1',
        sessionId: 'stored-1',
        executionGeneration: 7,
        busyInputMode: 'interrupt'
      }
    });

    await vi.waitFor(() => expect(store.messages.some(entry => entry.text === 'use the api')).toBe(false));
    expect(redirect).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'use the api' });
  });

  it('Does not treat a gateway-queued redirect as delivered', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('use the api');

    expect(redirect).toHaveBeenCalledWith('live-1', 'use the api', null, null);
    expect(store.messages.some(entry => entry.text === 'use the api')).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(store.thinking).toBe(false));
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('Queues the text when the runtime busy mode is queue', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    const redirect = vi.spyOn(commands, 'hermesRedirect').mockResolvedValue({
      status: 'ok',
      data: { status: 'redirected', delivered: null }
    } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'queue';
    store.active!.liveSessionId = 'live-1';

    await store.send('use the api');

    expect(redirect).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(store.messages.some(entry => entry.text === 'use the api')).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'use the api' });
  });

  it('Queues a rejected steer without keeping a phantom bubble', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'rejected', delivered: null }
    } as never);
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    await store.send('steer this');

    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'steer this')).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
  });

  it('Queues an undelivered steer for the next turn without interrupting', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'rejected', delivered: false }
    } as never);
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    await store.send('steer this');

    expect(interrupt).not.toHaveBeenCalled();
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
    expect(store.messages.some(entry => entry.text === 'steer this' && !entry.steering)).toBe(true);
  });

  it('Waits for the running generation before steering', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const steer = vi.spyOn(commands, 'hermesSteer').mockResolvedValue({
      status: 'ok',
      data: { status: 'queued', delivered: null }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    store.active!.liveSessionId = 'live-1';

    await store.send('steer this');
    expect(steer).not.toHaveBeenCalled();

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    expect(listener).toBeDefined();
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-1',
        sessionId: 'stored-1',
        executionGeneration: 7
      }
    });

    await vi.waitFor(() => expect(steer).toHaveBeenCalledWith('live-1', 7, 'steer this', null, null));
  });

  it('Keeps a steer that is still waiting for a generation across a session reset', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishInitial!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }) as never
      )
      .mockResolvedValue(settled as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    // The turn has not claimed a generation yet, so the steer waits for one.
    await store.send('steer across reset');
    expect(store.messages.some(entry => entry.text === 'steer across reset' && entry.steering)).toBe(true);

    store.setWorkingDir('/tmp/hermes-review');
    finishInitial(settled);

    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({
      prompt: 'steer across reset',
      cwd: '/tmp/hermes-review'
    });
  });

  it('Removes an undelivered steer and sends it when the turn already ended', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(input => {
        requestId = input.requestId;
        return new Promise(() => undefined) as never;
      })
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    let failSteer!: (reason: unknown) => void;
    vi.spyOn(commands, 'hermesSteer').mockImplementation(
      () =>
        new Promise((_, reject) => {
          failSteer = reject;
        }) as never
    );
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    store.active!.liveSessionId = 'live-1';

    await store.send('steer this');
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(true);

    const listener = eventMock.listeners.filter(entry => entry.event === 'hermes-session').at(-1);
    listener!.handler({
      payload: {
        requestId,
        liveSessionId: 'live-1',
        sessionId: 'stored-1',
        executionGeneration: 7
      }
    });
    store.stopThinking();
    failSteer(new Error('gateway unavailable'));

    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    // Stop retires the local turn through its own session; the failed steer still becomes the
    // next queued row instead of being dropped with the interrupt.
    expect(interrupt).toHaveBeenCalledWith('live-1', null, null);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(false);
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
  });

  it('Keeps a failed steer in its own conversation after switching away', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(input => {
        requestId = input.requestId;
        return new Promise(() => undefined) as never;
      })
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    let failSteer!: (reason: unknown) => void;
    vi.spyOn(commands, 'hermesSteer').mockImplementation(
      () =>
        new Promise((_, reject) => {
          failSteer = reject;
        }) as never
    );
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const original = store.active!;
    original.liveSessionId = 'live-1';
    original.executionGeneration = 7;

    const steering = store.send('steer this');
    await vi.waitFor(() => expect(commands.hermesSteer).toHaveBeenCalled());
    // The turn claims its own session id; Stop must target that, never the conversation copy.
    eventMock.listeners
      .filter(entry => entry.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId, liveSessionId: 'live-1' } });
    store.stopThinking();
    store.newChat();
    failSteer(new Error('gateway unavailable'));
    await steering;

    expect(chat).toHaveBeenCalledTimes(1);
    // Stopping the turn uses the local session interrupt, not the gateway-killing hard stop.
    expect(interrupt).toHaveBeenCalledWith('live-1', null, null);

    store.select(original.id);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
    expect(store.activeId).toBe(original.id);
    expect(store.messages.some(entry => entry.text === 'steer this' && !entry.steering)).toBe(true);
  });

  it('Keeps a queued steer across a profile switch and drains it on return', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let requestId = '';
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(input => {
        requestId = input.requestId;
        return new Promise(() => undefined) as never;
      })
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    let failSteer!: (reason: unknown) => void;
    vi.spyOn(commands, 'hermesSteer').mockImplementation(
      () =>
        new Promise((_, reject) => {
          failSteer = reject;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const original = store.active!;
    original.liveSessionId = 'live-1';
    original.executionGeneration = 7;

    const steering = store.send('steer this');
    await vi.waitFor(() => expect(commands.hermesSteer).toHaveBeenCalled());
    store.stopThinking();
    store.newChat();
    failSteer(new Error('gateway unavailable'));
    await steering;
    expect(chat).toHaveBeenCalledTimes(1);

    const beforeQueue = original.messages.length;
    let releaseListen!: () => void;
    const listen = eventMock.listen.getMockImplementation();
    expect(listen).toBeDefined();
    eventMock.listen.mockImplementationOnce(
      (event, handler) =>
        new Promise(resolve => {
          releaseListen = () => resolve(listen!(event, handler));
        })
    );

    store.select(original.id);
    await vi.waitFor(() => expect(original.messages.length).toBe(beforeQueue + 2));
    await vi.waitFor(() => expect(releaseListen).toBeDefined());
    await store.switchAgentProfile('work');
    releaseListen();
    await vi.waitFor(() => expect(original.messages.length).toBe(beforeQueue));

    await store.switchAgentProfile('default');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
    expect(store.activeId).toBe(original.id);
    expect(store.messages.some(entry => entry.text === 'steer this' && !entry.steering)).toBe(true);
  });

  it('Keeps a background turn streaming after an agent profile switch', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let requestId = '';
    let finish!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesChat').mockImplementationOnce(
      input =>
        new Promise(resolve => {
          requestId = input.requestId;
          finish = resolve;
        }) as never
    );
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const stop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('long turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const conversationId = store.active!.id;

    // Navigation must not interrupt: the turn keeps its own request id and owning profile.
    await store.switchAgentProfile('work');
    expect(store.thinking).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    const chunk = eventMock.listeners.filter(entry => entry.event === 'hermes-chunk').at(-1);
    chunk!.handler({ payload: { requestId, delta: 'still ' } });
    // The banner can bring back a turn from another profile, not only another conversation.
    expect(store.backgroundTurns[0]).toMatchObject({ conversationId, openable: true });
    expect(await store.openBackgroundTurn(conversationId)).toBe(true);
    expect(store.activeAgentProfileName).toBe('default');
    expect(store.activeId).toBe(conversationId);
    finish({
      status: 'ok',
      data: {
        text: 'still streaming',
        sessionId: 'session-bg',
        liveSessionId: 'live-bg',
        usage: null,
        interrupted: false
      }
    });

    await vi.waitFor(() => {
      const conversation = store.conversations.find(item => item.id === conversationId);
      expect(conversation?.messages.at(-1)?.text).toBe('still streaming');
      expect(conversation?.messages.at(-1)?.streaming).toBe(false);
    });
    expect(store.messages.some(entry => entry.text === 'still streaming')).toBe(true);
    expect(store.thinking).toBe(false);
  });

  it('Stops a local turn through session.interrupt instead of killing the gateway', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const stop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('long turn');
    // The turn claims its own session the way the gateway reports it, not by leaving the id on
    // the conversation (that slot still names the previous turn until this event arrives).
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    eventMock.listeners
      .filter(listener => listener.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId, liveSessionId: 'live-local' } });

    await store.stop();

    // The session interrupt keeps the local gateway (and its warm session) alive; killing it
    // would also lose `message.complete`, the event that preserves the streamed reply.
    expect(interrupt).toHaveBeenCalledWith('live-local', null, null);
    expect(stop).not.toHaveBeenCalled();
  });

  it('Never interrupts the previous session when Stop arrives before this turn claims one', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const requestIds: string[] = [];
    const pending: Array<(value: unknown) => void> = [];
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestIds.push(input.requestId);
      return new Promise(resolve => {
        pending.push(resolve);
      }) as never;
    });
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const hardStop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();

    // The first turn claims its session, then completes and leaves that id on the conversation.
    store.newChat();
    void store.send('first turn');
    await vi.waitFor(() => expect(requestIds).toHaveLength(1));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    eventMock.listeners
      .filter(listener => listener.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId: requestIds[0], liveSessionId: 'old-live' } });
    pending[0]!({
      status: 'ok',
      data: { text: 'first reply', sessionId: 'session-1', liveSessionId: 'old-live', usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(store.thinking).toBe(false));
    expect(store.active!.liveSessionId).toBe('old-live');

    // The second turn is still in pre-flight: its `hermes-session` has not arrived, and the
    // conversation slot still names the first turn's session.
    void store.send('second turn');
    await vi.waitFor(() => expect(requestIds).toHaveLength(2));
    await store.stop();
    expect(interrupt).not.toHaveBeenCalled();
    expect(hardStop).not.toHaveBeenCalled();

    // The id arrives after Stop: the interrupt targets this turn, never `old-live`.
    eventMock.listeners
      .filter(listener => listener.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId: requestIds[1], liveSessionId: 'new-live' } });
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith('new-live', null, null));
    expect(interrupt).not.toHaveBeenCalledWith('old-live', null, null);
    expect(hardStop).not.toHaveBeenCalled();
  });

  it('Interrupts a force-retired remote turn when its session arrives late', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    seedPanelProfile();
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    store.newChat();
    void store.send('slow resume');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );

    // Stop retires the turn before the gateway has announced a session. Nothing can be
    // interrupted yet, and the turn is no longer in `liveTurns`.
    store.stopThinking();
    expect(interrupt).not.toHaveBeenCalled();

    // The listener is still registered until `hermesChat` settles: the late id gets the
    // interrupt the retirement could not send.
    const session = eventMock.listeners.filter(listener => listener.event === 'hermes-session').at(-1)!;
    session.handler({ payload: { requestId, liveSessionId: 'late-live' } });
    await vi.waitFor(() =>
      expect(interrupt).toHaveBeenCalledWith('late-live', 'http://panel.tail1234.ts.net:9119', 'panel-1')
    );

    // The parked request is consumed: a repeated event must not interrupt twice.
    session.handler({ payload: { requestId, liveSessionId: 'late-live' } });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('Interrupts a late local session when the hard stop fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(() => undefined) as never;
    });
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    let failStop!: (reason: unknown) => void;
    const stop = vi.spyOn(commands, 'hermesStop').mockImplementation(
      () =>
        new Promise((_, reject) => {
          failStop = reject;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('never claims a session');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );

    // Force stop: no session id yet, so the local path kills the gateway. The id arrives while
    // that call is still in flight; it has to be parked before the yield or it is dropped.
    store.stopThinking();
    await vi.waitFor(() => expect(failStop).toBeTypeOf('function'));
    eventMock.listeners
      .filter(listener => listener.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId, liveSessionId: 'late-local' } });
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith('late-local', null, null));

    // The hard stop failing keeps the gateway and its session alive; the parked request was
    // consumed, so a repeated event cannot interrupt twice.
    failStop(new Error('stop failed'));
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it('Keeps the stop marker when a stopped turn never streamed a token', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finish!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('stop before any token');
    await vi.waitFor(() => expect(requestId).not.toBe(''));

    await store.stop();
    finish({
      status: 'ok',
      data: {
        text: 'the whole unanswered reply',
        sessionId: 's1',
        liveSessionId: null,
        usage: null,
        interrupted: false
      }
    });

    // Nothing reached the screen before Stop, so the late completion must not paste the answer
    // under an "interrupted" label; the stop marker is all that bubble should show.
    await vi.waitFor(() => expect(store.messages.at(-1)?.streaming).toBe(false));
    expect(store.messages.at(-1)?.interrupted).toBe(true);
    expect(store.messages.at(-1)?.text).toBe('');
  });

  it('Stops a background turn when its conversation is deleted and does not resurrect it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    let finish!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesChat').mockImplementation(
      input =>
        new Promise(resolve => {
          requestId = input.requestId;
          finish = resolve;
        }) as never
    );
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('background turn');
    const conversationId = store.active!.id;
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    await vi.waitFor(() =>
      expect(eventMock.listeners.some(listener => listener.event === 'hermes-session')).toBe(true)
    );
    eventMock.listeners
      .filter(listener => listener.event === 'hermes-session')
      .at(-1)!
      .handler({ payload: { requestId, liveSessionId: 'live-bg' } });
    // The row is off screen (a new draft) when it is deleted from history.
    store.newChat();
    expect(store.backgroundTurns).toHaveLength(1);

    await store.deleteConversation(conversationId);

    expect(interrupt).toHaveBeenCalledWith('live-bg', null, null);
    expect(store.conversations.some(item => item.id === conversationId)).toBe(false);

    // The late completion must not insert the deleted conversation back into the list.
    finish({
      status: 'ok',
      data: { text: 'late reply', sessionId: 'session-bg', liveSessionId: 'live-bg', usage: null, interrupted: false }
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.conversations.some(item => item.id === conversationId)).toBe(false);
    expect(store.conversations.flatMap(item => item.messages).some(entry => entry.text === 'late reply')).toBe(false);
  });

  it('Keeps a message queued in a fresh chat visible and starts it when the blocking turn ends', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const pending: Array<(value: unknown) => void> = [];
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(
      () =>
        new Promise(resolve => {
          pending.push(resolve);
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('first turn');
    const runningId = store.active!.id;

    // A fresh draft while the first turn is still live. The queued row has to be visible in
    // history; an empty placeholder would be filtered out and its text would be lost.
    store.newChat();
    await store.send('queued text');
    const queuedChat = store.conversations.find(item => item.id !== runningId)!;
    expect(queuedChat.messages).toHaveLength(1);
    expect(queuedChat.messages[0]).toMatchObject({ role: 'user', text: 'queued text', queued: true });
    expect(store.history.map(item => item.id)).toContain(queuedChat.id);
    expect(chat).toHaveBeenCalledTimes(1);

    // Opening another conversation leaves the queued text where it is; it must not fire while
    // the shared turn slot is still occupied.
    store.select(runningId);
    expect(chat).toHaveBeenCalledTimes(1);
    pending[0]!({
      status: 'ok',
      data: { text: 'first reply', sessionId: 'session-1', liveSessionId: null, usage: null, interrupted: false }
    });
    // When the blocking turn ends the queued conversation starts in the background, exactly as
    // the toast promised, and it reuses its visible row instead of appending a duplicate.
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'queued text' });
    const userRows = store.conversations
      .find(item => item.id === queuedChat.id)!
      .messages.filter(entry => entry.role === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.queued).toBe(false);
    expect(store.thinking).toBe(false);
    expect(store.backgroundTurns.map(turn => turn.conversationId)).toContain(queuedChat.id);
  });

  it('Skips a queue left in another profile instead of parking this profile behind it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    const prompts: string[] = [];
    const pending: Array<(value: unknown) => void> = [];
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      prompts.push(input.prompt);
      return new Promise(resolve => {
        pending.push(resolve);
      }) as never;
    });
    const store = useHermesStore();
    await store.loadRuntime();

    store.newChat();
    void store.send('default turn');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    // Queue in a fresh chat of this profile: this is the first key in the queue map.
    store.newChat();
    await store.send('queued default');
    expect(store.conversations.some(item => item.messages.some(entry => entry.text === 'queued default'))).toBe(true);

    // Leave the profile; the running turn and that queued row stay behind it.
    await store.switchAgentProfile('work');

    // The head key now names a conversation this profile does not list. Queue something in
    // the profile on screen and make sure it can still start when the shared slot frees up.
    store.newChat();
    await store.send('queued work');
    store.newChat();

    pending[0]!({
      status: 'ok',
      data: { text: 'default reply', sessionId: 'session-1', liveSessionId: null, usage: null, interrupted: false }
    });

    await vi.waitFor(() => expect(prompts).toContain('queued work'));
    expect(prompts).not.toContain('queued default');
    expect(store.activeId).toBeNull();

    // Returning to the first profile resumes the row that was waiting there.
    await store.switchAgentProfile('default');
    pending[1]!({
      status: 'ok',
      data: { text: 'work reply', sessionId: 'session-2', liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(prompts).toContain('queued default'));
  });

  it('Drops a queued row when its panel conversation is archived', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    seedPanelProfile();
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue({
      status: 'ok',
      data: JSON.stringify({
        sessions: [
          {
            id: 'panel-conv',
            display_name: 'Panel chat',
            runtime_revision: 1,
            runtime_generation: 2,
            last_activity_at: 100
          }
        ],
        total: 1
      })
    } as never);
    vi.spyOn(commands, 'hermesPanelSessionArchive').mockResolvedValue({ status: 'ok', data: null } as never);
    const pending: Array<(value: unknown) => void> = [];
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(
      () =>
        new Promise(resolve => {
          pending.push(resolve);
        }) as never
    );
    const store = useHermesStore();
    await store.loadPanelHistory('recents');
    expect(store.conversations.some(item => item.id === 'panel-conv')).toBe(true);

    // Keep the shared slot busy, then queue a message in the panel conversation.
    store.newChat();
    void store.send('blocking turn');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.select('panel-conv');
    await store.send('queued in panel');
    const panel = store.conversations.find(item => item.id === 'panel-conv')!;
    expect(panel.messages.some(entry => entry.role === 'user' && entry.queued)).toBe(true);

    await store.setConversationArchived('panel-conv', true);
    expect(store.conversations.some(item => item.id === 'panel-conv')).toBe(false);

    // Free the slot: the archived row's queue must not be started.
    pending[0]!({
      status: 'ok',
      data: { text: 'blocking reply', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(store.thinking).toBe(false));
    expect(chat).toHaveBeenCalledTimes(1);

    // The host still lists the row: re-reading it must not resurrect the queued send.
    await store.loadPanelHistory('recents');
    expect(store.conversations.some(item => item.id === 'panel-conv')).toBe(true);
    store.select('panel-conv');
    await Promise.resolve();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('Re-homes a running foreign panel row when the aggregate scope is turned off', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    seedPanelProfile();
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue({
      status: 'ok',
      data: JSON.stringify({
        sessions: [
          { id: 'mine', display_name: 'Mine', runtime_revision: 0, runtime_generation: 0, last_activity_at: 100 },
          {
            id: 'foreign',
            display_name: 'Foreign',
            profile: 'work',
            runtime_revision: 0,
            runtime_generation: 0,
            last_activity_at: 90
          }
        ],
        total: 2
      })
    } as never);
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    let requestId = '';
    let finish!: (value: unknown) => void;
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    const store = useHermesStore();
    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory('recents');
    expect(store.conversations.some(item => item.id === 'foreign')).toBe(true);

    store.select('foreign');
    void store.send('foreign turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    expect(chat).toHaveBeenCalledTimes(1);

    // The aggregate is turned off while the row's turn is running. The row leaves this list,
    // but its conversation and turn move to the row's own profile instead of being lost; the
    // banner can still open it.
    await store.setPanelAllProfiles(false);
    expect(store.conversations.some(item => item.id === 'foreign')).toBe(false);
    expect(store.backgroundTurns).toEqual([
      expect.objectContaining({ conversationId: 'foreign', openable: true, waiting: false })
    ]);

    finish({
      status: 'ok',
      data: { text: 'foreign reply', sessionId: 'session-f', liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(store.backgroundTurns).toHaveLength(0));
    // The completion landed in the row's own state, not back into this profile's list.
    expect(store.conversations.some(item => item.id === 'foreign')).toBe(false);

    await store.switchAgentProfile('work');
    const foreign = store.conversations.find(item => item.id === 'foreign');
    expect(foreign?.messages.at(-1)?.text).toBe('foreign reply');
    expect(foreign?.messages.at(-1)?.streaming).toBe(false);
  });

  it('Keeps the home profile transcript when re-homing a running panel row', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    seedPanelProfile();
    // The row's own profile already loaded this conversation earlier: its transcript must
    // survive the re-home, together with the local turn the aggregate window started.
    const persisted = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as Record<string, unknown>;
    persisted.states = {
      'panel-1::work': {
        model: {
          provider: 'nous',
          model: 'Hermes 4 · 405B',
          effort: 'medium',
          fast: false,
          endpoint: '',
          keySet: false
        },
        conversations: [
          {
            id: 'foreign',
            panel: true,
            panelProfile: 'work',
            panelSlice: 'recents',
            messages: [
              { id: 'home-row', role: 'user', text: 'home local row', at: 5 },
              { id: 'home-reply', role: 'assistant', text: 'home loaded reply', at: 6 }
            ],
            messagesLoaded: true,
            panelOffset: 40,
            panelHasOlder: true,
            updatedAt: 6
          }
        ],
        activeId: 'foreign',
        workingDir: '',
        auxiliary: {},
        forceAuxVision: false
      }
    };
    localStorage.setItem(PROFILES_KEY, JSON.stringify(persisted));
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue({
      status: 'ok',
      data: JSON.stringify({
        sessions: [
          { id: 'mine', display_name: 'Mine', runtime_revision: 0, runtime_generation: 0, last_activity_at: 100 },
          {
            id: 'foreign',
            display_name: 'Foreign',
            profile: 'work',
            runtime_revision: 0,
            runtime_generation: 0,
            last_activity_at: 90
          }
        ],
        total: 2
      })
    } as never);
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    let requestId = '';
    let finish!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesChat').mockImplementation(input => {
      requestId = input.requestId;
      return new Promise(resolve => {
        finish = resolve;
      }) as never;
    });
    const store = useHermesStore();
    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory('recents');
    store.select('foreign');
    void store.send('foreign turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));

    await store.setPanelAllProfiles(false);
    expect(store.conversations.some(item => item.id === 'foreign')).toBe(false);

    finish({
      status: 'ok',
      data: { text: 'foreign reply', sessionId: 'session-f', liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(store.backgroundTurns).toHaveLength(0));

    // The row moved into its own profile without replacing what that profile had loaded.
    await store.switchAgentProfile('work');
    const foreign = store.conversations.find(item => item.id === 'foreign');
    expect(foreign?.messages.map(entry => entry.text)).toEqual([
      'home local row',
      'home loaded reply',
      'foreign turn',
      'foreign reply'
    ]);
    expect(foreign?.messagesLoaded).toBe(true);
    expect(foreign?.panelOffset).toBe(40);
    expect(foreign?.panelHasOlder).toBe(true);
  });

  it('Resumes a queued row restored from history after a restart', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        conversations: [
          {
            id: 'restored-queued',
            messages: [{ id: 'restored-row', role: 'user', text: 'resume me', at: 1, queued: true }],
            updatedAt: 1
          }
        ],
        activeId: 'restored-queued'
      })
    );
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const store = useHermesStore();

    // The runtime queue is gone after a restart; the persisted `queued` row rebuilds it.
    await store.loadHistory();

    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ prompt: 'resume me' });
    const rows = store.conversations[0]!.messages.filter(entry => entry.role === 'user');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.queued).toBe(false);
  });

  it('Reports a background approval card in the banner and history', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let requestId = '';
    vi.spyOn(commands, 'hermesChat').mockImplementation(
      input =>
        new Promise(() => {
          requestId = input.requestId;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('needs approval');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const conversationId = store.active!.id;
    store.newChat();

    expect(store.backgroundTurns).toHaveLength(1);
    expect(store.backgroundTurns[0]).toMatchObject({ conversationId, waiting: false, openable: true });
    expect(store.conversationActivity(conversationId)).toBe('replying');

    const ask = eventMock.listeners.filter(entry => entry.event === 'hermes-ask').at(-1);
    ask!.handler({
      payload: {
        requestId: 'srq-bg',
        turnRequestId: requestId,
        kind: 'approval',
        deadline: null,
        params: { command: 'rm -rf /tmp/demo' }
      }
    });
    await nextTick();

    // The card stays in the background conversation, but the app must say it is waiting.
    expect(store.approvalRequest).toBeNull();
    expect(store.backgroundTurns[0]!.waiting).toBe(true);
    expect(store.conversationActivity(conversationId)).toBe('waiting');
  });

  it('Writes a background turn onto the conversation history reloaded after switching back', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let requestId = '';
    let finish!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesChat').mockImplementationOnce(
      input =>
        new Promise(resolve => {
          requestId = input.requestId;
          finish = resolve;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('long turn');
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const conversationId = store.active!.id;
    const startedAt = store.active!.updatedAt;

    // A newer file wins over the in-memory copy, which is what drops the object the turn holds.
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({
      status: 'ok',
      data: JSON.stringify({
        conversations: [
          {
            id: conversationId,
            messages: [{ id: 'older', role: 'user', text: 'from file', at: 1 }],
            updatedAt: startedAt + 10_000
          }
        ],
        activeId: conversationId
      })
    } as never);

    await store.switchAgentProfile('work');
    await store.switchAgentProfile('default');
    await vi.waitFor(() => expect(store.active?.messages[0]?.text).toBe('from file'));

    finish({
      status: 'ok',
      data: {
        text: 'finished in background',
        sessionId: 'session-bg',
        liveSessionId: null,
        usage: null,
        interrupted: false
      }
    });

    await vi.waitFor(() => {
      expect(store.active?.messages.map(entry => entry.text)).toContain('finished in background');
    });
    expect(store.active?.messages.at(-1)?.streaming).toBe(false);
  });

  it('Requeues a queued steer when the profile has no credentials yet', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesSecretStatus')
      .mockResolvedValueOnce({ status: 'ok', data: false } as never)
      .mockResolvedValue({ status: 'ok', data: true } as never);
    const toasts = useToasts();
    toasts.clear();
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(() => new Promise(() => undefined) as never)
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    let failSteer!: (reason: unknown) => void;
    vi.spyOn(commands, 'hermesSteer').mockImplementation(
      () =>
        new Promise((_, reject) => {
          failSteer = reject;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    const original = store.active!;
    original.liveSessionId = 'live-1';
    original.executionGeneration = 7;

    const steering = store.send('steer this');
    await vi.waitFor(() => expect(commands.hermesSteer).toHaveBeenCalled());
    store.stopThinking();
    store.newChat();
    failSteer(new Error('gateway unavailable'));
    await steering;
    expect(chat).toHaveBeenCalledTimes(1);

    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.select(original.id);
    await vi.waitFor(() => expect(toasts.items.value.some(item => item.title === 'Hermes profile')).toBe(true));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(original.messages.some(entry => entry.text === 'steer this')).toBe(false);

    store.select(original.id);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
    expect(store.messages.some(entry => entry.text === 'steer this' && !entry.steering)).toBe(true);
  });

  it('Queues a steer the runtime cannot accept', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    const steer = vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('does not support steer'));
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    expect(store.thinking).toBe(true);
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('steer this');

    expect(steer).toHaveBeenCalledWith('live-1', 7, 'steer this', null, null);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.messages.some(entry => entry.text === 'steer this')).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
  });

  it('Retries a stale steer once with the newer generation and leaves the turn running', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesChat').mockImplementation(() => new Promise(() => undefined) as never);
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    const steer = vi.spyOn(commands, 'hermesSteer').mockImplementation(((_live: string, generation: number) => {
      if (generation === 7) {
        store.active!.executionGeneration = 8;
        return Promise.reject(new Error('stale_generation'));
      }
      return Promise.resolve({ status: 'ok', data: { status: 'queued', delivered: null } });
    }) as never);
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    expect(store.thinking).toBe(true);
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('steer this');

    expect(steer).toHaveBeenNthCalledWith(1, 'live-1', 7, 'steer this', null, null);
    expect(steer).toHaveBeenNthCalledWith(2, 'live-1', 8, 'steer this', null, null);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(true);
  });

  it('Queues a stale steer without interrupting the running turn', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('steer this');

    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(false);

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
  });

  it('Leaves the running turn alone when a steer fails for another reason', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesChat').mockImplementation(() => new Promise(() => undefined) as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('gateway unavailable'));
    const interrupt = vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;

    await store.send('steer this');

    expect(interrupt).not.toHaveBeenCalled();
    expect(store.stopping).toBe(false);
    expect(store.thinking).toBe(true);
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(false);
  });

  it('Starts one queued chat at a time while a credential check is in flight', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    let keyCalls = 0;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      if (keyCalls === 1) return Promise.resolve({ status: 'ok', data: true });
      return new Promise(resolve => {
        releaseKey = resolve;
      });
    });
    let finishTurn!: (value: unknown) => void;
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishTurn = resolve;
          }) as never
      )
      .mockResolvedValue({
        status: 'ok',
        data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
      } as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('first queued');
    await store.send('second queued');

    finishTurn({
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    });
    await vi.waitFor(() => expect(keyCalls).toBe(2));
    store.select(store.activeId!);
    expect(keyCalls).toBe(2);
    expect(chat).toHaveBeenCalledTimes(1);

    releaseKey({ status: 'ok', data: true });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'first queued' });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('Returns a direct send to the queue when the profile switches during pre-flight', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let keyCalls = 0;
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      if (keyCalls === 1) {
        return new Promise(resolve => {
          releaseKey = resolve;
        }) as never;
      }
      return Promise.resolve({ status: 'ok', data: true }) as never;
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('keep my message');
    const conversationId = store.active!.id;
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Switching profiles while the credential check is in flight means the prompt was never
    // submitted: its row belongs back in the composing profile, not deleted from the store.
    await store.switchAgentProfile('work');
    expect(store.conversations.some(item => item.id === conversationId)).toBe(false);
    releaseKey({ status: 'ok', data: true });
    await sending;
    expect(chat).not.toHaveBeenCalled();

    // The persisted profile state still holds the row, marked as a queued send.
    const saved = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as {
      states: Record<
        string,
        { conversations: Array<{ id: string; messages: Array<{ role: string; text?: string; queued?: boolean }> }> }
      >;
    };
    const parked = saved.states['local::default']?.conversations.find(item => item.id === conversationId);
    expect(parked?.messages.filter(entry => entry.role === 'user')).toHaveLength(1);
    expect(parked?.messages.find(entry => entry.text === 'keep my message')).toMatchObject({ queued: true });

    // Returning to the profile resumes the parked send instead of losing it.
    await store.switchAgentProfile('default');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ prompt: 'keep my message' });
    expect(store.active?.messages.filter(entry => entry.role === 'user')).toHaveLength(1);
  });

  it('Queues an attachment send when the profile switches during pre-flight', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let keyCalls = 0;
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      if (keyCalls === 1) {
        return new Promise(resolve => {
          releaseKey = resolve;
        }) as never;
      }
      return Promise.resolve({ status: 'ok', data: true }) as never;
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('look at this', ['/tmp/photo.png']);
    const conversationId = store.active!.id;
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    await store.switchAgentProfile('work');
    releaseKey({ status: 'ok', data: true });
    await sending;
    expect(chat).not.toHaveBeenCalled();

    // The row and its file are parked as a queued send in the composing profile, not left
    // behind as a message that only looks sent.
    const saved = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as {
      states: Record<
        string,
        {
          conversations: Array<{
            id: string;
            messages: Array<{ role: string; text?: string; queued?: boolean; attachments?: string[] }>;
          }>;
        }
      >;
    };
    const parked = saved.states['local::default']?.conversations.find(item => item.id === conversationId);
    expect(parked?.messages.find(entry => entry.text === 'look at this')).toMatchObject({
      queued: true,
      attachments: ['/tmp/photo.png']
    });

    // Returning to the profile sends the body together with its file.
    await store.switchAgentProfile('default');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ prompt: 'look at this', attachments: ['/tmp/photo.png'] });
  });

  it('Keeps a pre-flight send ahead of messages queued behind it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let keyCalls = 0;
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      if (keyCalls === 1) {
        return new Promise(resolve => {
          releaseKey = resolve;
        }) as never;
      }
      return Promise.resolve({ status: 'ok', data: true }) as never;
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const first = store.send('first message');
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Composed while the first send waits for its credential check: queue mode puts it behind.
    store.active!.busyMode = 'queue';
    await store.send('second message');

    await store.switchAgentProfile('work');
    releaseKey({ status: 'ok', data: true });
    await first;
    expect(chat).not.toHaveBeenCalled();

    // Back on the profile, the abandoned first send resumes ahead of the later message.
    await store.switchAgentProfile('default');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ prompt: 'first message' });
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'second message' });
  });

  it('Does not apply a credential verdict to the profile selected meanwhile', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        version: 1,
        activeProfileId: 'local',
        profiles: [
          {
            id: 'local',
            name: 'Local Mac',
            kind: 'local',
            endpoint: '',
            status: 'connected',
            version: '0.23.0',
            latency: null,
            models: 0
          }
        ],
        states: {
          'local::work': {
            model: {
              provider: 'openai',
              model: 'GPT-5.6',
              effort: 'medium',
              fast: false,
              endpoint: '',
              keySet: true
            },
            conversations: [],
            activeId: null,
            workingDir: '',
            auxiliary: {},
            forceAuxVision: false
          }
        }
      })
    );
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(
      () =>
        new Promise(resolve => {
          releaseKey = resolve;
        }) as never
    );
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const toasts = useToasts();
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('old profile message');
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // The check answers only after the user moved to a profile that has its own key state.
    await store.switchAgentProfile('work');
    toasts.clear();
    releaseKey({ status: 'ok', data: false });
    await sending;

    // The "no key" verdict belongs to the profile that asked: it must not clear the visible
    // profile's key state, drain its queue or warn on it.
    expect(store.activeAgentProfileName).toBe('work');
    expect(store.model.keySet).toBe(true);
    expect(toasts.items.value.some(item => item.title === 'Hermes profile')).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it('Does not submit a prompt stopped during the credential check', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(
      () =>
        new Promise(resolve => {
          releaseKey = resolve;
        }) as never
    );
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const stop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('do not send this');
    const conversationId = store.active!.id;
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Stop while the send is still pre-flight: there is no session to interrupt yet, and the
    // prompt must not be submitted just because the credential check finished afterwards.
    await store.stop();
    releaseKey({ status: 'ok', data: true });
    await sending;
    expect(chat).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    // The cancelled message is not deleted: it waits as a queued row in its conversation.
    const saved = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as {
      states: Record<
        string,
        { conversations: Array<{ id: string; messages: Array<{ role: string; text?: string; queued?: boolean }> }> }
      >;
    };
    const parked = saved.states['local::default']?.conversations.find(item => item.id === conversationId);
    expect(parked?.messages.find(entry => entry.text === 'do not send this')).toMatchObject({ queued: true });
    expect(store.thinking).toBe(false);
    expect(store.stopping).toBe(false);
  });

  it('Keeps a pre-flight message when the stop fallback retires the turn', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(
      () =>
        new Promise(resolve => {
          releaseKey = resolve;
        }) as never
    );
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('keep after the stop fallback');
    const conversationId = store.active!.id;
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Stop's 10 s fallback retires the turn before the credential check returns. The claim is
    // gone, but the text was never submitted and has no other copy: it must go back to the queue.
    await store.stop();
    store.stopThinking();
    releaseKey({ status: 'ok', data: true });
    await sending;
    expect(chat).not.toHaveBeenCalled();

    const saved = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as {
      states: Record<
        string,
        { conversations: Array<{ id: string; messages: Array<{ role: string; text?: string; queued?: boolean }> }> }
      >;
    };
    const parked = saved.states['local::default']?.conversations.find(item => item.id === conversationId);
    expect(parked?.messages.find(entry => entry.text === 'keep after the stop fallback')).toMatchObject({
      queued: true
    });
  });

  it('Does not resubmit a prompt stopped after its bubble appears', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'answer', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    } as never);
    const stop = vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    const sending = store.send('cancel after the bubble');
    // The assistant bubble is already on screen while the event listeners finish registering.
    expect(store.active!.messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true });
    await store.stop();
    await sending;
    // Give any drain the aborted send might have started time to reach `hermesChat`.
    await new Promise(resolve => setTimeout(resolve, 0));

    // The cancelled prompt must not be pulled straight back out of the queue by this send's
    // own finally: the user asked for it to stop before anything was submitted.
    expect(chat).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(store.active!.messages.find(entry => entry.role === 'user')).toMatchObject({
      text: 'cancel after the bubble',
      queued: true
    });
    expect(store.thinking).toBe(false);
    expect(store.stopping).toBe(false);
  });

  it('Continues the queue behind a prompt stopped before submission', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let keyCalls = 0;
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      // The running turn and the resumed row pass; the first queued row parks on this check.
      if (keyCalls === 2) {
        return new Promise(resolve => {
          releaseKey = resolve;
        }) as never;
      }
      return Promise.resolve({ status: 'ok', data: true }) as never;
    });
    let finishRunning!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: 's1', liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRunning = resolve;
          }) as never
      )
      .mockImplementation(() => new Promise(() => undefined) as never);
    vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    void store.send('running turn');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    // The user opens a fresh chat while that turn runs and queues two rows there. Both get a
    // visible row; the first one starts as soon as the blocking turn settles.
    store.newChat();
    await store.send('queued A');
    await store.send('queued B');
    finishRunning(settled);
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Stop lands while the drained row is still in pre-flight. The cancelled row goes back to
    // the queue, but the row already waiting behind it owns the now-free slot.
    await store.stop();
    releaseKey({ status: 'ok', data: true });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'queued B' });

    const rows = store.active!.messages.filter(entry => entry.role === 'user');
    expect(rows.find(entry => entry.text === 'queued A')).toMatchObject({ queued: true });
    expect(rows.find(entry => entry.text === 'queued B')).toMatchObject({ queued: false });
    expect(store.thinking).toBe(true);
  });

  it('Queues a fresh send behind a stopped row instead of jumping ahead', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    let keyCalls = 0;
    let releaseKey!: (value: { status: 'ok'; data: boolean }) => void;
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation(() => {
      keyCalls += 1;
      if (keyCalls === 1) {
        return new Promise(resolve => {
          releaseKey = resolve;
        }) as never;
      }
      return Promise.resolve({ status: 'ok', data: true }) as never;
    });
    let finishParked!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishParked = resolve;
          }) as never
      )
      .mockResolvedValue(settled as never);
    vi.spyOn(commands, 'hermesStop').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesInterrupt').mockResolvedValue({ status: 'ok', data: null } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    const sending = store.send('cancelled prompt');
    await vi.waitFor(() => expect(releaseKey).toBeTypeOf('function'));

    // Stop before anything was submitted: the row is parked at the head of its queue.
    await store.stop();
    releaseKey({ status: 'ok', data: true });
    await sending;
    expect(chat).not.toHaveBeenCalled();
    expect(store.messages.find(entry => entry.text === 'cancelled prompt')).toMatchObject({ queued: true });
    expect(store.thinking).toBe(false);
    // The parked row keeps the composer from accepting files: the store would reject them.
    expect(store.attachmentsBlocked()).toBe(true);

    // A new send in the idle conversation must not overtake the parked row; it joins the queue
    // and the parked prompt owns the free slot first. (The send itself would await a new turn,
    // so it is not awaited here.)
    void store.send('fresh follow-up');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ prompt: 'cancelled prompt' });
    expect(store.messages.find(entry => entry.text === 'fresh follow-up')).toMatchObject({ queued: true });

    finishParked(settled);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'fresh follow-up' });
  });

  it('Blocks attachment sends while another conversation owns the slot', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue({
      status: 'ok',
      data: { providers: [], model: null, provider: null }
    } as never);
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue({ status: 'ok', data: true } as never);
    let finishRunning!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi.spyOn(commands, 'hermesChat').mockImplementation(
      () =>
        new Promise(resolve => {
          finishRunning = resolve;
        }) as never
    );
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    expect(store.attachmentsBlocked()).toBe(false);
    void store.send('running turn');
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    // A fresh chat is idle, but the background turn owns the shared slot: attachments would be
    // rejected, so the composer must not treat this as a send it can clear.
    store.newChat();
    expect(store.thinking).toBe(false);
    expect(store.attachmentsBlocked()).toBe(true);

    finishRunning(settled);
    await vi.waitFor(() => expect(store.attachmentsBlocked()).toBe(false));
  });

  it('Writes the assistant reply onto the conversation restored while send waited', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    let releaseHistory!: (value: unknown) => void;
    vi.spyOn(commands, 'hermesHistoryLoad').mockImplementation(
      () =>
        new Promise(resolve => {
          releaseHistory = resolve;
        }) as never
    );
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue({ status: 'ok', data: null } as never);
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const chat = vi.spyOn(commands, 'hermesChat').mockResolvedValue({
      status: 'ok',
      data: { text: 'assistant reply', sessionId: 'sess-1', liveSessionId: 'live-9', usage: null, interrupted: false }
    } as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.conversations.push({
      id: 'chat-1',
      messages: [{ id: 'earlier', role: 'user', text: 'earlier', at: 1 }],
      updatedAt: 1
    });
    store.activeId = 'chat-1';

    const loading = store.loadHistory();
    await vi.waitFor(() => expect(releaseHistory).toBeTypeOf('function'));
    const sending = store.send('hello from user');
    releaseHistory({
      status: 'ok',
      data: JSON.stringify({
        conversations: [
          {
            id: 'chat-1',
            messages: [{ id: 'earlier', role: 'user', text: 'earlier', at: 1 }],
            updatedAt: 9_999_999_999_999,
            sessionId: 'old-session'
          }
        ],
        activeId: 'chat-1'
      })
    });
    await loading;
    await sending;

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-session' }));
    expect(store.active?.id).toBe('chat-1');
    expect(store.active?.sessionId).toBe('sess-1');
    expect(store.active?.liveSessionId).toBe('live-9');
    expect(store.messages.map(entry => entry.text)).toEqual(['earlier', 'hello from user', 'assistant reply']);
    expect(store.conversations.filter(item => item.id === 'chat-1')).toHaveLength(1);
  });

  it('Continues the queue after stopThinking once the superseded chat finishes', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishInitial!: (value: unknown) => void;
    let finishQueued!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }) as never
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishQueued = resolve;
          }) as never
      )
      .mockResolvedValue(settled as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('first queued');
    await store.send('second queued');

    finishInitial(settled);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'first queued' });

    store.stopThinking();
    expect(chat).toHaveBeenCalledTimes(2);
    finishQueued(settled);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    expect(chat.mock.calls[2]?.[0]).toMatchObject({ prompt: 'second queued' });
  });

  it('Lets select start a queued chat while the superseded request stays hung', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishInitial!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }) as never
      )
      .mockImplementationOnce(() => new Promise(() => undefined) as never)
      .mockResolvedValue(settled as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('first queued');
    await store.send('second queued');

    finishInitial(settled);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    store.stopThinking();
    await Promise.resolve();
    expect(chat).toHaveBeenCalledTimes(2);

    store.select(store.activeId!);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(3));
    expect(chat.mock.calls[2]?.[0]).toMatchObject({ prompt: 'second queued' });
  });

  it('Sends a steer that was still waiting for a generation after stop and select', async () => {
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(() => new Promise(() => undefined) as never)
      .mockResolvedValue(settled as never);
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    await store.send('steer this');
    expect(store.messages.some(entry => entry.text === 'steer this' && entry.steering)).toBe(true);

    store.stopThinking();
    await Promise.resolve();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.messages.some(entry => entry.steering)).toBe(false);

    store.select(store.activeId!);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'steer this' });
    expect(store.messages.some(entry => entry.text === 'steer this' && !entry.steering)).toBe(true);
  });

  it('Restores a queued message when the runtime is not ready and sends it on the next select', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    let finishInitial!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }) as never
      )
      .mockResolvedValue(settled as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const store = useHermesStore();
    await store.loadRuntime();
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('queued text');

    store.runtime = { ...store.runtime!, ready: false };
    finishInitial(settled);
    await vi.waitFor(() => expect(store.thinking).toBe(false));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.messages.some(entry => entry.text === 'queued text')).toBe(false);

    store.runtime = { ...store.runtime!, ready: true };
    store.select(store.activeId!);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'queued text' });
  });

  it('Continues a credential-blocked queue when the model becomes usable', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue({
      status: 'ok',
      data: {
        ready: true,
        installed: true,
        version: 'Hermes Agent v0.19.0',
        expectedVersion: '0.19.0',
        path: '/tmp/hermes',
        dataPath: '/tmp/OpenNavoData',
        computerUse: true,
        outdated: false,
        message: null
      }
    });
    vi.spyOn(commands, 'hermesSecretStatus')
      .mockResolvedValueOnce({ status: 'ok', data: true } as never)
      .mockResolvedValueOnce({ status: 'ok', data: false } as never)
      .mockResolvedValue({ status: 'ok', data: true } as never);
    const toasts = useToasts();
    toasts.clear();
    let finishInitial!: (value: unknown) => void;
    const settled = {
      status: 'ok',
      data: { text: 'done', sessionId: null, liveSessionId: null, usage: null, interrupted: false }
    };
    const chat = vi
      .spyOn(commands, 'hermesChat')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }) as never
      )
      .mockResolvedValue(settled as never);
    vi.spyOn(commands, 'hermesSteer').mockRejectedValue(new Error('stale_generation'));
    const store = useHermesStore();
    await store.loadRuntime();
    store.saveModel({ ...store.model, provider: 'openai', model: 'GPT-5.6', endpoint: '' });
    store.newChat();
    void store.send('initial turn');
    store.active!.busyMode = 'steer';
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    store.active!.liveSessionId = 'live-1';
    store.active!.executionGeneration = 7;
    await store.send('after key');

    finishInitial(settled);
    await vi.waitFor(() => expect(toasts.items.value.some(item => item.title === 'Hermes profile')).toBe(true));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(store.messages.some(entry => entry.text === 'after key')).toBe(false);

    // The settings sheet resets the session as soon as a key is typed, then saves the model.
    store.resetSession();
    store.saveModel({ ...store.model, keySet: true });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0]).toMatchObject({ prompt: 'after key' });
    expect(store.activeId).toBeTruthy();
  });

  it('Stops Mac control on panic', () => {
    const store = useHermesStore();
    store.stopMac();
    expect(store.mac.enabled).toBe(false);
    expect(store.macStatus).toBe('paused');
  });
});

describe('Hermes credential state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Re-reads the stored key instead of trusting a persisted keySet', async () => {
    const status = vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue({ status: 'ok', data: false });
    const store = useHermesStore();
    store.useProvider('openai');
    store.model = { ...store.model, keySet: true };

    await expect(store.refreshCredentialState()).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith('openai', null);
    expect(store.model.keySet).toBe(false);
  });

  it('Records a key that the runtime reports as stored', async () => {
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue({ status: 'ok', data: true });
    const store = useHermesStore();
    store.useProvider('anthropic');

    await expect(store.refreshCredentialState()).resolves.toBe(true);
    expect(store.model.keySet).toBe(true);
  });

  it('Never asks for a key on an OAuth provider', async () => {
    const status = vi.spyOn(commands, 'hermesSecretStatus');
    const store = useHermesStore();
    store.useProvider('nous');

    await expect(store.refreshCredentialState()).resolves.toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(store.model.keySet).toBe(false);
  });

  it('Only requires a stored key for providers that need one', () => {
    const store = useHermesStore();
    const needs = (provider: 'openai' | 'nous' | 'codex' | 'local' | 'custom', endpoint = '') =>
      store.requiresStoredKey({ ...store.model, provider, endpoint }, HERMES_PROVIDER_MAP[provider]);

    expect(needs('openai')).toBe(true);
    // Account logins and local endpoints authenticate without a stored key.
    expect(needs('nous')).toBe(false);
    expect(needs('codex')).toBe(false);
    expect(needs('local', 'http://127.0.0.1:11434')).toBe(false);
    // A custom endpoint needs one only until its URL is set.
    expect(needs('custom')).toBe(true);
    expect(needs('custom', 'https://example.test/v1')).toBe(false);
  });
});

describe('Hermes provider slugs', () => {
  it('Maps the local and custom cards to the provider OpenNavo actually configures', () => {
    // `write_config()` registers one user-defined provider, `providers.openavoo-custom`.
    // Mapping these cards to the canonical `custom` slug matched an always-present empty
    // skeleton row, which is why their model list stayed empty.
    expect(hermesProviderSlug('custom')).toBe('openavoo-custom');
    expect(hermesProviderSlug('local')).toBe('openavoo-custom');
  });

  it('Keeps the canonical slugs for the vendor cards', () => {
    expect(hermesProviderSlug('openai')).toBe('openai-api');
    expect(hermesProviderSlug('google')).toBe('gemini');
    expect(hermesProviderSlug('codex')).toBe('openai-codex');
    expect(hermesProviderSlug('claude-code')).toBe('anthropic');
    expect(hermesProviderSlug('opencode')).toBe('opencode-zen');
    expect(hermesProviderSlug('nous')).toBe('nous');
  });
});

describe('Hermes official provider picker', () => {
  it('Picks the user-defined row on this Mac instead of the canonical skeleton', () => {
    // Shape observed locally: the canonical `custom` row is always present and always empty.
    const rows = [
      { slug: 'custom', is_current: false, authenticated: false, models: [] },
      { slug: 'openavoo-custom', is_current: true, authenticated: true, models: ['grok-4.7'] }
    ];
    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('openavoo-custom');
    expect(pickOfficialProvider(rows, 'local')?.slug).toBe('openavoo-custom');
  });

  it('Picks the scoped endpoint row on a Hermes Panel host', () => {
    // Shape observed on a panel host: `custom` is the configured-but-unauthenticated
    // provider (one saved model plus the "not authenticated" warning), while the real
    // endpoint is registered as `custom:newapi` with 14 models.
    const rows = [
      {
        slug: 'custom',
        is_current: true,
        authenticated: false,
        models: ['grok-4.7'],
        warning:
          'Configured provider is not authenticated; run `hermes model` to reactivate. Showing the saved model only.'
      },
      {
        slug: 'custom:newapi',
        is_current: true,
        authenticated: true,
        models: ['grok-4.6', 'grok-4.3', 'gpt-6-sol']
      }
    ];
    const picked = pickOfficialProvider(rows, 'custom');
    expect(picked?.slug).toBe('custom:newapi');
    expect(picked?.models).toHaveLength(3);
  });

  it('Falls back to the current row when nothing can list models', () => {
    const rows = [
      { slug: 'custom', is_current: true, authenticated: false, models: ['grok-4.7'] },
      { slug: 'custom:other', is_current: false, authenticated: false, models: [] }
    ];
    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('custom');
  });

  it('Returns undefined when the payload has no row for the card', () => {
    expect(pickOfficialProvider([{ slug: 'nous', models: ['x'] }], 'custom')).toBeUndefined();
  });
});
