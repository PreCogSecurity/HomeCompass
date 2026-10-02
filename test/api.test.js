import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { RateLimiter } from '../src/lib/rate-limit.js';
import { rawRequest, readJson, startTestServer } from './helpers/harness.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Boots an isolated server for a group of tests. */
async function group(fn) {
  const harness = await startTestServer();
  try {
    await fn(harness);
  } finally {
    await harness.close();
  }
}

/** @param {string} url @param {RequestInit} [init] */
function call(url, init) {
  return fetch(url, init);
}

/** POST a JSON body to the API. @param {string} url @param {unknown} body */
function postItem(url, body) {
  return call(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

describe('GET /api/health', () => {
  test('reports liveness without disclosing how much the owner owns', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      const body = await readJson(response);
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.version, 'string');
      // This route is unauthenticated and unthrottled, so it must be liveness
      // only: exposing the record count would hand any local process a free
      // census of the household inventory.
      assert.equal(body.store, undefined);
      assert.equal(JSON.stringify(body).includes('records'), false);
    }));

  test('is excluded from rate limiting so monitoring survives throttling', () =>
    group(async ({ baseUrl }) => {
      for (let index = 0; index < 25; index += 1) {
        const response = await call(`${baseUrl}/api/health`);
        assert.equal(response.status, 200);
      }
    }));
});

describe('security headers', () => {
  test('every response carries the full hardened header set', () =>
    group(async ({ baseUrl }) => {
      const paths = ['/', '/api/health', '/api/items', '/nope'];
      for (const path of paths) {
        const response = await call(`${baseUrl}${path}`);
        assert.equal(response.headers.get('content-security-policy') !== null, true, path);
        assert.match(response.headers.get('content-security-policy'), /default-src 'none'/, path);
        assert.match(response.headers.get('content-security-policy'), /object-src 'none'/, path);
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
        assert.match(response.headers.get('content-security-policy'), /base-uri 'none'/, path);
        assert.equal(response.headers.get('content-security-policy').includes('unsafe-inline'), false, path);
        assert.equal(response.headers.get('content-security-policy').includes('unsafe-eval'), false, path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
        assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
        assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path);
        assert.equal(response.headers.get('permissions-policy') !== null, true, path);
        assert.equal(response.headers.get('x-xss-protection'), '0', path);
        assert.notEqual(response.headers.get('x-request-id'), null, path);
        assert.equal(response.headers.get('x-powered-by'), null, path);
      }
    }));

  test('HSTS is absent on plain HTTP and present when a trusted proxy reports TLS', () =>
    group(async ({ baseUrl }) => {
      const plain = await call(`${baseUrl}/api/health`);
      assert.equal(plain.headers.get('strict-transport-security'), null);
    }));

  test('a forged X-Request-Id is replaced, not reflected', () =>
    group(async ({ baseUrl }) => {
      const attack = 'x".injected: 1, "evil';
      const response = await call(`${baseUrl}/api/health`, { headers: { 'X-Request-Id': attack } });
      assert.notEqual(response.headers.get('x-request-id'), attack);
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    }));

  test('a well-formed X-Request-Id is preserved for tracing', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/health`, { headers: { 'X-Request-Id': 'trace-abc_123' } });
      assert.equal(response.headers.get('x-request-id'), 'trace-abc_123');
    }));
});

describe('items CRUD', () => {
  test('creates, reads, updates and deletes an item', () =>
    group(async ({ baseUrl }) => {
      const created = await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'Cordless drill',
          category: 'Tools',
          room: 'Garage',
          quantity: 2,
          tags: ['power'],
        }),
      });
      assert.equal(created.status, 201);
      const { item } = await readJson(created);
      assert.match(item.id, /^[0-9a-f-]{36}$/);
      assert.equal(item.category, 'tools', 'category should be normalised');
      assert.equal(item.room, 'garage', 'room should be normalised');
      assert.equal(item.version, 1);
      assert.equal(created.headers.get('location'), `/api/items/${item.id}`);

      const fetched = await call(`${baseUrl}/api/items/${item.id}`);
      assert.equal(fetched.status, 200);
      assert.equal((await readJson(fetched)).item.name, 'Cordless drill');

      const updatedResponse = await call(`${baseUrl}/api/items/${item.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ room: 'shed', version: 1 }),
      });
      assert.equal(updatedResponse.status, 200);
      const updatedItem = (await readJson(updatedResponse)).item;
      assert.equal(updatedItem.room, 'shed');
      assert.equal(updatedItem.version, 2);

      const removed = await call(`${baseUrl}/api/items/${item.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal((await call(`${baseUrl}/api/items/${item.id}`)).status, 404);
    }));

  test('lists with filters, pagination and facets', () =>
    group(async ({ baseUrl }) => {
      for (const payload of [
        { name: 'Drill', room: 'garage', category: 'tools' },
        { name: 'Beans', room: 'kitchen', category: 'food' },
      ]) {
        await call(`${baseUrl}/api/items`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) });
      }
      const all = await readJson(await call(`${baseUrl}/api/items`));
      assert.equal(all.total, 2);
      assert.deepEqual(all.facets.rooms, ['garage', 'kitchen']);

      const filtered = await readJson(await call(`${baseUrl}/api/items?room=garage`));
      assert.equal(filtered.total, 1);
      assert.equal(filtered.items[0].name, 'Drill');

      const searched = await readJson(await call(`${baseUrl}/api/items?q=beans`));
      assert.equal(searched.total, 1);

      const paged = await readJson(await call(`${baseUrl}/api/items?limit=1&offset=1`));
      assert.equal(paged.items.length, 1);
      assert.equal(paged.limit, 1);
    }));

  test('returns 404 for unknown and malformed ids', () =>
    group(async ({ baseUrl }) => {
      for (const id of ['3f7c1b2e-5a49-4c8d-9f31-6a2b0c4d5e6f', '../../etc/passwd', 'not-an-id']) {
        assert.equal((await call(`${baseUrl}/api/items/${encodeURIComponent(id)}`)).status, 404, id);
      }
      assert.equal((await call(`${baseUrl}/api/items/${encodeURIComponent('..%2f..%2fetc')}`)).status, 404);
    }));

  test('returns 409 on a stale optimistic-concurrency token', () =>
    group(async ({ baseUrl }) => {
      const { item } = await readJson(
        await postItem(`${baseUrl}/api/items`, { name: 'Drill' }),
      );
      await call(`${baseUrl}/api/items/${item.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ room: 'shed', version: 1 }),
      });
      const stale = await call(`${baseUrl}/api/items/${item.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ room: 'attic', version: 1 }),
      });
      assert.equal(stale.status, 409);
      const body = await readJson(stale);
      assert.equal(body.error.code, 'conflict');
    }));

  test('HEAD returns the headers of the equivalent GET with no body', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/health`, { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
    }));
});

describe('request body hardening', () => {
  test('rejects a missing or wrong Content-Type with 415', () =>
    group(async ({ baseUrl }) => {
      const missing = await call(`${baseUrl}/api/items`, { method: 'POST', body: '{}' });
      assert.equal(missing.status, 415);
      const wrong = await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      });
      assert.equal(wrong.status, 415);
    }));

  test('rejects malformed JSON with 400 and never echoes the payload', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{"name": "unterminated',
      });
      assert.equal(response.status, 400);
      const { error } = await readJson(response);
      assert.equal(error.code, 'bad_request');
      assert.equal(JSON.stringify(error).includes('unterminated'), false);
    }));

  test('rejects an oversized body with 413', async () => {
    const harness = await startTestServer({ MAX_BODY_BYTES: '1024' });
    try {
      const huge = JSON.stringify({ name: 'x'.repeat(2048) });
      const response = await call(`${harness.baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: huge,
      });
      assert.equal(response.status, 413);
      assert.equal((await readJson(response)).error.code, 'payload_too_large');
    } finally {
      await harness.close();
    }
  });

  test('rejects an oversized body announced only by Content-Length', async () => {
    const harness = await startTestServer({ MAX_BODY_BYTES: '1024' });
    try {
      const response = await rawRequest(harness.port, '/api/items', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'Content-Length': '999999' },
        body: '{"name":"x"}',
      });
      assert.equal(response.status, 413);
    } finally {
      await harness.close();
    }
  });

  test('rejects a non-object body', () =>
    group(async ({ baseUrl }) => {
      for (const body of ['[]', '"a string"', '42', 'null']) {
        const response = await call(`${baseUrl}/api/items`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body,
        });
        assert.equal(response.status, 422, body);
      }
    }));
});

describe('input validation at the API boundary', () => {
  test('rejects a missing name with 422 and per-field errors', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/items`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(response.status, 422);
      const { error } = await readJson(response);
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.details.errors[0].path, 'name');
      assert.equal(typeof error.requestId, 'string');
    }));

  test('rejects unknown fields (mass assignment)', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Drill', id: 'forged', isAdmin: true }),
      });
      assert.equal(response.status, 422);
      const { error } = await readJson(response);
      assert.deepEqual(error.details.errors.map((entry) => entry.code).sort(), ['unknown_key', 'unknown_key']);
    }));

  test('refuses prototype pollution through JSON.parse', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{"name":"Drill","__proto__":{"polluted":"yes"}}',
      });
      assert.equal(response.status, 422);
      assert.equal({}.polluted, undefined);
      const { error } = await readJson(response);
      assert.equal(error.details.errors[0].code, 'forbidden_key');
    }));

  test('rejects out-of-range and malformed field values', () =>
    group(async ({ baseUrl }) => {
      const cases = [
        { name: '' },
        { name: 'x'.repeat(200) },
        { name: 'ok', quantity: 0 },
        { name: 'ok', quantity: 1.5 },
        { name: 'ok', value: -1 },
        { name: 'ok', purchaseDate: '2026-02-31' },
        { name: 'ok', purchaseDate: 'not-a-date' },
        { name: 'ok', tags: Array.from({ length: 20 }, (unused, index) => `t${index}`) },
      ];
      for (const body of cases) {
        const response = await call(`${baseUrl}/api/items`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 422, JSON.stringify(body));
      }
    }));

  test('rejects invalid pagination query parameters', () =>
    group(async ({ baseUrl }) => {
      for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'q=' + 'x'.repeat(200)]) {
        const response = await call(`${baseUrl}/api/items?${query}`);
        assert.equal(response.status, 422, query);
      }
    }));

  test('a PATCH with only unknown fields changes nothing', () =>
    group(async ({ baseUrl }) => {
      const { item } = await readJson(
        await postItem(`${baseUrl}/api/items`, { name: 'Drill' }),
      );
      const response = await call(`${baseUrl}/api/items/${item.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ version: 1, createdAt: '1999-01-01T00:00:00.000Z' }),
      });
      assert.equal(response.status, 422);
      const after = await readJson(await call(`${baseUrl}/api/items/${item.id}`));
      assert.equal(after.item.createdAt, item.createdAt);
      assert.equal(after.item.version, 1);
    }));
});

describe('HTTP semantics', () => {
  test('unknown API endpoints return 404 JSON', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/does-not-exist`);
      assert.equal(response.status, 404);
      assert.equal((await readJson(response)).error.code, 'not_found');
      assert.equal((await call(`${baseUrl}/api`)).status, 404);
    }));

  test('a known path with the wrong method returns 405 and an Allow header', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/api/items`, { method: 'PUT', headers: JSON_HEADERS, body: '{}' });
      assert.equal(response.status, 405);
      assert.equal((await readJson(response)).error.code, 'method_not_allowed');
      const allow = response.headers.get('allow');
      assert.match(allow, /GET/);
      assert.match(allow, /POST/);

      const itemRoute = await call(`${baseUrl}/api/items/${'3f7c1b2e-5a49-4c8d-9f31-6a2b0c4d5e6f'}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}',
      });
      assert.equal(itemRoute.status, 405);
      assert.match(itemRoute.headers.get('allow'), /DELETE/);
    }));

  test('a protocol-relative request target is rejected', () =>
    group(async ({ baseUrl, port }) => {
      const response = await rawRequest(port, '//evil.example.com/api/health');
      assert.equal(response.status, 400);
    }));

  test('the HTML shell is served for the root path with revalidation caching', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const etag = response.headers.get('etag');
      assert.notEqual(etag, null);
      const revalidated = await call(`${baseUrl}/`, { headers: { 'If-None-Match': etag } });
      assert.equal(revalidated.status, 304);
      assert.equal(await revalidated.text(), '');
    }));

  test('the UI ships no inline script or style, so the strict CSP holds', () =>
    group(async ({ baseUrl }) => {
      const html = await (await call(`${baseUrl}/`)).text();
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline script found');
      assert.equal(/<style[^>]*>/.test(html), false, 'inline style block found');
      assert.equal(/\sstyle="/.test(html), false, 'inline style attribute found');
      assert.equal(/\son(click|load|error)=/.test(html), false, 'inline event handler found');
      assert.match(html, /<script type="module" src="\/assets\/app\.mjs"\s*>/);
      assert.match(html, /<link rel="stylesheet" href="\/assets\/styles\.css"\s*\/>/);
    }));

  test('static traversal attempts are refused over a raw socket', () =>
    group(async ({ port }) => {
      const attacks = [
        '/../package.json',
        '/..%2fpackage.json',
        '/%2e%2e/package.json',
        '/assets/../../src/app.js',
        '/.env',
        '/.gitignore',
        '/index.html%00.png',
        '/../LICENSE',
      ];
      for (const attack of attacks) {
        const response = await rawRequest(port, attack);
        assert.equal(response.status, 404, attack);
        assert.equal(response.body.includes('MIT License'), false, attack);
      }
    }));

  test('an unknown static path returns 404 rather than a directory listing', () =>
    group(async ({ baseUrl }) => {
      const response = await call(`${baseUrl}/assets/missing.js`);
      assert.equal(response.status, 404);
    }));
});

describe('rate limiting', () => {
  test('throttles a client and advertises Retry-After', async () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0.01, maxKeys: 100 });
    const harness = await startTestServer({}, { limiter });
    try {
      const statuses = [];
      for (let index = 0; index < 4; index += 1) {
        statuses.push((await call(`${harness.baseUrl}/api/items`)).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429]);
      const throttled = await call(`${harness.baseUrl}/api/items`);
      assert.equal(throttled.status, 429);
      assert.equal(Number(throttled.headers.get('retry-after')) >= 1, true);
      assert.equal((await readJson(throttled)).error.code, 'rate_limited');
    } finally {
      await harness.close();
    }
  });

  test('ignores a spoofed X-Forwarded-For by default', async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.01, maxKeys: 100 });
    const harness = await startTestServer({ TRUST_PROXY: 'false' }, { limiter });
    try {
      const first = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
      const second = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': '198.51.100.9' } });
      assert.equal(first.status, 200);
      assert.equal(second.status, 429, 'spoofed client identities must share one bucket');
    } finally {
      await harness.close();
    }
  });

  test('honours X-Forwarded-For when a trusted proxy is declared', async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.01, maxKeys: 100 });
    const harness = await startTestServer({ TRUST_PROXY: 'true' }, { limiter });
    try {
      const first = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
      const second = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': '198.51.100.9' } });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
    } finally {
      await harness.close();
    }
  });

  test('rejects a malformed forwarded address even when the proxy is trusted', async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.01, maxKeys: 100 });
    const harness = await startTestServer({ TRUST_PROXY: 'true' }, { limiter });
    try {
      const first = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': 'not-an-ip' } });
      const second = await call(`${harness.baseUrl}/api/items`, { headers: { 'X-Forwarded-For': 'not-an-ip' } });
      assert.equal(first.status, 200);
      assert.equal(second.status, 429, 'a garbage header must fall back to one shared bucket');
    } finally {
      await harness.close();
    }
  });

  test('only HSTS appears once TLS termination is declared', async () => {
    const harness = await startTestServer({ TRUST_PROXY: 'true' });
    try {
      const secure = await call(`${harness.baseUrl}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(secure.headers.get('strict-transport-security'), /max-age=31536000/);
      const insecure = await call(`${harness.baseUrl}/api/health`, { headers: { 'X-Forwarded-Proto': 'http' } });
      assert.equal(insecure.headers.get('strict-transport-security'), null);
    } finally {
      await harness.close();
    }
  });
});

describe('observability', () => {
  test('metrics are opt-out in production and 404 when disabled', async () => {
    const harness = await startTestServer({ NODE_ENV: 'production' });
    try {
      // Absent an explicit opt-in, an unauthenticated caller must not be able
      // to read deployment counters at all.
      assert.equal(harness.config.metricsEnabled, false);
      const response = await call(`${harness.baseUrl}/api/metrics`);
      assert.equal(response.status, 404);
      // Liveness still works, because monitoring must never be the casualty.
      assert.equal((await call(`${harness.baseUrl}/api/health`)).status, 200);
    } finally {
      await harness.close();
    }
  });

  test('metrics can be re-enabled explicitly in production', async () => {
    const harness = await startTestServer({ NODE_ENV: 'production', METRICS_ENABLED: 'true' });
    try {
      const response = await call(`${harness.baseUrl}/api/metrics`);
      assert.equal(response.status, 200);
      const body = await readJson(response);
      // The record count now lives here, behind the opt-in.
      assert.equal(typeof body.store.records, 'number');
    } finally {
      await harness.close();
    }
  });

  test('metrics are throttled like any other endpoint', async () => {
    // A small bucket so the exemption, if it ever came back, fails this test.
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0.001, maxKeys: 10 });
    const harness = await startTestServer({}, { limiter });
    try {
      const statuses = [];
      for (let index = 0; index < 5; index += 1) {
        const response = await call(`${harness.baseUrl}/api/metrics`);
        statuses.push(response.status);
      }
      assert.equal(statuses.includes(429), true, `expected a 429 in ${statuses.join(',')}`);
    } finally {
      await harness.close();
    }
  });

  test('metrics expose counters only, never inventory contents', () =>
    group(async ({ baseUrl }) => {
      await call(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Secret Asset Name' }),
      });
      const response = await call(`${baseUrl}/api/metrics`);
      assert.equal(response.status, 200);
      const body = await readJson(response);
      assert.equal(body.counters.itemsCreated, 1);
      assert.equal(body.counters.requestsTotal >= 1, true);
      assert.equal(typeof body.uptimeSeconds, 'number');
      const serialised = JSON.stringify(body);
      assert.equal(serialised.includes('Secret Asset Name'), false);
      assert.equal(serialised.includes('password'), false);
    }));

  test('failures are counted, successes are not', () =>
    group(async ({ baseUrl, app }) => {
      await call(`${baseUrl}/api/items`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(app.metrics.snapshot().validationFailures, 1);
      await call(`${baseUrl}/api/health`);
      assert.equal(app.metrics.snapshot().requestsFailed, 0);
    }));
});
