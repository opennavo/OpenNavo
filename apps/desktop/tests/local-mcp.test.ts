import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LocalMcpSettings from '@/components/settings/LocalMcpSettings.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { useToasts } from '@/composables/useToasts';
import {
  MCP_COPIED_PATHS_KEY,
  MCP_COPIED_PATH_KEY,
  copiedMcpPaths,
  mcpAppMoved,
  mcpConfig,
  mcpMovedClients,
  normalizeMcpPath
} from '@/utils/mcpConfig';
import { setup } from './helpers';

const APP = '/Applications/OpenNavo.app/Contents/MacOS/opennavo-desktop';
const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  useToasts().clear();
  localStorage.removeItem(MCP_COPIED_PATH_KEY);
  localStorage.removeItem(MCP_COPIED_PATHS_KEY);
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

async function page(mock = '') {
  window.history.replaceState(null, '', mock ? `/?mock=${mock}` : '/');
  const { pinia, router } = await setup('/settings/mcp');
  const wrapper = mount(LocalMcpSettings, { global: { plugins: [pinia, router, i18n] } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
const checked = (wrapper: VueWrapper, test: string) =>
  wrapper.get(`[data-test="${test}"]`).attributes('aria-checked') === 'true';

describe('Local MCP config presets', () => {
  it('Launches the absolute app binary with the mcp subcommand in every preset', () => {
    expect(JSON.parse(mcpConfig('claude', APP))).toEqual({
      mcpServers: { opennavo: { command: APP, args: ['mcp'] } }
    });
    expect(JSON.parse(mcpConfig('cursor', APP))).toEqual({
      mcpServers: { opennavo: { command: APP, args: ['mcp'] } }
    });
    expect(JSON.parse(mcpConfig('generic', APP))).toEqual({ command: APP, args: ['mcp'] });
    expect(mcpConfig('codex', APP)).toBe(`[mcp_servers.opennavo]\ncommand = "${APP}"\nargs = ["mcp"]\n`);
  });

  it('Escapes TOML strings', () => {
    expect(mcpConfig('codex', '/Users/a "b"\\c/x')).toContain('command = "/Users/a \\"b\\"\\\\c/x"');
  });

  it('Detects a moved app only after a configuration was copied', () => {
    expect(mcpAppMoved(APP, null)).toBe(false);
    expect(mcpAppMoved(APP, APP)).toBe(false);
    expect(mcpAppMoved(APP, '/Users/me/Downloads/OpenNavo.app/Contents/MacOS/opennavo-desktop')).toBe(true);
    expect(mcpAppMoved(null, APP)).toBe(false);
  });

  it('Ignores case, trailing and repeated slashes when comparing paths', () => {
    expect(normalizeMcpPath('/Applications//OpenNavo.app/')).toBe('/applications/opennavo.app');
    expect(mcpAppMoved(APP, APP.toUpperCase())).toBe(false);
    expect(mcpAppMoved(APP, `${APP}/`)).toBe(false);
    expect(mcpAppMoved(APP, APP.replace('/Contents/', '//Contents/'))).toBe(false);
    // NFC and NFD spellings of the same folder name are one path.
    expect(mcpAppMoved('/Users/me/Caf\u00e9/x', '/Users/me/Cafe\u0301/x')).toBe(false);
  });

  it('Tracks the copied path per client, reading the old single-slot key as every client', () => {
    const OLD = '/Users/me/Downloads/OpenNavo.app/Contents/MacOS/opennavo-desktop';
    localStorage.setItem(MCP_COPIED_PATH_KEY, OLD);
    expect(mcpMovedClients(APP)).toEqual(['claude', 'cursor', 'codex', 'generic']);
    localStorage.setItem(MCP_COPIED_PATHS_KEY, JSON.stringify({ claude: OLD, cursor: APP, codex: 7 }));
    expect(copiedMcpPaths()).toEqual({ claude: OLD, cursor: APP });
    expect(mcpMovedClients(APP)).toEqual(['claude']);
    localStorage.setItem(MCP_COPIED_PATHS_KEY, '{not json');
    expect(mcpMovedClients(APP)).toEqual([]);
  });
});

describe('Settings: Local MCP switches', () => {
  it('Is off by default with writes unavailable', async () => {
    const wrapper = await page();
    expect(checked(wrapper, 'mcp-enabled')).toBe(false);
    expect(checked(wrapper, 'mcp-write')).toBe(false);
    expect(wrapper.get('[data-test="mcp-write"]').attributes('disabled')).toBeDefined();
  });

  it('Shows the state the backend reports, never an optimistic one', async () => {
    const wrapper = await page();
    let finish!: () => void;
    const real = commands.mcpSetEnabled;
    vi.spyOn(commands, 'mcpSetEnabled').mockImplementationOnce(async enabled => {
      await new Promise<void>(resolve => (finish = resolve));
      return real(enabled);
    });
    await wrapper.get('[data-test="mcp-enabled"]').trigger('click');
    await flushPromises();
    expect(checked(wrapper, 'mcp-enabled')).toBe(false);
    finish();
    await flushPromises();
    expect(checked(wrapper, 'mcp-enabled')).toBe(true);
    await wrapper.get('[data-test="mcp-write"]').trigger('click');
    await flushPromises();
    expect(checked(wrapper, 'mcp-write')).toBe(true);
    // Turning Local MCP off also turns writes off.
    await wrapper.get('[data-test="mcp-enabled"]').trigger('click');
    await flushPromises();
    expect(checked(wrapper, 'mcp-enabled')).toBe(false);
    expect(checked(wrapper, 'mcp-write')).toBe(false);
  });

  it('Says Local MCP is still on when turning it off fails', async () => {
    const wrapper = await page('mcp-write-on,mcp-off-fails');
    await wrapper.get('[data-test="mcp-enabled"]').trigger('click');
    await flushPromises();
    expect(checked(wrapper, 'mcp-enabled')).toBe(true);
    expect(wrapper.find('[data-test="mcp-still-on"]').text()).toBe(i18n.global.t('settings.mcp.stillOn'));
    const alert = wrapper.get('[data-test="mcp-failure"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain(i18n.global.t('settings.mcp.offFailed'));
    expect(alert.text()).toContain('E_MCP_BROKER');
    expect((await commands.mcpStatus()).enabled).toBe(true);
  });

  it('Says writes are still allowed when turning them off fails', async () => {
    const wrapper = await page('mcp-write-on,mcp-off-fails');
    await wrapper.get('[data-test="mcp-write"]').trigger('click');
    await flushPromises();
    expect(checked(wrapper, 'mcp-write')).toBe(true);
    expect(wrapper.find('[data-test="mcp-write-still-on"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="mcp-failure"]').text()).toContain(i18n.global.t('settings.mcp.writeOffFailed'));
  });
});

describe('Settings: Local MCP errors', () => {
  const stopped = { enabled: true, writeEnabled: false, running: false, socketPath: null, error: 'E_MCP_BROKER: bind failed', commandPath: APP };

  it('Shows a startup error and that Local MCP is not running, with writes unavailable', async () => {
    vi.spyOn(commands, 'mcpStatus').mockResolvedValue(stopped);
    const wrapper = await page();
    const alert = wrapper.get('[data-test="mcp-failure"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(wrapper.get('[data-test="mcp-not-running"]').text()).toBe(i18n.global.t('settings.mcp.notRunning'));
    expect(wrapper.get('[data-test="mcp-error"]').text()).toBe('E_MCP_BROKER: bind failed');
    expect(checked(wrapper, 'mcp-enabled')).toBe(true);
    expect(wrapper.get('[data-test="mcp-write"]').attributes('disabled')).toBeDefined();
  });

  it('Still lets writes be turned off while Local MCP is not running', async () => {
    vi.spyOn(commands, 'mcpStatus').mockResolvedValue({ ...stopped, writeEnabled: true });
    const wrapper = await page();
    expect(wrapper.get('[data-test="mcp-write"]').attributes('disabled')).toBeUndefined();
  });

  it('Shows no alert while Local MCP runs normally', async () => {
    const wrapper = await page('mcp-on');
    expect(wrapper.find('[data-test="mcp-failure"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="mcp-write"]').attributes('disabled')).toBeUndefined();
  });

  it('Offers a retry when the first status read fails', async () => {
    const status = vi.spyOn(commands, 'mcpStatus').mockRejectedValueOnce(new Error('ipc down'));
    const wrapper = await page();
    expect(wrapper.get('[data-test="mcp-load-failed"]').text()).toContain(i18n.global.t('settings.mcp.statusFailed'));
    expect(wrapper.find('[data-test="mcp-enabled"]').exists()).toBe(false);
    await wrapper.get('[data-test="mcp-load-retry"]').trigger('click');
    await flushPromises();
    expect(status).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-test="mcp-load-failed"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="mcp-enabled"]').exists()).toBe(true);
  });
});

describe('Settings: Local MCP configuration', () => {
  it('Copies the selected preset and warns once the app has moved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = await page();
    expect(wrapper.find('[data-test="mcp-moved"]').exists()).toBe(false);
    await wrapper.get('[data-test="mcp-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(mcpConfig('claude', APP));
    expect(JSON.parse(localStorage.getItem(MCP_COPIED_PATHS_KEY) ?? '{}')).toEqual({ claude: APP });
    wrapper.unmount();
    wrappers.pop();

    const OLD = '/Users/me/Downloads/OpenNavo.app/Contents/MacOS/opennavo-desktop';
    localStorage.setItem(MCP_COPIED_PATHS_KEY, JSON.stringify({ claude: OLD, cursor: OLD }));
    const moved = await page();
    expect(moved.get('[data-test="mcp-moved"]').text()).toContain(i18n.global.t('settings.mcp.moved'));
    const label = (client: string) => i18n.global.t(`settings.mcp.clients.${client}`);
    expect(moved.get('[data-test="mcp-moved-clients"]').text()).toContain(`${label('claude')}, ${label('cursor')}`);
    // Re-copying only Cursor leaves Claude Desktop flagged.
    const cursor = moved.findAll('button').find(button => button.text() === label('cursor'));
    await cursor!.trigger('click');
    await moved.get('[data-test="mcp-copy"]').trigger('click');
    await flushPromises();
    expect(moved.get('[data-test="mcp-moved-clients"]').text()).toBe(
      i18n.global.t('settings.mcp.movedClients', { clients: label('claude') })
    );
  });

  it('Re-checks the copied paths when the window regains focus', async () => {
    const wrapper = await page();
    expect(wrapper.find('[data-test="mcp-moved"]').exists()).toBe(false);
    localStorage.setItem(MCP_COPIED_PATHS_KEY, JSON.stringify({ codex: '/Volumes/Old/OpenNavo.app/Contents/MacOS/opennavo-desktop' }));
    const status = vi.spyOn(commands, 'mcpStatus');
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(status).toHaveBeenCalled();
    expect(wrapper.get('[data-test="mcp-moved-clients"]').text()).toContain(i18n.global.t('settings.mcp.clients.codex'));
  });
});
