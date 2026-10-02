/**
 * Security headers and request identity helpers.
 *
 * The default posture is deny-by-default: a strict Content-Security-Policy with
 * no `unsafe-inline`, no `unsafe-eval` and no third-party origins, plus the
 * modern anti-sniffing / framing / referrer headers. These are applied to every
 * response, including error responses, so a bug elsewhere cannot serve a page
 * without them.
 */

/** Locked-down CSP. `'self'` only; the UI ships no inline script or style. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

/**
 * Build the base header set. Kept as a factory so tests can assert on a copy
 * instead of a live response object.
 *
 * @param {{secure: boolean}} options
 * @returns {Record<string, string>}
 */
export function securityHeaders({ secure }) {
  const headers = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    // Modern guidance: the legacy XSS auditor is itself a source of bugs, so it
    // is explicitly disabled rather than left to legacy heuristics.
    'X-XSS-Protection': '0',
    'Permissions-Policy': [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', '),
  };
  if (secure) {
    // Only meaningful over TLS; a proxy that terminates TLS reports the original
    // scheme, which is why this is gated on the request actually being secure.
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORWARDED_FOR_VALUE = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Trust a caller-supplied correlation id only when it is strictly bounded;
 * anything else gets a fresh UUID. Echoing arbitrary header bytes back to the
 * client would otherwise become a reflected-input vector.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {() => string} [generateId]
 */
export function resolveRequestId(req, generateId = defaultRequestId) {
  const supplied = req.headers['x-request-id'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof value === 'string' && SAFE_REQUEST_ID.test(value)) return value;
  return generateId();
}

/** @returns {string} */
export function defaultRequestId() {
  return globalThis.crypto.randomUUID();
}

/**
 * Derive the rate limiting / audit key for a request.
 *
 * `X-Forwarded-For` is attacker-controlled, so it is ignored unless the operator
 * has explicitly declared a trusted proxy. That prevents a trivially spoofed
 * header from bypassing per-client throttling.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function clientKey(req, trustProxy) {
  const socketAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  if (!trustProxy) return socketAddress;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return socketAddress;

  // Left-most entry is the original client when a single trusted proxy appends.
  const candidate = raw.split(',')[0].trim();
  if (!FORWARDED_FOR_VALUE.test(candidate)) return socketAddress;
  return candidate.toLowerCase();
}

/**
 * Whether the original client connection was TLS. When `trustProxy` is set the
 * first `X-Forwarded-Proto` hop decides; otherwise a plain socket is not secure.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function isSecureRequest(req, trustProxy) {
  if (!trustProxy) return false;
  const header = req.headers['x-forwarded-proto'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return false;
  return raw.split(',')[0].trim().toLowerCase() === 'https';
}
