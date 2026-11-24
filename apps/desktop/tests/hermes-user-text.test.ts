import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import HermesUserText from '@/components/hermes/HermesUserText.vue';

describe('HermesUserText', () => {
  it('renders stored references as chips instead of raw directives', () => {
    const wrapper = mount(HermesUserText, {
      props: { text: 'read @url:`https://example.com/docs` and @file:`apps/main.ts`' }
    });

    const chips = wrapper.findAll('.hermes-ref-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.attributes('title')).toBe('https://example.com/docs');
    expect(chips[0]?.text()).toContain('example.com/docs');
    expect(chips[1]?.text()).toContain('apps/main.ts');
    // No template whitespace may leak in beside a chip: this is exactly what the user sent.
    expect(wrapper.text()).toBe('read example.com/docs and apps/main.ts');
  });

  it('keeps prose without references as plain text', () => {
    const wrapper = mount(HermesUserText, { props: { text: 'plain words' } });
    expect(wrapper.findAll('.hermes-ref-chip')).toHaveLength(0);
    expect(wrapper.text()).toBe('plain words');
  });
});
