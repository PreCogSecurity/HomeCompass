import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  buildItemPayload,
  errorMessages,
  filterItems,
  formatNumber,
  matchesQuery,
  normalize,
  sortItems,
  summarize,
  toViewModel,
} from '../public/assets/items.mjs';

const ITEMS = [
  {
    id: 'a',
    name: 'Cordless drill',
    category: 'tools',
    room: 'garage',
    quantity: 2,
    value: 129.99,
    notes: 'Spare battery in case',
    tags: ['power', '18v'],
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'b',
    name: 'Coffee beans',
    category: 'food',
    room: 'kitchen',
    quantity: 1,
    value: 12.5,
    notes: '',
    tags: ['pantry'],
    createdAt: '2026-02-02T00:00:00.000Z',
  },
  {
    id: 'c',
    name: 'Spares',
    category: 'tools',
    room: 'garage',
    quantity: 10,
    value: null,
    notes: '',
    tags: [],
    createdAt: '2026-03-02T00:00:00.000Z',
  },
];

describe('normalize', () => {
  test('trims and lowercases strings, tolerating other types', () => {
    assert.equal(normalize('  Garage '), 'garage');
    assert.equal(normalize(null), '');
    assert.equal(normalize(42), '');
  });
});

describe('matchesQuery', () => {
  test('matches name, category, room, notes and tags', () => {
    for (const query of ['drill', 'DRILL', 'tools', 'garage', 'battery', '18v']) {
      assert.equal(matchesQuery(ITEMS[0], query), true, query);
    }
  });

  test('an empty query matches everything', () => {
    assert.equal(matchesQuery(ITEMS[0], ''), true);
    assert.equal(matchesQuery(ITEMS[0], '   '), true);
  });

  test('unrelated text does not match', () => {
    assert.equal(matchesQuery(ITEMS[0], 'bicycle'), false);
  });
});

describe('filterItems', () => {
  test('combines query, room and category filters', () => {
    assert.equal(filterItems(ITEMS).length, 3);
    assert.equal(filterItems(ITEMS, { room: 'garage' }).length, 2);
    assert.equal(filterItems(ITEMS, { category: 'tools' }).length, 2);
    assert.equal(filterItems(ITEMS, { room: 'garage', category: 'tools', q: 'drill' }).length, 1);
    assert.equal(filterItems(ITEMS, { room: 'garage', q: 'coffee' }).length, 0);
  });

  test('treats filter values as case-insensitive', () => {
    assert.equal(filterItems(ITEMS, { room: 'GARAGE' }).length, 2);
  });

  test('does not mutate the input array', () => {
    const copy = [...ITEMS];
    filterItems(ITEMS, { room: 'garage' });
    assert.deepEqual(ITEMS, copy);
  });
});

describe('sortItems', () => {
  test('defaults to newest first', () => {
    assert.deepEqual(
      sortItems(ITEMS).map((item) => item.id),
      ['c', 'b', 'a'],
    );
  });

  test('supports ascending order on any field', () => {
    assert.deepEqual(
      sortItems(ITEMS, 'name', 'asc').map((item) => item.id),
      ['b', 'a', 'c'],
    );
  });

  test('does not mutate the input array', () => {
    const copy = [...ITEMS];
    sortItems(ITEMS);
    assert.deepEqual(ITEMS, copy);
  });

  test('is stable for equal keys', () => {
    assert.deepEqual(
      sortItems([{ id: 'x', room: 'a' }, { id: 'y', room: 'a' }]).map((item) => item.id),
      ['x', 'y'],
    );
  });
});

describe('summarize', () => {
  test('totals units, value and distinct rooms', () => {
    const stats = summarize(ITEMS);
    assert.equal(stats.count, 3);
    assert.equal(stats.totalUnits, 13);
    assert.equal(stats.rooms, 2);
    assert.equal(stats.totalValue, 142.49);
  });

  test('avoids floating point drift on money', () => {
    const stats = summarize([{ quantity: 1, value: 0.1 }, { quantity: 1, value: 0.2 }]);
    assert.equal(stats.totalValue, 0.3);
  });

  test('ignores malformed values instead of producing NaN', () => {
    const stats = summarize([
      { quantity: 'many', value: 'lots' },
      { quantity: 2, value: Number.NaN },
      { quantity: 1, value: 5 },
      { room: 'attic' },
    ]);
    assert.equal(stats.totalUnits, 3);
    assert.equal(stats.totalValue, 5);
    assert.equal(stats.rooms, 1);
  });

  test('handles an empty list', () => {
    assert.deepEqual(summarize([]), { count: 0, totalUnits: 0, totalValue: 0, rooms: 0 });
  });
});

describe('formatNumber', () => {
  test('formats with locale grouping', () => {
    assert.equal(formatNumber(1234567), '1,234,567');
  });

  test('returns an empty string for non-numbers', () => {
    for (const value of [null, undefined, Number.NaN, '5', {}]) {
      assert.equal(formatNumber(value), '');
    }
  });
});

describe('toViewModel', () => {
  test('produces display-safe defaults', () => {
    const view = toViewModel({});
    assert.equal(view.name, '(unnamed item)');
    assert.equal(view.category, 'uncategorized');
    assert.equal(view.room, '-');
    assert.equal(view.quantity, 1);
    assert.equal(view.value, null);
    assert.deepEqual(view.tags, []);
  });

  test('drops non-string tags', () => {
    assert.deepEqual(toViewModel({ tags: ['ok', 5, null, {}] }).tags, ['ok']);
  });

  test('passes real values through', () => {
    const view = toViewModel(ITEMS[0]);
    assert.equal(view.name, 'Cordless drill');
    assert.equal(view.room, 'garage');
    assert.equal(view.value, 129.99);
    assert.deepEqual(view.tags, ['power', '18v']);
  });
});

describe('errorMessages', () => {
  test('extracts per-field validation errors', () => {
    const messages = errorMessages({
      error: {
        code: 'validation_failed',
        message: 'Request validation failed',
        details: { errors: [{ path: 'name', message: 'name is required' }] },
      },
    });
    assert.deepEqual(messages, ['name: name is required']);
  });

  test('falls back to the top-level message', () => {
    assert.deepEqual(errorMessages({ error: { message: 'Item not found' } }), ['Item not found']);
  });

  test('never returns an empty list, whatever the payload', () => {
    const fallback = ['The request could not be completed. Please try again.'];
    const payloads = [
      null,
      undefined,
      'oops',
      42,
      {},
      { error: null },
      { error: {} },
      { error: { message: '' } },
      { error: { details: { errors: [] } } },
    ];
    for (const payload of payloads) {
      assert.deepEqual(errorMessages(payload), fallback, JSON.stringify(payload));
    }
  });

  test('ignores malformed entries and caps the list length', () => {
    const errors = Array.from({ length: 100 }, (unused, index) =>
      index % 2 === 0 ? { path: `f${index}`, message: `bad ${index}` } : 'junk',
    );
    const messages = errorMessages({ error: { message: 'm', details: { errors } } });
    assert.equal(messages.length, 20);
    assert.equal(messages[0], 'f0: bad 0');
  });
});

describe('buildItemPayload', () => {
  test('omits blank optional fields so server defaults stay authoritative', () => {
    const payload = buildItemPayload({ name: '  Drill  ', category: '', room: '   ', notes: '', tags: '' });
    assert.deepEqual(payload, { name: 'Drill' });
  });

  test('parses numbers and rejects junk values', () => {
    assert.equal(buildItemPayload({ name: 'x', quantity: '3' }).quantity, 3);
    assert.equal(buildItemPayload({ name: 'x', quantity: 'abc' }).quantity, undefined);
    assert.equal(buildItemPayload({ name: 'x', quantity: '0' }).quantity, undefined);
    assert.equal(buildItemPayload({ name: 'x', quantity: '-2' }).quantity, undefined);
    assert.equal(buildItemPayload({ name: 'x', value: '19.99' }).value, 19.99);
    assert.equal(buildItemPayload({ name: 'x', value: '-1' }).value, undefined);
  });

  test('splits, trims and caps tags', () => {
    const many = Array.from({ length: 40 }, (unused, index) => `tag${index}`).join(',');
    assert.equal(buildItemPayload({ name: 'x', tags: many }).tags.length, 16);
    assert.deepEqual(buildItemPayload({ name: 'x', tags: ' a , b ,, c ' }).tags, ['a', 'b', 'c']);
  });

  test('carries the purchase date through', () => {
    assert.equal(buildItemPayload({ name: 'x', purchaseDate: '2026-01-31' }).purchaseDate, '2026-01-31');
    assert.equal(buildItemPayload({ name: 'x', purchaseDate: '' }).purchaseDate, undefined);
  });

  test('an entirely blank form produces no payload', () => {
    assert.deepEqual(buildItemPayload({}), {});
  });
});
