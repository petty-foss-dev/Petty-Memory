import { can, enc, get } from './api.js';
import { uuidv7 } from './crypto.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { kdel, kget, kpost, plural, projectOptions, setStatus } from './knowledge.js';
import { displayTitle } from './text.js';

const PAGE = 25;
const COLUMN_PAGE = 20;
const NAME_MAX = 120;
const QUERY_MAX = 500;
const FIELD_NAME_MAX = 80;
const OPTION_MAX = 80;
const TEXT_MAX = 2000;
const LIMITS = { fields: 20, options: 50, sorts: 3, filters: 10, evaluated: 1000 };

const FIELD_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['checkbox', 'Checkbox'], ['select', 'Choice']];
const ROW_TYPES = [['note', 'Notes'], ['bookmark', 'Links'], ['task', 'Tasks'], ['file', 'Files'], ['image', 'Images']];
const LAYOUTS = [['table', 'Table'], ['cards', 'Cards'], ['kanban', 'Kanban']];
const BUILT_IN_SORTS = [['title', 'Title'], ['createdAt', 'Created'], ['updatedAt', 'Last updated']];
const OPS_BY_TYPE = {
  text: ['equals', 'notEquals', 'contains', 'empty', 'notEmpty'],
  number: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  date: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  checkbox: ['equals'],
  select: ['equals', 'notEquals', 'empty', 'notEmpty'],
};
const UNARY = new Set(['empty', 'notEmpty']);

function opLabel(type, op) {
  const ordered = type === 'date'
    ? { lt: 'is before', lte: 'is on or before', gt: 'is after', gte: 'is on or after' }
    : { lt: 'is less than', lte: 'is at most', gt: 'is more than', gte: 'is at least' };
  return { equals: 'is', notEquals: 'is not', contains: 'contains', empty: 'is empty', notEmpty: 'has a value', ...ordered }[op];
}

const label = (pairs, value) => pairs.find(([key]) => key === value)?.[1] ?? value;

function showValue(definition, value) {
  if (value === undefined || value === null) return '—';
  switch (definition.type) {
    case 'number': return value.toLocaleString();
    case 'checkbox': return value ? 'Yes' : 'No';
    case 'select': return definition.options.find((option) => option.id === value)?.name ?? '—';
    default: return String(value);
  }
}

/** A control for one typed value; `readValue` turns it back into the value the server expects, or null for none. */
function valueInput(definition, value, name) {
  switch (definition.type) {
    case 'number': return h('input', { type: 'number', step: 'any', value: value ?? '', 'aria-label': name });
    case 'date': return h('input', { type: 'date', value: value ?? '', 'aria-label': name });
    case 'checkbox': return h('input', { type: 'checkbox', checked: value === true, 'aria-label': name });
    case 'select': return h('select', { 'aria-label': name },
      h('option', { value: '' }, 'No value'),
      definition.options.map((option) => h('option', { value: option.id, selected: option.id === value }, option.name)));
    default: return h('input', { type: 'text', value: value ?? '', maxlength: TEXT_MAX, 'aria-label': name });
  }
}

function readValue(definition, input) {
  switch (definition.type) {
    case 'number': {
      if (input.value === '') return null;
      const number = Number(input.value);
      if (!Number.isFinite(number)) throw new Error(`${definition.name} needs a number.`);
      return number;
    }
    case 'checkbox': return input.checked;
    case 'text': return input.value.trim() || null;
    default: return input.value || null;
  }
}

function describeScope(collection, projectName) {
  const { project, query, type } = collection.scope;
  return [
    type ? label(ROW_TYPES, type) : 'All ordinary items',
    query ? `matching “${query}”` : null,
    project ? `in ${projectName(project)}` : null,
  ].filter(Boolean).join(' ');
}

function describeRules(collection) {
  const byId = new Map(collection.fields.map((f) => [f.id, f]));
  const sorts = collection.sort.map((rule) => `${byId.get(rule.field)?.name ?? label(BUILT_IN_SORTS, rule.field)} ${rule.direction === 'asc' ? 'ascending' : 'descending'}`);
  const filters = collection.filters.map((rule) => {
    const definition = byId.get(rule.field);
    if (!definition) return null;
    return `${definition.name} ${opLabel(definition.type, rule.op)}${UNARY.has(rule.op) ? '' : ` ${showValue(definition, rule.value)}`}`;
  }).filter(Boolean);
  return [
    filters.length ? `Only rows where ${filters.join(' and ')}.` : 'No filters.',
    sorts.length ? `Sorted by ${sorts.join(', then ')}.` : 'Newest updated first.',
  ].join(' ');
}

export function createCollectionsSection(ctx) {
  const moveDrafts = new Map();
  const writable = can('write');
  const list = h('div');
  const formBox = h('div');
  const body = h('div');
  let collections = [];
  let projects = [];
  let selectedId = null;
  let layout = null;
  let offset = 0;
  let columnLimits = new Map();
  let editor = null;
  let defForm = null;
  let rulesForm = null;
  let seq = 0;
  let rowsSeq = 0;

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'an archived project';
  const selected = () => collections.find((c) => c.id === selectedId) ?? null;

  async function refresh({ poll } = {}) {
    const mine = ++seq;
    if (!list.childElementCount) list.append(loading());
    try {
      [collections, projects] = await Promise.all([kget('/collections'), get('/projects')]);
      if (mine !== seq) return;
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, () => refresh()));
      return;
    }
    if (selectedId && !selected()) {
      selectedId = null;
      editor = null;
      rulesForm = null;
      if (poll) ctx.notify('The collection you were viewing was archived or removed elsewhere.', 'info');
    }
    if (!selectedId && collections.length) select(collections[0].id, false);
    clear(list, collections.length
      ? h('nav', { 'aria-label': 'Collections' }, h('ul', { class: 'chips' }, collections.map((c) => h('li', null, h('button', {
        type: 'button', class: `chip${c.id === selectedId ? ' active' : ''}`, 'aria-current': c.id === selectedId ? 'page' : undefined,
        onClick: () => { if (select(c.id, true)) refresh(); },
      }, c.name)))))
      : empty(writable ? 'No collections yet. Create one to give items typed fields and see them as a table, cards or a Kanban board.' : 'No collections yet. A read,write token can create them.'));
    if (!selected()) return clear(body);
    // A row being edited or open sort and filter rules keep the board as it is until they're saved or cancelled.
    if (poll && (editor || rulesForm)) return;
    renderCollection();
  }

  /** False when the person keeps an unsaved value edit. */
  function select(id, ask) {
    if (id === selectedId) return true;
    if (ask && editor) {
      ctx.notify('Save or cancel the values you are editing first.', 'info');
      return false;
    }
    selectedId = id;
    layout = null;
    offset = 0;
    columnLimits = new Map();
    editor = null;
    rulesForm = null;
    return true;
  }

  function renderCollection() {
    const collection = selected();
    layout ??= collection.layout;
    if (layout === 'kanban' && !collection.groupBy) layout = 'table';
    const rows = h('div', { class: 'collection-rows', 'aria-live': 'polite' }, loading());
    const rulesBox = h('div');
    const layoutChoice = h('fieldset', { class: 'chat-mode' }, h('legend', null, 'Layout'),
      LAYOUTS.map(([value, text]) => {
        const disabled = value === 'kanban' && !collection.groupBy;
        return h('label', { class: 'check', title: disabled ? 'Kanban needs a choice field to group by. Edit the collection to pick one.' : undefined },
          h('input', { type: 'radio', name: `layout-${collection.id}`, value, checked: value === layout, disabled, onChange: () => {
            layout = value;
            offset = 0;
            editor = null;
            renderCollection();
          } }), text);
      }));
    clear(body, h('section', { class: 'panel', 'aria-labelledby': 'collection-name' },
      h('div', { class: 'view-head' },
        h('h3', { id: 'collection-name' }, collection.name),
        writable ? h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', onClick: () => openDefinition(collection) }, 'Edit fields and scope'),
          h('button', { type: 'button', class: 'btn small', onClick: () => openRules(rulesBox, collection) }, 'Sort and filter'),
          h('button', { type: 'button', class: 'btn small', 'aria-label': `Archive ${collection.name}`, onClick: () => archive(collection) }, 'Archive')) : null),
      h('p', { class: 'hint' }, describeScope(collection, projectName), '. ', describeRules(collection)),
      h('div', { class: 'actions' }, layoutChoice,
        writable && layout !== collection.layout ? h('button', { type: 'button', class: 'btn small', onClick: () => saveLayout(collection) }, `Make ${label(LAYOUTS, layout)} the default`) : null,
        !collection.groupBy ? h('span', { class: 'hint' }, 'Kanban needs a choice field to group by.') : null),
      collection.fields.length ? null : h('p', { class: 'hint' }, writable ? 'This collection has no fields yet. Edit it to add text, number, date, checkbox or choice fields.' : 'This collection has no fields yet.'),
      rulesBox, rows));
    if (rulesForm) openRules(rulesBox, collection);
    loadRows(rows, collection);
  }

  async function saveLayout(collection) {
    const saved = await ctx.run(() => kpost('/collections', { id: collection.id, layout }), { success: 'Default layout saved', refreshOutline: false });
    if (saved) await refresh();
  }

  async function archive(collection) {
    const ok = await confirmDialog({
      title: 'Archive this collection?',
      body: `“${collection.name}” leaves the list. Field values stay on their items and return if you unarchive it.`,
      confirmLabel: 'Archive collection',
    });
    if (!ok) return;
    if (await ctx.run(() => kdel(`/collections/${enc(collection.id)}`), { success: 'Collection archived', refreshOutline: false })) {
      if (defForm?.id === collection.id) closeDefinition();
    }
  }

  async function loadRows(box, collection) {
    const mine = ++rowsSeq;
    const path = (params) => `/collections/${enc(collection.id)}/rows?${new URLSearchParams(params)}`;
    try {
      if (layout === 'kanban') {
        const base = await kget(path({ offset: 0, limit: 1 }));
        if (!base.groups) {
          if (mine !== rowsSeq) return;
          layout = 'table';
          return renderCollection();
        }
        const columns = await Promise.all(base.groups.map((group) => kget(path({
          offset: 0, limit: columnLimits.get(group.option) ?? COLUMN_PAGE, group: group.option ?? '__unset',
        })).then((page) => ({ group, page }))));
        if (mine !== rowsSeq) return;
        clear(box, summary(base), kanban(base.collection, columns));
      } else {
        const page = await kget(path({ offset, limit: PAGE }));
        if (mine !== rowsSeq) return;
        if (page.offset > 0 && page.rows.length === 0 && page.total > 0) {
          offset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
          return loadRows(box, collection);
        }
        clear(box, summary(page), page.rows.length
          ? (layout === 'cards' ? cards(page.collection, page.rows) : table(page.collection, page.rows))
          : empty(page.matched ? 'No rows pass the filters.' : 'No ordinary items match this collection’s scope yet.'),
        pager(page, box, collection));
      }
    } catch (error) {
      if (mine === rowsSeq) clear(box, errorBox(error, () => loadRows(box, collection)));
    }
  }

  function summary(page) {
    return h('div', { class: 'collection-summary' },
      h('p', { class: 'hint' }, `${plural(page.matched, 'item')} match the scope; ${plural(page.evaluated, 'item')} evaluated; ${plural(page.total, 'row')} pass the filters.`),
      page.capped ? h('p', { class: 'chat-notice' }, `Only the ${LIMITS.evaluated.toLocaleString()} most recently updated matching items are evaluated, so older ones aren’t shown. Narrow the scope by project, type or topic to cover everything.`) : null);
  }

  function pager(page, box, collection) {
    if (page.total <= page.limit && page.offset === 0) return null;
    const go = (next) => {
      if (editor) return ctx.notify('Save or cancel the values you are editing first.', 'info');
      offset = next;
      loadRows(box, collection);
    };
    return h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', disabled: page.offset === 0, onClick: () => go(Math.max(0, page.offset - page.limit)) }, 'Previous'),
      h('span', { class: 'hint' }, `Rows ${(page.offset + 1).toLocaleString()}–${(page.offset + page.rows.length).toLocaleString()} of ${page.total.toLocaleString()}`),
      h('button', { type: 'button', class: 'btn small', disabled: page.next === null, onClick: () => go(page.next) }, 'Next'));
  }

  const titleButton = (item) => h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(item.id) }, displayTitle(item));

  function table(collection, rows) {
    const columns = collection.fields;
    return h('div', { class: 'table-wrap' }, h('table', { class: 'k-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Item'), columns.map((f) => h('th', { scope: 'col' }, f.name)), writable ? h('th', { scope: 'col' }, h('span', { class: 'hint' }, 'Values')) : null)),
      h('tbody', null, rows.flatMap((row) => {
        const holder = h('tr', { class: 'row-editor', hidden: true }, h('td', { colspan: columns.length + 2 }));
        return [
          h('tr', null,
            h('th', { scope: 'row' }, titleButton(row.item), h('span', { class: 'meta' }, ` ${row.item.type}`)),
            columns.map((f) => h('td', null, showValue(f, row.values[f.id]))),
            writable ? h('td', null, editButton(collection, row, () => { holder.hidden = false; return holder.firstChild; }, () => { holder.hidden = true; })) : null),
          holder,
        ];
      }))));
  }

  function card(collection, row, extra) {
    const holder = h('div');
    return h('li', { class: 'card' },
      titleButton(row.item),
      h('p', { class: 'meta' }, [row.item.type, row.item.project?.name, `updated ${when(row.item.updatedAt)}`].filter(Boolean).join(' · ')),
      collection.fields.length ? h('dl', { class: 'field-values' }, collection.fields.flatMap((f) => [h('dt', null, f.name), h('dd', null, showValue(f, row.values[f.id]))])) : null,
      extra,
      writable ? h('div', { class: 'actions' }, editButton(collection, row, () => holder, () => holder.replaceChildren())) : null,
      holder);
  }

  function cards(collection, rows) {
    return h('ul', { class: 'cards collection-cards' }, rows.map((row) => card(collection, row)));
  }

  function kanban(collection, columns) {
    const groupField = collection.fields.find((f) => f.id === collection.groupBy);
    return h('div', { class: 'kanban', role: 'list', 'aria-label': `Grouped by ${groupField.name}` }, columns.map(({ group, page }) => h('section', { class: 'kanban-column', role: 'listitem', 'aria-label': group.name },
      h('h4', null, group.name, ' ', h('span', { class: 'count' }, String(group.count))),
      page.rows.length ? h('ul', { class: 'cards' }, page.rows.map((row) => card(collection, row, writable ? moveControl(collection, groupField, row) : null))) : empty('Nothing here.'),
      page.next !== null ? h('button', { type: 'button', class: 'btn small', onClick: () => {
        if (editor) return ctx.notify('Save or cancel the values you are editing first.', 'info');
        columnLimits.set(group.option, page.limit + COLUMN_PAGE);
        renderCollection();
      } }, `Show more (${page.rows.length} of ${page.total})`) : null)));
  }

  function moveControl(collection, groupField, row) {
    const current = row.values[groupField.id] ?? '';
    const key = `${collection.id}:${row.item.id}:${groupField.id}`;
    const pending = moveDrafts.get(key) ?? current;
    const desired = pending === '' || groupField.options.some((option) => option.id === pending) ? pending : current;
    const target = h('select', { 'aria-label': `Move ${displayTitle(row.item)} to` },
      groupField.options.map((option) => h('option', { value: option.id, selected: option.id === desired }, option.name)),
      h('option', { value: '', selected: desired === '' }, `No ${groupField.name}`));
    const move = h('button', { type: 'button', class: 'btn small', disabled: desired === current, onClick: async () => {
      move.disabled = target.disabled = true;
      const saved = await ctx.run(() => kpost(`/collections/${enc(collection.id)}/values`, { itemId: row.item.id, values: { [groupField.id]: target.value || null } }),
        { success: `Moved to ${target.value ? groupField.options.find((o) => o.id === target.value)?.name : `No ${groupField.name}`}`, refreshOutline: false });
      if (saved) moveDrafts.delete(key);
      else { move.disabled = false; target.disabled = false; }
    } }, 'Move');
    target.addEventListener('change', () => { moveDrafts.set(key, target.value); move.disabled = target.value === current; });
    return h('div', { class: 'actions' }, target, move);
  }

  /** Opens one row's typed editor; only changed fields are sent, and Clear removes a value. */
  function editButton(collection, row, mount, unmount) {
    const button = h('button', { type: 'button', class: 'btn small', 'aria-label': `Edit values of ${displayTitle(row.item)}`, onClick: () => {
      if (editor) return ctx.notify('Save or cancel the values you are editing first.', 'info');
      if (!collection.fields.length) return ctx.notify('Add fields to this collection first.', 'info');
      const host = mount();
      const controls = new Map();
      const cleared = new Set();
      const status = h('p', { class: 'hint', role: 'status', hidden: true });
      const close = () => {
        editor = null;
        unmount();
        button.disabled = false;
        button.focus();
      };
      const save = h('button', { type: 'submit', class: 'btn small primary' }, 'Save values');
      clear(host, h('form', { class: 'value-editor', 'aria-label': `Values of ${displayTitle(row.item)}`, onSubmit: async (event) => {
        event.preventDefault();
        const values = {};
        try {
          for (const f of collection.fields) {
            const before = row.values[f.id] ?? null;
            const next = cleared.has(f.id) ? null : readValue(f, controls.get(f.id));
            const unchangedFalse = f.type === 'checkbox' && before === null && next === false && !cleared.has(f.id);
            if (next !== before && !unchangedFalse) values[f.id] = next;
          }
        } catch (error) {
          return setStatus(status, error.message, 'error');
        }
        if (!Object.keys(values).length) return close();
        save.disabled = true;
        setStatus(status, 'Saving…');
        try {
          await kpost(`/collections/${enc(collection.id)}/values`, { itemId: row.item.id, values });
          editor = null;
          ctx.notify('Values saved', 'ok');
          renderCollection();
        } catch (error) {
          save.disabled = false;
          setStatus(status, `Not saved: ${error.message} Your changes are still here.`, 'error');
        }
      } },
      collection.fields.map((f) => {
        const input = valueInput(f, row.values[f.id], f.name);
        controls.set(f.id, input);
        const note = h('span', { class: 'hint', hidden: true }, 'Will be cleared');
        input.addEventListener(f.type === 'checkbox' || f.type === 'select' ? 'change' : 'input', () => { cleared.delete(f.id); note.hidden = true; });
        return h('div', { class: 'value-row' },
          h('span', { class: 'field-label' }, f.name),
          input,
          h('button', { type: 'button', class: 'btn small', 'aria-label': `Clear ${f.name}`, onClick: () => {
            cleared.add(f.id);
            note.hidden = false;
          } }, 'Clear'),
          note);
      }),
      h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn small', onClick: close }, 'Cancel')),
      status));
      editor = { itemId: row.item.id };
      button.disabled = true;
      controls.values().next().value?.focus();
    } }, 'Edit');
    return button;
  }

  function openRules(box, collection) {
    const draft = rulesForm?.id === collection.id ? rulesForm.draft : {
      sort: collection.sort.map((rule) => ({ ...rule })),
      filters: collection.filters.map((rule) => ({ ...rule })),
    };
    rulesForm = { id: collection.id, draft };
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const sortList = h('ol', { class: 'plain rule-list' });
    const filterList = h('ol', { class: 'plain rule-list' });
    const byId = new Map(collection.fields.map((f) => [f.id, f]));

    const renderSort = () => clear(sortList, draft.sort.map((rule, index) => h('li', { class: 'actions' },
      h('select', { 'aria-label': `Sort ${index + 1} field`, onChange: (event) => { rule.field = event.target.value; } },
        BUILT_IN_SORTS.map(([value, text]) => h('option', { value, selected: rule.field === value }, text)),
        collection.fields.map((f) => h('option', { value: f.id, selected: rule.field === f.id }, f.name))),
      h('select', { 'aria-label': `Sort ${index + 1} direction`, onChange: (event) => { rule.direction = event.target.value; } },
        h('option', { value: 'asc', selected: rule.direction === 'asc' }, 'Ascending'),
        h('option', { value: 'desc', selected: rule.direction === 'desc' }, 'Descending')),
      h('button', { type: 'button', class: 'btn small', onClick: () => { draft.sort.splice(index, 1); renderSort(); } }, 'Remove'))),
    draft.sort.length ? null : h('li', { class: 'hint' }, 'Newest updated first.'));

    const filterValue = (rule) => {
      const definition = byId.get(rule.field);
      if (UNARY.has(rule.op)) return null;
      if (definition.type === 'checkbox') {
        rule.value ??= true;
        return h('select', { 'aria-label': 'Filter value', onChange: (event) => { rule.value = event.target.value === 'true'; } },
          h('option', { value: 'true', selected: rule.value === true }, 'Yes'), h('option', { value: 'false', selected: rule.value === false }, 'No'));
      }
      const input = valueInput(definition, rule.value, 'Filter value');
      input.addEventListener(definition.type === 'select' ? 'change' : 'input', () => {
        try { rule.value = readValue(definition, input) ?? undefined; } catch { rule.value = undefined; }
      });
      rule.input = input;
      return input;
    };
    const renderFilters = () => clear(filterList, draft.filters.map((rule, index) => {
      const definition = byId.get(rule.field);
      return h('li', { class: 'actions' },
        h('select', { 'aria-label': `Filter ${index + 1} field`, onChange: (event) => {
          rule.field = event.target.value;
          rule.op = OPS_BY_TYPE[byId.get(rule.field).type][0];
          delete rule.value;
          renderFilters();
        } }, collection.fields.map((f) => h('option', { value: f.id, selected: rule.field === f.id }, f.name))),
        h('select', { 'aria-label': `Filter ${index + 1} condition`, onChange: (event) => { rule.op = event.target.value; renderFilters(); } },
          OPS_BY_TYPE[definition.type].map((op) => h('option', { value: op, selected: rule.op === op }, opLabel(definition.type, op)))),
        filterValue(rule),
        h('button', { type: 'button', class: 'btn small', onClick: () => { draft.filters.splice(index, 1); renderFilters(); } }, 'Remove'));
    }), draft.filters.length ? null : h('li', { class: 'hint' }, 'Every row in scope is shown.'));

    const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save sort and filters');
    clear(box, h('form', { class: 'panel stack rules-form', 'aria-label': 'Sort and filter', onSubmit: async (event) => {
      event.preventDefault();
      let filters;
      try {
        filters = draft.filters.map((rule) => {
          const definition = byId.get(rule.field);
          if (UNARY.has(rule.op)) return { field: rule.field, op: rule.op };
          const value = definition.type === 'checkbox' ? rule.value : readValue(definition, rule.input);
          if (value === null) throw new Error(`Give the ${definition.name} filter a value, or choose “is empty” or “has a value”.`);
          return { field: rule.field, op: rule.op, value };
        });
      } catch (error) {
        return setStatus(status, error.message, 'error');
      }
      save.disabled = true;
      setStatus(status, 'Saving…');
      try {
        await kpost('/collections', { id: collection.id, sort: draft.sort.map(({ field: f, direction }) => ({ field: f, direction })), filters });
        rulesForm = null;
        offset = 0;
        columnLimits = new Map();
        ctx.notify('Sort and filters saved', 'ok');
        await refresh();
      } catch (error) {
        save.disabled = false;
        setStatus(status, `Not saved: ${error.message}`, 'error');
      }
    } },
    h('h4', null, 'Sort'),
    sortList,
    h('button', { type: 'button', class: 'btn small', onClick: () => {
      if (draft.sort.length >= LIMITS.sorts) return setStatus(status, `Sort by at most ${LIMITS.sorts} fields.`, 'error');
      const used = new Set(draft.sort.map((rule) => rule.field));
      const next = [...BUILT_IN_SORTS.map(([value]) => value), ...collection.fields.map((f) => f.id)].find((value) => !used.has(value));
      draft.sort.push({ field: next, direction: 'asc' });
      renderSort();
    } }, 'Add sort'),
    h('h4', null, 'Filters'),
    h('p', { class: 'hint' }, 'Every filter must match. Values are checked against each field’s type.'),
    filterList,
    h('button', { type: 'button', class: 'btn small', disabled: !collection.fields.length, onClick: () => {
      if (draft.filters.length >= LIMITS.filters) return setStatus(status, `Use at most ${LIMITS.filters} filters.`, 'error');
      const first = collection.fields[0];
      draft.filters.push({ field: first.id, op: OPS_BY_TYPE[first.type][0] });
      renderFilters();
    } }, collection.fields.length ? 'Add filter' : 'Add fields to filter by them'),
    h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn', onClick: () => { rulesForm = null; box.replaceChildren(); } }, 'Cancel')),
    status));
    renderSort();
    renderFilters();
  }

  function closeDefinition() {
    defForm = null;
    clear(formBox);
  }

  /** Field and option ids are kept for existing entries and minted here for new ones, so grouping can name a new field. */
  function openDefinition(collection) {
    const draft = {
      name: collection?.name ?? '',
      project: collection?.scope.project ?? '',
      query: collection?.scope.query ?? '',
      type: collection?.scope.type ?? '',
      layout: collection?.layout ?? 'table',
      groupBy: collection?.groupBy ?? '',
      fields: (collection?.fields ?? []).map((f) => ({ id: f.id, existing: true, name: f.name, type: f.type, options: (f.options ?? []).map((o) => ({ ...o })) })),
    };
    const original = JSON.stringify(draft);
    defForm = { id: collection?.id ?? null, dirty: () => JSON.stringify(draft) !== original };
    const status = h('p', { class: 'hint', role: 'status', hidden: true });
    const fieldList = h('ol', { class: 'plain field-defs' });
    const groupBy = h('select');
    const layoutSelect = h('select', { onChange: (event) => { draft.layout = event.target.value; } }, LAYOUTS.map(([value, text]) => h('option', { value, selected: value === draft.layout }, text)));
    const bind = (input, apply) => {
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => apply(input.value));
      return input;
    };

    const renderGroupBy = () => {
      const choices = draft.fields.filter((f) => f.type === 'select');
      if (!choices.some((f) => f.id === draft.groupBy)) draft.groupBy = '';
      clear(groupBy, h('option', { value: '' }, 'Not grouped'), choices.map((f) => h('option', { value: f.id, selected: f.id === draft.groupBy }, f.name.trim() || 'Unnamed choice field')));
    };
    groupBy.addEventListener('change', () => { draft.groupBy = groupBy.value; });

    const renderFields = () => {
      clear(fieldList, draft.fields.map((f, index) => h('li', { class: 'field-def' },
        h('div', { class: 'grid2' },
          field(`Field ${index + 1} name`, bind(h('input', { type: 'text', value: f.name, maxlength: FIELD_NAME_MAX, required: true }), (value) => { f.name = value; renderGroupBy(); })),
          field('Type', h('select', { disabled: f.existing, onChange: (event) => {
            f.type = event.target.value;
            f.options = f.type === 'select' ? [{ id: uuidv7(), name: '' }] : [];
            renderFields();
          } }, FIELD_TYPES.map(([value, text]) => h('option', { value, selected: value === f.type }, text))),
          f.existing ? 'A saved field’s type can’t change. Add a new field instead.' : null)),
        f.type === 'select' ? h('div', { class: 'option-defs' },
          h('span', { class: 'field-label' }, 'Choices'),
          h('ul', { class: 'plain' }, f.options.map((option, optionIndex) => h('li', null,
            bind(h('input', { type: 'text', value: option.name, maxlength: OPTION_MAX, required: true, 'aria-label': `Choice ${optionIndex + 1} of ${f.name || `field ${index + 1}`}` }), (value) => { option.name = value; }),
            h('button', { type: 'button', class: 'btn small', disabled: f.options.length === 1, onClick: () => { f.options.splice(optionIndex, 1); renderFields(); } }, 'Remove')))),
          h('button', { type: 'button', class: 'btn small', disabled: f.options.length >= LIMITS.options, onClick: () => { f.options.push({ id: uuidv7(), name: '' }); renderFields(); } }, 'Add choice'),
          f.existing ? h('p', { class: 'hint' }, 'Removing a choice hides it on items that had it; their other values stay.') : null) : null,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', disabled: index === 0, onClick: () => { draft.fields.splice(index - 1, 0, ...draft.fields.splice(index, 1)); renderFields(); } }, 'Move up'),
          h('button', { type: 'button', class: 'btn small danger', onClick: () => { draft.fields.splice(index, 1); renderFields(); } }, 'Remove field'),
          f.existing ? h('span', { class: 'hint' }, 'Values stay on items if removed, but stop showing here.') : null))),
      draft.fields.length ? null : h('li', { class: 'hint' }, 'No fields yet.'));
      renderGroupBy();
    };

    const projectSelect = bind(h('select', null, projectOptions(projects, draft.project, 'Any project')), (value) => { draft.project = value; });
    const typeSelect = bind(h('select', null, h('option', { value: '' }, 'Any type'), ROW_TYPES.map(([value, text]) => h('option', { value, selected: value === draft.type }, text))), (value) => { draft.type = value; });
    const save = h('button', { type: 'submit', class: 'btn primary' }, collection ? 'Save collection' : 'Create collection');
    const cancel = async () => {
      if (defForm?.dirty() && !(await confirmDialog({
        title: 'Discard this collection?', body: 'Your changes haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
      }))) return;
      closeDefinition();
    };

    clear(formBox, h('form', { class: 'panel stack', 'aria-label': collection ? 'Edit collection' : 'New collection', onSubmit: async (event) => {
      event.preventDefault();
      if (!draft.name.trim()) return setStatus(status, 'Name the collection first.', 'error');
      if (draft.layout === 'kanban' && !draft.groupBy) return setStatus(status, 'Kanban needs a choice field to group by. Choose one, or pick another layout.', 'error');
      const fields = draft.fields.map((f) => ({ id: f.id, name: f.name.trim(), type: f.type, ...(f.type === 'select' ? { options: f.options.map((o) => ({ id: o.id, name: o.name.trim() })) } : {}) }));
      const kept = new Map(fields.map((f) => [f.id, f]));
      const input = {
        ...(collection ? { id: collection.id } : {}),
        name: draft.name.trim(),
        scope: { project: draft.project || null, query: draft.query.trim() || null, type: draft.type || null },
        layout: draft.layout,
        groupBy: draft.groupBy || null,
        fields,
      };
      // Rules naming a removed field or choice would be refused, so they go with it.
      if (collection) {
        input.sort = collection.sort.filter((rule) => BUILT_IN_SORTS.some(([value]) => value === rule.field) || kept.has(rule.field));
        input.filters = collection.filters.filter((rule) => {
          const f = kept.get(rule.field);
          return f && (f.type !== 'select' || UNARY.has(rule.op) || f.options.some((o) => o.id === rule.value));
        });
      }
      save.disabled = true;
      setStatus(status, 'Saving…');
      try {
        const saved = await kpost('/collections', input);
        closeDefinition();
        if (!collection) select(saved.id, false);
        else if (selectedId === saved.id) { layout = null; columnLimits = new Map(); }
        ctx.notify(collection ? 'Collection saved' : 'Collection created', 'ok');
        await refresh();
      } catch (error) {
        save.disabled = false;
        setStatus(status, `Not saved: ${error.message}`, 'error');
      }
    } },
    h('h2', null, collection ? `Edit “${collection.name}”` : 'New collection'),
    field('Name', bind(h('input', { type: 'text', value: draft.name, maxlength: NAME_MAX, required: true, placeholder: 'Reading list' }), (value) => { draft.name = value; })),
    h('h4', null, 'Which items it shows'),
    h('div', { class: 'grid2' },
      field('Project', projectSelect),
      field('Type', typeSelect),
      field('Topic keywords (optional)', bind(h('input', { type: 'search', value: draft.query, maxlength: QUERY_MAX, placeholder: 'sourdough' }), (value) => { draft.query = value; }))),
    h('p', { class: 'hint' }, 'Ordinary items only: secrets, decisions, templates, saved chats and definitions never appear. Up to 1,000 of the most recently updated matches are evaluated.'),
    h('h4', null, 'Fields'),
    fieldList,
    h('button', { type: 'button', class: 'btn small', onClick: () => {
      if (draft.fields.length >= LIMITS.fields) return setStatus(status, `A collection can have at most ${LIMITS.fields} fields.`, 'error');
      draft.fields.push({ id: uuidv7(), existing: false, name: '', type: 'text', options: [] });
      renderFields();
      fieldList.querySelector('li:last-child input')?.focus();
    } }, 'Add field'),
    h('div', { class: 'grid2' }, field('Group by', groupBy, 'A choice field; its choices become Kanban columns.'), field('Default layout', layoutSelect)),
    h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel')),
    status));
    renderFields();
    formBox.querySelector('input')?.focus();
  }

  const el = h('section', { class: 'knowledge-section', 'aria-labelledby': 'collections-heading' },
    h('div', { class: 'view-head' },
      h('h2', { id: 'collections-heading' }, 'Collections'),
      writable ? h('button', { type: 'button', class: 'btn small primary', onClick: () => {
        if (defForm) return formBox.querySelector('input')?.focus();
        openDefinition(null);
      } }, 'New collection') : null),
    h('p', { class: 'hint' }, 'Typed fields on ordinary items, shown as a table, cards or a Kanban board. Values are saved on the items, so they travel with history, export and sync.'),
    formBox, list, body);

  return { el, refresh };
}
