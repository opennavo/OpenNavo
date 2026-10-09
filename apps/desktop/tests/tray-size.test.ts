import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@tauri-apps/api/core';
import { mockWindows } from '@tauri-apps/api/mocks';
import { LogicalSize, Window } from '@tauri-apps/api/window';
import { useTrayWindowSize } from '@/composables/useTrayWindowSize';

vi.mock('@tauri-apps/api/core', { spy: true });

const Harness = defineComponent({
  setup() {
    const content = ref<HTMLElement | null>(null);
    useTrayWindowSize(content);
    return () => h('div', { ref: content });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tray window follows content size', () => {
  it('Round logical pixels upward, follow content, skip duplicates, stop observing on unmount', () => {
    mockWindows('tray');
    vi.mocked(core.isTauri).mockReturnValue(true);
    const setSize = vi.spyOn(Window.prototype, 'setSize').mockResolvedValue();
    let height = 206.75;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 330, height));
    let resize: () => void = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      }
    );

    const wrapper = mount(Harness);
    expect(observe).toHaveBeenCalledWith(wrapper.element);
    resize();
    resize();
    expect(setSize).toHaveBeenCalledExactlyOnceWith(new LogicalSize(330, 207));
    height = 350.25;
    resize();
    expect(setSize).toHaveBeenLastCalledWith(new LogicalSize(330, 351));
    height = 206.75;
    resize();
    expect(setSize).toHaveBeenLastCalledWith(new LogicalSize(330, 207));
    expect(setSize).toHaveBeenCalledTimes(3);
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('Browser previews and main window never invoke native resize', () => {
    const setSize = vi.spyOn(Window.prototype, 'setSize').mockResolvedValue();
    const isTauri = vi.mocked(core.isTauri).mockReturnValue(false);
    const browser = mount(Harness);
    browser.unmount();
    isTauri.mockReturnValue(true);
    mockWindows('main');
    const main = mount(Harness);
    main.unmount();
    expect(setSize).not.toHaveBeenCalled();
  });
});
