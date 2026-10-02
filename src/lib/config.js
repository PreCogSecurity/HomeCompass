/**
 * Configuration loading and validation.
 *
 * Everything is read from the environment (with an optional `.env` file), then
 * validated eagerly so a typo fails at boot with a clear message instead of
 * surfacing as a confusing runtime error later.
 */
import path from 'node:path';
import { buildAllowedHosts } from './host.js';
import { LOG_LEVELS } from './logger.js';

export const NODE_ENVS = Object.freeze(['development', 'test', 'production']);
export const SHUTDOWN_TIMEOUT_MIN_MS = 1000;
export const SHUTDOWN_TIMEOUT_MAX_MS = 60_000;

/**
 * Best-effort load of a `.env` file using Node's built-in parser (>=20.12),
 * avoiding a dotenv dependency. Missing file is not an error.
 *
 * @param {string} [envPath]
 * @returns {boolean} whether a file was loaded
 */
export function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (typeof process.loadEnvFile !== 'function') return false;
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch {
    // Absent or malformed .env: environment variables still win/are used.
    return false;
  }
}

/** @param {string} name */
function requireString(env, name, fallback, { maxLength = 200 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || raw.length > maxLength) {
    throw new TypeError(`${name} must be a string of at most ${maxLength} characters`);
  }
  return raw;
}

/** @param {string} name */
function requireInteger(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new TypeError(`${name} must be between ${min} and ${max}`);
  return value;
}

/** @param {string} name */
function requireNumber(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(raw)) throw new TypeError(`${name} must be a number`);
  const value = Number(raw);
  if (value <= min || value > max) throw new TypeError(`${name} must be > ${min} and <= ${max}`);
  return value;
}

/** @param {string} name */
function requireBoolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new TypeError(`${name} must be a boolean (true/false)`);
}

/**
 * Build a validated configuration object.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{
 *   env: string, host: string, port: number, publicDir: string, storeFile: string,
 *   logLevel: keyof LOG_LEVELS, maxItems: number, maxBodyBytes: number,
 *   rateLimitCapacity: number, rateLimitRefillPerSecond: number,
 *   trustProxy: boolean, shutdownTimeoutMs: number,
 *   metricsEnabled: boolean, allowedHosts: {allowAny: boolean, hosts: Set<string>}
 * }}
 */
export function createConfig(env = process.env) {
  const nodeEnv = requireString(env, 'NODE_ENV', 'development', { maxLength: 20 });
  if (!NODE_ENVS.includes(nodeEnv)) {
    throw new TypeError(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
  }

  const logLevel = requireString(env, 'LOG_LEVEL', 'info', { maxLength: 20 });
  if (Object.hasOwn(LOG_LEVELS, logLevel) === false) {
    throw new TypeError('LOG_LEVEL must be one of: debug, info, warn, error, silent');
  }

  const dataDir = path.resolve(requireString(env, 'DATA_DIR', './data', { maxLength: 512 }));
  const storeFile = path.resolve(
    requireString(env, 'STORE_FILE', path.join(dataDir, 'items.json'), { maxLength: 1024 }),
  );

  const host = requireString(env, 'HOST', '127.0.0.1', { maxLength: 255 });

  return {
    env: nodeEnv,
    // Loopback by default: an accidental bind to 0.0.0.0 would expose the
    // inventory database to the local network.
    host,
    port: requireInteger(env, 'PORT', 8080, { min: 1, max: 65_535 }),
    publicDir: path.resolve(requireString(env, 'PUBLIC_DIR', './public', { maxLength: 512 })),
    dataDir,
    storeFile,
    logLevel,
    maxItems: requireInteger(env, 'MAX_ITEMS', 5_000, { min: 1, max: 1_000_000 }),
    maxBodyBytes: requireInteger(env, 'MAX_BODY_BYTES', 65_536, { min: 1024, max: 1_048_576 }),
    rateLimitCapacity: requireInteger(env, 'RATE_LIMIT_CAPACITY', 120, { min: 1, max: 1_000_000 }),
    rateLimitRefillPerSecond: requireNumber(env, 'RATE_LIMIT_REFILL_PER_SECOND', 2, { min: 0, max: 10_000 }),
    // Off unless a reverse proxy is actually in front: honouring a spoofable
    // forwarding header would let clients forge their identity and evade limits.
    trustProxy: requireBoolean(env, 'TRUST_PROXY', false),
    shutdownTimeoutMs: requireInteger(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, {
      min: SHUTDOWN_TIMEOUT_MIN_MS,
      max: SHUTDOWN_TIMEOUT_MAX_MS,
    }),
    // Counters describe both the shape of the customer's inventory and the
    // health of the deployment. They stay off in production unless an operator
    // opts in, so an unauthenticated caller cannot read them by default.
    metricsEnabled: requireBoolean(env, 'METRICS_ENABLED', nodeEnv !== 'production'),
    // Defeats DNS rebinding; see src/lib/host.js for the threat model.
    allowedHosts: buildAllowedHosts({
      configured: requireString(env, 'ALLOWED_HOSTS', '', { maxLength: 2048 }),
      host,
    }),
  };
}
