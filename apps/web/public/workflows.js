import { can, del, enc, get, patch, post, query } from './api.js';
import { itemRow } from './rows.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading } from './dom.js';
import { displayTitle, isSecret } from './text.js';

const PAGE = 25;
const MAX_PAGE = 200;
const NAME_MAX = 120;
const QUERY_MAX = 500;

const TYPES = [['note', 'Notes'], ['bookmark', 'Links'], ['file', 'Files'], ['image', 'Images'], ['task', 'Tasks'], ['decision', 'Decisions']];
const STATUSES = [['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done'], ['cancelled', 'Cancelled']];
const ATTENTION = [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
const INTENTS = [['read', 'Read'], ['watch', 'Watch'], ['buy', 'Buy'], ['revisit', 'Revisit']];
/** Filters the form edits; anything else a view carries (set by another client) is kept as it is. */
const FORM_KEYS = ['project', 'inbox', 'type', 'tag', 'taskStatus', 'attention', 'intent', 'pinned', 'review', 'reminders', 'unopenedDays'];

const EXAMPLES = [
  ['To review', { review: true }, 'everything marked for review'],
  ['High-attention notes', { type: 'note', attention: 'high' }, 'notes you flagged as important'],
  ['Open tasks', { taskStatus: 'open' }, 'tasks nobody has started'],
  ['Links to read', { type: 'bookmark', intent: 'read' }, 'saved articles waiting for you'],
];

const label = (pairs, value) => pairs.find(([key]) => key === value)?.[1] ?? value;

export const templateOf = (item) => (item.metadata?.template?.version === 1 && typeof item.metadata.template.rootId === 'string' ? item.metadata.template : null);
export const isSavedView = (item) => item.metadata?.savedView?.version === 1;

function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function describe(view, projectName) {
  const f = view.filter ?? {};
  const parts = [
    view.query ? `Matches “${view.query}”` : null,
    f.project ? `In ${projectName(f.project)}` : null,
    f.inbox ? 'In the Inbox' : null,
    f.type ? label(TYPES, f.type) : null,
    f.tag ? `#${f.tag}` : null,
    f.taskStatus ? `${label(STATUSES, f.taskStatus)} tasks` : null,
    f.pinned ? 'Pinned' : null,
    f.review ? 'Marked for review' : null,
    f.attention ? `${label(ATTENTION, f.attention)} attention` : null,
    f.intent ? label(INTENTS, f.intent) : null,
    f.unopenedDays !== undefined ? `Unopened for ${f.unopenedDays}+ days` : null,
    f.reminders ? 'Has a reminder' : null,
  ].filter(Boolean);
  return parts.length ? parts : ['Every active item'];
}

const placeholderHelp = () => h('p', { class: 'hint' },
  'Placeholders: {{date}} becomes the date you choose (YYYY-MM-DD) and {{project}} the destination project’s name, or Inbox. Anything else in braces is left as written.');

const select = (name, pairs, value, anyLabel) => h('select', { name },
  h('option', { value: '' }, anyLabel),
  pairs.map(([key, text]) => h('option', { value: key, selected: key === value }, text)));

async function viewItems(id, want) {
  const items = [];
  let before;
  for (;;) {
    const page = await get(`/views/${enc(id)}/items${query({ before, limit: Math.min(MAX_PAGE, want - items.length) })}`);
    items.push(...page.items);
    if (!page.next) return { items, more: false };
    if (items.length >= want) return { items, more: true };
    before = page.next;
  }
}

export function createViewsView(ctx) {
  const list = h('div');
  const formBox = h('div');
  const body = h('div');
  let views = [];
  let projects = [];
  let selectedId = null;
  let want = PAGE;
  let form = null;
  let seq = 0;

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? 'an archived project';

  async function refresh() {
    const mine = ++seq;
    if (!list.childElementCount) list.append(loading());
    try {
      [views, projects] = await Promise.all([get('/views'), get('/projects')]);
      if (mine !== seq) return;
    } catch (error) {
      if (mine === seq) clear(list, errorBox(error, refresh));
      return;
    }
    // A view removed elsewhere falls back to the first one rather than a dead page.
    const selected = views.find((v) => v.id === selectedId) ?? views[0] ?? null;
    if (selected?.id !== selectedId) want = PAGE;
    selectedId = selected?.id ?? null;
    clear(list, views.length
      ? h('nav', { 'aria-label': 'Saved views' }, h('ul', { class: 'chips' }, views.map((v) => h('li', null, h('button', {
        type: 'button', class: `chip${v.id === selectedId ? ' active' : ''}`, 'aria-current': v.id === selectedId ? 'page' : undefined,
        onClick: () => { selectedId = v.id; want = PAGE; refresh(); },
      }, v.name)))))
      : emptyState());
    if (!selected) return clear(body);
    await showView(selected, mine);
  }

  function emptyState() {
    return h('div', null,
      empty(can('write')
        ? 'No saved views yet. Save a search you run often; start from an example and adjust it.'
        : 'No saved views yet. A read,write token can create them.'),
      can('write') ? h('ul', { class: 'chips', 'aria-label': 'Examples' }, EXAMPLES.map(([name, filter, why]) => h('li', null,
        h('button', { type: 'button', class: 'chip', title: `Shows ${why}`, onClick: () => openForm(null, { name, query: '', filter }) }, `${name}: ${why}`))))
        : null);
  }

  async function showView(view, mine) {
    try {
      const { items, more } = await viewItems(view.id, want);
      if (mine !== seq) return;
      clear(body,
        h('section', { class: 'panel', 'aria-labelledby': 'view-name' },
          h('div', { class: 'view-head' },
            h('h2', { id: 'view-name' }, view.name),
            can('write') ? h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'btn small', onClick: () => openForm(view, view) }, 'Edit'),
              h('button', { type: 'button', class: 'btn small danger', onClick: () => remove(view) }, 'Remove')) : null),
          h('ul', { class: 'chips', 'aria-label': 'Filters' }, describe(view, projectName).map((part) => h('li', { class: 'badge' }, part))),
          items.length ? h('ul', { class: 'results' }, items.map((item) => itemRow(item, ctx)))
            : empty('Nothing matches yet. Items that match appear as soon as they’re saved or changed.'),
          more ? h('button', { type: 'button', class: 'btn small', onClick: () => { want = items.length + PAGE; refresh(); } }, `Show more (${items.length} shown)`) : null));
    } catch (error) {
      if (mine === seq) clear(body, errorBox(error, refresh));
    }
  }

  async function remove(view) {
    const ok = await confirmDialog({
      title: 'Remove this saved view?', body: `“${view.name}” is archived. The items it shows aren’t changed.`, confirmLabel: 'Remove view', danger: true,
    });
    if (!ok) return;
    if (await ctx.run(() => del(`/views/${enc(view.id)}`), { success: 'View removed', refreshOutline: false })) {
      if (form?.view?.id === view.id) closeForm();
    }
  }

  function closeForm() {
    form = null;
    clear(formBox);
  }

  function openForm(view, initial) {
    const start = { name: initial.name, query: initial.query ?? '', filter: { ...(initial.filter ?? {}) } };
    const kept = Object.fromEntries(Object.entries(start.filter).filter(([key]) => !FORM_KEYS.includes(key)));
    const f = start.filter;
    const name = h('input', { type: 'text', value: start.name, required: true, maxlength: NAME_MAX, placeholder: 'Garage notes to review' });
    const words = h('input', { type: 'search', value: start.query, maxlength: QUERY_MAX, placeholder: 'opener wiring' });
    const project = h('select', null,
      h('option', { value: '' }, 'Any project'),
      h('option', { value: '__inbox__', selected: f.inbox === true }, 'Inbox only'),
      f.project && !projects.some((p) => p.id === f.project) ? h('option', { value: f.project, selected: true }, 'Archived project') : null,
      projects.map((p) => h('option', { value: p.id, selected: p.id === f.project }, p.name)));
    const type = select('type', TYPES, f.type, 'Any type');
    const tag = h('input', { type: 'text', value: f.tag ?? '', placeholder: 'wiring' });
    const taskStatus = select('taskStatus', STATUSES, f.taskStatus, 'Any (or not a task)');
    const attention = select('attention', ATTENTION, f.attention, 'Any attention');
    const intent = select('intent', INTENTS, f.intent, 'Any intent');
    const pinned = h('input', { type: 'checkbox', checked: f.pinned === true });
    const review = h('input', { type: 'checkbox', checked: f.review === true });
    const reminders = h('input', { type: 'checkbox', checked: f.reminders === true });
    const unopened = h('input', { type: 'number', min: 0, max: 36500, step: 1, value: f.unopenedDays ?? '', placeholder: 'Any age' });
    const status = h('p', { class: 'hint', role: 'status' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, view ? 'Save view' : 'Create view');

    const build = () => {
      const filter = { ...kept };
      if (project.value === '__inbox__') filter.inbox = true;
      else if (project.value) filter.project = project.value;
      const text = { type: type.value, tag: tag.value.replace(/^#/, '').trim(), taskStatus: taskStatus.value, attention: attention.value, intent: intent.value };
      for (const [key, value] of Object.entries(text)) if (value) filter[key] = value;
      if (pinned.checked) filter.pinned = true;
      if (review.checked) filter.review = true;
      if (reminders.checked) filter.reminders = true;
      if (unopened.value !== '') filter.unopenedDays = Number(unopened.value);
      return { name: name.value.trim(), query: words.value.trim(), filter };
    };
    const original = JSON.stringify({ name: start.name.trim(), query: start.query.trim(), filter: start.filter });
    form = { view, dirty: () => JSON.stringify(build()) !== original };

    const cancel = async () => {
      if (form?.dirty() && !(await confirmDialog({
        title: 'Discard this view?', body: 'Your changes to the view haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
      }))) return;
      closeForm();
    };
    const keptText = describe({ query: '', filter: kept }, projectName).filter((part) => part !== 'Every active item');
    clear(formBox, h('form', { class: 'panel stack', 'aria-label': view ? 'Edit saved view' : 'New saved view', onSubmit: async (e) => {
      e.preventDefault();
      const input = build();
      if (!input.name) return;
      submit.disabled = true;
      status.className = 'hint';
      status.textContent = 'Saving…';
      try {
        const saved = view ? await patch(`/views/${enc(view.id)}`, input) : await post('/views', input);
        closeForm();
        selectedId = saved.id;
        want = PAGE;
        ctx.notify(view ? 'View saved' : 'View created', 'ok');
        await refresh();
      } catch (error) {
        submit.disabled = false;
        status.className = 'error';
        status.textContent = `Not saved: ${error.message}`;
      }
    } },
    h('h2', null, view ? 'Edit saved view' : 'New saved view'),
    field('Name', name),
    field('Words to match (optional)', words, 'Matched as plain keywords, never run as code.'),
    h('div', { class: 'grid2' },
      field('Project', project), field('Type', type), field('Tag', tag),
      field('Task status', taskStatus), field('Attention', attention), field('Intent', intent),
      field('Unopened for at least (days)', unopened, 'Only bookmarks that have never been opened. Leave empty for any age.')),
    h('label', { class: 'check' }, pinned, 'Pinned only'),
    h('label', { class: 'check' }, review, 'Marked for review only'),
    h('label', { class: 'check' }, reminders, 'Has a reminder'),
    keptText.length ? h('p', { class: 'hint' }, `Also keeps: ${keptText.join(', ')}.`) : null,
    h('p', { class: 'hint' }, 'Every filter must match. Secrets, archived items and templates never appear.'),
    h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel')),
    status));
    name.focus();
  }

  const el = h('section', { class: 'view', 'aria-labelledby': 'views-heading' },
    h('header', { class: 'view-head' },
      h('h1', { id: 'views-heading' }, 'Saved views'),
      can('write') ? h('button', { type: 'button', class: 'btn small primary', onClick: () => {
        if (form) return formBox.querySelector('input')?.focus();
        openForm(null, { name: '', query: '', filter: {} });
      } }, 'New view') : null),
    h('p', { class: 'hint' }, 'Named filters that stay current, newest change first. Results are matched by keyword and filters only.'),
    formBox, list, body);
  return {
    el,
    // Polling leaves the open form alone, so a draft is never replaced.
    refresh: ({ poll } = {}) => (poll && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' ? undefined : refresh()),
    reveal(id) {
      selectedId = id;
      want = PAGE;
    },
  };
}

export function createTemplatesView(ctx) {
  const list = h('div');
  const useBox = h('div');
  let using = null;

  async function refresh() {
    if (!list.childElementCount) list.append(loading());
    try {
      const templates = await get('/templates');
      if (using && !templates.some((t) => t.id === using.id)) closeUse();
      clear(list, templates.length
        ? h('ul', { class: 'results' }, templates.map((t) => {
          const row = itemRow(t, ctx);
          if (can('write')) row.append(h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn small primary', onClick: () => openUse(t) }, 'Use…'),
            h('button', { type: 'button', class: 'btn small', 'aria-label': `Archive ${displayTitle(t)}`, onClick: () => archive(t) }, 'Archive')));
          return row;
        }))
        : h('div', null,
          empty('No templates yet.'),
          h('p', { class: 'hint' }, 'Open any note, nested notes included, and choose Save as template. Write {{date}} or {{project}} in its titles or text, for example “Standup {{date}}” or “{{project}} retro”, and they’re filled in each time you use it.')));
    } catch (error) {
      clear(list, errorBox(error, refresh));
    }
  }

  async function archive(template) {
    const ok = await confirmDialog({
      title: 'Archive this template?', body: `“${displayTitle(template)}” leaves the template library. Notes already made from it aren’t changed.`, confirmLabel: 'Archive template',
    });
    if (ok) await ctx.run(() => post(`/items/${enc(template.id)}/archive`), { success: 'Template archived' });
  }

  function closeUse() {
    using = null;
    clear(useBox);
  }

  function openUse(template) {
    using = template;
    const title = h('input', { type: 'text', placeholder: displayTitle(template) });
    const project = h('select', null, h('option', { value: '' }, 'Inbox'));
    const date = h('input', { type: 'date', value: localToday(), required: true });
    const status = h('p', { class: 'hint', role: 'status' });
    get('/projects').then((projects) => project.append(...projects.map((p) => h('option', { value: p.id }, p.name))), (error) => {
      status.className = 'error';
      status.textContent = `Couldn’t load projects: ${error.message}`;
    });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Create and open');
    clear(useBox, h('form', { class: 'panel stack', 'aria-label': `Use template ${displayTitle(template)}`, onSubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'hint';
      status.textContent = 'Creating…';
      try {
        const body = { project: project.value || null, date: date.value };
        if (title.value.trim()) body.title = title.value.trim();
        const created = await post(`/templates/${enc(template.id)}/use`, body);
        closeUse();
        ctx.notify(`Created “${displayTitle(created)}”`, 'ok');
        await ctx.changed();
        ctx.select(created.id);
      } catch (error) {
        submit.disabled = false;
        status.className = 'error';
        status.textContent = error.message;
      }
    } },
    h('h2', null, `Use “${displayTitle(template)}”`),
    field('Title (optional)', title),
    h('div', { class: 'grid2' }, field('Put it in', project), field('Date for {{date}}', date)),
    placeholderHelp(),
    h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onClick: closeUse }, 'Cancel')),
    status));
    title.focus();
  }

  const el = h('section', { class: 'view', 'aria-labelledby': 'templates-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'templates-heading' }, 'Templates')),
    h('p', { class: 'hint' }, 'Reusable note outlines. Using one copies the whole tree into a project or the Inbox; the template stays as it is. Edit a template by opening it.'),
    useBox, list);
  return {
    el,
    refresh: ({ poll } = {}) => (poll && useBox.contains(document.activeElement) ? undefined : refresh()),
    reveal(template) {
      if (can('write')) openUse(template);
    },
  };
}

/** The detail panel's template and saved-view section, or null when neither applies. */
export function workflowPanel(state, ctx) {
  const { item } = state;
  const template = templateOf(item);
  const writable = can('write');
  if (isSavedView(item)) {
    return h('section', { class: 'panel' }, h('h2', null, 'Saved view'),
      h('p', { class: 'hint' }, 'This note holds a saved view’s settings.'),
      h('button', { type: 'button', class: 'btn small', onClick: () => ctx.openView(item.id) }, 'Open the view'));
  }
  if (template) {
    const root = template.rootId === item.id;
    return h('section', { class: 'panel' }, h('h2', null, 'Template'),
      h('p', { class: 'hint' }, `${root ? 'This is a template.' : 'This note is part of a template.'} Edits here change future copies, not ones already made.`),
      h('div', { class: 'actions' },
        root ? null : h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(template.rootId) }, 'Open the template'),
        root && writable && !item.archivedAt ? h('button', { type: 'button', class: 'btn small', onClick: () => ctx.useTemplate(item) }, 'Use template…') : null));
  }
  if (!writable || item.type !== 'note' || isSecret(item) || item.archivedAt) return null;
  const name = h('input', { type: 'text', value: state.templateName ?? `${displayTitle(item)} template`.slice(0, NAME_MAX), maxlength: NAME_MAX, 'aria-label': 'Template name' });
  name.addEventListener('input', () => { state.templateName = name.value; state.interacting = true; });
  const status = h('p', { class: 'hint', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn small', disabled: state.editing }, 'Save as template');
  return h('section', { class: 'panel' }, h('h2', null, 'Save as template'),
    h('p', { class: 'hint' }, 'Copies this note and every note inside it; this note isn’t changed. Checkboxes start unchecked, and pins and reminders aren’t copied. Links, files, tasks and secrets can’t be included.'),
    state.editing ? h('p', { class: 'hint' }, 'Save or cancel your edit first.') : null,
    h('form', { class: 'actions', onSubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'hint';
      status.textContent = 'Saving…';
      try {
        const created = await post('/templates', { sourceId: item.id, name: name.value.trim() || undefined });
        state.templateName = undefined;
        ctx.notify('Template saved', 'ok');
        await ctx.changed({ detail: false });
        ctx.select(created.id);
      } catch (error) {
        submit.disabled = false;
        status.className = 'error';
        status.textContent = `Not saved: ${error.message}`;
      }
    } }, name, submit),
    placeholderHelp(),
    status);
}
