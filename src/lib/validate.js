/**
 * Schema validation for every untrusted boundary (HTTP bodies and query strings).
 *
 * Design notes:
 *  - Output objects are built from a *schema allow-list*, so an attacker-supplied
 *    key can never reach stored state. This is what prevents mass assignment and
 *    prototype pollution (`__proto__` / `constructor` / `prototype` are rejected
 *    outright, and unknown keys are refused when the schema is strict).
 *  - Error messages name fields, never values: reflecting rejected input back to
 *    the client would turn validation into an injection surface.
 *  - Nesting is depth-bounded so a deeply nested payload cannot exhaust the stack.
 */

/** Keys that must never appear on inbound objects. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 8;
const SAFE_KEY = /^[A-Za-z0-9_$.-]{1,40}$/;
const INTEGER_STRING = /^[+-]?\d{1,15}$/;
const NUMBER_STRING = /^[+-]?(?:\d{1,15}|\d{1,15}\.\d{1,6})$/;
const DATE_STRING = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})' +
    '(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$',
);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Render an untrusted key for an error message without echoing arbitrary bytes.
 *
 * @param {string} key
 * @returns {string}
 */
function safeKeyLabel(key) {
  return SAFE_KEY.test(key) ? key : '<invalid-key>';
}

/**
 * @param {{path: string, code: string, message: string}[]} errors
 * @param {string} path
 * @param {string} code
 * @param {string} message
 */
function push(errors, path, code, message) {
  if (errors.length < 50) errors.push({ path, code, message });
}

/**
 * Define a reusable schema.
 *
 * @param {Record<string, object>} fields
 * @param {{strict?: boolean}} [options] `strict: false` silently drops unknown keys.
 * @returns {{fields: Record<string, object>, strict: boolean}}
 */
export function defineSchema(fields, options = {}) {
  return Object.freeze({ fields: Object.freeze(fields), strict: options.strict !== false });
}

/**
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @returns {unknown}
 */
function coerceString(raw, field, path, errors) {
  if (typeof raw !== 'string') {
    push(errors, path, 'invalid_type', `${path} must be a string`);
    return undefined;
  }
  let value = field.trim === false ? raw : raw.trim();
  if (field.lower === true) value = value.toLowerCase();
  if (field.min !== undefined && [...value].length < field.min) {
    push(errors, path, 'too_short', `${path} must be at least ${field.min} character(s)`);
    return undefined;
  }
  if (field.max !== undefined && [...value].length > field.max) {
    push(errors, path, 'too_long', `${path} must be at most ${field.max} character(s)`);
    return undefined;
  }
  if (field.pattern !== undefined && !field.pattern.test(value)) {
    push(errors, path, 'invalid_format', `${path} has an invalid format`);
    return undefined;
  }
  if (Array.isArray(field.values) && !field.values.includes(value)) {
    push(errors, path, 'invalid_enum', `${path} must be one of: ${field.values.join(', ')}`);
    return undefined;
  }
  return value;
}

/**
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @returns {number|undefined}
 */
function coerceInteger(raw, field, path, errors) {
  let value;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    value = raw;
  } else if (field.coerceFromString === true && typeof raw === 'string' && INTEGER_STRING.test(raw)) {
    value = Number(raw);
  } else {
    push(errors, path, 'invalid_type', `${path} must be an integer`);
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    push(errors, path, 'invalid_type', `${path} must be an integer`);
    return undefined;
  }
  if (field.min !== undefined && value < field.min) {
    push(errors, path, 'out_of_range', `${path} must be >= ${field.min}`);
    return undefined;
  }
  if (field.max !== undefined && value > field.max) {
    push(errors, path, 'out_of_range', `${path} must be <= ${field.max}`);
    return undefined;
  }
  return value;
}

/**
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @returns {number|undefined}
 */
function coerceNumber(raw, field, path, errors) {
  let value;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = raw;
  } else if (field.coerceFromString === true && typeof raw === 'string' && NUMBER_STRING.test(raw)) {
    value = Number(raw);
  } else {
    push(errors, path, 'invalid_type', `${path} must be a number`);
    return undefined;
  }
  if (!Number.isFinite(value)) {
    push(errors, path, 'invalid_type', `${path} must be a finite number`);
    return undefined;
  }
  if (field.min !== undefined && value < field.min) {
    push(errors, path, 'out_of_range', `${path} must be >= ${field.min}`);
    return undefined;
  }
  if (field.max !== undefined && value > field.max) {
    push(errors, path, 'out_of_range', `${path} must be <= ${field.max}`);
    return undefined;
  }
  return value;
}

/**
 * Strict calendar validation: rejects impossible dates such as 2026-02-31 and
 * degenerate zero dates that `new Date()` would otherwise silently roll over.
 *
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @returns {string|null|undefined}
 */
function coerceDate(raw, field, path, errors) {
  if (raw === null || raw === '') {
    if (field.nullable === true) return null;
    push(errors, path, 'required', `${path} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    push(errors, path, 'invalid_type', `${path} must be an ISO date string (YYYY-MM-DD)`);
    return undefined;
  }
  const match = DATE_STRING.exec(raw.trim());
  if (match === null) {
    push(errors, path, 'invalid_format', `${path} must be an ISO date string (YYYY-MM-DD)`);
    return undefined;
  }
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1900 || y > 2999) {
    push(errors, path, 'invalid_format', `${path} must be between 1900 and 2999`);
    return undefined;
  }
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    push(errors, path, 'invalid_format', `${path} is not a real calendar date`);
    return undefined;
  }
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59)) {
    push(errors, path, 'invalid_format', `${path} has an invalid time component`);
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

/**
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @param {number} depth
 * @returns {unknown}
 */
function coerceArray(raw, field, path, errors, depth) {
  if (!Array.isArray(raw)) {
    push(errors, path, 'invalid_type', `${path} must be an array`);
    return undefined;
  }
  if (field.maxItems !== undefined && raw.length > field.maxItems) {
    push(errors, path, 'too_many_items', `${path} must contain at most ${field.maxItems} item(s)`);
    return undefined;
  }
  const out = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    if (entry === null || entry === undefined) return;
    const coerced = coerceField(entry, field.items, `${path}[${index}]`, errors, depth + 1);
    if (coerced === undefined) return;
    const key = typeof coerced === 'string' ? coerced : JSON.stringify(coerced);
    if (field.unique === true) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    out.push(coerced);
  });
  return out;
}

/**
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @param {number} depth
 * @returns {Record<string, unknown>|undefined}
 */
function coerceObject(raw, field, path, errors, depth) {
  if (!isPlainObject(raw)) {
    push(errors, path, 'invalid_type', `${path} must be an object`);
    return undefined;
  }
  return validateInto(field.fields, raw, path, errors, depth + 1, true);
}

/**
 * Dispatch a single field. Returns `undefined` when the value is invalid.
 *
 * @param {unknown} raw
 * @param {object} field
 * @param {string} path
 * @param {Array<object>} errors
 * @param {number} depth
 * @returns {unknown}
 */
function coerceField(raw, field, path, errors, depth) {
  if (depth > MAX_DEPTH) {
    push(errors, path, 'too_deep', `${path} exceeds the maximum nesting depth`);
    return undefined;
  }
  switch (field.type) {
    case 'string':
      return coerceString(raw, field, path, errors);
    case 'integer':
      return coerceInteger(raw, field, path, errors);
    case 'number':
      return coerceNumber(raw, field, path, errors);
    case 'boolean':
      if (typeof raw !== 'boolean') {
        push(errors, path, 'invalid_type', `${path} must be a boolean`);
        return undefined;
      }
      return raw;
    case 'date':
      return coerceDate(raw, field, path, errors);
    case 'enum':
      if (typeof raw !== 'string' || !field.values.includes(raw)) {
        push(errors, path, 'invalid_enum', `${path} must be one of: ${field.values.join(', ')}`);
        return undefined;
      }
      return raw;
    case 'array':
      return coerceArray(raw, field, path, errors, depth);
    case 'object':
      return coerceObject(raw, field, path, errors, depth);
    default:
      throw new TypeError(`Unsupported field type: ${field.type}`);
  }
}

/**
 * Validate `input` against `fields`, producing a *new* object containing only
 * schema-declared keys.
 *
 * @param {Record<string, object>} fields
 * @param {Record<string, unknown>} input
 * @param {string} prefix
 * @param {Array<object>} errors
 * @param {number} depth
 * @param {boolean} strict
 * @returns {Record<string, unknown>}
 */
function validateInto(fields, input, prefix, errors, depth, strict) {
  const out = {};
  for (const [key, field] of Object.entries(fields)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const present = Object.hasOwn(input, key);
    let raw = present ? input[key] : undefined;

    if (!present || raw === undefined) {
      if (field.default !== undefined) {
        out[key] = Array.isArray(field.default) ? [...field.default] : field.default;
      } else if (field.required === true) {
        push(errors, path, 'required', `${path} is required`);
      }
      // Absent optional fields are left absent on purpose: a PATCH must be a
      // genuine partial update, not a silent reset of fields it never mentioned.
      continue;
    }

    if (raw === null) {
      if (field.nullable === true) {
        out[key] = field.type === 'array' ? [] : null;
        continue;
      }
      push(errors, path, 'invalid_type', `${path} must not be null`);
      continue;
    }

    const coerced = coerceField(raw, field, path, errors, depth);
    if (coerced !== undefined) out[key] = coerced;
  }

  for (const key of Object.keys(input)) {
    // Untrusted key bytes never reach the message verbatim.
    const label = safeKeyLabel(key);
    const fieldPath = prefix === '' ? label : `${prefix}.${label}`;
    if (FORBIDDEN_KEYS.has(key)) {
      push(errors, fieldPath, 'forbidden_key', 'Field is not allowed');
      continue;
    }
    if (strict && !Object.hasOwn(fields, key)) {
      push(errors, fieldPath, 'unknown_key', 'Unknown field is not allowed');
    }
  }

  return out;
}

/**
 * Validate `input` against `schema`.
 *
 * @param {{fields: Record<string, object>, strict: boolean}} schema
 * @param {unknown} input
 * @returns {{ok: boolean, value: Record<string, unknown>|undefined, errors: Array<object>}}
 */
export function validate(schema, input) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      value: undefined,
      errors: [{ path: '', code: 'invalid_type', message: 'Request body must be a JSON object' }],
    };
  }
  const errors = [];
  const value = validateInto(schema.fields, input, '', errors, 0, schema.strict);
  if (errors.length > 0) return { ok: false, value: undefined, errors };
  return { ok: true, value, errors: [] };
}

const TAG = { type: 'string', min: 1, max: 32, trim: true, lower: true };

/** Body schema for `POST /api/items`. */
export const itemCreateSchema = defineSchema({
  name: { type: 'string', required: true, min: 1, max: 120 },
  category: { type: 'string', max: 64, lower: true, default: 'uncategorized' },
  room: { type: 'string', max: 64, lower: true },
  quantity: { type: 'integer', min: 1, max: 100_000, default: 1 },
  purchaseDate: { type: 'date', nullable: true },
  value: { type: 'number', min: 0, max: 1_000_000_000, nullable: true },
  notes: { type: 'string', max: 2000, default: '' },
  tags: { type: 'array', items: TAG, maxItems: 16, unique: true, default: [] },
});

/** Body schema for `PATCH /api/items/:id`; every field is optional. */
export const itemPatchSchema = defineSchema({
  name: { type: 'string', min: 1, max: 120 },
  category: { type: 'string', max: 64, lower: true },
  room: { type: 'string', max: 64, lower: true },
  quantity: { type: 'integer', min: 1, max: 100_000 },
  purchaseDate: { type: 'date', nullable: true },
  value: { type: 'number', min: 0, max: 1_000_000_000, nullable: true },
  notes: { type: 'string', max: 2000 },
  tags: { type: 'array', items: TAG, maxItems: 16, unique: true },
  // Optional optimistic-concurrency token echoed back by the client.
  version: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
});

/** Query schema for `GET /api/items`; every value arrives as a string. */
export const itemListQuerySchema = defineSchema({
  q: { type: 'string', max: 120, coerceFromString: true },
  room: { type: 'string', max: 64, lower: true, coerceFromString: true },
  category: { type: 'string', max: 64, lower: true, coerceFromString: true },
  limit: { type: 'integer', min: 1, max: 100, coerceFromString: true, default: 50 },
  offset: { type: 'integer', min: 0, max: 1_000_000, coerceFromString: true, default: 0 },
});
