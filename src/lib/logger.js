/**
 * Structured JSON logger with secret redaction and log-forging resistance.
 *
 * Two properties matter for a security product's logs:
 *  1. Secrets must never be written to disk (logs get shipped and retained).
 *  2. Attacker-controlled values must not be able to forge extra log lines, so
 *     control characters are escaped before serialisation.
 */

/** Numeric severity ordering; `silent` disables all output. */
export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

/**
 * Field names whose values are always replaced with `[redacted]`.
 *
 * Matching is case-insensitive and camelCase-aware, so `csrfToken`, `apiKey` and
 * `X-Api-Key` are all caught. The list deliberately errs towards over-redaction:
 * a field that looks secret-shaped is masked even when it happens not to be.
 */
const SENSITIVE_KEY = new RegExp(
  '(pass(word|phrase)?|secret|token|api[-_ ]?key|auth(orization)?|cookie|' +
    'session|csrf|credential|private[-_ ]?key|signature|bearer)',
);

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  // Split camelCase boundaries first so `csrfToken` matches the `token` rule.
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

// C0 controls (incl. CR/LF), DEL and C1 controls. Escaped so a value can never
// break out of its own line or inject terminal escape sequences into a viewer.
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ENTRIES = 50;
const MAX_DEPTH = 4;
export const REDACTED = '[redacted]';

/**
 * @param {string} char Single code point.
 * @returns {boolean}
 */
function isControlChar(char) {
  const code = char.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Escape control characters and bound the length.
 *
 * Iterates by code point so surrogate pairs are never split, and appends an
 * explicit truncation marker rather than silently cutting the value.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeControlChars(value) {
  let out = '';
  let length = 0;
  for (const char of value) {
    if (length >= MAX_STRING_LENGTH) return `${out}...[truncated]`;
    out += isControlChar(char) ? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}` : char;
    length += 1;
  }
  return out;
}

/**
 * Recursively sanitise a value for logging: redaction by key, control character
 * escaping, depth/width caps to prevent a huge payload becoming a log flood.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeForLog(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return escapeControlChars(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return '[symbol]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: escapeControlChars(value.message),
      ...(value.code === undefined ? {} : { code: escapeControlChars(String(value.code)) }),
    };
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => sanitizeForLog(entry, depth + 1));
    if (value.length > MAX_ARRAY_ENTRIES) items.push(`[+${value.length - MAX_ARRAY_ENTRIES} more]`);
    return items;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLog(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * @param {{level?: keyof LOG_LEVELS, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream,
 *          now?: () => Date, base?: Record<string, unknown>}} [options]
 */
export function createLogger(options = {}) {
  const {
    level = 'info',
    stdout = process.stdout,
    stderr = process.stderr,
    now = () => new Date(),
    base = {},
  } = options;

  const threshold = LOG_LEVELS[level];
  if (threshold === undefined) {
    throw new TypeError(`Unknown log level: ${level}`);
  }

  function emit(levelName, stream, message, context) {
    if (LOG_LEVELS[levelName] < threshold) return;
    const record = {
      time: now().toISOString(),
      level: levelName,
      msg: escapeControlChars(String(message)),
      ...sanitizeForLog(base),
      ...(context === undefined ? {} : sanitizeForLog(context)),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return Object.freeze({
    level,
    debug: (message, context) => emit('debug', stdout, message, context),
    info: (message, context) => emit('info', stdout, message, context),
    warn: (message, context) => emit('warn', stderr, message, context),
    error: (message, context) => emit('error', stderr, message, context),
  });
}
