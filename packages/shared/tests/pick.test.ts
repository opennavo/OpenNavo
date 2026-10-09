import { describe, expect, it } from 'vitest';
import { LOCALES, pick } from '../src';

describe('Falls back for sparse translations', () => {
  it.each(LOCALES)('Prefers the requested %s locale', locale => {
    expect(pick({ 'en-US': 'English', 'zh-CN': '原文', [locale]: 'Requested' }, locale, 'zh-CN')).toBe('Requested');
  });
  it('Tries English before the source locale without treating unrelated translations as the source', () => {
    expect(pick({ 'en-US': 'English', 'zh-CN': '原文' }, 'ja-JP', 'zh-CN')).toBe('English');
    expect(pick({ 'zh-CN': '原文' }, 'ru-RU', 'zh-CN')).toBe('原文');
    expect(pick({ 'zh-CN': '另一种语言' }, 'ru-RU', 'en-US', 'Official')).toBe('Official');
  });
  it('Falls back to the official name for empty or null values', () => {
    expect(pick({ 'ja-JP': ' ', 'en-US': null, 'es-ES': 'Fuente' }, 'ja-JP', 'es-ES')).toBe('Fuente');
    expect(pick({ 'ja-JP': '' }, 'ja-JP', 'es-ES', 'Official')).toBe('Official');
    expect(pick(null, 'ru-RU')).toBe('');
    expect(pick(undefined, 'en-US')).toBe('');
    expect(pick({ 'en-US': 'English' }, 'ja-JP')).toBe('English');
  });
});
