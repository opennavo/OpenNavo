import { describe, expect, it } from 'vitest';
import { architectures, displayUrl, installTrend, monthlyInstalls } from '../src/utils/package';

describe('Detail-page display calculations', () => {
  it('Calculates monthly average installations and trends', () => {
    const installs = { d30: 17392, d90: 101147, d365: 478472 };
    expect(monthlyInstalls(installs)).toEqual([
      { key: 'd30', value: 17392 },
      { key: 'avg90', value: 33716 },
      { key: 'avg365', value: 39873 }
    ]);
    expect(installTrend(installs)).toBe('slowing');
    expect(installTrend({ d30: 5000, d90: 9000, d365: 36000 })).toBe('rising');
    expect(installTrend({ d30: 3000, d90: 9000, d365: 36000 })).toBe('steady');
    expect(installTrend({ d30: 10, d90: 0, d365: 0 })).toBe('steady');
  });

  it('Displays architectures and addresses', () => {
    expect(architectures({ arm64: true, x86_64: true })).toEqual(['arm64', 'x86_64']);
    expect(architectures({ arm64: true, x86_64: false })).toEqual(['arm64']);
    expect(displayUrl('https://code.visualstudio.com/')).toBe('code.visualstudio.com');
    expect(displayUrl('http://example.com/updates')).toBe('example.com/updates');
  });
});
