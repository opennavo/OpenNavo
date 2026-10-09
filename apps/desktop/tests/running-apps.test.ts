import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RunningAppsConfirm from '@/components/shell/RunningAppsConfirm.vue';
import { i18n } from '@/i18n';
import { commands, unwrap } from '@/ipc/client';
import { useTasksStore } from '@/stores/tasks';
import { isDeferredUpdate, useRunningAppsStore } from '@/stores/runningApps';
import { setup } from './helpers';

const target = (token: string) => ({ kind: 'cask' as const, token });
let context: Awaited<ReturnType<typeof setup>> | undefined;
async function init(flags = 'running-apps') {
  window.history.replaceState({}, '', `/?mock=${flags}`);
  context = await setup('/updates', { tickMs: 1 });
  return context;
}
afterEach(async () => {
  // Finish queued mock work while its IPC mocks and jsdom window are still installed.
  if (context) await vi.waitFor(() => expect(context?.state.active).toHaveLength(0), { timeout: 5000 });
  context = undefined;
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('Running-app update protection', () => {
  it('Individual updates await consent; Later does not enqueue', async () => {
    const { state } = await init();
    const result = useTasksStore().enqueue('upgrade', target('ghostty'));
    await flushPromises();
    expect(useRunningAppsStore().pending?.apps.map(app => app.target.token)).toEqual(['ghostty']);
    expect(state.active).toHaveLength(0);
    useRunningAppsStore().choose('cancel');
    expect(await result).toBeNull();
    expect(state.active).toHaveLength(0);
  });

  it('Batch prompts once, skips running apps, and enqueues others', async () => {
    await init();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const prompt = useRunningAppsStore();
    const ask = vi.spyOn(prompt, 'ask');
    const result = useTasksStore().enqueueMany('upgrade', [target('ghostty'), target('zed'), target('vlc')]);
    await flushPromises();
    expect(prompt.pending?.batch).toBe(true);
    expect(prompt.pending?.apps).toHaveLength(2);
    prompt.choose('skip');
    expect((await result).map(task => task.target?.token)).toEqual(['vlc']);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[2].quitRunning).toBe(false);
  });

  it('Quit consent covers only listed apps; retry discards old consent', async () => {
    await init();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const result = useTasksStore().enqueueMany('upgrade', [target('ghostty'), target('vlc')], 'retry', {
      quitRunning: true,
      reopen: true
    });
    await flushPromises();
    useRunningAppsStore().choose('quit', true);
    await result;
    expect(enqueue.mock.calls.find(call => call[1]?.token === 'ghostty')?.[2]).toMatchObject({
      quitRunning: true,
      reopen: true
    });
    expect(enqueue.mock.calls.find(call => call[1]?.token === 'vlc')?.[2]).toMatchObject({
      quitRunning: false,
      reopen: false
    });
  });

  it('Automatic updates skip running apps without quitting or removing available updates', async () => {
    const { state } = await init();
    const task = await useTasksStore().enqueue('upgrade', target('ghostty'), 'schedule');
    await flushPromises();
    const ended = state.history.find(item => item.id === task?.id);
    expect(ended && isDeferredUpdate(ended)).toBe(true);
    expect((await unwrap(commands.updatesList())).some(item => item.token === 'ghostty')).toBe(true);
    expect(await unwrap(commands.appsRunning([target('ghostty')]))).toHaveLength(1);
    expect(useRunningAppsStore().pending).toBeNull();
  });

  it('Apps started after preflight are caught by execution-time checks', async () => {
    const { state } = await init('running-after-check');
    const task = await useTasksStore().enqueue('upgrade', target('ghostty'));
    await flushPromises();
    expect(state.history.find(item => item.id === task?.id)?.error?.code).toBe('E_APP_RUNNING');
  });

  it('Quit failures defer only that app while later apps execute', async () => {
    const { state } = await init('quit-fails');
    const result = useTasksStore().enqueueMany('upgrade', [target('ghostty'), target('vlc')]);
    await flushPromises();
    useRunningAppsStore().choose('quit');
    await result;
    await vi.waitFor(() =>
      expect(state.history.some(task => task.target?.token === 'vlc' && task.state === 'succeeded')).toBe(true)
    );
    expect(state.history.find(task => task.target?.token === 'ghostty')?.error?.code).toBe('E_APP_QUIT_FAILED');
  });

  it('Dialog lists apps, defaults to reopening, and treats dismissal as Later', async () => {
    const context = await init();
    const wrapper = mount(RunningAppsConfirm, {
      global: { plugins: [context.pinia, i18n, context.router] },
      attachTo: document.body
    });
    const result = useTasksStore().enqueueMany('upgrade', [target('ghostty'), target('zed')]);
    await flushPromises();
    expect(document.body.textContent).toContain('应用正在运行');
    expect(document.body.textContent).toContain('跳过这些应用');
    expect(document.body.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true);
    const later = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('稍后'));
    later?.click();
    expect(await result).toEqual([]);
    wrapper.unmount();
  });
});
