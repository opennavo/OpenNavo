import { flushPromises, mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import App from '@/App.vue';
import { routes } from '@/router';
import { setup } from './helpers';

it('Welcome is independent of main shell; mount main only after completion and prevent Back returning', async () => {
  const { pinia, router } = await setup('/settings');
  await router.push('/welcome');
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
      stubs: { AppShell: { template: '<div data-app-shell><router-view /></div>' } }
    }
  });
  expect(routes.find(route => route.name === 'welcome')?.meta?.bare).toBe(true);
  expect(wrapper.text()).toContain('欢迎页');
  expect(wrapper.find('[data-app-shell]').exists()).toBe(false);
  await router.replace('/discover');
  expect(wrapper.find('[data-app-shell]').exists()).toBe(true);
  router.back();
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/settings');
  wrapper.unmount();
});
