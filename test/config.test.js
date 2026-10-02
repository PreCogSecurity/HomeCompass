import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { createConfig } from '../src/lib/config.js';

describe('createConfig defaults', () => {
  test('binds to loopback, not every interface', () => {
    const config = createConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8080);
    assert.equal(config.env, 'development');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.trustProxy, false);
    assert.equal(config.maxBodyBytes, 65_536);
    assert.equal(config.maxItems, 5_000);
  });

  test('derives the store path from DATA_DIR', () => {
    const config = createConfig({ DATA_DIR: 'var/home' });
    assert.equal(config.dataDir, path.resolve('var/home'));
    assert.equal(config.storeFile, path.join(path.resolve('var/home'), 'items.json'));
  });

  test('an explicit STORE_FILE wins', () => {
    const config = createConfig({ DATA_DIR: 'var/home', STORE_FILE: 'var/db.json' });
    assert.equal(config.storeFile, path.resolve('var/db.json'));
  });

  test('resolved paths never contain traversal segments', () => {
    const config = createConfig({ DATA_DIR: 'var/home/../../etc' });
    assert.equal(config.dataDir.includes('..'), false);
  });
});

describe('createConfig parsing', () => {
  test('reads numeric settings from the environment', () => {
    const config = createConfig({ PORT: '3000', MAX_ITEMS: '10', MAX_BODY_BYTES: '2048' });
    assert.equal(config.port, 3000);
    assert.equal(config.maxItems, 10);
    assert.equal(config.maxBodyBytes, 2048);
  });

  test('accepts decimal values only for the refill rate', () => {
    assert.equal(createConfig({ RATE_LIMIT_REFILL_PER_SECOND: '0.5' }).rateLimitRefillPerSecond, 0.5);
    assert.throws(() => createConfig({ RATE_LIMIT_CAPACITY: '1.5' }), TypeError);
  });

  test('parses booleans in the usual spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(createConfig({ TRUST_PROXY: value }).trustProxy, true, value);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      assert.equal(createConfig({ TRUST_PROXY: value }).trustProxy, false, value);
    }
  });

  test('treats an empty variable as unset', () => {
    const config = createConfig({ PORT: '', HOST: '' });
    assert.equal(config.port, 8080);
    assert.equal(config.host, '127.0.0.1');
  });
});

describe('createConfig validation', () => {
  test('rejects an unknown NODE_ENV or LOG_LEVEL', () => {
    assert.throws(() => createConfig({ NODE_ENV: 'staging' }), /NODE_ENV must be one of/);
    assert.throws(() => createConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/);
  });

  test('rejects out-of-range and non-numeric numbers', () => {
    assert.throws(() => createConfig({ PORT: '0' }), /between 1 and 65535/);
    assert.throws(() => createConfig({ PORT: '70000' }), /between 1 and 65535/);
    assert.throws(() => createConfig({ PORT: '8080abc' }), /must be an integer/);
    assert.throws(() => createConfig({ PORT: '0x1f90' }), /must be an integer/);
    assert.throws(() => createConfig({ MAX_ITEMS: '0' }), /between 1 and 1000000/);
    assert.throws(() => createConfig({ MAX_BODY_BYTES: '10' }), /between 1024 and 1048576/);
    assert.throws(() => createConfig({ SHUTDOWN_TIMEOUT_MS: '10' }), /between 1000 and 60000/);
  });

  test('rejects a non-boolean TRUST_PROXY', () => {
    assert.throws(() => createConfig({ TRUST_PROXY: 'maybe' }), /must be a boolean/);
  });

  test('rejects over-long strings', () => {
    assert.throws(() => createConfig({ HOST: 'h'.repeat(300) }), /at most 255/);
  });

  test('a zero refill rate is refused because it would never recover', () => {
    assert.throws(() => createConfig({ RATE_LIMIT_REFILL_PER_SECOND: '0' }), /must be > 0/);
  });
});
