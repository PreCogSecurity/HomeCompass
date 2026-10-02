/**
 * In-process token-bucket rate limiter.
 *
 * Deliberately bounded: the bucket map is capped and evicts the oldest key, so a
 * flood of spoofed client addresses cannot turn the limiter itself into an
 * unbounded memory leak (a classic limiter-DoS).
 */

export class RateLimiter {
  #capacity;
  #refillPerMs;
  #maxKeys;
  #now;
  #buckets = new Map();

  /**
   * @param {{capacity?: number, refillPerSecond?: number, maxKeys?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    const { capacity = 120, refillPerSecond = 2, maxKeys = 10_000, now = () => Date.now() } = options;
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new TypeError('capacity must be a positive number');
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0 || refillPerSecond > 10_000) {
      throw new TypeError('refillPerSecond must be > 0 and <= 10000');
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new TypeError('maxKeys must be a positive integer');
    }
    this.#capacity = capacity;
    this.#refillPerMs = refillPerSecond / 1000;
    this.#maxKeys = maxKeys;
    this.#now = now;
  }

  /** Number of tracked keys; asserted in tests to prove eviction works. */
  get size() {
    return this.#buckets.size;
  }

  /**
   * Consume `cost` tokens for `key`.
   *
   * @param {string} key
   * @param {number} [cost]
   * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
   */
  take(key, cost = 1) {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new TypeError('cost must be a positive number');
    }
    const timestamp = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      this.#evictToFit();
      bucket = { tokens: this.#capacity, updatedAt: timestamp };
      this.#buckets.set(key, bucket);
    }

    const elapsed = Math.max(0, timestamp - bucket.updatedAt);
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs);
    bucket.updatedAt = timestamp;

    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      return {
        allowed: false,
        remaining: Math.max(0, Math.floor(bucket.tokens)),
        retryAfterMs: Math.ceil(deficit / this.#refillPerMs),
      };
    }
    bucket.tokens -= cost;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  /** Forget all state (used by tests and by graceful shutdown). */
  reset() {
    this.#buckets.clear();
  }

  /** Insertion-ordered Map iteration makes the oldest key trivially evictable. */
  #evictToFit() {
    while (this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done === true) return;
      this.#buckets.delete(oldest.value);
    }
  }
}
