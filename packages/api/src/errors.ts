import { ErrorCode } from '@opennavo/shared';

/** No response due to network failure, timeout, browser blocking, etc. */
export const NETWORK_ERROR = 'network';

export interface ApiErrorInit {
  code: string;
  msg: string;
  /** HTTP status, or zero without a response. */
  status: number;
  requestId: string | null;
  cause?: unknown;
}

/** API failure: business code other than 0000, or incomplete request (04 §7.1). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor({ code, msg, status, requestId, cause }: ApiErrorInit) {
    super(msg, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }

  /** User-facing explanation localized by the server to the request language. */
  get msg(): string {
    return this.message;
  }

  get isNotFound(): boolean {
    return this.code === ErrorCode.NotFound;
  }

  get isNetworkError(): boolean {
    return this.code === NETWORK_ERROR;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

interface EnvelopeLike {
  code: string;
  msg: string;
}

function isEnvelope(value: unknown): value is EnvelopeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EnvelopeLike).code === 'string' &&
    typeof (value as EnvelopeLike).msg === 'string'
  );
}

/** Convert failed responses to ApiError; nonstandard bodies such as gateway HTML map HTTP status to generic business codes. */
export function toApiError(body: unknown, response: Response): ApiError {
  const requestId = response.headers.get('X-Request-Id');
  if (isEnvelope(body)) return new ApiError({ code: body.code, msg: body.msg, status: response.status, requestId });
  return new ApiError({
    code: response.status === 404 ? ErrorCode.NotFound : ErrorCode.Internal,
    msg: `HTTP ${response.status}`,
    status: response.status,
    requestId
  });
}
