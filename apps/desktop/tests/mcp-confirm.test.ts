import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import McpConfirmPage from '@/pages/McpConfirmPage.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { setup } from './helpers';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function page(mock: string) {
  window.history.replaceState(null, '', `/?mock=${mock}`);
  const { pinia, router } = await setup('/mcp-confirm');
  const wrapper = mount(McpConfirmPage, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe('Local MCP confirmation window', () => {
  it('Shows the request as plain text with the caller lines and the footer', async () => {
    const wrapper = await page('mcp-confirm-uninstall');
    const text = wrapper.text();
    expect(text).toContain('Rectangle');
    expect(text).toContain('/Applications/Rectangle.app');
    expect(wrapper.get('[data-test="mcp-confirm-caller"]').text()).toContain('Developer ID Application: Anthropic PBC');
    expect(wrapper.get('[data-test="mcp-confirm-origin"]').text()).toBe('Claude（未验证）');
    expect(wrapper.get('[data-test="mcp-confirm-claims"]').text()).toBe('claude-ai');
    expect(wrapper.get('[data-test="mcp-confirm-footer"]').text()).toBe(
      '只有你点了「允许」才会执行。每个请求单独确认。'
    );
  });

  it('Shows an unsigned caller by path', async () => {
    const wrapper = await page('mcp-confirm-install');
    expect(wrapper.get('[data-test="mcp-confirm-caller"]').text()).toBe('未签名 · /opt/homebrew/bin/node');
  });

  it('Defaults to Deny: focus, Return and Escape all deny; Allow waits', async () => {
    const answer = vi.spyOn(commands, 'mcpConfirmAnswer');
    const wrapper = await page('mcp-confirm-install');
    expect(document.activeElement).toBe(wrapper.get('[data-test="mcp-confirm-deny"]').element);
    expect(wrapper.get('[data-test="mcp-confirm-allow"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-test="mcp-confirm-allow"]').trigger('click');
    expect(answer).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(answer).toHaveBeenCalledWith('confirm-1', false);
    expect(answer.mock.calls.every(([, allow]) => allow === false)).toBe(true);
  });

  it('Allows only by a click after the delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answer = vi.spyOn(commands, 'mcpConfirmAnswer');
    const wrapper = await page('mcp-confirm-install');
    await vi.advanceTimersByTimeAsync(1100);
    await wrapper.get('[data-test="mcp-confirm-allow"]').trigger('click');
    await flushPromises();
    expect(answer).toHaveBeenCalledWith('confirm-1', true);
  });

  it('Renders nothing from HTML and loads no remote content', () => {
    const source = readFileSync('src/pages/McpConfirmPage.vue', 'utf8');
    expect(source).not.toMatch(/v-html|innerHTML|<a\s|<iframe|<img\s|https?:\/\//);
  });
});
