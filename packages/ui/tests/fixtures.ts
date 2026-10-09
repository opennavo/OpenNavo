import type { PackageSummary } from '@opennavo/api';

export function packageSummary(overrides: Partial<PackageSummary> = {}): PackageSummary {
  return {
    kind: 'cask',
    token: 'docker-desktop',
    name: 'Docker Desktop',
    displayName: 'Docker Desktop',
    summary: '构建与分享容器化应用和微服务',
    iconUrl: null,
    accentColor: '#1D63ED',
    version: '4.93.0,240920',
    primaryCategory: { slug: 'virtualization', name: '虚拟化与容器', icon: 'lucide:boxes' },
    installs30d: 20043,
    rank30d: 4,
    autoUpdates: true,
    deprecated: false,
    disabled: false,
    isFont: false,
    isLibrary: false,
    editorChoice: false,
    versionChangedAt: '2026-09-30T14:53:51Z',
    ...overrides
  };
}
