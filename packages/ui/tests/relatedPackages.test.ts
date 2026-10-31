import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { describe, expect, it } from 'vitest';
import OnRelatedPackages from '../src/components/OnRelatedPackages.vue';
import { withLocale } from './helpers';

// A router link stand-in that is not an anchor, so a native <a> stays distinguishable in the DOM.
const FakeLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup:
    (props, { slots }) =>
    () =>
      h('span', { 'data-to': props.to }, slots.default?.())
});

describe('Related packages', () => {
  it('renders See more through linkAs and never as a native anchor', () => {
    const wrapper = mount(OnRelatedPackages, {
      props: {
        related: [{ key: 'cask/a', kind: 'cask', token: 'a', name: 'A', href: '/apps/a' }],
        relatedTitle: 'Related apps',
        relatedMoreHref: '/apps',
        relatedMoreLabel: 'See more',
        linkAs: FakeLink
      },
      global: withLocale('en-US')
    });
    try {
      expect(wrapper.findAll('a')).toHaveLength(0);
      expect(wrapper.get('[data-to="/apps/a"]').text()).toBe('A');
      expect(wrapper.get('[data-to="/apps"]').text()).toBe('See more');
      expect(wrapper.text()).toContain('Related apps');
    } finally {
      wrapper.unmount();
    }
  });
});
