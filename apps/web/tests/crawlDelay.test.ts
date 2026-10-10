import { describe, expect, it } from 'vitest';
import { withCrawlDelays } from '../server/utils/crawlDelay';

describe('robots.txt crawl delays', () => {
  it('adds Crawl-delay only to the delayed crawler group', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /search',
      '',
      'User-agent: ClaudeBot',
      'Disallow: /*/dependencies',
      ''
    ].join('\n');
    expect(withCrawlDelays(robots)).toBe(
      [
        'User-agent: *',
        'Disallow: /search',
        '',
        'User-agent: ClaudeBot',
        'Crawl-delay: 10',
        'Disallow: /*/dependencies',
        ''
      ].join('\n')
    );
  });

  it('keeps a multi-agent group intact by appending after the last User-agent line', () => {
    const robots = ['User-agent: ClaudeBot', 'User-agent: ExampleBot', 'Disallow: /private'].join('\n');
    expect(withCrawlDelays(robots, { ClaudeBot: 5 })).toBe(
      ['User-agent: ClaudeBot', 'User-agent: ExampleBot', 'Crawl-delay: 5', 'Disallow: /private'].join('\n')
    );
  });

  it('leaves robots.txt unchanged when no group names a delayed crawler', () => {
    const robots = 'User-agent: *\nDisallow: /search\n';
    expect(withCrawlDelays(robots)).toBe(robots);
  });
});
