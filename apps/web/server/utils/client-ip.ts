import { isIP } from 'node:net';

// Accept forwarded addresses only from explicitly trusted connections; use the rightmost value to ignore forged client prefixes.
export function clientIP(
  peer: string | undefined,
  forwarded: string | undefined,
  trustedProxies: string
): string | undefined {
  const address = peer?.replace(/^::ffff:/, '');
  if (!address || !isIP(address)) return undefined;
  if (
    !trustedProxies
      .split(',')
      .map(value => value.trim())
      .includes(address)
  )
    return address;
  const forwardedIP = forwarded?.split(',').at(-1)?.trim();
  return forwardedIP && isIP(forwardedIP) ? forwardedIP : address;
}
