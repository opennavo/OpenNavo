import { describe, expect, it } from 'vitest';
import { developerCityLabel, developerPlaceName, type DeveloperMapPlace } from '../app/composables/useDeveloperMap';

function place(overrides: Partial<DeveloperMapPlace>): DeveloperMapPlace {
  return {
    key: 'bay-area',
    kind: 'city',
    name: '旧金山湾区',
    countryCode: 'US',
    region: 'americas',
    lat: 37.77,
    lng: -122.42,
    developers: 10,
    apps: 12,
    installs30d: 1000,
    topDevelopers: [],
    ...overrides
  };
}

describe('developer map city labels', () => {
  it('uses the bilingual city key for known cities', () => {
    expect(developerCityLabel('bay-area', '旧金山湾区', 'zh-CN')).toBe('旧金山湾区');
    expect(developerCityLabel('bay-area', '旧金山湾区', 'en-US')).toBe('San Francisco Bay Area');
  });

  it('falls back to the stored name for cities without a translation', () => {
    expect(developerCityLabel('unknown-city', '某个城市', 'en-US')).toBe('某个城市');
  });

  it('keeps country-only places as their country code', () => {
    expect(developerPlaceName(place({ kind: 'country', key: 'US', name: 'US' }), 'en-US')).toBe('US');
    expect(developerPlaceName(place({ key: 'berlin', name: '柏林' }), 'en-US')).toBe('Berlin');
  });
});
