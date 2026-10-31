import { IpcError } from './client';

/**
 * The user said no in OpenNavo's confirmation window, let it time out, or it was withdrawn: nothing ran, so the
 * caller goes back to where it was without an error toast.
 */
const REFUSED = new Set([
  'E_CONFIRMATION_DENIED',
  'E_CONFIRMATION_TIMEOUT',
  'E_CONFIRMATION_INVALIDATED',
  'E_CONFIRMATION_EXPIRED'
]);

export function confirmationRefused(cause: unknown): boolean {
  return cause instanceof IpcError && REFUSED.has(cause.code);
}
