import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
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

function panelSessions(sessions: unknown[], total = sessions.length) {
  return ok(JSON.stringify({ sessions, total, limit: 20, offset: 0 }));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([]));
    vi.spyOn(commands, 'hermesPanelSessionMessages').mockResolvedValue(ok(JSON.stringify({ messages: [] })));
    vi.spyOn(commands, 'hermesPanelSessionRename').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesPanelSessionDelete').mockResolvedValue(ok(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the host for the active profile’s sessions, not the host default', async () => {
    const store = await mountPanelStore('aso-u4e13-u5bb6');

    await store.loadPanelHistory();

    // Second argument is the agent profile: without it every profile showed the same list.
    expect(commands.hermesPanelSessions).toHaveBeenCalledWith('panel-1', 'aso-u4e13-u5bb6', 20, 0);
  });

  it('sends no profile for the host’s own default profile', async () => {
    const store = await mountPanelStore('default');

    await store.loadPanelHistory();

    expect(commands.hermesPanelSessions).toHaveBeenCalledWith('panel-1', null, 20, 0);
  });

  it('renders the list from the host’s own metadata without reading transcripts', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(
      panelSessions([row({ id: 'sess-1' }), row({ id: 'sess-2', title: '每日检查 Hermes 更新' })])
    );
    const store = await mountPanelStore();

    await store.loadPanelHistory();

    // One list request per page; the old code fired one transcript read per row.
    expect(commands.hermesPanelSessionMessages).not.toHaveBeenCalled();
    expect(store.history.map(item => item.title)).toEqual(['Panel ok confirmation', '每日检查 Hermes 更新']);
  });

  it('uses the host title instead of the injected skill preamble', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(
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
    const page = Array.from({ length: 20 }, (_, index) => row({ id: `s-${index}` }));
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValueOnce(panelSessions(page, 21));
    const store = await mountPanelStore();

    await store.loadPanelHistory();
    expect(store.panelHistoryHasMore).toBe(true);

    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValueOnce(panelSessions([row({ id: 's-20' })], 21));
    await store.loadMorePanelHistory();

    // The offset follows the rows the host returned, not a hard-coded page size.
    expect(commands.hermesPanelSessions).toHaveBeenLastCalledWith('panel-1', null, 20, 20);
    expect(store.conversations).toHaveLength(21);
    expect(store.panelHistoryHasMore).toBe(false);
  });

  it('reads a transcript only when its conversation is opened', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.deleteConversation('sess-1');

    expect(commands.hermesPanelSessionDelete).toHaveBeenCalledWith('panel-1', 'sess-1', 3, 1, null);
    expect(store.conversations).toHaveLength(0);
  });

  it('keeps the row when the host refuses the delete', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.renameConversation('sess-1', '  新标题  ');

    expect(commands.hermesPanelSessionRename).toHaveBeenCalledWith('panel-1', 'sess-1', '新标题', 3, 1, null);
    expect(first(store.conversations).title).toBe('新标题');
  });

  it('never claims to clear the host’s sessions', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    await store.clearHistory();

    expect(commands.hermesPanelSessionDelete).not.toHaveBeenCalled();
    expect(store.conversations).toHaveLength(1);
  });

  it('keeps the conversation the user is reading when the list refreshes', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(
      panelSessions([row({ id: 'sess-1' }), row({ id: 'sess-2' })])
    );
    const store = await mountPanelStore();
    await store.loadPanelHistory();

    store.select('sess-2');
    await store.loadPanelHistory(true);

    expect(store.activeId).toBe('sess-2');
  });

  it('does not drop a turn that was sent while the transcript was loading', async () => {
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
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
    vi.spyOn(commands, 'hermesPanelSessions').mockResolvedValue(panelSessions([row({ id: 'sess-1' })]));
    vi.spyOn(commands, 'hermesPanelSessionRename').mockResolvedValueOnce({
      status: 'error' as const,
      error: { code: 'E_HERMES_PANEL_AUTH', message: 'Panel request returned 409.', detail: null }
    });
    const store = await mountPanelStore();
    await store.loadPanelHistory();
    expect(commands.hermesPanelSessions).toHaveBeenCalledTimes(1);

    await store.renameConversation('sess-1', '新标题');

    // A stale revision would otherwise refuse every later attempt.
    await vi.waitFor(() => expect(commands.hermesPanelSessions).toHaveBeenCalledTimes(2));
    expect(first(store.conversations).title).toBe('Panel ok confirmation');
  });
});
