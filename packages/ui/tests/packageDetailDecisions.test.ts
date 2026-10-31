import { mount } from '@vue/test-utils';
import { createSSRApp, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import OnPackageSpecCard from '../src/components/OnPackageSpecCard.vue';
import OnPackageOverview from '../src/components/OnPackageOverview.vue';
import { RouterLinkStub, withLocale } from './helpers';

describe('Package detail product decisions', () => {
  it('keeps the external-link arrow on the last character of a wrapped link (#112)', () => {
    const wrapper = mount(OnPackageSpecCard, {
      props: {
        rows: [
          {
            key: 'home',
            label: 'Home',
            value: 'github.com/yuuichieguchi/Calyx',
            href: 'https://github.com/yuuichieguchi/Calyx'
          }
        ]
      },
      global: withLocale('en-US')
    });
    try {
      const link = wrapper.get('[data-testid="spec-link"]');
      expect(link.text()).toBe('github.com/yuuichieguchi/Calyx');
      expect(link.classes()).not.toContain('inline-flex');
      const tail = link.get('[data-testid="spec-link-tail"]');
      expect(tail.classes()).toContain('whitespace-nowrap');
      expect(tail.text()).toBe('x');
      expect(tail.find('svg').exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it('includes the repository aria-describedby association in SSR output', async () => {
    const context: { teleports?: Record<string, string> } = {};
    const html = await renderToString(
      createSSRApp(OnPackageSpecCard, {
        checkedLabel: 'Checked',
        rows: [
          {
            key: 'repository',
            label: 'Repository',
            stars: {
              label: '★12.3K',
              checked: 'Repository data checked October 2, 2026.'
            }
          }
        ]
      }),
      context
    );
    const page = document.createElement('div');
    page.innerHTML = html + (context.teleports?.body ?? '');
    const id = page.querySelector('button')?.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const description = page.querySelector(`[id="${id}"]`);
    expect(description?.getAttribute('role')).toBe('tooltip');
    expect(description?.textContent).toContain('Repository data checked October 2, 2026.');
  });

  it('uses standard external-link attributes and styling for https URLs', () => {
    const wrapper = mount(OnPackageSpecCard, {
      props: {
        rows: [
          {
            key: 'repository',
            label: 'Repository',
            value: 'GitHub repository',
            href: 'https://github.com/acme/app',
            stars: { label: '★12.3K', href: 'https://github.com/acme/app' }
          },
          { key: 'homepage', label: 'Homepage', value: 'example.com', href: 'https://example.com/' }
        ]
      }
    });
    try {
      const links = wrapper.findAll('a');
      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(link.attributes('href')?.startsWith('https://')).toBe(true);
        expect(link.attributes('target')).toBe('_blank');
        expect(link.attributes('rel')).toBe('noopener noreferrer');
        expect(link.classes()).toEqual(expect.arrayContaining(['no-underline', 'hover:underline']));
        expect(link.find('svg').exists()).toBe(true);
      }
    } finally {
      wrapper.unmount();
    }
  });

  it('renders no link unless href and stars.href use the https scheme', () => {
    const wrapper = mount(OnPackageSpecCard, {
      props: {
        rows: [
          {
            key: 'repository',
            label: 'Repository',
            value: 'Open source',
            href: 'javascript:alert(1)',
            stars: { label: '★12.3K', href: 'javascript:alert(1)' }
          },
          { key: 'homepage', label: 'Homepage', value: 'Insecure example', href: 'http://example.com/' },
          { key: 'internal', label: 'Related', value: 'Related app', href: '/apps/example' }
        ]
      }
    });
    try {
      expect(wrapper.findAll('a')).toHaveLength(0);
      expect(wrapper.html()).not.toContain('javascript:');
      expect(wrapper.text()).toContain('Open source · ★12.3K');
      expect(wrapper.text()).toContain('Insecure example');
      expect(wrapper.text()).toContain('Related app');
    } finally {
      wrapper.unmount();
    }
  });

  it('uses the row href for stars when stars.href is absent, still requiring https', () => {
    const wrapper = mount(OnPackageSpecCard, {
      props: {
        rows: [
          {
            key: 'repository',
            label: 'Repository',
            value: 'Open source',
            href: 'https://github.com/acme/fallback',
            stars: { label: '★1K' }
          },
          {
            key: 'insecure',
            label: 'Insecure',
            value: 'Open source',
            href: 'javascript:alert(1)',
            stars: { label: '★2K' }
          }
        ]
      }
    });
    try {
      const links = wrapper.findAll('a');
      expect(links).toHaveLength(2);
      expect(links.map(link => link.attributes('href'))).toEqual([
        'https://github.com/acme/fallback',
        'https://github.com/acme/fallback'
      ]);
      expect(wrapper.text()).toContain('★1K');
      expect(wrapper.html()).not.toContain('javascript:');
    } finally {
      wrapper.unmount();
    }
  });

  it('keeps one overall date and puts the repository date in an accessible, tappable star tooltip', async () => {
    const wrapper = mount(OnPackageSpecCard, {
      props: {
        title: 'At a glance',
        checkedLabel: 'Checked',
        checkedAt: { iso: '2026-10-01', label: 'October 1, 2026' },
        rows: [
          {
            key: 'repository',
            label: 'Repository',
            value: 'Open source · MIT',
            stars: {
              label: '★12.3K',
              href: 'https://github.com/example/app',
              checked: 'Repository data checked October 2, 2026.'
            }
          }
        ]
      },
      attachTo: document.body
    });
    try {
      expect(wrapper.findAll('time')).toHaveLength(1);
      expect(wrapper.get('a').attributes('href')).toBe('https://github.com/example/app');
      expect(wrapper.text()).not.toContain('October 2');
      const trigger = wrapper.get('button');
      const tooltip = document.getElementById(trigger.attributes('aria-describedby')!);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toContain('Repository data checked October 2, 2026.');
      trigger.element.focus();
      expect(document.activeElement).toBe(trigger.element);
      await trigger.trigger('click');
      await nextTick();
      await nextTick();
      expect(tooltip?.classList.contains('visible')).toBe(true);
      await trigger.trigger('keydown', { key: 'Escape' });
      expect(tooltip?.classList.contains('invisible')).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it('replaces disabled installation with the explanation and no copy control', () => {
    const wrapper = mount(OnPackageOverview, {
      props: {
        command: 'brew install --cask example',
        installNotice: { text: 'Homebrew disabled this app: discontinued.', disabled: true }
      },
      global: withLocale('en-US')
    });
    expect(wrapper.get('[data-testid="package-install-command"]').text()).toContain('discontinued');
    expect(wrapper.find('pre code').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('places the warning before a copyable command and keeps it available at mobile widths', () => {
    const wrapper = mount(OnPackageOverview, {
      props: {
        command: 'brew install --cask example',
        installNotice: { text: 'Recommendations paused; Homebrew still offers this app.', disabled: false }
      },
      global: withLocale('en-US')
    });
    const card = wrapper.get('[data-testid="package-install-command"]');
    expect(card.element.className).not.toContain('hidden');
    expect(
      card.get('[role="note"]').element.compareDocumentPosition(card.get('pre').element) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(card.get('code').text()).toBe('brew install --cask example');
    expect(card.find('button').exists()).toBe(true);
    wrapper.unmount();
  });

  it('stacks the top slot and the gallery in one lead row instead of overlapping', () => {
    const wrapper = mount(OnPackageOverview, {
      props: { hasAbout: true, screenshots: [{ src: '/shots/1.png' }] },
      slots: {
        top: () => h('p', { id: 'top-slot' }, 'Facts'),
        about: () => h('p', 'About'),
        main: () => h('p', 'Main')
      },
      global: withLocale('en-US')
    });
    try {
      const lead = wrapper.get('[data-testid="package-overview-lead"]');
      expect(lead.find('#top-slot').exists()).toBe(true);
      expect(lead.find('img').exists()).toBe(true);
      expect(lead.classes()).toEqual(expect.arrayContaining(['lg:col-start-1', 'lg:row-start-1']));
      expect(wrapper.get('[data-testid="package-overview-about"]').classes()).toContain('lg:row-start-2');
    } finally {
      wrapper.unmount();
    }
  });

  it('starts the introduction in the first row when there is no lead', () => {
    const wrapper = mount(OnPackageOverview, {
      props: { hasAbout: true },
      slots: { about: () => h('p', 'About'), main: () => h('p', 'Main') },
      global: withLocale('en-US')
    });
    try {
      expect(wrapper.find('[data-testid="package-overview-lead"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="package-overview-about"]').classes()).toContain('lg:row-start-1');
      expect(wrapper.get('[data-testid="package-overview-main"]').classes()).toContain('lg:row-start-2');
    } finally {
      wrapper.unmount();
    }
  });

  it('renders See more through linkAs on the overview', () => {
    const wrapper = mount(OnPackageOverview, {
      props: {
        related: [{ key: 'cask/a', kind: 'cask', token: 'a', name: 'A', href: '/apps/a' }],
        relatedTitle: 'Related',
        relatedMoreHref: '/apps',
        relatedMoreLabel: 'See more',
        linkAs: RouterLinkStub
      },
      global: withLocale('en-US')
    });
    try {
      expect(wrapper.get('a[href="#/apps"]').text()).toBe('See more');
      expect(wrapper.get('a[href="#/apps/a"]').text()).toBe('A');
    } finally {
      wrapper.unmount();
    }
  });
  it('stacks the side column as one column beside the main column (#112)', () => {
    const wrapper = mount(OnPackageOverview, {
      props: { hasAbout: true, command: 'brew install --cask example' },
      slots: {
        about: () => h('p', 'About'),
        main: () => h('p', 'Main'),
        aside: () => h('p', { id: 'aside' }, 'Installs')
      },
      global: withLocale('en-US')
    });
    try {
      const main = wrapper.get('[data-testid="package-overview-main"]');
      expect(main.classes()).toEqual(expect.arrayContaining(['lg:row-start-2', 'lg:row-end-5']));
      // #112: every side card lives in one wrapper spanning all rows, so no card shares a row height with the main column.
      const side = wrapper.get('[data-testid="package-overview-side"]');
      expect(side.classes()).toEqual(
        expect.arrayContaining(['contents', 'lg:flex', 'lg:col-start-2', 'lg:row-start-1', 'lg:row-end-5'])
      );
      expect(side.element.contains(wrapper.get('#aside').element)).toBe(true);
      expect(side.element.contains(wrapper.get('[data-testid="package-install-command"]').element)).toBe(true);
      for (const child of Array.from(side.element.children)) expect(child.className).not.toMatch(/row-(start|end)-/);
    } finally {
      wrapper.unmount();
    }
  });

  it('forwards a failed install-command copy', async () => {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) }
    });
    const wrapper = mount(OnPackageOverview, {
      props: { command: 'brew install --cask example' },
      global: withLocale('en-US')
    });
    try {
      await wrapper.get('[data-testid="package-install-command"] button').trigger('click');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(wrapper.emitted('copyFailed')).toHaveLength(1);
      expect(wrapper.emitted('copied')).toBeUndefined();
    } finally {
      wrapper.unmount();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
    }
  });
});
