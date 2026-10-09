import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import OnCategoryChips from '../src/components/OnCategoryChips.vue';

// Horizontal category scrolling (08 §8.33): jsdom lacks layout, scrollBy, and pointer capture.
// Fake scroll-container dimensions/scrollLeft and record scroll calls.

const items = [
  { value: 'all', label: '全部' },
  { value: 'ai', label: 'AI 工具' },
  { value: 'dev', label: '开发工具' },
  { value: 'media', label: '影音' },
  { value: 'design', label: '设计' }
];

function mountChips(extra: { modelValue?: string; href?: boolean } = {}) {
  const list = extra.href ? items.map(item => ({ ...item, href: `/categories/${item.value}` })) : items;
  const wrapper = mount(OnCategoryChips, {
    props: { modelValue: extra.modelValue ?? 'all', items: list },
    attachTo: document.body
  });
  const strip = wrapper.get('.on-chips-scroll');
  return { wrapper, strip, el: strip.element as HTMLElement };
}

function fakeLayout(el: HTMLElement, layout: { clientWidth: number; scrollWidth: number; scrollLeft?: number }) {
  let scrollLeft = layout.scrollLeft ?? 0;
  const scrollBy = vi.fn();
  Object.defineProperties(el, {
    clientWidth: { configurable: true, value: layout.clientWidth },
    scrollWidth: { configurable: true, value: layout.scrollWidth },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      }
    },
    scrollBy: { configurable: true, value: scrollBy },
    setPointerCapture: { configurable: true, value: vi.fn() }
  });
  return {
    scrollBy,
    moveTo(value: number) {
      scrollLeft = value;
    }
  };
}

const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 32, width: right - left, height: 32 });

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('Chip scrolling arrows', () => {
  it('Hides arrows when content does not overflow', async () => {
    const { wrapper, strip, el } = mountChips();
    fakeLayout(el, { clientWidth: 600, scrollWidth: 600 });
    await strip.trigger('scroll');
    expect(wrapper.findAll('.on-chips-arrow')).toHaveLength(0);
    wrapper.unmount();
  });

  it('Scrolls smoothly by 80 percent and hides the arrow at the end', async () => {
    const { wrapper, strip, el } = mountChips();
    const layout = fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    await strip.trigger('scroll');
    // Far left: only the right arrow.
    expect(wrapper.findAll('.on-chips-arrow').map(arrow => arrow.attributes('data-direction'))).toEqual(['forward']);
    expect(strip.classes()).toContain('on-chips-has-forward');
    await wrapper.get('[data-direction="forward"]').trigger('click');
    expect(layout.scrollBy).toHaveBeenLastCalledWith({ left: 320, behavior: 'smooth' });

    layout.moveTo(300);
    await strip.trigger('scroll');
    expect(wrapper.findAll('.on-chips-arrow')).toHaveLength(2);

    // Far right (scrollLeft = 1000 - 400): only the left arrow.
    layout.moveTo(600);
    await strip.trigger('scroll');
    expect(wrapper.findAll('.on-chips-arrow').map(arrow => arrow.attributes('data-direction'))).toEqual(['back']);
    expect(strip.classes()).toContain('on-chips-has-back');
    expect(strip.classes()).not.toContain('on-chips-has-forward');
    await wrapper.get('[data-direction="back"]').trigger('click');
    expect(layout.scrollBy).toHaveBeenLastCalledWith({ left: -320, behavior: 'smooth' });
    wrapper.unmount();
  });

  it('Scrolls immediately with reduced motion', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const { wrapper, strip, el } = mountChips();
    const layout = fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    await strip.trigger('scroll');
    await wrapper.get('[data-direction="forward"]').trigger('click');
    expect(layout.scrollBy).toHaveBeenLastCalledWith({ left: 320, behavior: 'auto' });
    wrapper.unmount();
  });

  it('Keeps mouse-only arrows hidden from accessibility and keyboard focus', async () => {
    const { wrapper, strip, el } = mountChips();
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    await strip.trigger('scroll');
    const arrow = wrapper.get('.on-chips-arrow');
    expect(arrow.attributes('aria-hidden')).toBe('true');
    expect(arrow.attributes('tabindex')).toBe('-1');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    arrow.element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    wrapper.unmount();
  });
});

describe('Chip dragging', () => {
  // VTU trigger assigns inherited readonly button/clientX fields and throws; construct/dispatch events directly.
  // jsdom MouseEvent lacks pointer fields; add pointerId/pointerType read by the component.
  async function fire(
    target: Element | undefined,
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'click',
    init: { x?: number; pointerType?: string; button?: number; buttons?: number } = {}
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: init.button ?? 0,
      buttons: init.buttons ?? (type === 'pointerup' || type === 'click' ? 0 : 1),
      clientX: init.x ?? 0
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: init.pointerType ?? 'mouse' }
    });
    target?.dispatchEvent(event);
    await nextTick();
    return event;
  }

  it('Suppresses the next click after dragging and allows later clicks', async () => {
    const { wrapper, strip, el } = mountChips();
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000, scrollLeft: 100 });
    const radio = wrapper.findAll('[role="radio"]')[2]?.element;

    await fire(radio, 'pointerdown', { x: 300 });
    // Movement below 5 px is not a drag.
    await fire(radio, 'pointermove', { x: 297 });
    expect(el.scrollLeft).toBe(100);
    // Content follows the hand: pointer left 40 px moves content left and increases scrollLeft by 40.
    await fire(radio, 'pointermove', { x: 260 });
    expect(el.scrollLeft).toBe(140);
    expect(strip.classes()).toContain('on-chips-dragging');
    await fire(radio, 'pointerup', { x: 260 });
    expect(strip.classes()).not.toContain('on-chips-dragging');
    await fire(radio, 'click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();

    await fire(radio, 'pointerdown', { x: 300 });
    await fire(radio, 'pointerup', { x: 301 });
    await fire(radio, 'click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['dev']]);
    wrapper.unmount();
  });

  it('Allows the next click when no click followed the drag', async () => {
    const { wrapper, el } = mountChips();
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    const radios = wrapper.findAll('[role="radio"]');
    await fire(radios[1]?.element, 'pointerdown', { x: 300 });
    await fire(radios[1]?.element, 'pointermove', { x: 200 });
    await fire(radios[1]?.element, 'pointerup', { x: 200 });
    // Without a click, the next task clears the suppress-click flag.
    await new Promise(resolve => setTimeout(resolve, 0));
    await fire(radios[3]?.element, 'click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['media']]);
    wrapper.unmount();
  });

  it('Ends dragging when pointerup is lost', async () => {
    const { wrapper, el } = mountChips();
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    const radio = wrapper.findAll('[role="radio"]')[1]?.element;
    await fire(radio, 'pointerdown', { x: 300 });
    await fire(radio, 'pointermove', { x: 200, buttons: 0 });
    expect(el.scrollLeft).toBe(0);
    wrapper.unmount();
  });

  it('Preserves native touch, pen, and non-left-button behavior', async () => {
    const { wrapper, el } = mountChips();
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    const radio = wrapper.findAll('[role="radio"]')[1]?.element;
    for (const press of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { button: 2 }]) {
      await fire(radio, 'pointerdown', { x: 300, ...press });
      await fire(radio, 'pointermove', { x: 200 });
      await fire(radio, 'pointerup', { x: 200 });
    }
    expect(el.scrollLeft).toBe(0);
    await fire(radio, 'click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['ai']]);
    wrapper.unmount();
  });

  it('Prevents navigation and native link dragging during a drag', async () => {
    const { wrapper, el } = mountChips({ href: true });
    fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    const link = wrapper.findAll('a')[2]?.element;
    await fire(link, 'pointerdown', { x: 300 });
    await fire(link, 'pointermove', { x: 220 });
    await fire(link, 'pointerup', { x: 220 });
    const click = await fire(link, 'click');
    expect(click.defaultPrevented).toBe(true);
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
    link?.dispatchEvent(dragStart);
    expect(dragStart.defaultPrevented).toBe(true);
    wrapper.unmount();
  });
});

describe('Reveals the selected chip', () => {
  // Viewport 0–400 with 64 px fade insets on both ends.
  function layoutWithSelected(selected: { left: number; right: number }) {
    const { wrapper, el } = mountChips();
    const layout = fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    el.getBoundingClientRect = () => rect(0, 400) as DOMRect;
    // Third item, dev, is selected in the following cases.
    wrapper.get('[role="radio"]:nth-child(3)').element.getBoundingClientRect = () =>
      rect(selected.left, selected.right) as DOMRect;
    return { wrapper, layout };
  }

  it('Reveals right-side occlusion with room for the arrow', async () => {
    const { wrapper, layout } = layoutWithSelected({ left: 380, right: 470 });
    await wrapper.setProps({ modelValue: 'dev' });
    // Right boundary 400 - 64 = 336; selected right edge 470 requires scroll 134.
    expect(layout.scrollBy).toHaveBeenCalledWith({ left: 134, behavior: 'smooth' });
    wrapper.unmount();
  });

  it('Reveals left-side occlusion with room for the arrow', async () => {
    const { wrapper, layout } = layoutWithSelected({ left: -40, right: 50 });
    await wrapper.setProps({ modelValue: 'dev' });
    // Left boundary 64; selected left edge -40 requires scroll -104.
    expect(layout.scrollBy).toHaveBeenCalledWith({ left: -104, behavior: 'smooth' });
    wrapper.unmount();
  });

  it('Does not scroll a visible selection', async () => {
    const { wrapper, layout } = layoutWithSelected({ left: 100, right: 190 });
    await wrapper.setProps({ modelValue: 'dev' });
    expect(layout.scrollBy).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('Keyboard focus', () => {
  // jsdom :focus-visible is unreliable; explicitly declare keyboard focus, optionally simulating an unsupported selector.
  function focusVisible(chip: Element, visible: boolean | 'unsupported') {
    Object.defineProperty(chip, 'matches', {
      configurable: true,
      value: (selector: string) => {
        if (visible === 'unsupported') throw new SyntaxError(`不认识的选择器 ${selector}`);
        return visible && selector === ':focus-visible';
      }
    });
  }

  function layoutWithChip(index: number, chip: { left: number; right: number }) {
    const { wrapper, strip, el } = mountChips();
    const layout = fakeLayout(el, { clientWidth: 400, scrollWidth: 1000 });
    el.getBoundingClientRect = () => rect(0, 400) as DOMRect;
    const radio = wrapper.get(`[role="radio"]:nth-child(${index})`);
    radio.element.getBoundingClientRect = () => rect(chip.left, chip.right) as DOMRect;
    return { wrapper, strip, layout, radio };
  }

  const focusin = () => new FocusEvent('focusin', { bubbles: true });

  it('Reveals focused content beyond arrows and fades', () => {
    const { wrapper, layout, radio } = layoutWithChip(3, { left: 380, right: 470 });
    focusVisible(radio.element, true);
    radio.element.dispatchEvent(focusin());
    expect(layout.scrollBy).toHaveBeenCalledWith({ left: 134, behavior: 'auto' });
    wrapper.unmount();
  });

  it('Does not shift content for mouse focus', () => {
    const { wrapper, layout, radio } = layoutWithChip(3, { left: 380, right: 470 });
    focusVisible(radio.element, false);
    radio.element.dispatchEvent(focusin());
    expect(layout.scrollBy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('Handles unsupported focus-visible selectors without throwing', () => {
    const { wrapper, layout, radio } = layoutWithChip(3, { left: 380, right: 470 });
    focusVisible(radio.element, 'unsupported');
    expect(() => radio.element.dispatchEvent(focusin())).not.toThrow();
    expect(layout.scrollBy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('Prevents native focus scrolling on arrows', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const { wrapper, strip } = mountChips();
    await strip.trigger('keydown', { key: 'ArrowRight' });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
    wrapper.unmount();
  });
});
