import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { RateLimiter } from '../src/lib/rate-limit.js';

/** Controllable clock. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  test('allows up to capacity then throttles', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('a').allowed, true);
    const denied = limiter.take('a');
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.retryAfterMs, 1000);
  });

  test('refills over time and never exceeds capacity', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: clock.now });
    limiter.take('a', 4);
    assert.equal(limiter.take('a').allowed, false);
    clock.advance(500);
    const verdict = limiter.take('a');
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.remaining, 0);
    clock.advance(60_000);
    assert.equal(limiter.take('a', 100).remaining, 4);
  });

  test('keeps buckets independent per key', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    assert.equal(limiter.take('a').allowed, true);
    assert.equal(limiter.take('b').allowed, true);
    assert.equal(limiter.take('a').allowed, false);
  });

  test('reports remaining tokens as a non-negative integer', () => {
    const limiter = new RateLimiter({ capacity: 10, refillPerSecond: 1 });
    assert.equal(limiter.take('a', 3).remaining, 7);
    assert.equal(Number.isInteger(limiter.take('a', 1).remaining), true);
  });

  test('caps tracked keys so spoofed identities cannot exhaust memory', () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, maxKeys: 10 });
    for (let index = 0; index < 5000; index += 1) limiter.take(`client-${index}`);
    assert.equal(limiter.size, 10);
  });

  test('reset clears all state', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    limiter.take('a');
    assert.equal(limiter.take('a').allowed, false);
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.take('a').allowed, true);
  });

  test('never returns a negative remaining count', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now });
    limiter.take('a', 2);
    clock.advance(100);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(limiter.take('a').remaining >= 0, true);
    }
  });

  test('rejects nonsensical configuration and usage', () => {
    assert.throws(() => new RateLimiter({ capacity: 0 }), TypeError);
    assert.throws(() => new RateLimiter({ capacity: -1 }), TypeError);
    assert.throws(() => new RateLimiter({ refillPerSecond: 0 }), TypeError);
    assert.throws(() => new RateLimiter({ refillPerSecond: 1e9 }), TypeError);
    assert.throws(() => new RateLimiter({ maxKeys: 0 }), TypeError);
    assert.throws(() => new RateLimiter({ maxKeys: 1.5 }), TypeError);

    const limiter = new RateLimiter();
    assert.throws(() => limiter.take('a', 0), TypeError);
    assert.throws(() => limiter.take('a', -3), TypeError);
    assert.throws(() => limiter.take('a', Number.NaN), TypeError);
  });

  test('a backwards clock cannot mint extra tokens', () => {
    const clock = fakeClock(10_000);
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 10, now: clock.now });
    limiter.take('a', 5);
    clock.advance(-5_000);
    assert.equal(limiter.take('a').allowed, false);
  });
});
