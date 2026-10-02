import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore, isValidItemId } from '../src/lib/store.js';
import { silentLogger } from './helpers/harness.mjs';

/** @param {{maxItems?: number}} [options] */
async function withStore(options, run) {
  const dir = await mkdtemp(join(tmpdir(), 'homecompass-store-'));
  const file = join(dir, 'items.json');
  const store = new InventoryStore({ file, logger: silentLogger(), ...options });
  await store.init();
  try {
    await run({ store, file, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_ITEM = { name: 'Cordless drill', category: 'tools', room: 'garage', quantity: 2 };

describe('isValidItemId', () => {
  test('accepts UUIDs and rejects anything else', () => {
    assert.equal(isValidItemId('3f7c1b2e-5a49-4c8d-9f31-6a2b0c4d5e6f'), true);
    for (const value of ['', 'x', '../../etc/passwd', 'a'.repeat(500), null, 42, {}]) {
      assert.equal(isValidItemId(value), false);
    }
  });
});

describe('InventoryStore', () => {
  test('creates an empty database on first init', () =>
    withStore({}, async ({ store, file }) => {
      assert.equal(store.count, 0);
      assert.equal(store.ready, true);
      const raw = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(raw, { version: 1, items: [] });
    }));

  test('round-trips a created item and survives a reload', () =>
    withStore({}, async ({ store, file }) => {
      const created = await store.create(VALID_ITEM);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.version, 1);
      assert.equal(store.count, 1);

      const reopened = new InventoryStore({ file, logger: silentLogger() });
      await reopened.init();
      const reloaded = reopened.get(created.id);
      assert.equal(reloaded.name, 'Cordless drill');
      assert.equal(reopened.count, 1);
    }));

  test('applies defaults for omitted fields', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create({ name: 'Box' });
      assert.equal(created.category, 'uncategorized');
      assert.equal(created.quantity, 1);
      assert.deepEqual(created.tags, []);
      assert.equal(created.notes, '');
    }));

  test('updates, bumps the version and preserves immutable fields', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create(VALID_ITEM);
      const updated = await store.update(created.id, { room: 'shed', version: 1 });
      assert.equal(updated.room, 'shed');
      assert.equal(updated.version, 2);
      assert.equal(updated.id, created.id);
      assert.equal(updated.createdAt, created.createdAt);
      assert.notEqual(updated.updatedAt, undefined);
    }));

  test('rejects a stale version with a conflict', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create(VALID_ITEM);
      await store.update(created.id, { room: 'shed' });
      await assert.rejects(() => store.update(created.id, { room: 'attic', version: 1 }), {
        status: 409,
        code: 'conflict',
      });
    }));

  test('ignores attempts to write server-owned fields through the writable set', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create(VALID_ITEM);
      const updated = await store.update(created.id, { id: 'spoofed', createdAt: '1999-01-01' });
      assert.equal(updated.id, created.id);
      assert.equal(updated.createdAt, created.createdAt);
    }));

  test('returns not-found for unknown and malformed ids', () =>
    withStore({}, async ({ store }) => {
      assert.equal(store.get('nope'), undefined);
      assert.equal(store.get(''), undefined);
      await assert.rejects(() => store.update('nope', { room: 'x' }), { status: 404 });
      await assert.rejects(() => store.remove('nope'), { status: 404 });
    }));

  test('deletes an item exactly once', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create(VALID_ITEM);
      const removed = await store.remove(created.id);
      assert.equal(removed.id, created.id);
      assert.equal(store.count, 0);
      await assert.rejects(() => store.remove(created.id), { status: 404 });
    }));

  test('enforces the item ceiling', () =>
    withStore({ maxItems: 2 }, async ({ store }) => {
      await store.create(VALID_ITEM);
      await store.create(VALID_ITEM);
      await assert.rejects(() => store.create(VALID_ITEM), { status: 409 });
    }));

  test('get() hands out a copy so callers cannot mutate stored state', () =>
    withStore({}, async ({ store }) => {
      const created = await store.create(VALID_ITEM);
      const snapshot = store.get(created.id);
      snapshot.name = 'tampered';
      snapshot.tags.push('injected');
      assert.equal(store.get(created.id).name, 'Cordless drill');
      assert.deepEqual(store.get(created.id).tags, []);
    }));

  test('searches name, notes, tags, room and category', () =>
    withStore({}, async ({ store }) => {
      await store.create({ ...VALID_ITEM, notes: 'Spare battery pack' });
      await store.create({ name: 'Hammer', tags: ['hand-tool'] });
      for (const query of ['drill', 'BATTERY', 'hand-tool', 'garage', 'tools']) {
        assert.equal(store.list({ q: query }).total >= 1, true, `query ${query}`);
      }
      assert.equal(store.list({ q: 'no-such-thing' }).total, 0);
    }));

  test('filters by room and category, and paginates deterministically', () =>
    withStore({}, async ({ store }) => {
      for (const item of [
        { name: 'a', room: 'kitchen', category: 'food' },
        { name: 'b', room: 'kitchen', category: 'tools' },
        { name: 'c', room: 'garage', category: 'tools' },
      ]) {
        await store.create(item);
      }
      assert.equal(store.list({ room: 'kitchen' }).total, 2);
      assert.equal(store.list({ category: 'tools' }).total, 2);
      assert.equal(store.list({ limit: 2 }).items.length, 2);
      assert.equal(store.list({ limit: 2, offset: 2 }).items.length, 1);
      assert.equal(store.list({ limit: 2, offset: 99 }).items.length, 0);
      assert.deepEqual(store.facets(), { rooms: ['garage', 'kitchen'], categories: ['food', 'tools'] });
    }));

  test('serialises concurrent writes without losing updates', () =>
    withStore({}, async ({ store, file }) => {
      await Promise.all(Array.from({ length: 25 }, (unused, index) => store.create({ name: `item-${index}` })));
      assert.equal(store.count, 25);
      const raw = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(raw.items.length, 25);
    }));

  test('leaves no temp files behind', () =>
    withStore({}, async ({ store, dir }) => {
      await store.create(VALID_ITEM);
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dir);
      assert.deepEqual(entries.filter((entry) => entry.includes('.tmp')), []);
    }));

  test('refuses to start on a corrupt database rather than discarding data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'homecompass-store-'));
    const file = join(dir, 'items.json');
    await writeFile(file, '{ this is not json', 'utf8');
    try {
      const store = new InventoryStore({ file, logger: silentLogger() });
      await assert.rejects(() => store.init(), /not valid JSON/);
      // The operator's file must still be there, untouched.
      assert.equal(await readFile(file, 'utf8'), '{ this is not json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to start on an unexpected database shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'homecompass-store-'));
    const file = join(dir, 'items.json');
    await writeFile(file, '{"items": "not-an-array"}', 'utf8');
    try {
      await assert.rejects(() => new InventoryStore({ file, logger: silentLogger() }).init(), /unexpected shape/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('skips and reports malformed records instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'homecompass-store-'));
    const file = join(dir, 'items.json');
    const goodId = '3f7c1b2e-5a49-4c8d-9f31-6a2b0c4d5e6f';
      const items = [{ id: 'bad' }, null, 7, { id: goodId, name: 'ok' }];
      await writeFile(file, JSON.stringify({ version: 1, items }), 'utf8');
    try {
      const store = new InventoryStore({ file, logger: silentLogger() });
      await store.init();
      assert.equal(store.count, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('stores the database with owner-only permissions on POSIX', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX permissions only');
    await withStore({}, async ({ file }) => {
      const stats = await import('node:fs/promises').then((fs) => fs.stat(file));
      assert.equal(stats.mode & 0o777, 0o600);
      await chmod(file, 0o600);
    });
  });

  test('treats an empty database file as empty rather than corrupt', () =>
    withStore({}, async ({ store, file }) => {
      await writeFile(file, '   \n', 'utf8');
      const reopened = new InventoryStore({ file, logger: silentLogger() });
      await reopened.init();
      assert.equal(reopened.count, 0);
    }));
});

test('constructor rejects nonsensical options', () => {
  assert.throws(() => new InventoryStore({ file: '' }), TypeError);
  assert.throws(() => new InventoryStore({ file: 'x', maxItems: 0 }), TypeError);
  assert.throws(() => new InventoryStore({ file: 'x', maxItems: 1.5 }), TypeError);
});

describe('pagination determinism', () => {
  test('items sharing a timestamp still page without gaps or repeats', () =>
    withStore({}, async ({ store, file }) => {
      for (let index = 0; index < 12; index += 1) await store.create({ name: `Item ${index}` });

      // Force every record onto an identical `createdAt`, so the id tie-break is
      // the only thing keeping ordering stable between calls. `Array.sort` makes
      // no promise about ties, and an unstable order silently repeats a row on
      // one page and drops another entirely.
      const frozen = '2026-01-01T00:00:00.000Z';
      const raw = JSON.parse(await readFile(file, 'utf8'));
      for (const item of raw.items) item.createdAt = frozen;
      await writeFile(file, JSON.stringify(raw, null, 2), 'utf8');

      const reopened = new InventoryStore({ file, logger: silentLogger() });
      await reopened.init();

      const ids = [];
      for (const offset of [0, 5, 10]) {
        ids.push(...reopened.list({ limit: 5, offset }).items.map((item) => item.id));
      }
      assert.equal(ids.length, 12, 'every record must appear exactly once');
      assert.equal(new Set(ids).size, 12, 'no record may appear on two pages');

      // Repeating the walk must yield an identical order.
      const repeat = [];
      for (const offset of [0, 5, 10]) {
        repeat.push(...reopened.list({ limit: 5, offset }).items.map((item) => item.id));
      }
      assert.deepEqual(repeat, ids);

      // With every timestamp equal, the order must be the declared tie-break
      // (id descending) and nothing else. This pins the rule rather than relying
      // on the engine's sort-stability guarantee.
      const expected = [...ids].sort().reverse();
      assert.deepEqual(ids, expected);
    }));
});
