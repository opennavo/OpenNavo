// Types for release-lib.mjs (tests and editors; implementation in the matching .mjs file).
export type ReleaseTarget = 'darwin-aarch64' | 'darwin-x86_64' | 'dmg-universal';

export interface TargetSpec {
  rustTarget: string;
  bundle: 'app' | 'dmg';
  file: (version: string) => string;
}

export interface ReleaseArtifact {
  target: ReleaseTarget | string;
  url: string;
  signature: string | null;
  bytes: number;
  sha256: string;
}

export interface ReleaseBody {
  version: string;
  channel: string;
  minMacos: string;
  sourceLocale: 'zh-CN';
  i18n: Record<'zh-CN' | 'en-US', { notes: string }>;
  artifacts: ReleaseArtifact[];
}

export const TARGETS: Record<ReleaseTarget, TargetSpec>;
export function isReleaseVersion(version: string): boolean;
export function channelOf(version: string): 'stable' | 'beta';
export function versionFromTag(tag: string): string;
export function artifactUrl(baseUrl: string, version: string, file: string): string;
export function githubBase(repository: string): string;
export function githubArtifactUrl(repository: string, version: string, file: string): string;
export function describeFile(path: string): { bytes: number; sha256: string };
export function releaseBody(input: {
  version: string;
  channel: string;
  artifacts: ReleaseArtifact[];
  notesZh?: string;
  notesEn?: string;
  minMacos?: string;
}): ReleaseBody;
export function renderCask(
  template: string,
  values: { version: string; sha256: string; downloadUrl: string; manifestUrl: string; homepage: string }
): string;
