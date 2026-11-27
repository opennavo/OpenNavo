/** Validation shared by the connection form; the Rust side applies the same rules. */
export type PanelUrlCheck = 'ok' | 'invalid' | 'insecure';

export function validatePanelBaseUrl(raw: string): PanelUrlCheck {
  try {
    const parsed = new URL(raw.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'invalid';
    if (parsed.protocol !== 'http:') return 'ok';
    // WHATWG keeps the brackets on an IPv6 hostname (`[::1]`), so compare the bare address.
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const octets = host.split('.').map(Number);
    const tailnet =
      octets.length === 4 && (octets[0] ?? 0) === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
    if (tailnet || loopback || host.endsWith('.ts.net')) return 'ok';
    return 'insecure';
  } catch {
    return 'invalid';
  }
}
