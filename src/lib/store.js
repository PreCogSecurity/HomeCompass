/**
 * File-backed inventory store.
 *
 * Reliability properties that matter to a customer running this in their home:
 *  - Atomic durability: data is written to a temp file then `rename`d, so a crash
 *    mid-write can never truncate or corrupt the database.
 *  - Serialised mutations: writes go through a promise queue, so two concurrent
 *    requests cannot interleave read-modify-write cycles and lose an update.
 *  - Corruption is never silently discarded: an unparseable database fails the
 *    boot with an actionable message instead of quietly starting empty.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { conflict, notFound } from './errors.js';

/** Record ids are opaque UUIDs; this bounds anything that looks like one. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATABASE_VERSION = 1;
/** Fields a client is allowed to influence, mapped to internal setters. */
const WRITABLE_FIELDS = Object.freeze([
  'name',
  'category',
  'room',
  'quantity',
  'purchaseDate',
  'value',
  'notes',
  'tags',
]);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidItemId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * @param {string} haystack
 * @param {string} needle
 */
function contains(haystack, needle) {
  return typeof haystack === 'string' && haystack.toLowerCase().includes(needle);
}

/**
 * Produce a self-owned, immutable record.
 *
 * The `tags` array is copied because `Object.freeze` is shallow: without this, a
 * caller holding a reference to a returned record could mutate stored state.
 *
 * @param {Record<string, unknown>} record
 */
function freezeRecord(record) {
  const owned = { ...record, tags: Array.isArray(record.tags) ? [...record.tags] : [] };
  return Object.freeze(owned);
}

/**
 * Hand a caller a mutable copy of a stored record.
 *
 * @param {Record<string, unknown> | undefined} record
 */
function copyRecord(record) {
  if (record === undefined) return undefined;
  return { ...record, tags: [...record.tags] };
}

export class InventoryStore {
  #file;
  #maxItems;
  #logger;
  #items = new Map();
  #queue = Promise.resolve();
  #tempCounter = 0;
  #ready = false;

  /**
   * @param {{file: string, maxItems?: number, logger?: {warn: Function, error: Function}}} options
   */
  constructor(options) {
    const { file, maxItems = 5_000, logger } = options;
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('file is required');
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new TypeError('maxItems must be >= 1');
    this.#file = path.resolve(file);
    this.#maxItems = maxItems;
    this.#logger = logger ?? { warn: () => {}, error: () => {} };
  }

  /** Whether the database has been loaded successfully. */
  get ready() {
    return this.#ready;
  }

  get file() {
    return this.#file;
  }

  get count() {
    return this.#items.size;
  }

  /** Load the database, creating an empty one when the file does not exist. */
  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    let raw;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#ready = true;
        await this.#persist();
        return this;
      }
      throw error;
    }

    if (raw.trim() === '') {
      this.#ready = true;
      await this.#persist();
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `HomeCompass database at ${this.#file} is not valid JSON. ` +
          'Refusing to start so no data is lost; move the file aside and restore a backup.',
        { cause: error },
      );
    }

    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      throw new Error(
        `HomeCompass database at ${this.#file} has an unexpected shape ` +
          `(expected an object with an "items" array). Refusing to start.`,
      );
    }

    for (const record of parsed.items) {
      if (record !== null && typeof record === 'object' && isValidItemId(record.id)) {
        this.#items.set(record.id, freezeRecord(record));
      } else {
        this.#logger.warn('Skipping malformed inventory record', {
          idType: typeof record?.id,
        });
      }
    }
    this.#ready = true;
    return this;
  }

  /**
   * Filtered, sorted, paginated read. Never mutates stored records.
   *
   * @param {{q?: string, room?: string, category?: string, limit?: number, offset?: number}} [query]
   */
  list(query = {}) {
    const { q, room, category, limit = 50, offset = 0 } = query;
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';

    let items = [...this.#items.values()];
    if (typeof room === 'string' && room !== '') items = items.filter((item) => item.room === room);
    if (typeof category === 'string' && category !== '') {
      items = items.filter((item) => item.category === category);
    }
    if (needle !== '') {
      items = items.filter((item) =>
        contains(item.name, needle) ||
        contains(item.category, needle) ||
        contains(item.room, needle) ||
        contains(item.notes, needle) ||
        (Array.isArray(item.tags) && item.tags.some((tag) => contains(tag, needle))),
      );
    }

    // Newest first, tie-broken by id. Two items created in the same millisecond
    // share a `createdAt`; without an explicit tie-break the page order would
    // depend on the engine's sort-stability guarantee and on Map insertion
    // order. Making the rule total means a page walk is reproducible no matter
    // how the map was rebuilt, which is what keeps offset pagination free of
    // silently repeated and silently skipped rows.
    items.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    const total = items.length;
    const page = items.slice(offset, offset + limit);

    return { items: page.map((item) => copyRecord(item)), total, limit, offset };
  }

  /** Distinct room and category values, for UI filter controls. */
  facets() {
    const rooms = new Set();
    const categories = new Set();
    for (const item of this.#items.values()) {
      if (typeof item.room === 'string' && item.room !== '') rooms.add(item.room);
      if (typeof item.category === 'string' && item.category !== '') categories.add(item.category);
    }
    return {
      rooms: [...rooms].sort(),
      categories: [...categories].sort(),
    };
  }

  /** @param {string} id */
  get(id) {
    if (!isValidItemId(id)) return undefined;
    return copyRecord(this.#items.get(id));
  }

  /**
   * Insert a validated item.
   *
   * @param {Record<string, unknown>} values
   */
  async create(values) {
    return this.#mutate(() => {
      if (this.#items.size >= this.#maxItems) {
        throw conflict(`Inventory is full (limit ${this.#maxItems} items)`);
      }
      const now = new Date().toISOString();
      const record = { id: randomUUID(), createdAt: now, updatedAt: now, version: 1 };
      for (const field of WRITABLE_FIELDS) {
        if (Object.hasOwn(values, field)) record[field] = values[field];
      }
      // Explicit defaults so every stored record has the same shape.
      if (record.category === undefined) record.category = 'uncategorized';
      if (record.quantity === undefined) record.quantity = 1;
      if (record.tags === undefined) record.tags = [];
      if (record.notes === undefined) record.notes = '';
      if (record.room === undefined) record.room = null;
      if (record.purchaseDate === undefined) record.purchaseDate = null;
      if (record.value === undefined) record.value = null;
      this.#items.set(record.id, freezeRecord(record));
      return copyRecord(record);
    });
  }

  /**
   * Merge a validated patch. When `values.version` is supplied it must match the
   * stored version, otherwise the caller is working from stale state.
   *
   * @param {string} id
   * @param {Record<string, unknown>} values
   */
  async update(id, values) {
    return this.#mutate(() => {
      if (!isValidItemId(id)) throw notFound('Item not found');
      const existing = this.#items.get(id);
      if (existing === undefined) throw notFound('Item not found');

      const expected = values.version;
      if (expected !== undefined && expected !== existing.version) {
        throw conflict(`Item was modified (expected version ${expected}, current ${existing.version})`);
      }

      const record = { ...existing };
      for (const field of WRITABLE_FIELDS) {
        if (Object.hasOwn(values, field)) record[field] = values[field];
      }
      record.id = existing.id;
      record.createdAt = existing.createdAt;
      record.version = existing.version + 1;
      record.updatedAt = new Date().toISOString();
      this.#items.set(id, freezeRecord(record));
      return copyRecord(record);
    });
  }

  /** @param {string} id */
  async remove(id) {
    return this.#mutate(() => {
      if (!isValidItemId(id)) throw notFound('Item not found');
      const existing = this.#items.get(id);
      if (existing === undefined) throw notFound('Item not found');
      this.#items.delete(id);
      return copyRecord(existing);
    });
  }

  /** Serialise mutations and persist once per settled queue entry. */
  #mutate(operation) {
    const run = this.#queue.then(async () => {
      const result = await operation();
      await this.#persist();
      return result;
    });
    // Keep the chain alive even when a caller rejects.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Write-then-rename for atomicity, with real durability.
   *
   * `rename` alone is only *atomic*, not *durable*: it updates the directory
   * entry in page cache, so a power cut immediately afterwards can still lose
   * the write — and this file is the only copy of the customer's inventory. So
   * the temp file is `fsync`ed before the rename, and the directory entry is
   * `fsync`ed after it, which is the ordering the kernel requires.
   *
   * Directory `fsync` is not supported on Windows; it is best-effort there and
   * failures are non-fatal because `MoveFileEx` already gives replace-on-close
   * semantics for the rename itself.
   */
  async #persist() {
    this.#tempCounter += 1;
    const tempFile = `${this.#file}.tmp-${process.pid}-${this.#tempCounter}`;
    const payload = `${JSON.stringify(
      { version: DATABASE_VERSION, items: [...this.#items.values()] },
      null,
      2,
    )}\n`;
    try {
      const handle = await open(tempFile, 'w', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempFile, this.#file);
      await this.#syncDirectory();
    } catch (error) {
      await unlink(tempFile).catch(() => {});
      throw error;
    }
  }

  /** Best-effort flush of the parent directory entry. */
  async #syncDirectory() {
    let handle;
    try {
      handle = await open(path.dirname(this.#file), 'r');
      await handle.sync();
    } catch {
      // Not supported on every platform; the rename is still atomic.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
