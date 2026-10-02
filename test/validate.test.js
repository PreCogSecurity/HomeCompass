import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  defineSchema,
  isPlainObject,
  itemCreateSchema,
  itemListQuerySchema,
  itemPatchSchema,
  validate,
} from '../src/lib/validate.js';

describe('isPlainObject', () => {
  test('accepts object literals and null-prototype objects', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
  });

  test('rejects arrays, null and primitives', () => {
    for (const value of [[], null, 'x', 1, true, () => {}]) {
      assert.equal(isPlainObject(value), false);
    }
  });
});

describe('validate (general behaviour)', () => {
  test('rejects a non-object body', () => {
    for (const value of [[], 'x', null, 42]) {
      const result = validate(itemCreateSchema, value);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, 'invalid_type');
    }
  });

  test('strips unknown keys in strict mode and reports them', () => {
    const result = validate(itemCreateSchema, { name: 'Drill', isAdmin: true });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map((error) => error.code),
      ['unknown_key'],
    );
  });

  test('silently drops unknown keys when the schema is non-strict', () => {
    const schema = defineSchema({ name: { type: 'string', required: true } }, { strict: false });
    const result = validate(schema, { name: 'Drill', extra: 'ignored' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { name: 'Drill' });
  });

  test('rejects prototype-pollution keys without polluting Object.prototype', () => {
    const payload = JSON.parse('{"name":"Drill","__proto__":{"polluted":true}}');
    const result = validate(itemCreateSchema, payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'forbidden_key');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });

  test('rejects "constructor" and "prototype" keys', () => {
    for (const key of ['constructor', 'prototype']) {
      const result = validate(itemCreateSchema, { name: 'x', [key]: {} });
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((error) => error.code === 'forbidden_key'), true);
    }
  });

  test('does not echo hostile key bytes into the error message', () => {
    const result = validate(itemCreateSchema, { name: 'x', '<script>alert(1)</script>': 1 });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].path, '<invalid-key>');
  });

  test('error messages never contain the rejected value', () => {
    const result = validate(itemCreateSchema, { name: 'secret-value-that-must-not-be-reflected' , quantity: 'abc' });
    assert.equal(result.ok, false);
    const rendered = JSON.stringify(result.errors);
    assert.equal(rendered.includes('secret-value-that-must-not-be-reflected'), false);
  });

  test('never returns more than 50 errors, so a hostile payload cannot flood the response', () => {
    const payload = { name: 'x' };
    for (let index = 0; index < 500; index += 1) payload[`extra${index}`] = index;
    const result = validate(itemCreateSchema, payload);
    assert.equal(result.errors.length, 50);
  });
});

describe('validate (strings)', () => {
  test('trims, enforces length bounds and lowercases on request', () => {
    const result = validate(itemCreateSchema, { name: '  Drill  ', category: '  TOOLS ' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      name: 'Drill',
      category: 'tools',
      quantity: 1,
      notes: '',
      tags: [],
    });
  });

  test('counts code points rather than UTF-16 units', () => {
    const name = '\u{1F600}'.repeat(120);
    assert.equal(validate(itemCreateSchema, { name }).ok, true);
    assert.equal(validate(itemCreateSchema, { name: `${name}a` }).ok, false);
  });

  test('rejects empty required strings after trimming', () => {
    const result = validate(itemCreateSchema, { name: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'too_short');
  });

  test('rejects non-strings', () => {
    const result = validate(itemCreateSchema, { name: 42 });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'invalid_type');
  });

  test('defaults are copied, not shared between validations', () => {
    const first = validate(itemCreateSchema, { name: 'a' });
    const second = validate(itemCreateSchema, { name: 'b' });
    first.value.tags.push('mutated');
    assert.deepEqual(second.value.tags, []);
  });
});

describe('validate (numbers)', () => {
  test('rejects non-integer integers', () => {
    assert.equal(validate(itemCreateSchema, { name: 'a', quantity: 1.5 }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', quantity: 1.5 }).errors[0].code, 'invalid_type');
  });

  test('rejects NaN, Infinity and unsafe integers', () => {
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 10]) {
      assert.equal(validate(itemCreateSchema, { name: 'a', quantity }).ok, false);
    }
  });

  test('enforces min and max bounds', () => {
    assert.equal(validate(itemCreateSchema, { name: 'a', quantity: 0 }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', quantity: 100_001 }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', value: -1 }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', value: 1_000_000_001 }).ok, false);
  });

  test('only coerces from strings when the field opts in', () => {
    assert.equal(validate(itemCreateSchema, { name: 'a', quantity: '5' }).ok, false);
    assert.equal(validate(itemListQuerySchema, { limit: '5' }).value.limit, 5);
  });

  test('rejects exponential or overflowing numeric strings when coercing', () => {
    for (const limit of ['1e3', '0x10', ' 5 ', '5.5', '99999999999999999999', '+-5']) {
      assert.equal(validate(itemListQuerySchema, { limit }).ok, false);
    }
  });
});

describe('validate (dates)', () => {
  test('accepts ISO dates and normalises timestamps', () => {
    assert.equal(validate(itemCreateSchema, { name: 'a', purchaseDate: '2024-03-05' }).ok, true);
    const result = validate(itemCreateSchema, { name: 'a', purchaseDate: '2024-03-05T18:30:00Z' });
    assert.equal(result.ok, true);
    assert.equal(result.value.purchaseDate, '2024-03-05');
  });

  test('accepts null when nullable', () => {
    const result = validate(itemCreateSchema, { name: 'a', purchaseDate: null });
    assert.equal(result.ok, true);
    assert.equal(result.value.purchaseDate, null);
  });

  test('rejects impossible calendar dates', () => {
    for (const purchaseDate of ['2026-02-31', '2024-13-01', '2024-00-10', '2024-01-00', '0000-01-01']) {
      const result = validate(itemCreateSchema, { name: 'a', purchaseDate });
      assert.equal(result.ok, false, `expected ${purchaseDate} to be rejected`);
    }
  });

  test('rejects garbage and out-of-range times', () => {
    const garbageDates = ['yesterday', '2024-1-1', '2024-01-01T25:00:00Z', '2024-01-01T10:99:00Z', '2999-12-31x'];
    for (const purchaseDate of garbageDates) {
      assert.equal(validate(itemCreateSchema, { name: 'a', purchaseDate }).ok, false, purchaseDate);
    }
  });

  test('accepts leap days only in leap years', () => {
    assert.equal(validate(itemCreateSchema, { name: 'a', purchaseDate: '2024-02-29' }).ok, true);
    assert.equal(validate(itemCreateSchema, { name: 'a', purchaseDate: '2023-02-29' }).ok, false);
  });
});

describe('validate (arrays)', () => {
  test('normalises, deduplicates and caps tags', () => {
    const result = validate(itemCreateSchema, { name: 'a', tags: [' Tools ', 'TOOLS', 'garage'] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.tags, ['tools', 'garage']);
  });

  test('rejects too many tags and invalid tag elements', () => {
    const many = Array.from({ length: 17 }, (unused, index) => `tag${index}`);
    assert.equal(validate(itemCreateSchema, { name: 'a', tags: many }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', tags: ['ok', ''] }).ok, false);
    assert.equal(validate(itemCreateSchema, { name: 'a', tags: 'not-an-array' }).ok, false);
  });
});

describe('validate (nesting)', () => {
  test('deeply nested input cannot exhaust the call stack', () => {
    // Recursion is driven by the schema, so attacker-controlled depth cannot
    // translate into stack depth: this must return, not blow the stack.
    const schema = defineSchema({ meta: { type: 'object', fields: { a: { type: 'object', fields: {} } } } });
    let payload = { meta: { a: {} } };
    for (let depth = 0; depth < 5000; depth += 1) payload = { meta: { a: payload.meta } };
    const result = validate(schema, payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'unknown_key');
  });

  test('the schema depth guard stops an over-deep schema', () => {
    let fields = {};
    for (let depth = 0; depth < 20; depth += 1) fields = { child: { type: 'object', fields } };
    const schema = defineSchema(fields);
    let payload = {};
    for (let depth = 0; depth < 20; depth += 1) payload = { child: payload };
    const result = validate(schema, payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.code === 'too_deep'), true);
  });
});

describe('item schemas', () => {
  test('the create schema requires a name and nothing else', () => {
    const result = validate(itemCreateSchema, {});
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map((error) => error.path),
      ['name'],
    );
  });

  test('the patch schema accepts an empty body', () => {
    const result = validate(itemPatchSchema, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {});
  });

  test('the list query schema applies pagination defaults', () => {
    const result = validate(itemListQuerySchema, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { limit: 50, offset: 0 });
  });

  test('the list query schema bounds pagination', () => {
    assert.equal(validate(itemListQuerySchema, { limit: '0' }).ok, false);
    assert.equal(validate(itemListQuerySchema, { limit: '101' }).ok, false);
    assert.equal(validate(itemListQuerySchema, { offset: '-1' }).ok, false);
  });
});
