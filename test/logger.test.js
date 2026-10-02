import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Writable } from 'node:stream';
import { createLogger, LOG_LEVELS, REDACTED, sanitizeForLog } from '../src/lib/logger.js';

/** Collects written lines. */
function collector() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString('utf8').trim());
      callback();
    },
  });
  return { stream, lines };
}

describe('sanitizeForLog', () => {
  test('redacts values whose key looks like a secret', () => {
    const result = sanitizeForLog({
      username: 'sam',
      password: 'hunter2',
      apiKey: 'sk-live-123',
      'X-Api-Key': 'abc',
      authorization: 'Bearer abc',
      cookie: 'session=1',
      csrfToken: 'x',
      credentials: 'y',
      privateKey: 'z',
    });
    assert.equal(result.username, 'sam');
    const sensitiveKeys = [
      'password',
      'apiKey',
      'X-Api-Key',
      'authorization',
      'cookie',
      'csrfToken',
      'credentials',
      'privateKey',
    ];
    for (const key of sensitiveKeys) {
      assert.equal(result[key], REDACTED, key);
    }
  });

  test('escapes control characters so a value cannot forge a log line', () => {
    const result = sanitizeForLog({ note: 'evil\n{"level":"info","msg":"forged"}\r\u001b[31m' });
    assert.equal(result.note.includes('\n'), false);
    assert.equal(result.note.includes('\r'), false);
    assert.equal(result.note.includes('\u001b'), false);
    assert.equal(result.note.includes('\\u000a'), true);
    assert.equal(result.note.includes('\\u001b'), true);
  });

  test('escaping is stateless across repeated calls (no lastIndex leakage)', () => {
    for (let index = 0; index < 5; index += 1) {
      assert.equal(sanitizeForLog('a\nb'), 'a\\u000ab');
    }
  });

  test('truncates very long strings and marks the truncation', () => {
    const result = sanitizeForLog({ blob: 'x'.repeat(5000) });
    assert.equal(result.blob.endsWith('...[truncated]'), true);
    assert.equal(result.blob.length < 2100, true);
  });

  test('does not split surrogate pairs while escaping', () => {
    const result = sanitizeForLog('\u{1F600}\n');
    assert.equal(result, '\u{1F600}\\u000a');
  });

  test('bounds array width and object depth', () => {
    const wide = sanitizeForLog({ list: Array.from({ length: 200 }, (unused, index) => index) });
    assert.equal(wide.list.length, 51);
    assert.equal(wide.list[50], '[+150 more]');

    let deep = { value: 'leaf' };
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    assert.equal(JSON.stringify(sanitizeForLog(deep)).includes('[truncated]'), true);
  });

  test('summarises errors without a stack trace', () => {
    const error = new Error('boom');
    error.code = 'E_TEST';
    const result = sanitizeForLog({ error });
    assert.deepEqual(result.error, { name: 'Error', message: 'boom', code: 'E_TEST' });
  });

  test('handles non-plain values safely', () => {
    assert.equal(sanitizeForLog(Number.NaN), 'NaN');
    assert.equal(sanitizeForLog(10n), '10');
    assert.equal(sanitizeForLog(() => {}), '[function]');
    assert.equal(sanitizeForLog(Symbol('s')), '[symbol]');
    assert.equal(sanitizeForLog(null), null);
    assert.equal(sanitizeForLog(undefined), undefined);
  });
});

describe('createLogger', () => {
  test('writes structured JSON with a level, message and timestamp', () => {
    const { stream, lines } = collector();
    const logger = createLogger({
      level: 'debug',
      stdout: stream,
      stderr: stream,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });
    logger.info('hello', { requestId: 'abc' });
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.deepEqual(record, {
      time: '2026-01-02T03:04:05.000Z',
      level: 'info',
      msg: 'hello',
      requestId: 'abc',
    });
  });

  test('honours the level threshold', () => {
    const { stream, lines } = collector();
    const logger = createLogger({ level: 'warn', stdout: stream, stderr: stream });
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    assert.equal(lines.length, 2);
  });

  test('emits nothing at level silent', () => {
    const { stream, lines } = collector();
    const logger = createLogger({ level: 'silent', stdout: stream, stderr: stream });
    logger.error('this must not appear');
    assert.equal(lines.length, 0);
  });

  test('sends warn and error to stderr and info to stdout', () => {
    const out = collector();
    const err = collector();
    const logger = createLogger({ level: 'debug', stdout: out.stream, stderr: err.stream });
    logger.info('to-stdout');
    logger.warn('to-stderr');
    logger.error('to-stderr');
    assert.equal(out.lines.length, 1);
    assert.equal(err.lines.length, 2);
  });

  test('applies redaction to real log calls', () => {
    const { stream, lines } = collector();
    const logger = createLogger({ level: 'info', stdout: stream, stderr: stream });
    logger.info('login', { username: 'sam', password: 'hunter2' });
    assert.equal(lines[0].includes('hunter2'), false);
    assert.equal(lines[0].includes(REDACTED), true);
  });

  test('merges base fields into every record', () => {
    const { stream, lines } = collector();
    const logger = createLogger({ level: 'info', stdout: stream, stderr: stream, base: { service: 'homecompass' } });
    logger.info('up');
    assert.equal(JSON.parse(lines[0]).service, 'homecompass');
  });

  test('rejects an unknown level', () => {
    assert.throws(() => createLogger({ level: 'chatty' }), TypeError);
  });

  test('LOG_LEVELS orders severities correctly', () => {
    assert.equal(LOG_LEVELS.debug < LOG_LEVELS.info, true);
    assert.equal(LOG_LEVELS.info < LOG_LEVELS.warn, true);
    assert.equal(LOG_LEVELS.warn < LOG_LEVELS.error, true);
    assert.equal(LOG_LEVELS.error < LOG_LEVELS.silent, true);
  });
});
