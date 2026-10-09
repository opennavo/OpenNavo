import { describe, expect, it } from 'vitest';
import { clientIP } from '../server/utils/client-ip';

describe('SSR visitor identity', () => {
  it('keeps visitors behind the trusted entry proxy separate', () => {
    expect(clientIP('172.30.80.2', '203.0.113.1', '172.30.80.2')).toBe('203.0.113.1');
    expect(clientIP('::ffff:172.30.80.2', '203.0.113.2', '172.30.80.2')).toBe('203.0.113.2');
  });
  it('ignores spoofed headers from direct clients and spoofed chain prefixes', () => {
    expect(clientIP('203.0.113.1', '198.51.100.1', '172.30.80.2')).toBe('203.0.113.1');
    expect(clientIP('172.30.80.2', '198.51.100.1, 203.0.113.1', '172.30.80.2')).toBe('203.0.113.1');
    expect(clientIP('172.30.80.2', '203.0.113.1', '')).toBe('172.30.80.2');
  });
  it('rejects invalid addresses and supports IPv6', () => {
    expect(clientIP('172.30.80.2', 'invalid', '172.30.80.2')).toBe('172.30.80.2');
    expect(clientIP('172.30.80.2', '2001:db8::1', '172.30.80.2')).toBe('2001:db8::1');
    expect(clientIP(undefined, '203.0.113.1', '172.30.80.2')).toBeUndefined();
  });
});
