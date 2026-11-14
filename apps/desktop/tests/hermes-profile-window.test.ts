import { mount } from '@vue/test-utils';
import { afterEach, expect, it } from 'vitest';
import App from '@/App.vue';
import { setup } from './helpers';

afterEach(() => {
  delete document.documentElement.dataset.opennavoWindow;
});

it('secondary Hermes windows mount the profile shell instead of the main app shell', async () => {
  const { pinia, router } = await setup('/assistant');
  document.documentElement.dataset.opennavoWindow = 'hermes-profile';
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
      stubs: {
        AppShell: { template: '<div data-app-shell><router-view /></div>' },
        HermesProfileShell: { template: '<div data-profile-shell><router-view /></div>' }
      }
    }
  });

  expect(wrapper.find('[data-profile-shell]').exists()).toBe(true);
  expect(wrapper.find('[data-app-shell]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Hermes 助手');
  wrapper.unmount();
});
