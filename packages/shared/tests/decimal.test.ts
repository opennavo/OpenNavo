import { describe, expect, it } from 'vitest';
import { formatDecimal } from '../src/format';

describe('Supports fixed decimal places', () => {
  it.each([
    ['en-US', '12.50'],
    ['zh-CN', '12.50'],
    ['ja-JP', '12.50'],
    ['es-ES', '12,50'],
    ['pt-BR', '12,50'],
    ['ru-RU', '12,50']
  ] as const)('%s 使用对应的小数符号', (locale, expected) => {
    expect(formatDecimal(12.5, { locale })).toBe(expected);
  });
  it('Preserves English and Chinese two-decimal rounding behavior', () => {
    expect(formatDecimal(1.005)).toBe('1.00');
    expect(formatDecimal(0.125, { locale: 'zh-CN', digits: 3 })).toBe('0.125');
    expect(formatDecimal(0.125, { locale: 'ru-RU', digits: 3 })).toBe('0,125');
  });
});
