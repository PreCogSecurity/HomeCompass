/**
 * Shared test harness: boots the real application on an ephemeral port with an
 * isolated temporary database, so tests exercise production code paths rather
 * than a re-implementation.
 */
import { Writable } from 'node:stream';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { createConfig } from '../../src/lib/config.js';
import { createLogger } from '../../src/lib/logger.js';
import { RateLimiter } from '../../src/lib/rate-limit.js';
import { InventoryStore } from '../../src/lib/store.js';

/** Writable stream that records everything written to it. */
export function memoryStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  stream.lines = lines;
  /** @returns {string[]} */
  stream.records = () => lines.map((line) => JSON.parse(line));
  return stream;
}

/** @param {{stdout?: object, stderr?: object}} [options] */
export function silentLogger(options = {}) {
  return createLogger({
    level: 'silent',
    stdout: options.stdout ?? memoryStream(),
    stderr: options.stderr ?? memoryStream(),
  });
}

/**
 * Boot the application against a throwaway database.
 *
 * @param {Record<string, string>} [envOverrides]
 * @param {{limiter?: RateLimiter}} [options]
 */
export async function startTestServer(envOverrides = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'homecompass-test-'));
  const stdout = memoryStream();
  const stderr = memoryStream();
  const logger = createLogger({ level: 'silent', stdout, stderr });

  const config = createConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: dir,
    ...envOverrides,
  });

  const store = new InventoryStore({ file: config.storeFile, maxItems: config.maxItems, logger });
  await store.init();

  const limiter =
    options.limiter ?? new RateLimiter({ capacity: 1000, refillPerSecond: 1000, maxKeys: 500 });

  const app = createApp({ config, store, logger, limiter });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.removeListener('error', reject);
      resolve();
    });
  });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    config,
    store,
    stdout,
    stderr,
    async close() {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Send a request with a completely unprocessed path.
 *
 * `fetch` normalises `..` and percent-encoded dots per the WHATWG URL spec before
 * the request leaves the process, which would silently defeat traversal tests.
 * `http.request` sends the target verbatim, so this is the only faithful way to
 * attack the resolver.
 *
 * @param {number} port
 * @param {string} rawPath
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 */
export function rawRequest(port, rawPath, options = {}) {
  const { method = 'GET', headers = {}, body } = options;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** @param {Response} response */
export async function readJson(response) {
  return JSON.parse(await response.text());
}
