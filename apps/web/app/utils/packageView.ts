// Detail display calculations (08 §10.5), pure for testing.
// Monthly installs, trends, architecture, and URL display live in shared @opennavo/ui; only web-specific calculations remain here.

/** Detail URLs: Cask-only (ADR-018), all under /apps. */
export function packagePath(token: string, tab?: 'versions' | 'dependencies' | 'details'): string {
  return `/apps/${token}${tab ? `/${tab}` : ''}`;
}

/** Mixed dependency/conflict/alternative lists: only Casks have detail links; command-line tools show names only. */
export function packageLink(kind: string, token: string): string | undefined {
  return kind === 'cask' ? packagePath(token) : undefined;
}

/** Map categories to schema.org applicationCategory (05 §6.2), defaulting to UtilitiesApplication. */
const APPLICATION_CATEGORY: Record<string, string> = {
  'developer-tools': 'DeveloperApplication',
  terminal: 'DeveloperApplication',
  languages: 'DeveloperApplication',
  databases: 'DeveloperApplication',
  virtualization: 'DeveloperApplication',
  design: 'DesignApplication',
  media: 'MultimediaApplication',
  communication: 'CommunicationApplication',
  games: 'GameApplication',
  security: 'SecurityApplication',
  education: 'EducationalApplication'
};

export function applicationCategory(slug: string | null | undefined): string {
  return (slug && APPLICATION_CATEGORY[slug]) || 'UtilitiesApplication';
}
