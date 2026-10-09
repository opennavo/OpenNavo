import type { PackageSummary } from '@opennavo/api';

// Example data from mockup 02-discover.
const base = {
  iconUrl: null,
  rank30d: null,
  autoUpdates: false,
  deprecated: false,
  disabled: false,
  isFont: false,
  isLibrary: false,
  editorChoice: false,
  versionChangedAt: '2026-09-30T14:53:51Z'
};

export const samplePackagesZhCN: PackageSummary[] = [
  {
    ...base,
    kind: 'cask',
    token: 'docker-desktop',
    name: 'Docker Desktop',
    displayName: 'Docker Desktop',
    summary: '构建与分享容器化应用和微服务',
    accentColor: '#1D63ED',
    version: '4.93.0,240920',
    primaryCategory: { slug: 'virtualization', name: '虚拟化与容器', icon: 'lucide:boxes' },
    installs30d: 20043
  },
  {
    ...base,
    kind: 'cask',
    token: 'visual-studio-code',
    name: 'Microsoft Visual Studio Code',
    displayName: 'Visual Studio Code',
    summary: '开源代码编辑器',
    accentColor: '#2F8FEF',
    version: '1.140.0',
    primaryCategory: { slug: 'developer-tools', name: '开发工具', icon: 'lucide:code-xml' },
    installs30d: 17394,
    autoUpdates: true
  },
  {
    ...base,
    kind: 'cask',
    token: 'blender',
    name: 'Blender',
    displayName: 'Blender',
    summary: '3D 创作套件',
    accentColor: '#E87D0D',
    version: '5.2.2',
    primaryCategory: { slug: 'design', name: '设计', icon: 'lucide:pen-tool' },
    installs30d: 13999
  },
  {
    ...base,
    kind: 'cask',
    token: 'google-chrome',
    name: 'Google Chrome',
    displayName: 'Google Chrome',
    summary: '网页浏览器',
    accentColor: null,
    version: '154.0.7731.0',
    primaryCategory: { slug: 'browsers', name: '浏览器', icon: 'lucide:globe' },
    installs30d: 11472,
    autoUpdates: true
  },
  {
    ...base,
    kind: 'cask',
    token: 'orbstack',
    name: 'OrbStack',
    displayName: 'OrbStack',
    summary: 'Docker Desktop 的轻量替代',
    accentColor: '#7B3FF2',
    version: '2.2.3',
    primaryCategory: { slug: 'virtualization', name: '虚拟化与容器', icon: 'lucide:boxes' },
    installs30d: 9129
  },
  {
    ...base,
    kind: 'cask',
    token: 'obsidian',
    name: 'Obsidian',
    displayName: 'Obsidian',
    summary: '基于本地 Markdown 文件的知识库',
    accentColor: '#7C3AED',
    version: '1.13.7',
    primaryCategory: { slug: 'writing', name: '写作与笔记', icon: 'lucide:notebook-pen' },
    installs30d: 8685
  },
  {
    ...base,
    kind: 'formula',
    token: 'codex',
    name: 'codex',
    displayName: 'Codex',
    summary: 'OpenAI 的终端编程智能体',
    accentColor: null,
    version: '0.71.0',
    primaryCategory: null,
    installs30d: 91234
  }
];

// Preserve the original Chinese design fixtures while presenting English by default.
const englishText: Record<string, [string, string | null]> = {
  'docker-desktop': ['Build and share containerized apps and microservices', 'Virtualization and containers'],
  'visual-studio-code': ['Open-source code editor', 'Developer tools'],
  blender: ['3D creation suite', 'Design'],
  'google-chrome': ['Web browser', 'Browsers'],
  orbstack: ['Lightweight alternative to Docker Desktop', 'Virtualization and containers'],
  obsidian: ['Knowledge base built on local Markdown files', 'Writing and notes'],
  codex: ['OpenAI coding agent for the terminal', null]
};
export const samplePackages: PackageSummary[] = samplePackagesZhCN.map(pkg => {
  const [summary, category] = englishText[pkg.token]!;
  return {
    ...pkg,
    summary,
    primaryCategory: pkg.primaryCategory ? { ...pkg.primaryCategory, name: category! } : null
  };
});
