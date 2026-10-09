import { mount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import UserAvatar from '../src/layouts/modules/global-header/components/user-avatar.vue';

const mocks = vi.hoisted(() => ({ logout: vi.fn(), reset: vi.fn() }));
vi.mock('@/service/api', () => ({ fetchLogout: mocks.logout }));
vi.mock('@/store/modules/auth', () => ({
  useAuthStore: () => ({ isLogin: true, userInfo: { userName: 'admin' }, resetStore: mocks.reset })
}));
vi.mock('@/hooks/common/router', () => ({ useRouterPush: () => ({ routerPushByKey: vi.fn(), toLogin: vi.fn() }) }));
vi.mock('@/hooks/common/icon', () => ({ useSvgIcon: () => ({ SvgIconVNode: vi.fn() }) }));
vi.mock('@/locales', () => ({ $t: (key: string) => key }));

beforeEach(() => vi.clearAllMocks());
function confirmLogout() {
  let confirm: (() => Promise<unknown>) | undefined;
  window.$dialog = {
    info: (options: { onPositiveClick: () => Promise<unknown> }) => {
      confirm = options.onPositiveClick;
    }
  } as unknown as NonNullable<Window['$dialog']>;
  const wrapper = mount(UserAvatar, {
    global: {
      stubs: {
        NDropdown: { template: "<button @click=\"$emit('select', 'logout')\"><slot /></button>" },
        ButtonIcon: true,
        SvgIcon: true
      }
    }
  });
  wrapper.find('button').element.click();
  wrapper.unmount();
  return confirm!;
}
it('waits for server revocation before clearing local credentials', async () => {
  let finish!: (value: { error: undefined }) => void;
  mocks.logout.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = confirmLogout()();
  expect(mocks.logout).toHaveBeenCalledOnce();
  expect(mocks.reset).not.toHaveBeenCalled();
  finish({ error: undefined });
  await pending;
  expect(mocks.reset).toHaveBeenCalledOnce();
});
it('keeps the session and confirmation open when revocation fails', async () => {
  mocks.logout.mockResolvedValue({ error: new Error('offline') });
  expect(await confirmLogout()()).toBe(false);
  expect(mocks.reset).not.toHaveBeenCalled();
});
