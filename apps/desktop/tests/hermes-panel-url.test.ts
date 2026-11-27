import { describe, expect, it } from 'vitest';
import { validatePanelBaseUrl } from '@/hermes/panelUrl';

describe('Hermes panel base URL', () => {
  it('accepts IPv6 and IPv4 loopback, tailnet and HTTPS prefixes', () => {
    expect(validatePanelBaseUrl('http://[::1]:9119')).toBe('ok');
    expect(validatePanelBaseUrl('http://[0:0:0:0:0:0:0:1]:9119')).toBe('ok');
    expect(validatePanelBaseUrl('http://127.0.0.1:9119')).toBe('ok');
    expect(validatePanelBaseUrl('http://100.64.0.9:9119')).toBe('ok');
    expect(validatePanelBaseUrl('http://panel.tail1234.ts.net:9119')).toBe('ok');
    expect(validatePanelBaseUrl('https://panel.example/hermes')).toBe('ok');
  });

  it('rejects insecure origins and parts a base URL cannot carry', () => {
    expect(validatePanelBaseUrl('http://8.8.8.8:9119')).toBe('insecure');
    expect(validatePanelBaseUrl('ftp://panel.example')).toBe('invalid');
    expect(validatePanelBaseUrl('https://user:pass@panel.example')).toBe('invalid');
    expect(validatePanelBaseUrl('https://panel.example/?token=1')).toBe('invalid');
    expect(validatePanelBaseUrl('https://panel.example/#frag')).toBe('invalid');
  });
});
