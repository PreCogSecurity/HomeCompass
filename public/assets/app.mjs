/**
 * Browser controller: talks to the HomeCompass API and paints the DOM.
 *
 * Rendering rules enforced here:
 *  - every value from the API is written with `textContent`, never `innerHTML`,
 *    so stored content is incapable of becoming executable markup;
 *  - no inline handlers or `eval`, so the strict CSP can stay as tight as it is;
 *  - outbound requests are same-origin only, with an abort timeout.
 */
import {
  buildItemPayload,
  errorMessages,
  filterItems,
  formatNumber,
  sortItems,
  summarize,
  toViewModel,
} from './items.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

const state = {
  items: [],
  facets: { rooms: [], categories: [] },
  filters: { q: '', room: '', category: '' },
};

/** @param {string} id */
const byId = (id) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element: ${id}`);
  return element;
};

class ApiError extends Error {
  /** @param {string} message @param {number} status @param {unknown} payload */
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown}} [options]
 */
async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method,
      // Same-origin only; no ambient credentials to leak.
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let payload = null;
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const [message] = errorMessages(payload);
      throw new ApiError(message, response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The server took too long to respond.', 0, null);
    }
    throw new ApiError('Cannot reach the HomeCompass server.', 0, null);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string[]} messages */
function renderErrors(container, statusElement, messages) {
  container.replaceChildren();
  statusElement.textContent = '';
  for (const message of messages) {
    const entry = document.createElement('li');
    entry.textContent = message;
    container.append(entry);
  }
  container.hidden = messages.length === 0;
}

/** @param {string} message */
function renderStatus(statusElement, message) {
  statusElement.textContent = message;
}

/**
 * @param {Record<string, unknown>[]} items
 */
function renderRows(items) {
  const body = byId('item-rows');
  const rows = items.map((rawItem) => {
    const item = toViewModel(rawItem);
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = item.name;
    row.append(nameCell);

    const categoryCell = document.createElement('td');
    categoryCell.textContent = item.category;
    row.append(categoryCell);

    const roomCell = document.createElement('td');
    roomCell.textContent = item.room;
    row.append(roomCell);

    const quantityCell = document.createElement('td');
    quantityCell.className = 'numeric';
    quantityCell.textContent = formatNumber(item.quantity);
    row.append(quantityCell);

    const valueCell = document.createElement('td');
    valueCell.className = 'numeric';
    valueCell.textContent = item.value === null ? '-' : formatNumber(item.value, undefined);
    row.append(valueCell);

    const tagsCell = document.createElement('td');
    tagsCell.textContent = item.tags.join(', ');
    row.append(tagsCell);

    const actionsCell = document.createElement('td');
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'button button--danger';
    removeButton.textContent = 'Delete';
    removeButton.dataset.itemId = item.id;
    removeButton.addEventListener('click', () => {
      void removeItem(item.id, item.name);
    });
    actionsCell.append(removeButton);
    row.append(actionsCell);

    return row;
  });
  body.replaceChildren(...rows);
}

/** @param {{rooms: string[], categories: string[]}} facets */
function renderFacetOptions() {
  const roomSelect = byId('filter-room');
  const categorySelect = byId('filter-category');
  const roomList = byId('room-options');
  const categoryList = byId('category-options');

  const build = (values, previous) => {
    const options = [new Option('All', '')];
    for (const value of values) options.push(new Option(value, value));
    return { options, previous };
  };

  const rooms = build(facets.rooms, roomSelect.value);
  const categories = build(facets.categories, categorySelect.value);
  roomSelect.replaceChildren(...rooms.options);
  categorySelect.replaceChildren(...categories.options);
  roomSelect.value = rooms.previous;
  categorySelect.value = categories.previous;
  roomList.replaceChildren(
    ...facets.rooms.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }),
  );
  categoryList.replaceChildren(
    ...facets.categories.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }),
  );
}

function render() {
  const filtered = sortItems(filterItems(state.items, state.filters));
  renderRows(filtered);

  const stats = summarize(filtered);
  byId('summary').textContent =
    `${formatNumber(stats.count)} item(s), ${formatNumber(stats.totalUnits)} unit(s)` +
    `, ${formatNumber(stats.totalValue)} recorded value across ${formatNumber(stats.rooms)} room(s).`;

  const empty = byId('empty-state');
  empty.hidden = filtered.length > 0;
  byId('list-status').textContent =
    stats.count === 0 && (state.filters.q !== '' || state.filters.room !== '' || state.filters.category !== '')
      ? 'No items match the current filters.'
      : '';
}

/** Load the inventory from the API. */
async function loadItems() {
  const statusElement = byId('list-status');
  const query = new URLSearchParams();
  if (state.filters.q !== '') query.set('q', state.filters.q);
  if (state.filters.room !== '') query.set('room', state.filters.room);
  if (state.filters.category !== '') query.set('category', state.filters.category);
  query.set('limit', '100');

  const suffix = query.toString();
  try {
    const payload = await api(`/api/items${suffix === '' ? '' : `?${suffix}`}`);
    state.items = Array.isArray(payload.items) ? payload.items : [];
    state.facets = payload.facets ?? { rooms: [], categories: [] };
    renderFacetOptions();
    render();
    statusElement.textContent = '';
  } catch (error) {
    renderStatus(statusElement, error instanceof Error ? error.message : 'Failed to load inventory.');
  }
}

/** @param {string} id @param {string} name */
async function removeItem(id, name) {
  if (!window.confirm(`Delete "${name}" from your inventory?`)) return;
  const statusElement = byId('list-status');
  try {
    await api(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadItems();
  } catch (error) {
    renderStatus(statusElement, error instanceof Error ? error.message : 'Failed to delete the item.');
  }
}

/** @param {SubmitEvent} event */
async function handleSubmit(event) {
  event.preventDefault();
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const errorList = byId('form-errors');
  const statusElement = byId('form-status');

  const raw = {};
  for (const [key, value] of new FormData(form).entries()) {
    raw[key] = typeof value === 'string' ? value : '';
  }
  const payload = buildItemPayload(raw);

  const submitButton = /** @type {HTMLButtonElement|null} */ (form.querySelector('button[type="submit"]'));
  if (submitButton !== null) submitButton.disabled = true;

  try {
    const created = await api('/api/items', { method: 'POST', body: payload });
    renderErrors(errorList, statusElement, []);
    renderStatus(
      statusElement,
      created && created.item && typeof created.item.name === 'string'
        ? `Added "${created.item.name}".`
        : 'Item added.',
    );
    form.reset();
    byId('field-quantity').value = '1';
    await loadItems();
  } catch (error) {
    renderErrors(errorList, statusElement, error instanceof Error ? [error.message] : ['Could not add the item.']);
  } finally {
    if (submitButton !== null) submitButton.disabled = false;
  }
}

/** @param {Event} event */
function handleFilterChange(event) {
  const target = /** @type {HTMLInputElement|HTMLSelectElement} */ (event.currentTarget);
  const name = target.getAttribute('data-filter');
  if (name === null) return;
  state.filters[name] = target.value;
  void loadItems();
}

function init() {
  byId('item-form').addEventListener('submit', (event) => void handleSubmit(event));

  const filterSearch = byId('filter-query');
  filterSearch.setAttribute('data-filter', 'q');
  const filterRoom = byId('filter-room');
  filterRoom.setAttribute('data-filter', 'room');
  const filterCategory = byId('filter-category');
  filterCategory.setAttribute('data-filter', 'category');

  for (const element of [filterSearch, filterRoom, filterCategory]) {
    element.addEventListener('input', handleFilterChange);
    element.addEventListener('change', handleFilterChange);
  }

  void loadItems();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
