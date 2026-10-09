import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { CaskPlatform } from '@opennavo/api';
import { LOCALES, sharedMessages } from '@opennavo/shared';
import OnCaskArtifacts from '../src/components/OnCaskArtifacts.vue';
import OnCaskPlatformSelect from '../src/components/OnCaskPlatformSelect.vue';
import { selectedCaskPlatform } from '../src/utils/package';
import { withLocale } from './helpers';

const platforms: CaskPlatform[] = [
  {
    tag: 'sonoma',
    macos: '14',
    arch: 'x86_64',
    version: '1',
    downloadUrl: null,
    downloadSha256: null,
    minMacos: '13',
    requiresRosetta: false,
    artifacts: { apps: ['Intel.app'], binaries: [], pkgs: [], entries: [] },
    dependsOn: {
      arch: ['x86_64'],
      casks: ['legacy-helper'],
      formulae: [],
      macos: '>= 13; <= 14',
      requirements: { maximum_macos: { '<=': ['14'] } }
    },
    conflictsWith: { casks: [], formulae: [] }
  },
  {
    tag: 'arm64_sonoma',
    macos: '14',
    arch: 'arm64',
    version: '2',
    downloadUrl: 'https://example.com/arm.zip',
    minMacos: '14',
    requiresRosetta: true,
    artifacts: { apps: ['Arm.app'], binaries: [], pkgs: [], entries: [] },
    dependsOn: {
      arch: ['arm64'],
      casks: [],
      formulae: ['arm-helper'],
      macos: '>= 14',
      requirements: { formula: ['arm-helper'] }
    },
    conflictsWith: { casks: [], formulae: [] }
  }
];

describe('Cask platforms and installation declarations', () => {
  it('Prefers the current version, supports legacy platforms, and keeps null downloads independent of dependencies', () => {
    const pkg = { version: '2', platforms };
    expect(selectedCaskPlatform(pkg, '')?.tag).toBe('arm64_sonoma');
    expect(selectedCaskPlatform(pkg, 'sonoma')).toMatchObject({
      version: '1',
      downloadUrl: null,
      downloadSha256: null
    });
    expect(selectedCaskPlatform(pkg, 'sonoma')?.dependsOn.casks).toEqual(['legacy-helper']);
    expect(selectedCaskPlatform({ version: '2', platforms: [] }, '')).toBeUndefined();
  });

  it('Shows architecture requirements, dependencies, and Rosetta', async () => {
    const wrapper = mount(OnCaskPlatformSelect, {
      props: { platforms, modelValue: 'arm64_sonoma' },
      global: withLocale('en-US')
    });
    expect(wrapper.text()).toContain(sharedMessages['en-US'].cask.rosetta);
    expect(wrapper.text()).toContain('arm-helper');
    await wrapper.get('select').setValue('sonoma');
    expect(wrapper.emitted('update:modelValue')).toEqual([['sonoma']]);
    await wrapper.setProps({ modelValue: 'sonoma' });
    expect(wrapper.text()).toContain('legacy-helper');
    expect(wrapper.text()).toContain('>= 13; <= 14');
    expect(wrapper.text()).not.toContain('arm-helper');
    expect(wrapper.find('section > p').exists()).toBe(false);
  });

  for (const locale of LOCALES) {
    it(`${locale}: renders fonts, paths, uninstall cleanup, and escaped scripts`, () => {
      const script = '<script>window.bad = true</script>';
      const wrapper = mount(OnCaskArtifacts, {
        global: withLocale(locale),
        props: {
          entries: [
            {
              type: 'font',
              phase: 'install',
              sources: ['Font.otf'],
              target: null,
              declaration: { font: ['Font.otf'] }
            },
            {
              type: 'app',
              phase: 'install',
              sources: ['Original.app'],
              target: 'Renamed.app',
              declaration: { app: ['Original.app', { target: 'Renamed.app' }] }
            },
            { type: 'uninstall', phase: 'uninstall', sources: [], declaration: { uninstall: [{ script }] } },
            { type: 'zap', phase: 'cleanup', sources: [], declaration: { zap: [{ trash: '~/.test' }] } }
          ]
        }
      });
      expect(wrapper.text()).toContain(sharedMessages[locale].cask.declarations);
      expect(wrapper.text()).toContain(sharedMessages[locale].cask.cleanup);
      expect(wrapper.text()).toContain('Font.otf');
      expect(wrapper.text()).toContain('Renamed.app');
      expect(wrapper.text()).toContain('~/.test');
      expect(wrapper.text()).not.toContain('/Applications/');
      expect(wrapper.find('script').exists()).toBe(false);
      expect(wrapper.findAll('details')).toHaveLength(4);
    });
  }
});
