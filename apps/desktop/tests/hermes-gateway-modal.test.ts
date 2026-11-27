import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesGatewayModal from '@/components/hermes/HermesGatewayModal.vue';
import { useHermesStore } from '@/stores/hermes';
import { i18n } from '@/i18n';

const wrappers: VueWrapper[] = [];

const stubs = {
  OnModal: { template: '<div><slot /><slot name="footer" /></div>' },
  OnButton: { template: '<button type="button" @click="$emit(\'click\')"><slot /></button>' },
  OnIcon: true
};

async function fill(wrapper: VueWrapper) {
  const inputs = wrapper.findAll('input');
  await inputs[0]!.setValue('Loopback');
  await inputs[1]!.setValue('http://[::1]:9119');
  await inputs[2]!.setValue('admin');
  await inputs[3]!.setValue('secret');
}

function loginButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').at(-1)!;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks();
});

describe('Hermes gateway modal', () => {
  it('accepts IPv6 loopback and does not let a stale login close a reopened form', async () => {
    const store = useHermesStore();
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => {
      finishFirst = resolve;
    });
    const add = vi
      .spyOn(store, 'addPanelProfile')
      .mockReturnValueOnce(first as never)
      .mockResolvedValueOnce({ id: 'panel-new' } as never);

    const wrapper = mount(HermesGatewayModal, {
      props: { open: false },
      global: { plugins: [i18n], stubs }
    });
    wrappers.push(wrapper);
    await wrapper.setProps({ open: true });
    await fill(wrapper);
    await loginButton(wrapper).trigger('click');
    expect(add).toHaveBeenCalledTimes(1);

    // Reopen as another connection while the first login is still running.
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await fill(wrapper);
    await loginButton(wrapper).trigger('click');
    await flushPromises();
    expect(add).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('close')).toHaveLength(1);

    // The stale receipt must not close the reopened form a second time.
    finishFirst();
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
