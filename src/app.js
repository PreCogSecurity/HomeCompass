/**
 * HomeCompass HTTP application.
 *
 * Responsibilities, in order: assign a request id, apply security headers to
 * *every* response, throttle the API, parse bounded JSON bodies, validate all
 * input at the boundary, and serialise failures into one uniform error shape.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  badRequest,
  methodNotAllowed,
  misdirectedRequest,
  notFound,
  payloadTooLarge,
  unsupportedMediaType,
  validationFailed,
  toErrorResponse,
} from './lib/errors.js';
import { clientKey, isSecureRequest, resolveRequestId, securityHeaders } from './lib/headers.js';
import { checkHost } from './lib/host.js';
import { Metrics } from './lib/metrics.js';
import { RateLimiter } from './lib/rate-limit.js';
import { buildEtag, resolveRealAsset, resolveStaticAsset } from './lib/static.js';
import { itemCreateSchema, itemListQuerySchema, itemPatchSchema, validate } from './lib/validate.js';

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** Version is read from the manifest so the health check cannot drift from the release. */
const { version: APP_VERSION } = createRequire(import.meta.url)('../package.json');
/**
 * Routes excluded from throttling so monitoring keeps working under load.
 *
 * Only `/api/health` qualifies. `/api/metrics` used to be exempt as well, which
 * handed an unauthenticated caller an unlimited-rate operational read; it is now
 * throttled like any other API surface.
 */
const UNTHROTTLED_ROUTES = new Set(['/api/health']);

/** Route table; `:id` is a single dynamic segment. */
const API_ROUTES = {
  '/api/health': { GET: 'health' },
  '/api/metrics': { GET: 'metrics' },
  '/api/items': { GET: 'listItems', POST: 'createItem' },
  '/api/items/:id': { GET: 'getItem', PATCH: 'updateItem', DELETE: 'deleteItem' },
};

const ROUTE_ENTRIES = Object.entries(API_ROUTES).map(([routePath, methods]) => ({
  // Drop the leading empty segment produced by splitting an absolute path.
  segments: routePath.split('/').slice(1),
  methods,
}));

/**
 * @param {string[]} segments
 * @returns {{handlers: Record<string, string>, params: Record<string, string>}[]}
 */
function matchRoutes(segments) {
  const matches = [];
  for (const route of ROUTE_ENTRIES) {
    if (route.segments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const expected = route.segments[index];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = segments[index];
      } else if (expected !== segments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push({ handlers: route.methods, params });
  }
  return matches;
}

/**
 * Read and parse a JSON request body under a hard byte limit.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req, limitBytes) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw unsupportedMediaType('Content-Type must be application/json');
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw payloadTooLarge();
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limitBytes) {
      // Stop reading; the caller responds 413 and the socket is closed after.
      req.destroy();
      throw payloadTooLarge();
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}

/**
 * Create the HomeCompass app.
 *
 * @param {{config: object, store: import('./lib/store.js').InventoryStore,
 *          logger: ReturnType<import('./lib/logger.js').createLogger>,
 *          limiter?: RateLimiter, metrics?: Metrics, publicDir?: string}} options
 */
export function createApp(options) {
  const { config, store, logger, publicDir = DEFAULT_PUBLIC_DIR, limiter, metrics = new Metrics() } = options;
  const rateLimiter =
    limiter ??
    new RateLimiter({
      capacity: config.rateLimitCapacity,
      refillPerSecond: config.rateLimitRefillPerSecond,
    });

  /** @param {import('node:http').ServerResponse} res */
  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    res.writeHead(status, {
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    // A HEAD response carries the headers of the equivalent GET but no payload.
    if (res.req && res.req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  }

  /** @param {import('node:http').IncomingMessage} req */
  async function handleApi(req, res, { requestId, url }) {
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const matches = matchRoutes(segments);
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (matches.length === 0) throw notFound('Unknown API endpoint');

    const route = matches.find((entry) => Object.hasOwn(entry.handlers, method));
    if (route === undefined) {
      const allowed = [...new Set(matches.flatMap((entry) => Object.keys(entry.handlers)))].sort();
      if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD');
      throw methodNotAllowed(allowed);
    }

    const params = route.params;
    switch (route.handlers[method]) {
      case 'health': {
        metrics.increment('requestsTotal');
        // Liveness only. The inventory record count is deliberately withheld
        // here: this route is unauthenticated and unthrottled, so returning it
        // would hand any local process a free census of what the owner owns.
        sendJson(res, 200, {
          status: store.ready ? 'ok' : 'degraded',
          uptimeSeconds: Math.round(process.uptime()),
          version: APP_VERSION,
        });
        return;
      }
      case 'metrics': {
        // Disabled in production by default. Reported as 404 rather than 403 so
        // the endpoint is not even confirmed to exist.
        if (!config.metricsEnabled) throw notFound('Unknown API endpoint');
        metrics.increment('requestsTotal');
        sendJson(res, 200, { ...metrics.toJSON(), store: { records: store.count, ready: store.ready } });
        return;
      }
      case 'listItems': {
        const query = Object.fromEntries(url.searchParams.entries());
        const result = validate(itemListQuerySchema, query);
        if (!result.ok) {
          metrics.increment('validationFailures');
          throw validationFailed(result.errors);
        }
        const { q, room, category, limit, offset } = result.value;
        const page = store.list({ q, room, category, limit, offset });
        metrics.increment('requestsTotal');
        sendJson(res, 200, { ...page, facets: store.facets() });
        return;
      }
      case 'createItem': {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const result = validate(itemCreateSchema, body);
        if (!result.ok) {
          metrics.increment('validationFailures');
          throw validationFailed(result.errors);
        }
        const created = await store.create(result.value);
        metrics.increment('itemsCreated');
        metrics.increment('requestsTotal');
        sendJson(res, 201, { item: created }, { Location: `/api/items/${created.id}` });
        return;
      }
      case 'getItem': {
        const item = store.get(params.id);
        if (item === undefined) throw notFound('Item not found');
        metrics.increment('requestsTotal');
        sendJson(res, 200, { item });
        return;
      }
      case 'updateItem': {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const result = validate(itemPatchSchema, body);
        if (!result.ok) {
          metrics.increment('validationFailures');
          throw validationFailed(result.errors);
        }
        const updated = await store.update(params.id, result.value);
        metrics.increment('itemsUpdated');
        metrics.increment('requestsTotal');
        sendJson(res, 200, { item: updated });
        return;
      }
      case 'deleteItem': {
        const removed = await store.remove(params.id);
        metrics.increment('itemsDeleted');
        metrics.increment('requestsTotal');
        sendJson(res, 200, { item: removed });
        return;
      }
      /* c8 ignore next 2 */
      default:
        throw notFound('Unknown API endpoint');
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  async function handleStatic(req, res, { url }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw methodNotAllowed(['GET', 'HEAD']);
    }
    const asset = resolveStaticAsset(publicDir, url.pathname + url.search);
    if (asset === null) throw notFound('Not found');

    // Lexical validation cannot see through symlinks, so re-verify the real path.
    const realPath = await resolveRealAsset(publicDir, asset.filePath);
    if (realPath === null) throw notFound('Not found');

    let stats;
    try {
      stats = await stat(realPath);
    } catch {
      throw notFound('Not found');
    }
    if (!stats.isFile()) throw notFound('Not found');

    const etag = buildEtag(stats.size, stats.mtimeMs);
    const headers = {
      'Content-Type': asset.contentType,
      ETag: etag,
      // Revalidate every time: a deploy must never be masked by a stale asset,
      // and the server stays authoritative for the UI.
      'Cache-Control': 'no-cache',
      'Content-Length': String(stats.size),
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    metrics.increment('requestsTotal');
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(realPath);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    const startedAt = process.hrtime.bigint();
    const requestId = resolveRequestId(req, () => randomUUID());
    res.setHeader('X-Request-Id', requestId);
    for (const [name, value] of Object.entries(securityHeaders({ secure: isSecureRequest(req, config.trustProxy) }))) {
      res.setHeader(name, value);
    }

    let url;
    const target = req.url ?? '/';
    // DNS rebinding: refuse a request addressed to a name this deployment does
    // not serve, before any routing, storage or template logic runs. Without
    // this, any web page can point its own hostname at the loopback port and
    // read the whole inventory as same-origin.
    const hostVerdict = checkHost(req.headers.host, config.allowedHosts);
    if (!hostVerdict.ok) {
      metrics.increment('hostRejected');
      metrics.increment('requestsRejected');
      logger.warn('Rejected request with untrusted Host header', { requestId, reason: hostVerdict.reason });
      const { status, body } = toErrorResponse(misdirectedRequest(), requestId);
      sendJson(res, status, body);
      return;
    }
    // `//host/path` would be resolved against the base as an authority, which is
    // never a legitimate origin-form target. Reject before any parsing happens.
    if (target.startsWith('//')) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'Malformed request target', requestId },
      });
      return;
    }
    try {
      url = new URL(target, 'http://homecompass.invalid');
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed request target', requestId } });
      return;
    }

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (!UNTHROTTLED_ROUTES.has(url.pathname)) {
          const verdict = rateLimiter.take(clientKey(req, config.trustProxy));
          if (!verdict.allowed) {
            metrics.increment('rateLimited');
            metrics.increment('requestsFailed');
            logger.warn('Rate limit exceeded', { requestId, path: url.pathname });
            sendJson(res, 429, {
              error: { code: 'rate_limited', message: 'Too many requests', requestId },
            }, { 'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) });
            return;
          }
        }
        await handleApi(req, res, { requestId, url });
        return;
      }
      await handleStatic(req, res, { url });
    } catch (error) {
      const { status, body, headers } = toErrorResponse(error, requestId);
      if (status >= 500) {
        metrics.increment('requestsFailed');
        logger.error('Request failed', {
          requestId,
          path: url.pathname,
          status,
          error: error instanceof AppError ? { name: error.name, message: error.message } : error,
        });
      } else if (status >= 400) {
        logger.debug('Request rejected', { requestId, path: url.pathname, status, code: body.error.code });
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, body, headers);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.debug('Request completed', {
        requestId,
        method: req.method,
        path: url?.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      // Last-resort net: never let a rejection take the process down silently.
      logger.error('Unhandled request failure', { error });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { code: 'internal_error', message: 'Internal server error', requestId: randomUUID() },
        });
      } else {
        res.destroy();
      }
    });
  });

  // Slow-loris hardening: bound header and body-idle time.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  return Object.freeze({ server, metrics, config, publicDir });
}
