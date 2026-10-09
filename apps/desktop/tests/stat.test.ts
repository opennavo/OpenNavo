import { expect, it } from 'vitest';
import { formatBytes } from '@opennavo/shared';
import { splitValue } from '../src/utils/stat';

it('Russian sizes preserve nonbreaking grouping spaces within numbers and split only units', () => {
  const parts = splitValue(formatBytes(5_000_000_000_000_000, { locale: 'ru-RU' }));
  expect(parts.value).toBe(new Intl.NumberFormat('ru-RU').format(5000));
  expect(parts.unit).toBe('ТБ');
});
