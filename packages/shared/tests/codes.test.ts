import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPIRED_TOKEN_CODES, ErrorCode, LOGOUT_CODES, MODAL_LOGOUT_CODES, isErrorCode } from '../src/codes';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// Development docs are not published; compare §3 error codes only when docs exist locally.
const apiDoc = new URL('../../../docs/04-api.md', import.meta.url);

describe('Keeps business codes consistent with their source', () => {
  it('Matches Go constant names and values', () => {
    const go = read('../../../apps/server/internal/domain/codes.go');
    const goCodes = Object.fromEntries(
      Array.from(go.matchAll(/Code(\w+)\s*=\s*"(\d{4})"/g), ([, name, code]) => [name, code])
    );
    expect(goCodes).toEqual(ErrorCode);
  });

  it.skipIf(!existsSync(apiDoc))('Matches the local documentation table when available', () => {
    const doc = readFileSync(apiDoc, 'utf8');
    const section = doc.slice(doc.indexOf('## 3. 错误码'), doc.indexOf('## 4.'));
    const documented = Array.from(section.matchAll(/^\| `(\d{4})` \|/gm), ([, code]) => code).sort();
    expect(documented).toEqual(Object.values(ErrorCode).sort());
  });

  it('Recognizes logout environment codes', () => {
    const env = read('../../../apps/admin/.env');
    const list = (key: string) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.split(',') ?? [];
    expect(list('VITE_SERVICE_LOGOUT_CODES')).toEqual(LOGOUT_CODES);
    expect(list('VITE_SERVICE_MODAL_LOGOUT_CODES')).toEqual(MODAL_LOGOUT_CODES);
    expect(list('VITE_SERVICE_EXPIRED_TOKEN_CODES')).toEqual(EXPIRED_TOKEN_CODES);
    expect(env).toMatch(new RegExp(`^VITE_SERVICE_SUCCESS_CODE=${ErrorCode.OK}$`, 'm'));
  });

  it('isErrorCode', () => {
    expect(isErrorCode('1101')).toBe(true);
    expect(isErrorCode('1234')).toBe(false);
    expect(isErrorCode(1101)).toBe(false);
  });
});
