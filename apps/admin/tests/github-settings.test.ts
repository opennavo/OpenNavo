import { flushPromises, mount } from '@vue/test-utils';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NP,
  NPopconfirm,
  NSkeleton,
  NTag,
  NText,
  NA
} from 'naive-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GitHubSettings from '../src/views/system/github/index.vue';

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/service/api', () => ({ fetchGitHubSettings: api.load, updateGitHubSettings: api.save }));
vi.mock('@/locales', () => ({ $t: (key: string) => key }));

function response(source: 'admin' | 'none' = 'none') {
  return {
    data: { tokenConfigured: source !== 'none', tokenSource: source },
    error: undefined
  };
}

function page() {
  return mount(GitHubSettings, {
    global: {
      components: { NAlert, NButton, NCard, NForm, NFormItem, NInput, NP, NPopconfirm, NSkeleton, NTag, NText, NA }
    }
  });
}

function button(wrapper: ReturnType<typeof page>, key: string) {
  return wrapper.findAll('button').find(node => node.text() === key)!;
}

beforeEach(() => {
  api.load.mockReset().mockResolvedValue(response());
  api.save.mockReset().mockResolvedValue(response('admin'));
});

describe('GitHub PAT settings', () => {
  it('Clear new PAT after saving and never repopulate stored tokens', async () => {
    const wrapper = page();
    await flushPromises();
    expect(button(wrapper, 'page.system.github.save').attributes('disabled')).toBeDefined();
    const input = wrapper.find('input[type="password"]');
    await input.setValue('fixture-admin-credential');
    await button(wrapper, 'page.system.github.save').trigger('click');
    await flushPromises();
    expect(api.save).toHaveBeenCalledWith({ token: 'fixture-admin-credential', clearToken: false });
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('page.system.github.tokenSource.admin');
    expect(wrapper.text()).not.toContain('fixture-admin-credential');
    wrapper.unmount();
  });

  it('Keep draft on save failure for retry without changing server state', async () => {
    api.save.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    const wrapper = page();
    await flushPromises();
    await wrapper.find('input[type="password"]').setValue('retry-credential');
    await button(wrapper, 'page.system.github.save').trigger('click');
    await flushPromises();
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('retry-credential');
    expect(wrapper.text()).toContain('page.system.github.saveFailed');
    expect(wrapper.text()).toContain('page.system.github.tokenSource.none');
    await button(wrapper, 'page.system.github.save').trigger('click');
    await flushPromises();
    expect(api.save).toHaveBeenCalledTimes(2);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });

  it('Hide editable forms on load failure until refresh succeeds', async () => {
    api.load.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    const wrapper = page();
    await flushPromises();
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).toContain('page.system.github.loadFailed');
    await button(wrapper, 'common.refresh').trigger('click');
    await flushPromises();
    expect(wrapper.find('input').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('page.system.github.loadFailed');
    wrapper.unmount();
  });

  it('Reject whitespace in PATs and duplicate saves', async () => {
    const wrapper = page();
    await flushPromises();
    await wrapper.find('input').setValue('bad token');
    await button(wrapper, 'page.system.github.save').trigger('click');
    await flushPromises();
    expect(api.save).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('page.system.github.invalidToken');
    let finish!: (value: ReturnType<typeof response>) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    await wrapper.find('input').setValue('valid-credential');
    await button(wrapper, 'page.system.github.save').trigger('click');
    await flushPromises();
    await button(wrapper, 'page.system.github.save').trigger('click');
    expect(api.save).toHaveBeenCalledTimes(1);
    finish(response('admin'));
    await flushPromises();
    wrapper.unmount();
  });
});
