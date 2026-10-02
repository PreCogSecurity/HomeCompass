/**
 * Minimal process metrics.
 *
 * Deliberately dependency-free and deliberately dull: counters only, no request
 * bodies, no IPs, no item contents. `/api/metrics` must never become a side
 * channel that leaks inventory data or becomes an amplification target.
 */

const COUNTERS = Object.freeze([
  'requestsTotal',
  'requestsFailed',
  'requestsRejected',
  'itemsCreated',
  'itemsUpdated',
  'itemsDeleted',
  'validationFailures',
  'rateLimited',
  'hostRejected',
]);

export class Metrics {
  #counters = Object.create(null);
  #startedAt = Date.now();
  #now;

  /** @param {{now?: () => number}} [options] */
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
    for (const name of COUNTERS) this.#counters[name] = 0;
  }

  /** @param {string} name @param {number} [by] */
  increment(name, by = 1) {
    if (!Object.hasOwn(this.#counters, name)) return;
    this.#counters[name] += by;
  }

  /** @returns {Record<string, number>} */
  snapshot() {
    return { ...this.#counters };
  }

  /** @returns {{uptimeSeconds: number, counters: Record<string, number>}} */
  toJSON() {
    return {
      uptimeSeconds: Math.max(0, Math.round((this.#now() - this.#startedAt) / 1000)),
      counters: this.snapshot(),
    };
  }
}
