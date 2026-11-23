import { describe, expect, it } from 'vitest';
import { pickOfficialProvider } from '@/hermes/providers';

describe('Hermes provider picker', () => {
  it('prefers a scoped custom endpoint over the bare canonical row', () => {
    // A panel host marks both rows authenticated (its model-config fallback is not a skeleton),
    // and lists the stale `custom` row first. Sending that slug reaches a dead endpoint.
    const rows = [
      { slug: 'custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'custom:newapi', authenticated: true, is_current: true, models: ['grok-4.7', 'grok-4.6'] }
    ];

    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('custom:newapi');
  });

  it('falls back to the bare custom row when no named entry carries models', () => {
    const rows = [
      { slug: 'custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'custom:newapi', authenticated: false, is_current: false, models: [] }
    ];

    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('custom');
  });

  it('keeps the local openavoo-custom row when a named entry is not the current route', () => {
    const rows = [
      { slug: 'openavoo-custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'custom:newapi', authenticated: true, is_current: false, models: ['grok-4.6'] }
    ];

    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('openavoo-custom');
  });

  it('keeps openavoo-custom when a bare custom row is also usable', () => {
    const rows = [
      { slug: 'custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'openavoo-custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'custom:newapi', authenticated: true, is_current: false, models: ['grok-4.6'] }
    ];

    expect(pickOfficialProvider(rows, 'custom')?.slug).toBe('openavoo-custom');
  });

  it('keeps a built-in card on its own row', () => {
    const rows = [
      { slug: 'openrouter', authenticated: true, is_current: true, models: ['openrouter/auto'] },
      { slug: 'custom:openrouter', authenticated: true, is_current: true, models: ['other/model'] }
    ];

    expect(pickOfficialProvider(rows, 'openrouter')?.slug).toBe('openrouter');
  });

  it('never routes a built-in card to the shared openavoo-custom endpoint', () => {
    const rows = [
      { slug: 'openavoo-custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'openai-api', authenticated: false, is_current: false, models: [] }
    ];

    expect(pickOfficialProvider(rows, 'openai')?.slug).toBe('openai-api');
  });

  it('keeps a built-in card on its own authenticated row next to openavoo-custom', () => {
    const rows = [
      { slug: 'openavoo-custom', authenticated: true, is_current: true, models: ['grok-4.7'] },
      { slug: 'openai-api', authenticated: true, is_current: true, models: ['gpt-5.4'] }
    ];

    expect(pickOfficialProvider(rows, 'openai')?.slug).toBe('openai-api');
  });
});
