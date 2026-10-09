import { describe, expect, it } from 'vitest';
import { suggestedLanguage } from '../app/utils/languagePreference';

describe('Locale suggestion conditions', () => {
  it('Follow preference order with regional variants across six languages', () => {
    expect(suggestedLanguage(['fr', 'ja-JP', 'ru'], 'en-US', null, null)).toBe('ja-JP');
    expect(suggestedLanguage(['pt-PT'], 'zh-CN', null, null)).toBe('pt-BR');
  });
  it('Hide for matching language, manual selection, or dismissed prompts', () => {
    expect(suggestedLanguage(['en-GB'], 'en-US', null, null)).toBeNull();
    expect(suggestedLanguage(['ru'], 'en-US', 'zh-CN', null)).toBeNull();
    expect(suggestedLanguage(['ru'], 'en-US', null, '1')).toBeNull();
  });
  it('Unsupported preferences suggest English without switching automatically', () => {
    expect(suggestedLanguage(['fr'], 'zh-CN', null, null)).toBe('en-US');
  });
});
