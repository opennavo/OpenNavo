import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
import { useHermesStore } from '@/stores/hermes';
import HermesProfileSection from '@/components/hermes/HermesProfileSection.vue';
import { i18n } from '@/i18n';

function ok<T>(data: T) {
  return { status: 'ok' as const, data };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  vi.spyOn(commands, 'hermesAgentProfiles').mockResolvedValue(
    ok([
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
    ])
  );
  vi.spyOn(commands, 'hermesHistoryLoad').mockResolvedValue(ok(null));
  vi.spyOn(commands, 'hermesModelOptions').mockResolvedValue(ok({ providers: [], model: null, provider: null }));
});

describe('Hermes profile rail', () => {
  it('lists profiles by name in the rail and switches the active one', async () => {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const wrapper = mount(HermesProfileSection, { global: { plugins: [i18n] } });

    expect(wrapper.text()).toContain('Profiles');
    // Names are readable now, not two-letter chips behind a tooltip.
    expect(wrapper.text()).toContain('Research');
    expect(wrapper.text()).toContain('default');

    const rows = wrapper.findAll('button');
    const research = rows.find(row => row.text().includes('Research'));
    expect(research).toBeTruthy();
    await research!.trigger('click');
    expect(store.activeAgentProfileName).toBe('research');
  });

  it('marks the active profile and reports the profile count', async () => {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const wrapper = mount(HermesProfileSection, { global: { plugins: [i18n] } });

    const rows = wrapper.findAll('button');
    const active = rows.find(row => row.attributes('aria-pressed') === 'true');
    expect(active?.text()).toContain('default');
    expect(wrapper.text()).toContain('2 profiles');
  });
});

describe('Hermes profile section states', () => {
  it('Clears the loading flag once the list resolves', async () => {
    const store = useHermesStore();
    expect(store.agentProfilesLoading).toBe(false);

    const pending = store.loadAgentProfiles();
    expect(store.agentProfilesLoading).toBe(true);
    await pending;

    expect(store.agentProfilesLoading).toBe(false);
    expect(store.agentProfiles.length).toBeGreaterThan(0);
  });

  it('Renders each row as sibling buttons, not nested interactive elements', async () => {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const wrapper = mount(HermesProfileSection, { global: { plugins: [i18n] } });

    // A `⋯` inside the row button is invalid HTML and unreachable by keyboard.
    expect(wrapper.findAll('button button')).toHaveLength(0);
    expect(wrapper.findAll('[role="button"]')).toHaveLength(0);
    const actions = wrapper
      .findAll('button[aria-label]')
      .filter(node => (node.attributes('aria-label') ?? '').toLowerCase().includes('profile'));
    expect(actions.length).toBeGreaterThan(0);
  });
});

describe('Hermes profile section menu', () => {
  async function openMenuFor(label: string) {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const wrapper = mount(HermesProfileSection, { global: { plugins: [i18n] }, attachTo: document.body });
    const row = wrapper.findAll('div.group\\/row').find(node => node.text().includes(label));
    const actions = row!.findAll('button').at(-1)!;
    await actions.trigger('click');
    await new Promise(resolve => setTimeout(resolve, 0));
    return { wrapper, menu: document.body.querySelector('.shadow-modal') as HTMLElement | null };
  }

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('Explains that the default profile cannot be deleted', async () => {
    const { wrapper } = await openMenuFor('default');
    const text = document.body.textContent ?? '';
    expect(text).toContain('default');
    expect(text.toLowerCase()).toContain('cannot be deleted');
    // No delete action is offered for it.
    expect(wrapper.findAll('button').some(node => node.text().toLowerCase().includes('delete'))).toBe(false);
  });

  it('Flips the menu above a row that sits near the bottom edge', async () => {
    // jsdom reports zeroed rects; pretend the row is the last thing on screen.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 900,
      bottom: 926,
      left: 0,
      right: 200,
      width: 200,
      height: 26,
      toJSON: () => ({})
    } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { value: 940, configurable: true });
    // jsdom has no layout: give the menu its real height so the flip decision is meaningful.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 260 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 220 });

    const { menu } = await openMenuFor('Research');
    expect(menu).toBeTruthy();
    const top = Number.parseFloat(menu!.style.top);
    // It must sit entirely above the row (top edge 900), not merely be clamped to fit.
    expect(top + 260).toBeLessThanOrEqual(900);
  });
});

describe('Hermes profile switching feedback', () => {
  it('Exposes the profile being activated and clears it afterwards', async () => {
    const store = useHermesStore();
    await store.loadAgentProfiles();
    const other = store.agentProfiles.find(profile => profile.name !== store.activeAgentProfileName);

    const switching = store.switchAgentProfile(other?.name ?? 'default');
    expect(store.profileSwitchingTo).toBe(other?.name);
    await switching;
    expect(store.profileSwitchingTo).toBeNull();
  });
});
