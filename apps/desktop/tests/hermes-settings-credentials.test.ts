import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
import { useHermesStore } from '@/stores/hermes';
import HermesSettings from '@/components/hermes/HermesSettings.vue';
import { i18n } from '@/i18n';
import { en } from '@/hermes/content';

const ok = <T>(data: T) => ({ status: 'ok' as const, data });

const PROFILES_KEY = 'ONV_HERMES_PROFILES_V1';

/** Shape captured from a real Hermes Panel host (`GET /api/model/options`). */
const PANEL_PAYLOAD = {
  providers: [
    {
      slug: 'custom',
      name: 'Custom',
      is_current: true,
      is_user_defined: false,
      models: ['grok-4.7'],
      total_models: 1,
      source: 'configured-current',
      authenticated: false,
      auth_type: 'api_key',
      warning:
        'Configured provider is not authenticated; run `hermes model` to reactivate. Showing the saved model only.'
    },
    {
      slug: 'custom:newapi',
      name: 'newapi',
      is_current: true,
      is_user_defined: true,
      models: ['grok-4.6', 'grok-4.3', 'gpt-6-sol', 'deepseek-v4.1-flash'],
      total_models: 4,
      source: 'user-config',
      authenticated: true
    }
  ]
};

const SAVED_CATALOG = {
  providers: [
    {
      slug: 'openavoo-custom',
      name: 'Custom',
      is_current: true,
      models: ['saved-model', 'grok-default'],
      total_models: 2,
      authenticated: true
    }
  ]
};

const RESEARCH_CATALOG = {
  providers: [
    {
      slug: 'openavoo-custom',
      name: 'Custom',
      is_current: true,
      models: ['grok-research'],
      total_models: 1,
      authenticated: true
    }
  ]
};

function seedConnection(kind: 'local' | 'panel') {
  if (kind === 'panel') {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        version: 1,
        activeProfileId: 'panel-1',
        profiles: [
          { id: 'local', name: 'Local', kind: 'local', endpoint: '' },
          { id: 'panel-1', name: 'Panel', kind: 'panel', endpoint: 'http://panel.tail1234.ts.net:9119' }
        ]
      })
    );
  }
}

const AGENT_PROFILES = [
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

/** The profile-scope `<select>` in the sheet header, not a model picker. */
function profileScopeSelect(): HTMLSelectElement | null {
  return (
    Array.from(document.body.querySelectorAll('select')).find(select =>
      Array.from(select.options).some(option => option.value === 'research')
    ) ?? null
  );
}

function cacheKeysForProfile(connectionId: string, agentProfile: string): string[] {
  const prefix = `ONV_HERMES_MODEL_OPTIONS_V3::${encodeURIComponent(connectionId)}::${encodeURIComponent(agentProfile)}::`;
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

async function mountSheet() {
  // The sheet loads on the open transition, so start closed and open it.
  const wrapper = mount(HermesSettings, {
    props: { open: false, tab: 'model' },
    attachTo: document.body,
    global: { plugins: [i18n] }
  });
  await wrapper.setProps({ open: true });
  await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 0));
  return wrapper;
}

/** The sheet teleports into `body`, so assertions read the document, not the wrapper. */
const sheetText = () => document.body.textContent ?? '';
const hasAuthField = () => document.body.querySelector('#hermes-auth') !== null;

describe('Hermes settings credentials', () => {
  let wrapper: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    // Every sheet is attached to `body`; leaving one mounted leaks its copy into the next test.
    wrapper?.unmount();
    wrapper = null;
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
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
    vi.spyOn(commands, 'hermesLoginStatus').mockResolvedValue(
      ok({
        codex: false,
        claudeCode: false,
        copilot: false,
        opencode: false,
        opencodeGo: false,
        nous: false,
        codexSource: null,
        claudeCodeSource: null,
        copilotSource: null,
        opencodeSource: null,
        opencodeGoSource: null,
        nousSource: null
      })
    );
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue(ok(false));
    vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok(PANEL_PAYLOAD));
    vi.spyOn(commands, 'hermesPermissionsStatus').mockResolvedValue(ok({} as never));
  });

  it('Writes a delayed key save to the profile the sheet was editing', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    let finishSet!: (value: unknown) => void;
    const saving = new Promise(resolve => {
      finishSet = resolve;
    });
    const secretSet = vi.spyOn(commands, 'hermesSecretSet').mockReturnValue(saving as never);
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue(ok(true));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    store.saveModel({ ...store.model, provider: 'custom', model: 'grok-4.7', endpoint: 'https://api.example.test/v1' });
    wrapper = await mountSheet();

    const key = document.body.querySelector<HTMLInputElement>('#hermes-key');
    expect(key).not.toBeNull();
    key!.value = 'sk-still-default';
    key!.dispatchEvent(new Event('input'));
    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.common.save
    );
    save!.click();
    await vi.waitFor(() => expect(secretSet).toHaveBeenCalledWith('custom', 'sk-still-default', null));

    // The user moves the sheet to another profile while the key write is still running.
    const select = profileScopeSelect();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    finishSet(ok(null));
    await vi.waitFor(() => expect(secretSet).toHaveBeenCalledTimes(1));

    // The write stayed on the original profile; the new one's draft never inherited the key.
    expect(secretSet).toHaveBeenCalledWith('custom', 'sk-still-default', null);
    expect(store.apiKey).toBe('');
    expect(store.agentProfileModel('research').provider).not.toBe('custom');
  });

  it('Does not claim a failed key write was saved', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    vi.spyOn(commands, 'hermesSecretSet').mockResolvedValue({
      status: 'error',
      error: { code: 'E_HERMES_CREDENTIAL', message: 'Could not store the key.', detail: null }
    });
    const store = useHermesStore();
    await store.loadAgentProfiles();
    store.saveModel({ ...store.model, provider: 'custom', model: 'grok-4.7', endpoint: 'https://api.example.test/v1' });
    wrapper = await mountSheet();
    const key = document.body.querySelector<HTMLInputElement>('#hermes-key');
    key!.value = 'sk-fails';
    key!.dispatchEvent(new Event('input'));
    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.common.save
    );
    save!.click();
    await vi.waitFor(() => expect(commands.hermesSecretSet).toHaveBeenCalledWith('custom', 'sk-fails', null));
    await new Promise(resolve => setTimeout(resolve, 0));
    // The failure keeps the sheet open and never copies the key into the next turn.
    expect(document.body.querySelector('#hermes-key')).not.toBeNull();
    expect(store.apiKey).toBe('');
  });

  it('Hides this Mac’s credential fields on a panel connection and points at the host', async () => {
    seedConnection('panel');
    useHermesStore().useProvider('custom');
    await mountSheet();

    expect(hasAuthField()).toBe(false);
    // Copy comes from `content.ts`; the sheet renders en-US in tests.
    expect(sheetText()).toContain('panel host');
  });

  it('Shows the model list of the endpoint the panel host actually serves', async () => {
    seedConnection('panel');
    useHermesStore().useProvider('custom');
    wrapper = await mountSheet();

    const rows = useHermesStore().modelOptions?.providers ?? [];
    const endpoint = rows.find(row => row.slug === 'custom:newapi');
    expect(endpoint?.models).toHaveLength(4);

    // The unauthenticated `custom` row's warning must not be presented as this card's status.
    expect(sheetText()).not.toContain('not authenticated');
    // And the endpoint's own models are what the picker offers.
    for (const id of ['grok-4.6', 'grok-4.3', 'gpt-6-sol', 'deepseek-v4.1-flash']) {
      expect(JSON.stringify(rows.find(row => row.slug === 'custom:newapi')?.models)).toContain(id);
    }
  });

  it('Keeps the credential fields on a local connection', async () => {
    seedConnection('local');
    useHermesStore().useProvider('custom');
    wrapper = await mountSheet();

    expect(hasAuthField()).toBe(true);
    expect(sheetText()).not.toContain('panel host');
  });

  it('Shows an empty model field and the Base URL hint for an unconfigured custom provider', async () => {
    localStorage.setItem(
      'ONV_HERMES_STATE_V2',
      JSON.stringify({ model: { provider: 'custom', model: 'Custom model', endpoint: '' } })
    );
    wrapper = await mountSheet();

    const field = document.body.querySelector<HTMLInputElement>('#hermes-model');
    expect(field?.value).toBe('');
    expect(field?.placeholder).toBe(en.settings.model.modelPlaceholder);
    expect(sheetText()).toContain(en.settings.model.catalogEndpoint);
    expect(sheetText()).not.toContain('Custom model');
    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.common.save
    );
    expect(save?.disabled).toBe(true);
  });

  it('Keeps a hand-entered model while refreshing and retains cached choices on a failed read', async () => {
    vi.mocked(commands.hermesModelOptions).mockResolvedValue(ok(SAVED_CATALOG));
    const store = useHermesStore();
    store.saveModel({
      ...store.model,
      provider: 'custom',
      model: 'saved-model',
      endpoint: 'https://api.example.test/v1'
    });
    wrapper = await mountSheet();
    const refresh = () =>
      Array.from(document.body.querySelectorAll('button')).find(
        button => button.textContent?.trim() === en.settings.model.refreshModels
      );
    const field = document.body.querySelector<HTMLInputElement>('#hermes-model')!;
    field.value = 'private/model-id';
    field.dispatchEvent(new Event('input'));

    vi.mocked(commands.hermesModelOptions).mockResolvedValueOnce({
      status: 'error',
      error: { code: 'E_HERMES_MODEL_OPTIONS', message: 'Catalog offline', detail: null }
    });
    refresh()!.click();
    await vi.waitFor(() => expect(sheetText()).toContain(en.settings.model.catalogStale));
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${en.settings.model.openModelList}"]`)!.click();
    await vi.waitFor(() => expect(sheetText()).toContain('grok-default'));
    const search = document.body.querySelector<HTMLInputElement>('#hermes-model-options input')!;
    search.value = 'grok';
    search.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(document.body.querySelector('#hermes-model-options')?.textContent).not.toContain('saved-model')
    );
    expect(field.value).toBe('private/model-id');

    vi.mocked(commands.hermesModelOptions).mockResolvedValueOnce(ok(RESEARCH_CATALOG));
    refresh()!.click();
    await vi.waitFor(() => expect(sheetText()).toContain('grok-research'));
    expect(field.value).toBe('private/model-id');
    expect(sheetText()).not.toContain(en.settings.model.catalogStale);
    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.common.save
    );
    save!.click();
    expect(store.model.model).toBe('private/model-id');
  });

  it('Does not carry a key saved for another agent profile into the active one', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    const secretSet = vi.spyOn(commands, 'hermesSecretSet').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue(ok(true));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    // Give the profile being edited its own provider so the sheet keeps a key field after the
    // scope changes (a login-based provider would swap in the OAuth panel instead).
    store.setAgentProfileModel('research', {
      ...store.model,
      provider: 'custom',
      model: 'grok-4.7',
      endpoint: 'https://api.example.test/v1',
      keySet: false
    });
    store.useProvider('custom');
    wrapper = await mountSheet();

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    const key = document.body.querySelector<HTMLInputElement>('#hermes-key');
    expect(key).not.toBeNull();
    key!.value = 'sk-research-only';
    key!.dispatchEvent(new Event('input'));

    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Save'
    );
    expect(save).toBeDefined();
    save!.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Written to the profile the sheet was editing...
    expect(secretSet).toHaveBeenCalledWith('custom', 'sk-research-only', 'research');
    // ...and not kept in the store, where the active profile's next turn would copy it into
    // its own `.env` through `write_config`.
    expect(store.activeAgentProfileName).toBe('default');
    expect(store.apiKey).toBe('');
  });

  it('Drops the cached catalog for the profile whose API key was written', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    vi.spyOn(commands, 'hermesSecretSet').mockResolvedValue(ok(null));
    vi.spyOn(commands, 'hermesSecretStatus').mockResolvedValue(ok(true));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    store.setAgentProfileModel('research', {
      ...store.model,
      provider: 'custom',
      model: 'grok-4.7',
      endpoint: 'https://api.example.test/v1',
      keySet: false
    });
    store.useProvider('custom');
    wrapper = await mountSheet();

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(cacheKeysForProfile('local', 'research')).toHaveLength(1));

    const key = document.body.querySelector<HTMLInputElement>('#hermes-key');
    expect(key).not.toBeNull();
    key!.value = 'sk-research-only';
    key!.dispatchEvent(new Event('input'));

    const save = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Save'
    );
    expect(save).toBeDefined();
    save!.click();

    await vi.waitFor(() => expect(cacheKeysForProfile('local', 'research')).toHaveLength(0));
  });

  it('Does not align the model being edited from another profile catalog', async () => {
    seedConnection('panel');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    vi.mocked(commands.hermesModelOptions).mockImplementation(input =>
      Promise.resolve(ok(input.profile === 'research' ? RESEARCH_CATALOG : SAVED_CATALOG))
    );
    const store = useHermesStore();
    await store.loadAgentProfiles();
    store.useProvider('custom');
    store.saveModel({ ...store.model, provider: 'custom', model: 'saved-model' });
    store.setAgentProfileModel('research', { ...store.model, model: 'grok-research' });
    wrapper = await mountSheet();
    await vi.waitFor(() => expect(store.modelOptionsForScope('default', store.model)).not.toBeNull());
    expect(document.body.querySelector<HTMLInputElement>('#hermes-model')?.value).toBe('saved-model');

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(store.modelOptionsForScope('research', store.model)).not.toBeNull());
    expect(document.body.querySelector<HTMLInputElement>('#hermes-model')?.value).toBe('grok-research');

    await wrapper.setProps({ open: false });
    store.invalidateModelOptionsCache('default');
    expect(store.model.model).toBe('saved-model');
    vi.mocked(commands.hermesModelOptions).mockImplementation(input =>
      input.profile === 'research' ? Promise.resolve(ok(RESEARCH_CATALOG)) : Promise.reject(new Error('panel offline'))
    );
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(sheetText()).toContain('panel offline'));

    const model = document.body.querySelector<HTMLInputElement>('#hermes-model');
    expect(model?.value).toBe('saved-model');
  });

  it('Reads the diagnostics pane for the profile the sheet is editing', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    const cliRead = vi.spyOn(commands, 'hermesCliRead').mockResolvedValue(ok('mcp servers: none'));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));

    // MCP servers, skills, toolsets and cron jobs are per profile; reading them from the root
    // home listed the default profile's state while another profile was selected.
    await vi.waitFor(() => expect(cliRead).toHaveBeenCalledWith('tools', 'research', null, null));
  });

  it('Routes diagnostics to the Panel connection and names its profile explicitly', async () => {
    seedConnection('panel');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    const cliRead = vi.spyOn(commands, 'hermesCliRead').mockResolvedValue(ok('mcp servers: none'));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    // Selecting the profile (even the already-active one) is what re-reads the diagnostics pane.
    select!.value = 'default';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(cliRead).toHaveBeenCalledWith('tools', 'default', 'panel-1', 'http://panel.tail1234.ts.net:9119')
    );

    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));

    // A Panel profile belongs to that host: a remote name must never run the local CLI.
    await vi.waitFor(() =>
      expect(cliRead).toHaveBeenCalledWith('tools', 'research', 'panel-1', 'http://panel.tail1234.ts.net:9119')
    );
  });

  it('Repaints the model draft when the connection changes while the sheet is open', async () => {
    seedConnection('panel');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'model' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    const input = document.body.querySelector<HTMLInputElement>('#hermes-model');
    expect(input).not.toBeNull();
    input!.value = 'unsaved-panel-draft';
    input!.dispatchEvent(new Event('input'));
    expect(input!.value).toBe('unsaved-panel-draft');

    // A switch must repaint from the new connection's state, not keep saving the old draft.
    store.switchProfile('local');
    await vi.waitFor(() => expect(input!.value).not.toBe('unsaved-panel-draft'));
    expect(input!.value.length).toBeGreaterThan(0);
  });

  it('Ignores a diagnostics read that lands after the connection switch', async () => {
    seedConnection('panel');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    type CliReadResult = Awaited<ReturnType<typeof commands.hermesCliRead>>;
    let resolvePanel!: (value: CliReadResult) => void;
    const panelRead = new Promise<CliReadResult>(resolve => {
      resolvePanel = resolve;
    });
    let resolveLocal!: (value: CliReadResult) => void;
    const localRead = new Promise<CliReadResult>(resolve => {
      resolveLocal = resolve;
    });
    vi.spyOn(commands, 'hermesCliRead').mockImplementation((_kind, _profile, connectionId) =>
      connectionId === 'panel-1' ? panelRead : localRead
    );
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(commands.hermesCliRead).toHaveBeenCalledTimes(1));

    const cronInput = document.body.querySelector<HTMLInputElement>('input[placeholder="Cron job ID"]');
    expect(cronInput).not.toBeNull();
    cronInput!.value = 'job-from-panel';
    cronInput!.dispatchEvent(new Event('input'));

    store.switchProfile('local');
    await vi.waitFor(() => expect(commands.hermesCliRead).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cronInput!.value).toBe(''));

    resolveLocal(ok('local output'));
    await vi.waitFor(() => expect(sheetText()).toContain('local output'));

    // The panel read was already in flight when the connection changed; it must not paint.
    resolvePanel(ok('panel output'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sheetText()).not.toContain('panel output');
    expect(sheetText()).toContain('local output');
  });

  it('Stops the diagnostics spinner when an MCP list supersedes a pending read', async () => {
    seedConnection('panel');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    type CliReadResult = Awaited<ReturnType<typeof commands.hermesCliRead>>;
    let resolveTools!: (value: CliReadResult) => void;
    const toolsRead = new Promise<CliReadResult>(resolve => {
      resolveTools = resolve;
    });
    vi.spyOn(commands, 'hermesCliRead').mockReturnValue(toolsRead);
    const mcpList = vi.spyOn(commands, 'hermesMcpAction').mockResolvedValue(ok('mcp servers: none'));
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    // Start a tools read and leave it pending: the pane is on "Loading…".
    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(commands.hermesCliRead).toHaveBeenCalledTimes(1));
    expect(document.body.querySelector('pre')?.textContent).toContain(en.common.loading);

    // The MCP list supersedes it. Its own success must also stop the spinner; otherwise the
    // pane would keep "Loading…" forever because the pending read's finally is now stale.
    const listButton = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.settings.diagnostics.mcpList
    );
    expect(listButton).not.toBeUndefined();
    listButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(mcpList).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.body.querySelector('pre')?.textContent).toContain('mcp servers: none'));

    // The tools read lands afterwards; it is stale and must not replace the MCP list.
    resolveTools(ok('tools output'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.body.querySelector('pre')?.textContent).toContain('mcp servers: none');
  });

  it('Stops the diagnostics spinner when a cron action fails', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    type CliReadResult = Awaited<ReturnType<typeof commands.hermesCliRead>>;
    let resolveTools!: (value: CliReadResult) => void;
    const toolsRead = new Promise<CliReadResult>(resolve => {
      resolveTools = resolve;
    });
    vi.spyOn(commands, 'hermesCliRead').mockReturnValue(toolsRead);
    vi.spyOn(commands, 'hermesCronAction').mockResolvedValue({
      status: 'error',
      error: { code: 'E_HERMES_RUNTIME', message: 'Hermes cron action failed.', detail: 'cron stopped: boom' }
    });
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    // Start a tools read and leave it pending: the pane is on "Loading…".
    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(commands.hermesCliRead).toHaveBeenCalledTimes(1));
    expect(document.body.querySelector('pre')?.textContent).toContain(en.common.loading);

    // The action supersedes that read. Its failure must clear the spinner it orphaned and
    // leave the runtime's own reason in the pane.
    const cronInput = document.body.querySelector<HTMLInputElement>('input[placeholder="Cron job ID"]');
    expect(cronInput).not.toBeNull();
    cronInput!.value = 'job-from-failure';
    cronInput!.dispatchEvent(new Event('input'));
    // Let the disabled binding re-render now that the id is non-empty.
    await new Promise(resolve => setTimeout(resolve, 0));
    const pause = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.settings.diagnostics.pause
    );
    expect(pause).not.toBeUndefined();
    pause!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(document.body.querySelector('pre')?.textContent).toContain('cron stopped: boom'));
    expect(document.body.querySelector('pre')?.textContent).not.toContain(en.common.loading);

    // The superseded tools read still must not paint over the error.
    resolveTools(ok('tools output'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.body.querySelector('pre')?.textContent).toContain('cron stopped: boom');
  });

  it('Drops a cron action that succeeds after the profile and kind switched', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    const cliRead = vi
      .spyOn(commands, 'hermesCliRead')
      .mockImplementation((kind, profile) => Promise.resolve(ok(`${kind}:${profile ?? 'default'}`)));
    type CronResult = Awaited<ReturnType<typeof commands.hermesCronAction>>;
    let resolveCron!: (value: CronResult) => void;
    const cron = new Promise<CronResult>(resolve => {
      resolveCron = resolve;
    });
    const cronAction = vi.spyOn(commands, 'hermesCronAction').mockReturnValue(cron);
    const store = useHermesStore();
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'tools' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesModelOptions).toHaveBeenCalled());

    const pane = () => document.body.querySelector('pre')?.textContent ?? '';
    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(pane()).toContain('tools:research'));

    // Start a cron action and leave it pending.
    const cronInput = document.body.querySelector<HTMLInputElement>(
      `input[placeholder="${en.settings.diagnostics.cronJobId}"]`
    );
    expect(cronInput).not.toBeNull();
    cronInput!.value = 'job-after-switch';
    cronInput!.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const pause = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.settings.diagnostics.pause
    );
    expect(pause).not.toBeUndefined();
    pause!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(cronAction).toHaveBeenCalledTimes(1));

    // The user picks another diagnostic kind, then another profile. Both start their own
    // reads and invalidate the cron action's sequence.
    const skills = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === en.settings.diagnostics.skills
    );
    expect(skills).not.toBeUndefined();
    skills!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(pane()).toContain('skills:research'));

    select!.value = 'default';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(pane()).toContain('skills:default'));

    // The action succeeds only now. Reloading `cron` here would flip the selected kind and
    // paint the old action's list over the new profile's pane.
    resolveCron(ok('paused'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(cliRead.mock.calls.map(([kind]) => kind)).not.toContain('cron');
    expect(pane()).toContain('skills:default');
  });

  it('Drops a key status that lands after the profile switched', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(ok(AGENT_PROFILES));
    type SecretStatusResult = Awaited<ReturnType<typeof commands.hermesSecretStatus>>;
    let resolveDefault!: (value: SecretStatusResult) => void;
    const defaultStatus = new Promise<SecretStatusResult>(resolve => {
      resolveDefault = resolve;
    });
    let resolveResearch!: (value: SecretStatusResult) => void;
    const researchStatus = new Promise<SecretStatusResult>(resolve => {
      resolveResearch = resolve;
    });
    vi.spyOn(commands, 'hermesSecretStatus').mockImplementation((_provider, profile) =>
      profile === 'research' ? researchStatus : defaultStatus
    );
    const store = useHermesStore();
    // Both profiles use an API-key provider, so both reads go through hermesSecretStatus.
    store.saveModel({ ...store.model, provider: 'openai', model: 'gpt-5.6' });
    store.setAgentProfileModel('research', { ...store.model, provider: 'openai', model: 'gpt-5.6' });
    await store.loadAgentProfiles();
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'model' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });
    await vi.waitFor(() => expect(commands.hermesSecretStatus).toHaveBeenCalledTimes(1));

    const select = profileScopeSelect();
    expect(select).not.toBeNull();
    select!.value = 'research';
    select!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(commands.hermesSecretStatus).toHaveBeenCalledTimes(2));

    resolveResearch(ok(false));
    await new Promise(resolve => setTimeout(resolve, 0));
    const keyInput = document.body.querySelector<HTMLInputElement>('#hermes-auth');
    expect(keyInput).not.toBeNull();
    expect(keyInput!.placeholder).toBe('sk-…');

    // The default profile's reply is stale: it must not mark the research draft as keyed.
    resolveDefault(ok(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(keyInput!.placeholder).toBe('sk-…');
  });

  it('Keeps the newest login status when an older read lands last', async () => {
    type LoginStatusResult = Awaited<ReturnType<typeof commands.hermesLoginStatus>>;
    let resolveDefault!: (value: LoginStatusResult) => void;
    const defaultStatus = new Promise<LoginStatusResult>(resolve => {
      resolveDefault = resolve;
    });
    let resolveResearch!: (value: LoginStatusResult) => void;
    const researchStatus = new Promise<LoginStatusResult>(resolve => {
      resolveResearch = resolve;
    });
    vi.spyOn(commands, 'hermesLoginStatus').mockImplementation(profile =>
      profile === 'research' ? researchStatus : defaultStatus
    );
    const store = useHermesStore();
    const status = (nous: boolean) => ({
      codex: false,
      claudeCode: false,
      copilot: false,
      opencode: false,
      opencodeGo: false,
      nous,
      codexSource: null,
      claudeCodeSource: null,
      copilotSource: null,
      opencodeSource: null,
      opencodeGoSource: null,
      nousSource: null
    });

    const defaultRead = store.loadLoginStatus('default');
    const researchRead = store.loadLoginStatus('research');
    resolveResearch(ok(status(true)));
    await researchRead;
    expect(store.loginStatus?.nous).toBe(true);

    resolveDefault(ok(status(false)));
    await defaultRead;
    expect(store.loginStatus?.nous).toBe(true);
  });

  it('Shows the shared loading ring while updating the local runtime', async () => {
    seedConnection('local');
    vi.spyOn(commands, 'hermesRuntimeStatus').mockResolvedValue(
      ok({
        ready: true,
        installed: true,
        version: '0.23.0',
        expectedVersion: '0.23.3',
        path: '/tmp/hermes',
        dataPath: '/tmp',
        computerUse: false,
        outdated: true,
        message: null
      })
    );
    let finishInstall!: () => void;
    const install = new Promise<Awaited<ReturnType<typeof commands.hermesRuntimeInstall>>>(resolve => {
      finishInstall = () =>
        resolve(
          ok({
            ready: true,
            installed: true,
            version: '0.23.3',
            expectedVersion: '0.23.3',
            path: '/tmp/hermes',
            dataPath: '/tmp',
            computerUse: false,
            outdated: false,
            message: null
          })
        );
    });
    vi.spyOn(commands, 'hermesRuntimeInstall').mockReturnValue(install);
    wrapper = mount(HermesSettings, {
      props: { open: false, tab: 'mac' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    });
    await wrapper.setProps({ open: true });

    await vi.waitFor(() => expect(sheetText()).toContain('Update local Hermes'));
    const update = Array.from(document.body.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Update local Hermes'
    );
    expect(update).toBeDefined();
    update!.click();

    await vi.waitFor(() =>
      expect(document.body.querySelector('button[aria-busy="true"]')?.textContent).toContain('Update local Hermes')
    );
    const busy = document.body.querySelector('button[aria-busy="true"]');
    expect(busy?.hasAttribute('disabled')).toBe(true);
    expect(busy?.querySelector('.on-spinner')).not.toBeNull();

    finishInstall();
  });
});
