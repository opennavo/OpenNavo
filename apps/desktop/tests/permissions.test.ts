import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UninstallConfirm from '@/components/package/UninstallConfirm.vue';
import PermissionGuidePage from '@/pages/PermissionGuidePage.vue';
import SettingsPage from '@/pages/SettingsPage.vue';
import { i18n } from '@/i18n';
import { commands, events } from '@/ipc/client';
import type { Permissions } from '@/ipc/bindings';
import { startGuideState, startLocalState, usePermissionsStore } from '@/stores';
import { setup } from './helpers';

// Privacy permissions (06 §12.3, §12.6, §12.7): removing app data on uninstall requires Full Disk Access; guidance overlay and settings permission rows.
const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label
  );

async function context(path: string, flags = '') {
  window.history.replaceState(null, '', flags ? `/?mock=${flags}` : '/');
  return setup(path, { brew: true, tickMs: 5 });
}

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('Uninstall confirmation: app data removal', () => {
  async function mountConfirm(zap: boolean) {
    const { pinia, router } = await context('/installed');
    await startLocalState();
    const confirm = vi.fn();
    const Host = defineComponent({
      setup: () => {
        const open = ref(true);
        const checked = ref(zap);
        return () =>
          h(UninstallConfirm, {
            kind: 'cask',
            token: 'ghostty',
            name: 'Ghostty',
            open: open.value,
            'onUpdate:open': (value: boolean) => (open.value = value),
            zap: checked.value,
            'onUpdate:zap': (value: boolean) => (checked.value = value),
            onConfirm: confirm
          });
      }
    });
    mount(Host, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
    await flushPromises();
    return { confirm };
  }

  it('Data removal without Full Disk Access requires guidance before confirmation', async () => {
    const { confirm } = await mountConfirm(true);
    expect(usePermissionsStore().fullDiskAccess).toBe('denied');
    expect(text()).toContain('删除应用数据需要「完全磁盘访问权限」');
    expect(button('卸载')?.disabled).toBe(true);

    const guide = vi.spyOn(commands, 'permissionGuideOpen');
    button('开启')?.click();
    await flushPromises();
    expect(guide).toHaveBeenCalledWith('full_disk_access');
    await vi.waitFor(() => expect(usePermissionsStore().fullDiskAccess).toBe('granted'), { timeout: 3000 });
    await flushPromises();
    expect(text()).not.toContain('删除应用数据需要「完全磁盘访问权限」');
    expect(button('卸载')?.disabled).toBe(false);
    button('卸载')?.click();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('Unchecked data removal uninstalls only the app without Full Disk Access', async () => {
    await mountConfirm(true);
    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    checkbox?.click();
    await flushPromises();
    expect(text()).not.toContain('删除应用数据需要「完全磁盘访问权限」');
    expect(button('卸载')?.disabled).toBe(false);
  });
});

describe('Permission guidance overlay', () => {
  async function mountGuide(pane: string) {
    const { pinia, router } = await context(`/permission-guide/${pane}`);
    await startGuideState();
    mount(PermissionGuidePage, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
    await flushPromises();
  }

  it('Describe current panel, drag icon on press, Close dismisses overlay', async () => {
    await mountGuide('full_disk_access');
    expect(text()).toContain('完全磁盘访问权限');
    expect(text()).toContain('把 OpenNavo 拖到上方的列表');
    expect(text()).toContain('列表里已有 OpenNavo 时，打开它旁边的开关即可。');

    const drag = vi.spyOn(commands, 'permissionGuideDrag');
    button('拖动 OpenNavo 图标')?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(drag).toHaveBeenCalledTimes(1);
    // Right-click must not start dragging.
    button('拖动 OpenNavo 图标')?.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    expect(drag).toHaveBeenCalledTimes(1);

    const close = vi.spyOn(commands, 'permissionGuideClose');
    button('关闭')?.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('Show completion after permission is enabled', async () => {
    await mountGuide('app_management');
    expect(text()).toContain('App 管理');
    usePermissionsStore().apply({ appManagement: 'granted', fullDiskAccess: 'denied', relaunchRequired: false });
    await flushPromises();
    expect(text()).toContain('已允许 OpenNavo 管理 App');
    expect(button('拖动 OpenNavo 图标')).toBeUndefined();
  });

  it('Development builds that cannot drag instruct using + instead', async () => {
    vi.spyOn(commands, 'permissionGuideInfo').mockResolvedValue({ status: 'ok', data: { draggable: false } });
    await mountGuide('full_disk_access');
    expect(text()).toContain('点按列表下方的「+」，选择 OpenNavo');
    const drag = vi.spyOn(commands, 'permissionGuideDrag');
    button('拖动 OpenNavo 图标')?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(drag).not.toHaveBeenCalled();
  });
});

describe('Settings: Privacy', () => {
  it('List App Management/Full Disk Access states and enable missing permissions', async () => {
    const { pinia, router } = await context('/settings/privacy');
    await startLocalState();
    mount(SettingsPage, { global: { plugins: [pinia, router, i18n] }, attachTo: document.body });
    await flushPromises();
    expect(text()).toContain('App 管理');
    expect(text()).toContain('完全磁盘访问权限');
    expect(text()).toContain('已开启');
    expect(text()).toContain('未开启');

    const guide = vi.spyOn(commands, 'permissionGuideOpen');
    const enable = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
      item => item.textContent?.trim() === '开启'
    );
    expect(enable).toHaveLength(1);
    enable[0]?.click();
    await flushPromises();
    expect(guide).toHaveBeenCalledWith('full_disk_access');
    await vi.waitFor(() => expect(usePermissionsStore().fullDiskAccess).toBe('granted'), { timeout: 3000 });
    await flushPromises();
    expect(text()).not.toContain('未开启');
  });
});

describe('Permission response ordering', () => {
  const oldStatus: Permissions = { appManagement: 'denied', fullDiskAccess: 'denied', relaunchRequired: false };
  const newStatus: Permissions = { appManagement: 'granted', fullDiskAccess: 'granted', relaunchRequired: true };

  function deferredQuery() {
    let resolve!: (value: Awaited<ReturnType<typeof commands.permissionsGet>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof commands.permissionsGet>>>(done => {
      resolve = done;
    });
    return { promise, resolve: (data: Permissions) => resolve({ status: 'ok', data }) };
  }

  it('Old queries cannot clear newer relaunch notices; post-event queries can update', async () => {
    await context('/discover');
    await startLocalState();
    const store = usePermissionsStore();
    const query = deferredQuery();
    const get = vi.spyOn(commands, 'permissionsGet').mockReturnValueOnce(query.promise);
    const refreshing = store.refresh();
    await events.permissionsChanged.emit(newStatus);
    await flushPromises();
    expect(store.relaunchRequired).toBe(true);
    query.resolve(oldStatus);
    expect(await refreshing).toEqual(newStatus);
    expect(store.status).toEqual(newStatus);
    expect(store.relaunchRequired).toBe(true);

    get.mockResolvedValueOnce({ status: 'ok', data: oldStatus });
    expect(await store.refresh()).toEqual(oldStatus);
    expect(store.relaunchRequired).toBe(false);
  });

  it.each([true, false])(
    'Only the latest concurrent request applies; old request returns first: %s',
    async olderFirst => {
      await context('/discover');
      const store = usePermissionsStore();
      store.apply(oldStatus);
      const older = deferredQuery();
      const newer = deferredQuery();
      vi.spyOn(commands, 'permissionsGet').mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const first = store.refresh();
      const second = store.refresh();
      if (olderFirst) {
        older.resolve(newStatus);
        await first;
        expect(store.status).toEqual(oldStatus);
        newer.resolve(newStatus);
        await second;
      } else {
        newer.resolve(newStatus);
        await second;
        older.resolve(oldStatus);
        expect(await first).toEqual(newStatus);
      }
      expect(store.status).toEqual(newStatus);
    }
  );
});
