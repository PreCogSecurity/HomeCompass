import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildAllowedHosts, checkHost, LOOPBACK_HOSTS, parseHost } from '../src/lib/host.js';
import { rawRequest, startTestServer } from './helpers/harness.mjs';

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
        headers: { Host: 'evil.example.com' },
      });
      assert.equal(attack.status, 421);
      const body = JSON.parse(attack.body);
      assert.equal(body.error.code, 'misdirected_request');
      // The rejected value must not be reflected back.
      assert.equal(attack.body.includes('evil.example.com'), false);
      // And nothing was served.
      assert.equal(attack.headers['content-security-policy'] !== undefined, true);

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
      const attack = await rawRequest(harness.port, '/', { headers: { Host: 'evil.example.com' } });
      assert.equal(attack.status, 421);
      assert.equal(attack.body.includes('<!DOCTYPE'), false);
    } finally {
      await harness.close();
    }
  });

  test('a configured hostname keeps the UI reachable', async () => {
    const harness = await startTestServer({ ALLOWED_HOSTS: 'homecompass.example' });
    try {
      const allowed = await rawRequest(harness.port, '/api/health', {
        headers: { Host: 'homecompass.example' },
      });
      assert.equal(allowed.status, 200);
      const denied = await rawRequest(harness.port, '/api/health', {
        headers: { Host: 'evil.example.com' },
      });
      assert.equal(denied.status, 421);
    } finally {
      await harness.close();
    }
  });

  test('rejections are counted for operators to alert on', async () => {
    const harness = await startTestServer();
    try {
      await rawRequest(harness.port, '/api/health', { headers: { Host: 'evil.example.com' } });
      assert.equal(harness.app.metrics.snapshot().hostRejected, 1);
    } finally {
      await harness.close();
    }
  });
});
