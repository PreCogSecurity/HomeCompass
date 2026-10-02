/**
 * Structured application errors.
 *
 * Every expected failure (bad input, missing record, throttling) is raised as an
 * `AppError` so the HTTP layer can turn it into a uniform, leak-free JSON error
 * response. Unexpected throwables stay plain `Error`s and are reported as 500s
 * without exposing internals to the client.
 */

/** HTTP status -> stable machine readable code, used by the error serializer. */
export class AppError extends Error {
  /**
   * @param {string} message Client-safe message. Never interpolate user input.
   * @param {{status?: number, code?: string, details?: unknown,
   *          headers?: Record<string, string>, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    const { status = 500, code = 'internal_error', details, headers, cause } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (headers !== undefined) this.headers = headers;
    if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(this, AppError);
  }
}

/** 400 - the request itself is malformed or unusable. */
export function badRequest(message = 'Malformed request', details) {
  return new AppError(message, { status: 400, code: 'bad_request', details });
}

/** 404 - route or resource does not exist. */
export function notFound(message = 'Resource not found') {
  return new AppError(message, { status: 404, code: 'not_found' });
}

/** 405 - route exists but not for this method. Carries the `Allow` header. */
export function methodNotAllowed(allow) {
  return new AppError('Method not allowed', {
    status: 405,
    code: 'method_not_allowed',
    headers: { Allow: allow.join(', ') },
  });
}

/** 409 - optimistic concurrency conflict. */
export function conflict(message = 'Resource was modified by another request') {
  return new AppError(message, { status: 409, code: 'conflict' });
}

/**
 * 421 - the `Host` header is not one this deployment answers for.
 *
 * This is the DNS rebinding defence. The response deliberately does not echo
 * the rejected value, so the endpoint cannot be used as a Host-header oracle.
 */
export function misdirectedRequest(message = 'Host header is not served by this instance') {
  return new AppError(message, { status: 421, code: 'misdirected_request' });
}

/** 413 - request body exceeded the configured limit. */
export function payloadTooLarge(message = 'Request body too large') {
  return new AppError(message, { status: 413, code: 'payload_too_large' });
}

/** 415 - unsupported request media type. */
export function unsupportedMediaType(message = 'Expected application/json') {
  return new AppError(message, { status: 415, code: 'unsupported_media_type' });
}

/** 422 - syntactically valid JSON that fails schema validation. */
export function validationFailed(errors, message = 'Request validation failed') {
  return new AppError(message, {
    status: 422,
    code: 'validation_failed',
    details: { errors },
  });
}

/** 429 - rate limit exhausted. */
export function tooManyRequests(retryAfterSeconds) {
  return new AppError('Too many requests', {
    status: 429,
    code: 'rate_limited',
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

/**
 * Serialize any thrown value into the single error envelope used by the API.
 * Only `AppError`s contribute client-visible detail; everything else is opaque.
 *
 * @param {unknown} error
 * @param {string} requestId
 */
export function toErrorResponse(error, requestId) {
  if (error instanceof AppError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
    };
    if (error.details !== undefined) body.error.details = error.details;
    return { status: error.status, body, headers: error.headers };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Internal server error',
        requestId,
      },
    },
    headers: undefined,
  };
}
