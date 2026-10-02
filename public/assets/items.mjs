/**
 * Pure client-side view logic.
 *
 * Kept free of DOM and network access on purpose: this module is imported by
 * both the browser bundle and the Node test suite, so filtering, summarising and
 * error-message shaping are all covered by real assertions.
 *
 * Everything here returns plain strings. The renderer assigns them with
 * `textContent`, which is what makes stored-XSS impossible even if an attacker
 * manages to write markup into an inventory record.
 */

/** @param {unknown} value */
export function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Free-text match across the fields a user would reasonably search.
 *
 * @param {Record<string, unknown>} item
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(item, query) {
  const needle = normalize(query);
  if (needle === '') return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const haystack = [item.name, item.category, item.room, item.notes, ...tags];
  return haystack.some((field) => normalize(field).includes(needle));
}

/**
 * @param {Record<string, unknown>[]} items
 * @param {{q?: string, room?: string, category?: string}} [filters]
 */
export function filterItems(items, filters = {}) {
  const { q = '', room = '', category = '' } = filters;
  const wantedRoom = normalize(room);
  const wantedCategory = normalize(category);
  return items.filter((item) => {
    if (wantedRoom !== '' && normalize(item.room) !== wantedRoom) return false;
    if (wantedCategory !== '' && normalize(item.category) !== wantedCategory) return false;
    return matchesQuery(item, q);
  });
}

/** Newest first by default; `key` may be any item field. */
export function sortItems(items, key = 'createdAt', direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
    const leftText = typeof left === 'string' ? left : '';
    const rightText = typeof right === 'string' ? right : '';
    if (leftText === rightText) return 0;
    return (leftText < rightText ? -1 : 1) * sign;
  });
}

/**
 * Aggregate totals for the header summary.
 *
 * @param {Record<string, unknown>[]} items
 * @returns {{count: number, totalUnits: number, totalValue: number, rooms: number}}
 */
export function summarize(items) {
  let totalUnits = 0;
  let totalValue = 0;
  const rooms = new Set();
  for (const item of items) {
    const quantity = Number.isInteger(item.quantity) ? item.quantity : 0;
    totalUnits += quantity;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) totalValue += item.value;
    if (typeof item.room === 'string' && item.room !== '') rooms.add(item.room);
  }
  return {
    count: items.length,
    totalUnits,
    // Floating point addition of money needs rounding to avoid 0.1+0.2 drift.
    totalValue: Math.round(totalValue * 100) / 100,
    rooms: rooms.size,
  };
}

/** @param {number} value @param {string} [locale] */
export function formatNumber(value, locale = 'en-US') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * Flatten a record into the strings the table renders.
 *
 * @param {Record<string, unknown>} item
 */
export function toViewModel(item) {
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [];
  return {
    id: typeof item.id === 'string' ? item.id : '',
    name: typeof item.name === 'string' && item.name !== '' ? item.name : '(unnamed item)',
    category: typeof item.category === 'string' ? item.category : 'uncategorized',
    room: typeof item.room === 'string' && item.room !== '' ? item.room : '-',
    quantity: Number.isInteger(item.quantity) ? item.quantity : 1,
    value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null,
    notes: typeof item.notes === 'string' ? item.notes : '',
    tags,
  };
}

/**
 * Turn an API error envelope into one human-readable line per field.
 * Unknown shapes degrade to a single generic message, so a malformed or hostile
 * payload can never end up being rendered as UI text.
 *
 * @param {unknown} payload
 * @returns {string[]}
 */
export function errorMessages(payload) {
  const fallback = ['The request could not be completed. Please try again.'];
  if (payload === null || typeof payload !== 'object') return fallback;
  const error = /** @type {{error?: unknown}} */ (payload).error;
  if (error === null || typeof error !== 'object') return fallback;
  const details = /** @type {{details?: unknown}} */ (error).details;
  if (details !== undefined && details !== null && typeof details === 'object') {
    const list = /** @type {{errors?: unknown}} */ (details).errors;
    if (Array.isArray(list) && list.length > 0) {
      const messages = list
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.message === 'string')
        .map((entry) => {
          const field = typeof entry.path === 'string' && entry.path !== '' ? `${entry.path}: ` : '';
          return `${field}${entry.message}`;
        });
      if (messages.length > 0) return messages.slice(0, 20);
    }
  }
  if (details !== undefined && (details === null || typeof details !== 'object')) return fallback;
  return typeof error.message === 'string' && error.message !== '' ? [error.message] : fallback;
}

/**
 * Build the create/update payload from raw form values.
 * Empty optional fields are omitted entirely rather than sent as `""`,
 * so the server's own defaults and nullable rules stay authoritative.
 *
 * @param {Record<string, string>} raw
 */
export function buildItemPayload(raw) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  const name = (raw.name ?? '').trim();
  if (name !== '') payload.name = name;

  const category = (raw.category ?? '').trim();
  if (category !== '') payload.category = category;

  const room = (raw.room ?? '').trim();
  if (room !== '') payload.room = room;

  const quantity = raw.quantity === undefined ? '' : raw.quantity.trim();
  if (quantity !== '') {
    const parsed = Number(quantity);
    if (Number.isInteger(parsed) && parsed > 0) payload.quantity = parsed;
  }

  const value = raw.value === undefined ? '' : raw.value.trim();
  if (value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) payload.value = parsed;
  }

  const purchaseDate = (raw.purchaseDate ?? '').trim();
  if (purchaseDate !== '') payload.purchaseDate = purchaseDate;

  const tags = (raw.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
    .slice(0, 16);
  if (tags.length > 0) payload.tags = tags;

  const notes = (raw.notes ?? '').trim();
  if (notes !== '') payload.notes = notes;

  return payload;
}
