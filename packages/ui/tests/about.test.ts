import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import OnAboutContent from '../src/components/OnAboutContent.vue';

it('Collapses About plaintext and isolates external open-source links', async () => {
  const wrapper = mount(OnAboutContent, {
    props: {
      draftLabel: '待审',
      content: {
        sections: [
          { key: 'privacy', title: '隐私', paragraphs: ['<img src=x onerror=alert(1)>'], draft: true },
          { key: 'openSource', title: 'Open source', paragraphs: [], draft: false }
        ],
        modules: [
          { ecosystem: 'npm', name: 'vue', version: '3.5.0', license: 'MIT', url: 'https://github.com/vuejs/core' }
        ]
      }
    }
  });
  expect(wrapper.find('img').exists()).toBe(false);
  expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
  expect(wrapper.text()).toContain('待审');
  expect(wrapper.get('summary').text()).toBe('npm · 1');
  expect(wrapper.get('details').attributes('open')).toBeUndefined();
  expect(wrapper.find('a').exists()).toBe(false);
  (wrapper.get('details').element as HTMLDetailsElement).open = true;
  await wrapper.get('details').trigger('toggle');
  expect(wrapper.get('a').attributes('rel')).toBe('noopener noreferrer');
  expect(wrapper.get('a').attributes('href')).toBe('https://github.com/vuejs/core');
});
