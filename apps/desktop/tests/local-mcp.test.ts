import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LocalMcpSettings from '@/components/settings/LocalMcpSettings.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { useToasts } from '@/composables/useToasts';
import { MCP_COPIED_PATH_KEY, mcpAppMoved, mcpConfig } from '@/utils/mcpConfig';
import { setup } from './helpers';

const APP = '/Applications/OpenNavo.app/Contents/MacOS/opennavo-desktop';
const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  useToasts().clear();
  localStorage.removeItem(MCP_COPIED_PATH_KEY);
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

describe('Settings: Local MCP configuration', () => {
  it('Copies the selected preset and warns once the app has moved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = await page();
    expect(wrapper.find('[data-test="mcp-moved"]').exists()).toBe(false);
    await wrapper.get('[data-test="mcp-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(mcpConfig('claude', APP));
    expect(localStorage.getItem(MCP_COPIED_PATH_KEY)).toBe(APP);
    wrapper.unmount();
    wrappers.pop();

    localStorage.setItem(MCP_COPIED_PATH_KEY, '/Users/me/Downloads/OpenNavo.app/Contents/MacOS/opennavo-desktop');
    const moved = await page();
    expect(moved.get('[data-test="mcp-moved"]').text()).toBe(i18n.global.t('settings.mcp.moved'));
  });
});

describe('Settings: Local MCP write request log', () => {
  const body = (test: string) => document.body.querySelectorAll(`[data-test="${test}"]`);

  it('Lists entries newest first with the caller lines but never the pid', async () => {
    const wrapper = await page('mcp-write-on');
    await wrapper.get('[data-test="mcp-audit-view"]').trigger('click');
    await flushPromises();
    const entries = [...body('mcp-audit-entry')].map(node => node.textContent ?? '');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('/Applications/Rectangle.app');
    expect(entries[0]).toContain('Developer ID Application: Anthropic PBC');
    expect(entries[0]).toContain('可能来自：Claude（未验证）');
    expect(entries[0]).toContain('自称：claude-ai');
    expect(entries[1]).toContain('未签名 · /opt/homebrew/bin/node');
    expect(entries.join(' ')).not.toContain('4182');
  });

  it('Shows the empty state', async () => {
    const wrapper = await page('mcp-on');
    await wrapper.get('[data-test="mcp-audit-view"]').trigger('click');
    await flushPromises();
    expect(body('mcp-audit-empty')).toHaveLength(1);
  });

  it('Clears only after confirmation', async () => {
    const wrapper = await page('mcp-write-on');
    const clear = vi.spyOn(commands, 'mcpAuditClear');
    await wrapper.get('[data-test="mcp-audit-clear"]').trigger('click');
    await flushPromises();
    expect(clear).not.toHaveBeenCalled();
    (document.body.querySelector('[data-on-confirm]') as HTMLElement).click();
    await flushPromises();
    expect(clear).toHaveBeenCalledTimes(1);
    const listed = await commands.mcpAuditList();
    expect(listed.status === 'ok' && listed.data).toEqual([]);
  });

  it('Reports a failed read', async () => {
    const wrapper = await page('mcp-write-on');
    vi.spyOn(commands, 'mcpAuditList').mockResolvedValueOnce({
      status: 'error',
      error: { code: 'E_AUDIT_UNAVAILABLE', message: 'x', detail: null }
    });
    await wrapper.get('[data-test="mcp-audit-view"]').trigger('click');
    await flushPromises();
    expect(body('mcp-audit-failed')).toHaveLength(1);
  });
});
