// Business codes (04 §3), matching apps/server/internal/domain/codes.go one-to-one; tests verify parity.

export const ErrorCode = {
  OK: '0000',
  Validation: '1001',
  NotFound: '1002',
  Conflict: '1003',
  Forbidden: '1004',
  RateLimited: '1005',
  InvalidState: '1006',
  InvalidUpload: '1007',
  InvalidCredentials: '1101',
  AccountLocked: '1102',
  CursorExpired: '1201',
  UpstreamUnavailable: '1301',
  LLMUnavailable: '1302',
  Internal: '5000',
  SessionInvalid: '7777',
  PasswordChanged: '7778',
  Unauthenticated: '8888',
  AccountDisabled: '8889',
  AccessExpired: '9999'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Immediate logout (soybean VITE_SERVICE_LOGOUT_CODES). */
export const LOGOUT_CODES: readonly ErrorCode[] = [ErrorCode.Unauthenticated, ErrorCode.AccountDisabled];
/** Logout after dialog (VITE_SERVICE_MODAL_LOGOUT_CODES). */
export const MODAL_LOGOUT_CODES: readonly ErrorCode[] = [ErrorCode.SessionInvalid, ErrorCode.PasswordChanged];
/** Refresh token then replay (VITE_SERVICE_EXPIRED_TOKEN_CODES); refresh itself never returns these codes. */
export const EXPIRED_TOKEN_CODES: readonly ErrorCode[] = [ErrorCode.AccessExpired];

const values = new Set<string>(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && values.has(value);
}
