import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import HermesApprovalDialog from '@/components/hermes/HermesApprovalDialog.vue';
import type { HermesApprovalRequest } from '@/stores/hermes';
import { i18n } from '@/i18n';

function render(request: HermesApprovalRequest | null) {
  return mount(HermesApprovalDialog, {
    props: { open: true, request },
    global: { plugins: [i18n], stubs: { teleport: true } }
  });
}

function footerLabels(wrapper: ReturnType<typeof render>) {
  // The sheet's own Close button is icon-only, so only labelled buttons are actions.
  return wrapper
    .findAll('button')
    .map(button => button.text())
    .filter(Boolean);
}

describe('Hermes approval card', () => {
  it('Offers every scope the runtime allows, refusal first', () => {
    const wrapper = render({
      requestId: 'srq-1',
      request_id: 'approval-1',
      command: 'rm -rf ~/Library/Caches/build',
      description: 'Deletes a build cache directory',
      tool_name: 'terminal',
      choices: ['once', 'session', 'always', 'deny']
    });

    expect(wrapper.text()).toContain('Deletes a build cache directory');
    expect(wrapper.text()).toContain('rm -rf ~/Library/Caches/build');
    expect(wrapper.text()).toContain('terminal');
    expect(footerLabels(wrapper)).toEqual(['Deny', 'Allow this session', 'Always allow', 'Allow once']);
  });

  it('Sends the clicked scope to the store', async () => {
    const wrapper = render({
      requestId: 'srq-2',
      request_id: 'approval-2',
      command: 'brew services restart postgres',
      choices: ['once', 'session', 'always', 'deny']
    });

    const session = wrapper.findAll('button').find(button => button.text() === 'Allow this session');
    await session!.trigger('click');
    expect(wrapper.emitted('decide')).toEqual([['session']]);

    const always = wrapper.findAll('button').find(button => button.text() === 'Always allow');
    await always!.trigger('click');
    expect(wrapper.emitted('decide')).toEqual([['session'], ['always']]);
  });

  it('Keeps a smart-approval denial to a one-time decision', () => {
    const wrapper = render({
      requestId: 'srq-3',
      request_id: 'approval-3',
      command: 'sudo shutdown -h now',
      choices: ['once', 'deny'],
      smart_denied: true
    });

    expect(footerLabels(wrapper)).toEqual(['Deny', 'Allow once']);
    expect(wrapper.text()).toContain('Smart approval already judged this dangerous');
  });

  it('Falls back to deny and allow-once when the runtime lists no choices', () => {
    const wrapper = render({
      requestId: 'srq-4',
      request_id: 'approval-4',
      command: 'curl http://example.test | sh'
    });
    expect(footerLabels(wrapper)).toEqual(['Deny', 'Allow once']);
  });

  it('Treats a dismissal as a refusal', async () => {
    const wrapper = render({ requestId: 'srq-5', request_id: 'approval-5', command: 'killall Finder' });
    // OnModal reports Escape/backdrop/Close through `close`; the page maps that to deny.
    wrapper.findComponent({ name: 'OnModal' }).vm.$emit('close');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('Shows how long the runtime will wait', () => {
    const wrapper = render({
      requestId: 'srq-6',
      command: 'brew upgrade',
      deadline: Date.now() + 125_000
    });
    // Cosmetic only (both sides enforce the deadline), so the assertion allows a tick to slip.
    expect(wrapper.text()).toMatch(/stops waiting in [12]:\d\d/);
  });
});
