import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { watchEffect } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
import { i18n } from '@/i18n';
import AssistantHistory from '@/components/hermes/AssistantHistory.vue';
import { useHermesStore } from '@/stores/hermes';

const ok = <T>(data: T) => ({ status: 'ok' as const, data });
const PROFILES_KEY = 'ONV_HERMES_PROFILES_V1';

/** A panel connection on the `aso` profile, so history comes from the host's session store. */
function seedPanelConnection(agentProfile = 'default') {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify({
      version: 1,
      activeProfileId: 'panel-1',
      profiles: [
        { id: 'local', name: 'Local', kind: 'local', endpoint: '' },
        { id: 'panel-1', name: 'Panel', kind: 'panel', endpoint: 'http://panel.tail1234.ts.net:9119' }
      ],
      activeAgentProfiles: { 'panel-1': agentProfile }
    })
  );
}

function agentProfileFixture(name: string, isDefault = false) {
  return {
    name,
    displayName: isDefault ? null : name.toUpperCase(),
    path: `/tmp/${name}`,
    isDefault,
    model: 'grok-4.7',
    provider: 'custom',
    skillCount: 0,
    hasEnv: false,
    description: null,
    botTitle: null,
    distributionName: null,
    distributionVersion: null
  };
}

/** One `GET /api/sessions` row, as the host sends it (epoch seconds, host-side title). */
function row(overrides: Record<string, unknown>) {
  return {
    id: 'sess-1',
    display_name: null,
    title: 'Panel ok confirmation',
    preview: 'Reply with exactly PANEL_OK',
    message_count: 2,
    runtime_revision: 3,
    runtime_generation: 1,
    started_at: 1_700_000_000,
    last_activity_at: 1_700_000_500,
    last_active: 1_700_000_400,
    ...overrides
  };
}

/** The normalized envelope `hermes_panel_history` returns for one slice. */
function panelSessions(sessions: unknown[], total = sessions.length, overrides: Record<string, unknown> = {}) {
  return ok(
    JSON.stringify({
      slice: 'recents',
      allProfiles: false,
      degraded: false,
      sessions,
      total,
      limit: 40,
      offset: 0,
      hasMore: sessions.length > 0 && sessions.length < total,
      ...overrides
    })
  );
}

/** First item, so the strict index check does not need `!` at every assertion. */
function first<T>(items: T[]): T {
  const [value] = items;
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

async function mountPanelStore(agentProfileName = 'default') {
  localStorage.clear();
  setActivePinia(createPinia());
  seedPanelConnection(agentProfileName);
  const store = useHermesStore();
  await store.loadAgentProfiles();
  return store;
}

describe('Hermes panel history', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue(
      ok({
        ready: true,
        installed: true,
        version: '0.23.0',
        expectedVersion: '0.23.0',
        path: '/tmp/hermes',
        dataPath: '/tmp',
        computerUse: false,
        outdated: false,
        message: null
      })
    );
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(
      ok([agentProfileFixture('default', true), agentProfileFixture('aso-u4e13-u5bb6')])
    );
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok({ providers: [], model: null, provider: null }));
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(ok(JSON.stringify({ messages: [] })));
    vi.spyOn(commands, 'hermesPanelSessionRename').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelSessionDelete').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelSessionArchive').mockResolvedValue(ok(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the host for the active profile’s sessions, not the host default', async () => {
    const store = await mountPanelStore('aso-u4e13-u5bb6');

    await store.loadPanelHistory();

    // Second argument is the agent profile: without it every profile showed the same list.
    // Third is the aggregation switch; slice/limit/offset complete the request.
    expect(commands.hermesPanelHistory).toHaveBeenCalledWith('panel-1', 'aso-u4e13-u5bb6', false, 'recents', 40, 0);
  });

  it('sends no profile for the host’s own default profile', async () => {
    const store = await mountPanelStore('default');

    await store.loadPanelHistory();

    expect(commands.hermesPanelHistory).toHaveBeenCalledWith('panel-1', null, false, 'recents', 40, 0);
  });

  it('renders the list from the host’s own metadata without reading transcripts', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'sess-1' }), row({ id: 'sess-2', title: '每日检查 Hermes 更新' })])
    );
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    // One list request per page; the old code fired one transcript read per row.
    expect(commands.hermesPanelSessionMessages).not.toHaveBeenCalled();
    expect(store.history.map(item => item.title)).toEqual(['Panel ok confirmation', '每日检查 Hermes 更新']);
  });

  it('uses the host title instead of the injected skill preamble', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([
        row({
          id: 'cron-1',
          title: 'social-hourly · Nov 11 02:42',
          preview: '[IMPORTANT: The user has invoked the "opennavo-social" skill, indicating they want…]'
        })
      ])
    );
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    expect(first(store.history).title).toBe('social-hourly · Nov 11 02:42');
    expect(first(store.history).panelPreview ?? '').not.toContain('[IMPORTANT:');
  });

  it('falls back to a cleaned preview when the host has no title', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([
        row({
          id: 'untitled',
          title: null,
          display_name: null,
          preview: '[IMPORTANT: The user has invoked the "x" skill.] 目前你如何接入到 Telegram？'
        })
      ])
    );
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    expect(first(store.history).title).toBe('目前你如何接入到 Telegram？');
    expect(first(store.history).title).not.toContain('IMPORTANT');
  });

  it('sorts by the host’s last activity, not by creation time', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([
        // Older row, but touched most recently: it belongs on top.
        row({ id: 'old-but-active', started_at: 1_700_000_000, last_activity_at: 1_800_000_000 }),
        row({ id: 'new-but-stale', started_at: 1_750_000_000, last_activity_at: 1_750_000_000 })
      ])
    );
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    expect(store.history.map(item => item.id)).toEqual(['old-but-active', 'new-but-stale']);
    expect(first(store.history).updatedAt).toBe(1_800_000_000_000);
  });

  it('pages with the host total and appends the next rows', async () => {
    // A full first page means the host has more rows behind it.
    const page = Array.from({ length: 40 }, (_, index) => row({ id: `s-${index}` }));
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce(panelSessions(page, 41));
    const store = await mountPanelStore();

    await store.loadPanelHistory();
    expect(store.panelSliceState('recents').hasMore).toBe(true);

    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce(
      panelSessions([row({ id: 's-40' })], 41, { hasMore: false })
    );
    await store.loadMorePanelHistory();

    // The offset follows the rows the host returned, not a hard-coded page size.
    expect(commands.hermesPanelHistory).toHaveBeenLastCalledWith('panel-1', null, false, 'recents', 40, 40);
    expect(store.conversations).toHaveLength(41);
    expect(store.panelSliceState('recents').hasMore).toBe(false);
  });

  it('reads a transcript only when its conversation is opened', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: 'Reply with exactly PANEL_OK', timestamp: 1_700_000_000 },
            { id: 2, role: 'assistant', content: 'PANEL_OK', timestamp: 1_700_000_010 },
            { id: 3, role: 'tool', content: '{"ok":true}', timestamp: 1_700_000_011 }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(2));

    expect(commands.hermesPanelSessionMessages).toHaveBeenCalledWith('panel-1', 'sess-1', null, 120, 0);
    expect(store.messages.map(entry => entry.text)).toEqual(['Reply with exactly PANEL_OK', 'PANEL_OK']);
    expect(store.panelConversationLoading).toBeNull();
  });

  it('folds a tool result into the assistant turn that called it', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: '查一下排名', timestamp: 1_700_000_000 },
            {
              id: 2,
              role: 'assistant',
              content: '',
              timestamp: 1_700_000_005,
              tool_calls: [
                {
                  id: 'call-1',
                  call_id: 'call-1',
                  type: 'function',
                  function: { name: 'app_store.search', arguments: '{"term":"班级宠物"}' }
                }
              ]
            },
            {
              id: 3,
              role: 'tool',
              tool_call_id: 'call-1',
              tool_name: 'app_store.search',
              content: '{"rank":3}',
              timestamp: 1_700_000_020
            },
            { id: 4, role: 'assistant', content: '第 3 名。', timestamp: 1_700_000_030 }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(3));

    // The tool row is folded into its call instead of becoming a message of its own.
    const toolTurn = first(store.messages.slice(1));
    expect(toolTurn.tools).toHaveLength(1);
    expect(toolTurn.tools?.[0]).toMatchObject({
      name: 'app_store.search',
      args: '{"term":"班级宠物"}',
      result: '{"rank":3}',
      pending: false,
      time: '15s'
    });
    expect(store.messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('keeps a turn that only called tools', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: '跑一下', timestamp: 1_700_000_000 },
            {
              id: 2,
              role: 'assistant',
              content: '',
              timestamp: 1_700_000_005,
              tool_calls: [{ id: 'call-1', call_id: 'call-1', function: { name: 'shell', arguments: '{}' } }]
            },
            {
              id: 3,
              role: 'tool',
              tool_call_id: 'call-1',
              tool_name: 'shell',
              content: 'done',
              timestamp: 1_700_000_006
            }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(2));

    // Previously an empty assistant row was dropped, so the turn vanished entirely.
    expect(first(store.messages.slice(1)).text).toBe('');
    expect(first(store.messages.slice(1)).tools?.[0]?.result).toBe('done');
  });

  it('still renders a tool result whose call is not in the page', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            {
              id: 1,
              role: 'tool',
              tool_call_id: 'gone',
              tool_name: 'shell',
              content: 'orphan output',
              timestamp: 1_700_000_000
            }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(1));

    expect(first(store.messages).tools?.[0]).toMatchObject({ name: 'shell', result: 'orphan output' });
  });

  it('drops the rows the panel marks hidden', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: 'hi', timestamp: 1_700_000_000 },
            { id: 2, role: 'assistant', content: 'scaffolding', display_kind: 'hidden', timestamp: 1_700_000_001 },
            { id: 3, role: 'assistant', content: 'real answer', timestamp: 1_700_000_002 }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(2));

    expect(store.messages.map(entry => entry.text)).toEqual(['hi', 'real answer']);
  });

  it('offers older rows only while a full page came back', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const page = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      role: index % 2 ? 'assistant' : 'user',
      content: `row ${index}`,
      timestamp: 1_700_000_000 + index
    }));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(ok(JSON.stringify({ messages: page })));
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(first(store.conversations).messagesLoaded).toBe(true));

    const conversation = first(store.conversations);
    expect(conversation.panelOffset).toBe(120);
    expect(conversation.panelHasOlder).toBe(true);

    // A short page means the session has reached its beginning.
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(
      ok(JSON.stringify({ messages: [{ id: 0, role: 'user', content: 'oldest', timestamp: 1_600_000_000 }] }))
    );
    await store.loadOlderPanelMessages('sess-1');

    expect(commands.hermesPanelSessionMessages).toHaveBeenLastCalledWith('panel-1', 'sess-1', null, 120, 120);
    expect(conversation.panelHasOlder).toBe(false);
    expect(first(conversation.messages).text).toBe('oldest');
  });

  it('does not duplicate rows that overlap between two pages', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const page = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      role: 'assistant',
      content: `row ${index}`,
      timestamp: 1_700_000_000 + index
    }));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(ok(JSON.stringify({ messages: page })));
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(first(store.conversations).messagesLoaded).toBe(true));

    // The second page overlaps the first by one row, as a live session can.
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(
      ok(
        JSON.stringify({
          messages: [page[0], { id: 0, role: 'assistant', content: 'older', timestamp: 1_600_000_000 }]
        })
      )
    );
    await store.loadOlderPanelMessages('sess-1');

    const conversation = first(store.conversations);
    const ids = conversation.messages.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(conversation.messages).toHaveLength(121);
  });

  it('deletes on the host so the row does not come back', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.deleteConversation('sess-1');

    expect(commands.hermesPanelSessionDelete).toHaveBeenCalledWith('panel-1', 'sess-1', 3, 1, null);
    expect(store.conversations).toHaveLength(0);
  });

  it('keeps the row when the host refuses the delete', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionDelete').mockResolvedValue({
      status: 'error' as const,
      error: { code: 'E_HERMES_PANEL', message: 'Panel request returned 500.', detail: null }
    });
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.deleteConversation('sess-1');

    expect(store.conversations).toHaveLength(1);
  });

  it('renames on the host so the title survives a refresh', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.renameConversation('sess-1', '  新标题  ');

    expect(commands.hermesPanelSessionRename).toHaveBeenCalledWith('panel-1', 'sess-1', '新标题', 3, 1, null);
    expect(first(store.conversations).title).toBe('新标题');
  });

  it('never claims to clear the host’s sessions', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.clearHistory();

    expect(commands.hermesPanelSessionDelete).not.toHaveBeenCalled();
    expect(store.conversations).toHaveLength(1);
  });

  it('keeps the conversation the user is reading when the list refreshes', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'sess-1' }), row({ id: 'sess-2' })])
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    store.select('sess-2');
    await store.loadPanelHistory('recents', true);

    expect(store.activeId).toBe('sess-2');
  });

  it('does not drop a turn that was sent while the transcript was loading', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    let release: (value: unknown) => void = () => {};
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }) as never
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    store.select('sess-1');
    const conversation = first(store.conversations);
    // The user types before the host answers.
    conversation.messages = [{ id: 'm-local', role: 'user', text: 'typed during load', at: Date.now() }];
    release(
      ok(
        JSON.stringify({
          messages: [{ id: 1, role: 'user', content: 'Reply with exactly PANEL_OK', timestamp: 1_700_000_000 }]
        })
      )
    );
    await vi.waitFor(() => expect(conversation.messagesLoaded).toBe(true));

    expect(conversation.messages.map(entry => entry.text)).toEqual([
      'Reply with exactly PANEL_OK',
      'typed during load'
    ]);
  });

  it('re-reads the list after a refused write so the retry carries a fresh fence', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionRename').mockResolvedValueOnce({
      status: 'error' as const,
      error: { code: 'E_HERMES_PANEL_AUTH', message: 'Panel request returned 409.', detail: null }
    });
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    expect(commands.hermesPanelHistory).toHaveBeenCalledTimes(1);

    await store.renameConversation('sess-1', '新标题');

    // A stale revision would otherwise refuse every later attempt.
    await vi.waitFor(() => expect(commands.hermesPanelHistory).toHaveBeenCalledTimes(2));
    expect(first(store.conversations).title).toBe('Panel ok confirmation');
  });

  it('reads gateway threads through their own slice, not the recents page', async () => {
    const store = await mountPanelStore();

    await store.loadPanelHistory('messaging');

    expect(commands.hermesPanelHistory).toHaveBeenCalledWith('panel-1', null, false, 'messaging', 40, 0);
  });

  it('tags each row with the slice and platform that produced it', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockImplementation((async (
      _id: string,
      _profile: unknown,
      _all: unknown,
      slice: string
    ) =>
      slice === 'messaging'
        ? panelSessions([row({ id: 'tg-1', source: 'telegram', title: 'Telegram 值班' })], 1, { slice })
        : panelSessions([row({ id: 'local-1', source: 'desktop' })], 1, { slice })) as never);
    const store = await mountPanelStore();

    await store.loadPanelHistory('recents');
    await store.loadPanelHistory('messaging');

    expect(store.panelRowsFor('recents').map(item => item.id)).toEqual(['local-1']);
    expect(store.panelRowsFor('messaging').map(item => item.id)).toEqual(['tg-1']);
    expect(first(store.panelRowsFor('messaging')).panelSource).toBe('telegram');
  });

  it('keeps rows from another slice when one slice refreshes', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockImplementation((async (
      _id: string,
      _profile: unknown,
      _all: unknown,
      slice: string
    ) =>
      slice === 'messaging'
        ? panelSessions([row({ id: 'tg-1', source: 'telegram' })], 1, { slice })
        : panelSessions([row({ id: 'local-1', source: 'desktop' })], 1, { slice })) as never);
    const store = await mountPanelStore();
    await store.loadPanelHistory('recents');
    await store.loadPanelHistory('messaging');

    // A recents refresh must not drop the gateway page the user already loaded.
    await store.refreshPanelHistory('recents');

    expect(store.conversations.map(item => item.id).sort()).toEqual(['local-1', 'tg-1']);
  });

  it('replaces panel rows persisted by a build that had no slices', async () => {
    // A row saved before slices existed carries no `panelSlice`; if a refresh kept it, the
    // phantom conversation would show in every view forever.
    localStorage.clear();
    setActivePinia(createPinia());
    seedPanelConnection('default');
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        version: 1,
        activeProfileId: 'panel-1',
        profiles: [
          { id: 'local', name: 'Local', kind: 'local', endpoint: '' },
          { id: 'panel-1', name: 'Panel', kind: 'panel', endpoint: 'http://panel.tail1234.ts.net:9119' }
        ],
        activeAgentProfiles: { 'panel-1': 'default' },
        states: {
          'panel-1::default': {
            model: { provider: 'nous', model: 'grok-4.7', effort: 'medium', fast: false, endpoint: '', keySet: false },
            conversations: [
              {
                id: 'legacy-row',
                title: '旧版本留下的会话',
                messages: [],
                updatedAt: 1_700_000_000_000,
                panel: true,
                panelSource: 'telegram'
              }
            ],
            activeId: null,
            workingDir: '',
            auxiliary: {},
            forceAuxVision: false
          }
        }
      })
    );
    const store = useHermesStore();
    await store.loadAgentProfiles();
    // The restored row is inferred into the gateway slice, not left unowned.
    expect(store.panelRowsFor('messaging').map(item => item.id)).toEqual(['legacy-row']);

    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'fresh-row', source: 'telegram' })], 1, { slice: 'messaging' })
    );
    await store.loadPanelHistory('messaging');

    // The host's answer replaces the stale row instead of piling up beside it.
    expect(store.conversations.map(item => item.id)).toEqual(['fresh-row']);
  });

  it('drops a row the host no longer lists in that slice', async () => {
    vi.spyOn(commands, 'hermesPanelHistory')
      .mockResolvedValueOnce(panelSessions([row({ id: 'a' }), row({ id: 'b' })]))
      .mockResolvedValueOnce(panelSessions([row({ id: 'a' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.refreshPanelHistory('recents');

    expect(store.conversations.map(item => item.id)).toEqual(['a']);
  });

  it('aggregates every profile on the host and tags the rows', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'tg-1', source: 'telegram', profile: 'aso' })], 1, {
        allProfiles: true,
        profileTotals: { default: 4, aso: 1 }
      })
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory('recents');

    expect(commands.hermesPanelHistory).toHaveBeenLastCalledWith('panel-1', null, true, 'recents', 40, 0);
    expect(store.panelAllProfiles).toBe(true);
    expect(first(store.conversations).panelProfile).toBe('aso');
  });

  it('reads an aggregated row through its own profile, not the selected one', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'aso-1', profile: 'aso' })], 1, { allProfiles: true })
    );
    const store = await mountPanelStore();
    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory();

    store.select('aso-1');

    // The row lives in `aso`'s store: addressing the selected `default` profile read the wrong
    // database and came back empty.
    await vi.waitFor(() => expect(commands.hermesPanelSessionMessages).toHaveBeenCalled());
    expect(commands.hermesPanelSessionMessages).toHaveBeenCalledWith('panel-1', 'aso-1', 'aso', 120, 0);
  });

  it('writes an aggregated row through its own profile', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'aso-1', profile: 'aso' })], 1, { allProfiles: true })
    );
    const store = await mountPanelStore();
    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory();

    await store.renameConversation('aso-1', '新标题');
    expect(commands.hermesPanelSessionRename).toHaveBeenLastCalledWith('panel-1', 'aso-1', '新标题', 3, 1, 'aso');

    await store.setConversationArchived('aso-1', true);
    expect(commands.hermesPanelSessionArchive).toHaveBeenLastCalledWith('panel-1', 'aso-1', true, 4, 1, 'aso');
  });

  it('drops another profile’s rows when the aggregate is turned off', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'aso-1', profile: 'aso' }), row({ id: 'default-1', profile: 'default' })], 2, {
        allProfiles: true
      })
    );
    const store = await mountPanelStore();
    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory();
    expect(store.panelRowsFor('recents')).toHaveLength(2);

    await store.setPanelAllProfiles(false);

    // The aggregate is a view, not a merge: the other profile's row must not stay on the list,
    // nor end up in this profile's saved state.
    expect(store.panelRowsFor('recents').map(item => item.id)).toEqual(['default-1']);
    expect(localStorage.getItem(PROFILES_KEY) ?? '').not.toContain('aso-1');
  });

  it('re-reads a transcript the host has moved past', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce(
      panelSessions([row({ id: 'sess-1', message_count: 2 })], 1)
    );
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: '第一轮', timestamp: 1_700_000_000 },
            { id: 2, role: 'assistant', content: '好的', timestamp: 1_700_000_010 }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(2));

    // The host reports a new turn. Keeping the cached transcript would leave the open chat
    // stale until the user selected the row again.
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce(
      panelSessions([row({ id: 'sess-1', message_count: 4, last_activity_at: 1_700_000_900 })], 1)
    );
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValueOnce(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: '第一轮', timestamp: 1_700_000_000 },
            { id: 2, role: 'assistant', content: '好的', timestamp: 1_700_000_010 },
            { id: 3, role: 'user', content: '第二轮', timestamp: 1_700_000_800 },
            { id: 4, role: 'assistant', content: '收到', timestamp: 1_700_000_900 }
          ]
        })
      )
    );
    await store.refreshPanelHistory('recents');

    await vi.waitFor(() => expect(store.messages).toHaveLength(4));
    expect(store.messages.map(entry => entry.text)).toContain('收到');
  });

  it('keeps a transcript the host reports unchanged', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'sess-1', message_count: 2 })], 1)
    );
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(
      ok(
        JSON.stringify({
          messages: [
            { id: 1, role: 'user', content: 'Reply with exactly PANEL_OK', timestamp: 1_700_000_000 },
            { id: 2, role: 'assistant', content: 'PANEL_OK', timestamp: 1_700_000_010 }
          ]
        })
      )
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    store.select('sess-1');
    await vi.waitFor(() => expect(store.messages).toHaveLength(2));

    await store.refreshPanelHistory('recents');

    // One transcript read: a refresh of an unchanged row must not throw the messages away.
    expect(commands.hermesPanelSessionMessages).toHaveBeenCalledTimes(1);
    expect(store.messages).toHaveLength(2);
  });

  it('surfaces a host without the aggregated route instead of failing', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'a' })], 1, { allProfiles: false, degraded: true })
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.setPanelAllProfiles(true);
    await store.loadPanelHistory('recents');

    expect(store.panelSliceState('recents').degraded).toBe(true);
    expect(store.panelSliceState('recents').error).toBeNull();
    expect(store.conversations).toHaveLength(1);
  });

  it('does not cache a failed page as an empty list', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce({
      status: 'error' as const,
      error: { code: 'E_HERMES_PANEL', message: 'Panel request returned 503.', detail: 'busy' }
    });
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    expect(store.panelSliceState('recents').error).not.toBeNull();
    expect(store.panelSliceState('recents').loaded).toBe(false);

    // The next open retries instead of showing "no conversations" for the rest of the run.
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValueOnce(panelSessions([row({ id: 'a' })]));
    await store.loadPanelHistory();

    expect(store.conversations).toHaveLength(1);
    expect(store.panelSliceState('recents').error).toBeNull();
  });

  it('archives on the host and re-reads the lists', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.setConversationArchived('sess-1', true);

    expect(commands.hermesPanelSessionArchive).toHaveBeenCalledWith('panel-1', 'sess-1', true, 3, 1, null);
    // The row belongs to the archive now; the slice reloads on the next visit.
    expect(store.conversations).toHaveLength(0);
    expect(store.panelSliceState('recents').loaded).toBe(false);
  });

  it('restores an archived row', async () => {
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'sess-1', archived: true })], 1, { slice: 'archived' })
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory('archived');
    expect(first(store.panelRowsFor('archived')).panelArchived).toBe(true);

    await store.setConversationArchived('sess-1', false);

    expect(commands.hermesPanelSessionArchive).toHaveBeenLastCalledWith('panel-1', 'sess-1', false, 3, 1, null);
  });
});

describe('Hermes panel history state reactivity', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue(
      ok({
        ready: true,
        installed: true,
        version: '0.23.0',
        expectedVersion: '0.23.0',
        path: '/tmp/hermes',
        dataPath: '/tmp',
        computerUse: false,
        outdated: false,
        message: null
      })
    );
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok([agentProfileFixture('default', true)]));
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok({ providers: [], model: null, provider: null }));
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(ok(JSON.stringify({ messages: [] })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets an observer see loading and error flip', async () => {
    // A ref holding plain objects made these mutations invisible: the popover kept its first
    // render, so a failed request looked like "no conversations" with no way to retry.
    let release: (value: unknown) => void = () => {};
    vi.spyOn(commands, 'hermesPanelHistory').mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }) as never
    );
    const store = await mountPanelStore();

    const seen: Array<{ loading: boolean; error: string | null }> = [];
    const stop = watchEffect(() => {
      const state = store.panelSliceState('recents');
      seen.push({ loading: state.loading, error: state.error });
    });

    const loading = store.loadPanelHistory();
    await vi.waitFor(() => expect(store.panelSliceState('recents').loading).toBe(true));

    release({
      status: 'error' as const,
      error: { code: 'E_HERMES_PANEL', message: 'Panel request returned 500.', detail: null }
    });
    await loading;
    await vi.waitFor(() => expect(store.panelSliceState('recents').error).not.toBeNull());
    stop();

    expect(seen.some(entry => entry.loading)).toBe(true);
    expect(seen.some(entry => entry.error !== null)).toBe(true);
  });
});

describe('Hermes history popover on a local connection', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue(
      ok({
        ready: true,
        installed: true,
        version: '0.23.0',
        expectedVersion: '0.23.0',
        path: '/tmp/hermes',
        dataPath: '/tmp',
        computerUse: false,
        outdated: false,
        message: null
      })
    );
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok([agentProfileFixture('default', true)]));
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok({ providers: [], model: null, provider: null }));
    vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesHistorySave').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(ok(JSON.stringify({ messages: [] })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to recents when the panel stops being the active connection', async () => {
    localStorage.clear();
    setActivePinia(createPinia());
    seedPanelConnection();
    // The local connection has one conversation of its own: if the popover stayed on the
    // gateway slice after the switch, this row could never appear (that view only lists
    // panel rows, and its tab is hidden with the panel).
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        version: 1,
        activeProfileId: 'panel-1',
        profiles: [
          { id: 'local', name: 'Local', kind: 'local', endpoint: '' },
          { id: 'panel-1', name: 'Panel', kind: 'panel', endpoint: 'http://panel.tail1234.ts.net:9119' }
        ],
        activeAgentProfiles: { 'panel-1': 'default' },
        states: {
          'local::default': {
            model: { provider: 'nous', model: 'grok-4.7', effort: 'medium', fast: false, endpoint: '', keySet: false },
            conversations: [
              {
                id: 'local-1',
                title: '本地会话',
                messages: [{ id: 'm-1', role: 'user', text: 'hi', at: 1_700_000_000_000 }],
                updatedAt: 1_700_000_000_000
              }
            ],
            activeId: 'local-1',
            workingDir: '',
            auxiliary: {},
            forceAuxVision: false
          }
        }
      })
    );
    const store = useHermesStore();
    await store.loadAgentProfiles();
    vi.spyOn(commands, 'hermesPanelHistory').mockResolvedValue(
      panelSessions([row({ id: 'sess-1', source: 'telegram' })], 1, { slice: 'messaging' })
    );
    await store.loadPanelHistory('messaging');

    const wrapper = mount(AssistantHistory, {
      props: { open: true },
      global: { plugins: [i18n] },
      attachTo: document.body
    });
    await flushPromises();
    const messaging = wrapper.find('[data-hermes-view="messaging"]');
    expect(messaging.exists()).toBe(true);
    await messaging.trigger('click');
    await flushPromises();
    expect(messaging.attributes('aria-pressed')).toBe('true');

    store.switchProfile('local');
    await flushPromises();

    // The slice tabs are gone with the panel, and the popover is back on the list it can show.
    expect(wrapper.find('[data-hermes-view]').exists()).toBe(false);
    expect(wrapper.text()).toContain('本地会话');
    wrapper.unmount();
  });
});
