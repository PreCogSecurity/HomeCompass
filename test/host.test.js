import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { CONTENT_SECURITY_POLICY } from '../src/lib/headers.js';
import { buildAllowedHosts, checkHost, LOOPBACK_HOSTS, parseHost } from '../src/lib/host.js';
import { rawRequest, startTestServer } from './helpers/harness.mjs';

/** A name an attacker controls, and therefore never a legitimate deployment host. */
const ATTACKER_HOST = 'evil.example.com';

/** A name the operator declared through `ALLOWED_HOSTS`. */
const DECLARED_HOST = 'homecompass.example';

/** The only error envelope a rejected `Host` is allowed to produce. */
const REJECTION = {
  code: 'misdirected_request',
  message: 'Host header is not served by this instance',
};

/**
 * Every response header value that equals `value` exactly.
 *
 * Exact equality is the only sound way to prove a value is absent from a
 * response. A substring scan over a joined header string (or over the raw body)
 * is weaker — it is the pattern that CodeQL's "incomplete string comparison"
 * query flags in a security check, because `'x.example.com'.includes(...)` can
 * never distinguish an equal value from one embedded in a larger host — and it
 * answers the wrong question about header values.
 *
 * @param {{headers: Record<string, string|string[]|number|undefined>}} response
 * @param {string} value
 * @returns {(string|string[]|number)[]}
 */
function headerValues(response, value) {
  return Object.values(response.headers).filter((header) => header === value);
}

describe('parseHost', () => {
  test('normalises names and strips the port', () => {
    assert.equal(parseHost('localhost'), 'localhost');
    assert.equal(parseHost('localhost:8080'), 'localhost');
    assert.equal(parseHost('HomeCompass.Example.COM:8443'), 'homecompass.example.com');
    assert.equal(parseHost('  example.com  '), 'example.com');
    assert.equal(parseHost(['example.com:80']), 'example.com');
  });

  test('handles bracketed IPv6 literals', () => {
    assert.equal(parseHost('[::1]'), '[::1]');
    assert.equal(parseHost('[::1]:8080'), '[::1]');
    assert.equal(parseHost('[2001:DB8::1]:443'), '[2001:db8::1]');
  });

  test('rejects malformed authorities instead of guessing', () => {
    for (const value of [
      '',
      '   ',
      'example.com:',
      'example.com:notaport',
      'exa mple.com',
      'exa_mple.com',
      'example.com/path',
      'example.com\r\nX-Injected: 1',
      '[::1',
      '::1',
      '::1:8080',
      'a'.repeat(300),
      42,
      null,
      undefined,
    ]) {
      assert.equal(parseHost(value), null, JSON.stringify(value));
    }
  });

  test('userinfo cannot be used to impersonate an allowed host', () => {
    // `victim.example@evil.example` must not be read as `victim.example`.
    assert.equal(parseHost('victim.example@evil.example'), 'evil.example');
    assert.equal(parseHost('example.com@'), null);
  });
});

describe('buildAllowedHosts', () => {
  test('always permits the loopback names so local browsing just works', () => {
    const { allowAny, hosts } = buildAllowedHosts({ configured: '', host: '127.0.0.1' });
    assert.equal(allowAny, false);
    for (const loopback of LOOPBACK_HOSTS) assert.equal(hosts.has(loopback), true, loopback);
  });

  test('includes the configured bind address', () => {
    const { hosts } = buildAllowedHosts({ configured: '', host: 'HomeCompass.local' });
    assert.equal(hosts.has('homecompass.local'), true);
  });

  test('adds operator-declared names, with or without ports', () => {
    const { hosts } = buildAllowedHosts({
      configured: 'home.example.com, other.example.com:8443,  , 10.0.0.5',
      host: '127.0.0.1',
    });
    assert.equal(hosts.has('home.example.com'), true);
    assert.equal(hosts.has('other.example.com'), true);
    assert.equal(hosts.has('10.0.0.5'), true);
    assert.equal(hosts.has('evil.example.com'), false);
  });

  test('the wildcard disables the control and says so explicitly', () => {
    const { allowAny, hosts } = buildAllowedHosts({ configured: '*', host: '127.0.0.1' });
    assert.equal(allowAny, true);
    assert.equal(hosts.size, 0);
    assert.equal(checkHost('anything.example', { allowAny, hosts }).ok, true);
  });
});

describe('checkHost', () => {
  const allowed = buildAllowedHosts({ configured: 'home.example.com', host: '127.0.0.1' });

  test('accepts allowed hosts regardless of port or case', () => {
    for (const value of ['localhost:8080', '127.0.0.1:9999', 'home.example.com', 'HOME.EXAMPLE.COM:443']) {
      assert.equal(checkHost(value, allowed).ok, true, value);
    }
  });

  test('rejects an unlisted host, which is the DNS rebinding case', () => {
    const verdict = checkHost('evil.example.com', allowed);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'unlisted');
  });

  test('rejects a missing or malformed Host header', () => {
    assert.equal(checkHost(undefined, allowed).reason, 'missing');
    assert.equal(checkHost('', allowed).reason, 'missing');
    assert.equal(checkHost('bad host', allowed).reason, 'malformed');
  });
});

describe('DNS rebinding defence over HTTP', () => {
  test('a request with a foreign Host is refused before it reaches the API', async () => {
    const harness = await startTestServer();
    try {
      // This is exactly what a rebinding attack looks like on the wire: a
      // loopback connection carrying an attacker-controlled Host.
      const attack = await rawRequest(harness.port, '/api/items', {
        headers: { Host: ATTACKER_HOST },
      });
      assert.equal(attack.status, 421);
      // Asserting the *whole* envelope is what proves nothing was reflected
      // back: deep equality cannot be satisfied by a body that also carries the
      // rejected value. It additionally pins the client-safe message, so a
      // future change that starts interpolating the Host into it fails here.
      assert.deepEqual(JSON.parse(attack.body), {
        error: { ...REJECTION, requestId: attack.headers['x-request-id'] },
      });
      // The same guarantee for the response headers.
      assert.deepEqual(headerValues(attack, ATTACKER_HOST), []);
      // The refusal still carries the full hardening header set.
      assert.equal(attack.headers['content-security-policy'], CONTENT_SECURITY_POLICY);

      // The same route over a legitimate Host still works.
      const ok = await rawRequest(harness.port, '/api/items');
      assert.equal(ok.status, 200);
    } finally {
      await harness.close();
    }
  });

  test('static assets are covered too, so the UI cannot be rebound either', async () => {
    const harness = await startTestServer();
    try {
      const attack = await rawRequest(harness.port, '/', { headers: { Host: ATTACKER_HOST } });
      assert.equal(attack.status, 421);
      assert.equal(JSON.parse(attack.body).error.code, REJECTION.code);
      // The answer is the JSON envelope, not the page: a JSON content type and
      // the absence of an ETag mean no byte of the UI was served to the
      // rebound document.
      assert.equal(attack.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(attack.headers.etag, undefined);
      assert.deepEqual(headerValues(attack, ATTACKER_HOST), []);
    } finally {
      await harness.close();
    }
  });

  test('a configured hostname keeps the UI reachable', async () => {
    const harness = await startTestServer({ ALLOWED_HOSTS: DECLARED_HOST });
    try {
      const allowed = await rawRequest(harness.port, '/api/health', {
        headers: { Host: DECLARED_HOST },
      });
      assert.equal(allowed.status, 200);
      const denied = await rawRequest(harness.port, '/api/health', {
        headers: { Host: ATTACKER_HOST },
      });
      assert.equal(denied.status, 421);
      assert.deepEqual(JSON.parse(denied.body).error.code, REJECTION.code);
    } finally {
      await harness.close();
    }
  });

  test('rejections are counted for operators to alert on', async () => {
    const harness = await startTestServer();
    try {
      await rawRequest(harness.port, '/api/health', { headers: { Host: ATTACKER_HOST } });
      assert.equal(harness.app.metrics.snapshot().hostRejected, 1);
    } finally {
      await harness.close();
    }
  });
});
