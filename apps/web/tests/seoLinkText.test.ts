import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Lighthouse's SEO link-text audit fails anchors whose exact visible text is a generic phrase
// (lighthouse/core/audits/seo/link-text.js). The related-packages link used to be "See more" and
// dropped the English detail pages to 0.92.
const GENERIC_LINK_TEXT = new Set([
  'click here',
  'here',
  'learn more',
  'more',
  'more info',
  'more information',
  'read more',
  'see more'
]);
const locales = ['en-US', 'zh-CN', 'zh-Hant', 'ja-JP', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'pt-BR', 'ru-RU'];

it('related packages link text stays descriptive', () => {
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
    expect(GENERIC_LINK_TEXT.has(messages.package.relatedMore.trim().toLowerCase()), locale).toBe(false);
  }
});
