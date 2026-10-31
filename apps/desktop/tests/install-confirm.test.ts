import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import BrewfileRestore from '@/components/library/BrewfileRestore.vue';
import InstallConfirm from '@/components/shell/InstallConfirm.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { useTasksStore } from '@/stores/tasks';
import { useTapConfirmStore } from '@/stores/tapConfirm';
import { useInstallConfirmStore } from '@/stores/installConfirm';
import { setup } from './helpers';

const target = { kind: 'cask' as const, token: 'notion' };
async function init(flags = 'existing-app') {
  window.history.replaceState({}, '', `/?mock=${flags}`);
  const context = await setup('/discover', { tickMs: 1 });
  context.state.installed = context.state.installed.filter(item => item.token !== target.token);
  return context;
}
afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('Pre-install adoption confirmation', () => {
  it('Preflight before install; no task before consent; repeated clicks share one confirmation', async () => {
    const { state } = await init();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const tasks = useTasksStore();
    const first = tasks.enqueue('install', target);
    const second = tasks.enqueue('install', target);
    await flushPromises();
    expect(useInstallConfirmStore().pending?.status).toBe('conflict');
    expect(state.active).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    useInstallConfirmStore().choose(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a?.id).toBe(b?.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('install', target, { adopt: true }, 'manual');
  });

  it('Canceling and retrying old adoption tasks cannot reuse consent', async () => {
    await init();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const result = useTasksStore().enqueue('install', target, 'retry', {
      adopt: true
    });
    await flushPromises();
    useInstallConfirmStore().choose(false);
    expect(await result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Normal installs discard caller-injected adoption flags', async () => {
    await init('');
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    await useTasksStore().enqueue('install', target, 'manual', { adopt: true });
    expect(enqueue).toHaveBeenCalledWith('install', target, { adopt: false }, 'manual');
    expect(useInstallConfirmStore().pending).toBeNull();
  });

  it('Already managed apps only refresh local state without reinstalling', async () => {
    const { state } = await init();
    const existing = state.installed[0];
    expect(existing).toBeDefined();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const refresh = vi.spyOn(commands, 'libraryRefresh');
    expect(
      await useTasksStore().enqueue('install', {
        kind: 'cask',
        token: existing!.token
      })
    ).toBeNull();
    expect(refresh).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Preflight failures block installation; unverifiable apps cannot force consent', async () => {
    await init('install-check-fails');
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    await expect(useTasksStore().enqueue('install', target)).rejects.toMatchObject({
      code: 'E_TIMEOUT'
    });
    expect(enqueue).not.toHaveBeenCalled();
    await init('install-blocked');
    const result = useTasksStore().enqueue('install', target);
    await flushPromises();
    expect(useInstallConfirmStore().pending?.status).toBe('blocked');
    useInstallConfirmStore().choose(true);
    expect(await result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Confirm batches individually; background tasks never prompt or auto-adopt', async () => {
    await init();
    const tasks = useTasksStore();
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const result = tasks.enqueueMany('install', [target, { ...target, token: 'unmanaged-example' }], 'bundle');
    await flushPromises();
    useInstallConfirmStore().choose(false);
    await flushPromises();
    expect(useInstallConfirmStore().pending?.status).toBe('conflict');
    useInstallConfirmStore().choose(true);
    expect(await result).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await tasks.enqueue('install', target, 'schedule', { adopt: true })).toBeNull();
    expect(useInstallConfirmStore().pending).toBeNull();
  });

  it('Execution conflicts require fresh preflight/consent on retry; adoption failure remains recorded', async () => {
    const { state } = await init('conflict-after-check');
    const tasks = useTasksStore();
    const first = await tasks.enqueue('install', target);
    await vi.waitFor(() => expect(state.history.find(task => task.id === first?.id)?.error?.code).toBe('E_APP_EXISTS'));
    tasks.applyUpdate(state.history.find(task => task.id === first?.id) ?? null);
    const retry = tasks.enqueue('install', target, 'retry');
    await flushPromises();
    expect(useInstallConfirmStore().pending?.status).toBe('conflict');
    useInstallConfirmStore().choose(true);
    const second = await retry;
    expect(second?.id).not.toBe(first?.id);
    await vi.waitFor(() => expect(state.history.find(task => task.id === second?.id)?.state).toBe('succeeded'));
    const failed = await init('adopt-fails');
    const adopt = useTasksStore().enqueue('install', target);
    await flushPromises();
    useInstallConfirmStore().choose(true);
    const task = await adopt;
    await vi.waitFor(() =>
      expect(failed.state.history.find(item => item.id === task?.id)?.error?.code).toBe('E_APP_EXISTS')
    );
    expect(useInstallConfirmStore().pending).toBeNull();
  });

  function brewfile(context: Awaited<ReturnType<typeof init>>, tokens: string[]) {
    return mount(BrewfileRestore, {
      props: {
        open: true,
        path: '/Users/mock/Brewfile',
        preview: {
          entries: tokens.map((token, index) => ({
            line: index + 1,
            raw: `cask "${token}"`,
            kind: 'cask' as const,
            token,
            status: 'ready' as const,
            reason: null
          })),
          ready: tokens.length,
          installed: 0,
          unsupported: 0,
          digest: 'preview-digest'
        }
      },
      global: { plugins: [context.pinia, i18n, context.router] },
      attachTo: document.body
    });
  }
  const clickInstall = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('安装'))?.click();

  it('Brewfile restore asks before adopting an app that is already installed, and Rust gets that answer', async () => {
    const context = await init();
    const wrapper = brewfile(context, ['notion']);
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    const install = vi.spyOn(commands, 'brewfileInstall').mockResolvedValue({ status: 'ok', data: [] });
    clickInstall();
    await flushPromises();
    // The same adoption prompt as a single install, before OpenNavo's confirmation window.
    expect(useInstallConfirmStore().pending?.status).toBe('conflict');
    expect(install).not.toHaveBeenCalled();
    useInstallConfirmStore().choose(true);
    await flushPromises();
    expect(install).toHaveBeenCalledWith('/Users/mock/Brewfile', 'preview-digest', {
      adopt: ['notion'],
      taps: [],
      declined: []
    });
    expect(enqueue).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('Brewfile restore marks a declined adoption as skipped and never asks Rust when nothing is left', async () => {
    const context = await init();
    const wrapper = brewfile(context, ['notion']);
    const install = vi.spyOn(commands, 'brewfileInstall');
    clickInstall();
    await flushPromises();
    useInstallConfirmStore().choose(false);
    await flushPromises();
    expect(install).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('Brewfile restore asks for a missing third-party tap first; Rust adds the tap as part of the plan', async () => {
    const context = await init('');
    vi.spyOn(commands, 'installPreflight').mockResolvedValue({
      status: 'ok',
      data: { name: 'Notion', paths: [], status: 'ready', tap: 'example-dev/tap' }
    });
    const wrapper = brewfile(context, ['notion', 'zed']);
    const install = vi.spyOn(commands, 'brewfileInstall').mockResolvedValue({
      status: 'error',
      error: { code: 'E_CONFIRMATION_DENIED', message: 'confirmation_denied', detail: null }
    });
    clickInstall();
    await flushPromises();
    expect(useTapConfirmStore().pending).toEqual({ name: 'Notion', tap: 'example-dev/tap' });
    useTapConfirmStore().choose(true);
    await flushPromises();
    useTapConfirmStore().choose(false);
    await flushPromises();
    expect(install).toHaveBeenCalledWith('/Users/mock/Brewfile', 'preview-digest', {
      adopt: [],
      taps: ['example-dev/tap'],
      declined: ['zed']
    });
    // Deny in OpenNavo's window: quiet, nothing queued.
    expect(document.body.textContent).not.toContain('E_CONFIRMATION_DENIED');
    wrapper.unmount();
  });

  it('Dialog shows paths; Cancel and Escape create no task', async () => {
    const context = await init();
    const wrapper = mount(InstallConfirm, {
      global: { plugins: [context.pinia, i18n, context.router] },
      attachTo: document.body
    });
    const enqueue = vi.spyOn(commands, 'taskEnqueue');
    let result = useTasksStore().enqueue('install', target);
    await flushPromises();
    expect(document.body.textContent).toContain('/Applications/');
    expect(document.body.textContent).toContain('确认接管');
    document.querySelector<HTMLButtonElement>('[data-install-cancel]')?.click();
    expect(await result).toBeNull();
    result = useTasksStore().enqueue('install', target);
    await flushPromises();
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(useInstallConfirmStore().pending).toBeNull();
    // Unmounting also cancels as a fallback; no task awaiting authorization may remain.
    wrapper.unmount();
    expect(await result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
