import { describe, expect, it } from 'vitest';
import { formatCurrency } from '../src/format';

describe('Formats USD amounts', () => {
  it.each([
    ['en-US', '$1,234.50'],
    ['zh-CN', 'US$1,234.50'],
    ['ja-JP', '$1,234.50'],
    ['es-ES', '1234,50\u00a0US$'],
    ['pt-BR', 'US$\u00a01.234,50'],
    ['ru-RU', '1\u00a0234,50\u00a0$']
  ] as const)('%s 使用本地货币位置与分隔符', (locale, expected) => {
    expect(formatCurrency(1234.5, { locale })).toBe(expected);
  });

  it('Defaults to English with zero and rounding support', () => {
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(1.005)).toBe('$1.01');
    expect(formatCurrency(-12.5)).toBe('-$12.50');
  });
});
