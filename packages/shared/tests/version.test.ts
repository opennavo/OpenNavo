import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersions, isOutdated } from '../src/version';

interface VersionCase {
  left: string;
  right: string;
  expected: -1 | 0 | 1 | null;
}

// Shared test cases read by Go, TS, and Rust.
const cases = JSON.parse(
  readFileSync(new URL('../../../apps/server/testdata/version_cases.json', import.meta.url), 'utf8')
) as VersionCase[];

describe('Shared comparison behavior', () => {
  it('Covers at least 60 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases)('$left vs $right → $expected', ({ left, right, expected }) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});

describe('Handles additional edge cases', () => {
  it.each([
    // A lone letter without digits is a patch suffix (openssl 1.1.1a), newer than the release.
    ['1.1.1a', '1.1.1', 1],
    ['1.1.1a', '1.1.1b', -1],
    // Only a/b immediately followed by digits mean alpha/beta.
    ['1.0b1', '1.0', -1],
    ['1.0-patch1', '1.0p1', 0],
    // Suffix digits sort above letters.
    ['1.0-alpha.1', '1.0-alpha.beta', 1],
    ['1.0-alpha.beta', '1.0-alpha.1', -1],
    ['1.0-alpha-z', '1.0-alpha', 1],
    ['1.0-alpha', '1.0-alpha-z', -1],
    ['HEAD', 'head-1234', 0],
    ['latest', 'HEAD', null]
  ] as const)('%s vs %s → %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});

describe('isOutdated', () => {
  it('Reports updates only when the installed version is definitely older', () => {
    expect(isOutdated('1.139.1', '1.140.0')).toBe(true);
    expect(isOutdated('1.140.0', '1.140.0')).toBe(false);
    expect(isOutdated('1.141.0', '1.140.0')).toBe(false);
    expect(isOutdated('latest', '1.0')).toBe(false);
    expect(isOutdated('', '1.0')).toBe(false);
  });
});
