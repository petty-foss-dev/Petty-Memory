import { can, connect, currentClient, disconnect, enc, get, onSessionLost, post, query } from './api.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { createCaptureView } from './capture.js';
import { createChatView } from './chat.js';
import { createDetail } from './detail.js';
import { clearEditHistory, isEditable, redoEdit, undoEdit } from './edits.js';
import { createKnowledgeView } from './knowledge.js';
import { createOutline } from './outline.js';
import { createReviewView } from './review.js';
import { createSetupChecklist } from './setup.js';
import { createSharesView } from './shares.js';
import { createVaultView } from './vault.js';
import { createTemplatesView, createViewsView } from './workflows.js';
import { itemRow } from './rows.js';

const POLL_MS = 30_000;
const PAGE = 25;
/** The server's largest page. */
const MAX_PAGE = 200;
const VIEWS = [
  ['outline', 'Outline'],
  ['search', 'Search'],
  ['capture', 'Capture & import'],
  ['review', 'Review'],
  ['chat', 'AI chat'],
  ['knowledge', 'Knowledge'],
  ['highlights', 'Highlights'],
  ['views', 'Saved views'],
  ['templates', 'Templates'],
  ['projects', 'Projects'],
  ['vault', 'Vault'],
  ['shares', 'Shares'],
];

export function mountApp(root) {
  onSessionLost((error) => showConnect(root, error.message));
  showConnect(root);
}

let stopPolling = null;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped.', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}

function showConnect(root, message) {
  stopPolling?.();
  stopPolling = null;
  disconnect();
  clearEditHistory();
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'em_…' });
  const status = h('p', { class: message ? 'error' : 'hint', role: 'status' }, message ?? '');
  const form = h('form', { class: 'connect stack', onSubmit: async (e) => {
    e.preventDefault();
    status.className = 'hint';
    status.textContent = 'Connecting…';
    try {
      await connect(input.value);
      input.value = '';
      showShell(root);
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
    }
  } },
  h('h1', null, 'Petty Memory'),
  h('p', null, 'Connect this browser to the library on this server with an API token.'),
  field('Token', input, 'Kept only in this tab’s memory. Reloading or disconnecting forgets it.'),
  h('button', { type: 'submit', class: 'btn primary' }, 'Connect'),
  status,
  h('details', null,
    h('summary', null, 'How do I get a token?'),
    h('p', null, 'On the computer that runs Petty Memory:'),
    h('pre', null, 'petty-memory clients add "Browser" --scope read,write'),
    h('p', null, 'Add the secrets scope only if you want this browser to open encrypted secret notes:'),
    h('pre', null, 'petty-memory clients add "Browser vault" --scope read,write,secrets'),
    h('p', null, 'You can revoke a token at any time with petty-memory clients revoke.')));
  clear(root, h('main', { class: 'connect-page' }, form));
  input.focus();
}

function showShell(root) {
  const client = currentClient();
  let view = 'outline';
  let selectedId = null;
  const status = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  let toastTimer = null;

  const ctx = {
    selectedId: () => selectedId,
    /** Resolves false when the user keeps an unsaved draft instead of moving on. */
    async select(id, { edit = false, keepFocus = false } = {}) {
      if (id === null) {
        if (!(await detail.close())) return false;
        selectedId = null;
      } else {
        if (!(await detail.open(id, { edit }))) return false;
        selectedId = id;
        if (!keepFocus && matchMedia('(max-width: 900px)').matches) detail.el.focus?.();
      }
      shell.classList.toggle('has-detail', selectedId !== null);
      outline.render();
      return true;
    },
    async undo(redo = false) {
      try {
        const result = await (redo ? redoEdit() : undoEdit());
        if (!result) return;
        ctx.notify(`${redo ? 'Redid' : 'Undid'}: ${result.label}`, 'ok');
        await ctx.changed();
        outline.focus(result.focusId);
      } catch (error) {
        ctx.notify(`Couldn’t ${redo ? 'redo' : 'undo'}: ${error.message}`, 'error');
        await ctx.changed();
      }
    },
    notify(message, kind = 'info') {
      clearTimeout(toastTimer);
      clear(status, h('p', { class: kind }, message));
      toastTimer = setTimeout(() => status.replaceChildren(), kind === 'error' ? 10_000 : 4_000);
    },
    /** Runs a change, reports failure, then refreshes what may show it. */
    async run(action, { success, refreshOutline = true } = {}) {
      try {
        const result = await action();
        if (success) ctx.notify(success, 'ok');
        await ctx.changed({ outline: refreshOutline });
        return result;
      } catch (error) {
        ctx.notify(error.message, 'error');
        await ctx.changed({ outline: refreshOutline });
        return undefined;
      }
    },
    openView(id) {
      views.views.reveal(id);
      show('views');
    },
    useTemplate(template) {
      show('templates');
      views.templates.reveal(template);
    },
    /** Opens a PDF at a page or a recording at a time: `{kind: 'pdf'|'audio', sourceId, page?, start?, quote?, sha256?, transcriptId?}`. */
    openResearch(locator) {
      views.knowledge.reveal({ ...locator, section: 'research' });
      show('knowledge');
    },
    /** Opens AI chat with an editable draft: `{mode, text, project?, projectName?, root?: {id, title}}`. Nothing is sent until Send. */
    startChat(draft) {
      show('chat');
      return views.chat.startDraft(draft);
    },
    async changed({ outline: refreshOutline = true, detail: refreshDetail = true } = {}) {
      await Promise.all([
        refreshOutline ? outline.refresh() : null,
        refreshOutline && view === 'outline' ? setup.refresh() : null,
        refreshDetail ? detail.refresh() : null,
        view !== 'outline' ? views[view].refresh({ poll: true }) : null,
      ]);
    },
  };

  const outline = createOutline(ctx);
  const setup = createSetupChecklist({ open: (key) => show(key) });
  const detail = createDetail(ctx);
  detail.el.tabIndex = -1;
  const views = {
    outline: { el: h('div', null, setup.el, outline.el), refresh: () => outline.refresh() },
    search: createSearchView(ctx),
    capture: createCaptureView(ctx),
    review: createReviewView(ctx),
    chat: createChatView(ctx),
    knowledge: createKnowledgeView(ctx),
    highlights: createHighlightsView(ctx),
    views: createViewsView(ctx),
    templates: createTemplatesView(ctx),
    projects: createProjectsView(ctx),
    vault: createVaultView(ctx),
    shares: createSharesView(ctx),
  };

  const main = h('main', { class: 'main', id: 'main' });
  const navButtons = VIEWS.map(([key, label]) => h('button', {
    type: 'button', class: 'nav-btn', 'aria-current': key === view ? 'page' : undefined, onClick: () => show(key),
  }, label));
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' }, navButtons);
  const banner = can('write') ? null : h('p', { class: 'banner' }, 'Read-only token: you can browse and search, but not change anything. Connect with a read,write token to edit.');
  const shell = h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
      h('span', { class: 'brand' }, 'Petty Memory'),
      h('span', { class: 'who', title: `Scopes: ${client.scopes.join(', ')}` }, `${client.name} · ${client.scopes.join(', ')}`),
      h('button', { type: 'button', class: 'btn small', onClick: () => ctx.changed() }, 'Refresh'),
      h('button', { type: 'button', class: 'btn small', onClick: async () => {
        if (detail.isDirty() && !(await confirmDialog({
          title: 'Disconnect with unsaved changes?', body: 'Your unsaved text in the open item will be lost.', confirmLabel: 'Discard and disconnect', danger: true,
        }))) return;
        showConnect(root);
      } }, 'Disconnect')),
    nav, banner, main, detail.el, status);

  function show(key) {
    if (key !== view) views[view].leave?.();
    view = key;
    navButtons.forEach((b, i) => {
      if (VIEWS[i][0] === key) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    clear(main, views[key].el);
    if (key === 'outline') setup.refresh();
    else views[key].refresh();
  }

  clear(root, shell);
  show('outline');

  // Ctrl/Cmd+Z in a field is that field's own typing undo; elsewhere it undoes the last outline or text change.
  const onKey = (event) => {
    const mod = /Mac|iP(hone|ad)/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    if (!mod || event.altKey || !(key === 'z' || key === 'y') || isEditable(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    ctx.undo(key === 'y' || event.shiftKey);
  };
  document.addEventListener('keydown', onKey);

  const lifetime = new AbortController();
  let active = null;
  let polling = null;
  let live;
  let revision = 0;
  let deviceId = null;
  const refresh = () => Promise.all([
    outline.busy() ? null : outline.refresh(), detail.refresh(),
    view !== 'outline' ? views[view].refresh({ poll: true }) : null,
  ]);
  const start = () => {
    if (polling || document.hidden || lifetime.signal.aborted) return;
    polling = (async () => {
      let failures = 0;
      while (!document.hidden && !lifetime.signal.aborted) {
        active = new AbortController();
        const signal = active.signal;
        try {
          if (live === undefined) {
            try { live = (await get('/capabilities', { signal })).features.includes('changes-wait'); }
            catch (error) { if (error.status === 404) live = false; else throw error; }
          }
          if (live) {
            const change = await get(`/changes${query({ since: revision, wait: 25000 })}`, { signal });
            if (!Number.isSafeInteger(change.revision) || change.revision < 0 || typeof change.deviceId !== 'string') throw new Error('The server sent an invalid change notification.');
            if (change.revision !== revision || change.deviceId !== deviceId) await refresh();
            revision = change.revision;
            deviceId = change.deviceId;
          } else {
            await pause(POLL_MS, signal);
            await refresh();
          }
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          if (error.status === 401 || error.status === 403) { lifetime.abort(); return; }
          failures++;
          if (failures === 1) ctx.notify(`Live updates paused: ${error.message}`, 'error');
          try { await pause(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)), signal); }
          catch { return; }
        }
      }
    })().finally(() => {
      polling = null;
      if (!document.hidden && !lifetime.signal.aborted) queueMicrotask(start);
    });
  };
  const visibility = () => {
    if (document.hidden) active?.abort();
    else {
      refresh().catch((error) => { if (!lifetime.signal.aborted) ctx.notify(error.message, 'error'); });
      start();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  start();
  stopPolling = () => {
    views.chat.dispose();
    views.capture.dispose();
    views.knowledge.destroy();
    lifetime.abort();
    active?.abort();
    clearTimeout(toastTimer);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('keydown', onKey);
  };
}

/** Up to `want` items matching `filter`, newest first, following the server's page cursor. */
async function itemsUpTo(filter, want) {
  const items = [];
  let before;
  for (;;) {
    const limit = Math.min(MAX_PAGE, want - items.length);
    const page = await get(`/items${query({ ...filter, limit, before })}`);
    items.push(...page);
    if (page.length < limit) return { items, more: false };
    if (items.length >= want) return { items, more: true };
    const last = page.at(-1);
    before = `${last.updatedAt},${last.id}`;
  }
}

const moreButton = (shown, onClick) => h('button', { type: 'button', class: 'btn small', onClick }, `Show more (${shown} shown)`);

function createSearchView(ctx) {
  const q = h('input', { type: 'search', placeholder: 'Search everything', 'aria-label': 'Search' });
  const type = h('select', { 'aria-label': 'Type' }, [['', 'Any type'], ['note', 'Notes'], ['bookmark', 'Links'], ['task', 'Tasks'], ['decision', 'Decisions'], ['file', 'Files']]
    .map(([value, label]) => h('option', { value }, label)));
  const attention = h('select', { 'aria-label': 'Attention' }, [['', 'Any attention'], ['high', 'High attention'], ['normal', 'Normal'], ['low', 'Low']]
    .map(([value, label]) => h('option', { value }, label)));
  const review = h('input', { type: 'checkbox' });
  const tag = h('input', { type: 'text', placeholder: 'Tag', 'aria-label': 'Tag', size: 10 });
  const results = h('ul', { class: 'results' });
  const more = h('div');
  let seq = 0;
  let timer = null;
  let want = PAGE;

  async function refresh() {
    const mine = ++seq;
    if (!results.childElementCount) results.append(h('li', null, loading()));
    const filters = { type: type.value, tag: tag.value.trim(), attention: attention.value, review: review.checked };
    try {
      const text = q.value.trim();
      // Search ranks at most MAX_PAGE results; browsing by filter pages through everything.
      const found = text
        ? await get(`/search${query({ q: text, ...filters, limit: Math.min(want, MAX_PAGE) })}`).then((hits) => ({ items: hits, more: hits.length === want && want < MAX_PAGE }))
        : await itemsUpTo(filters, want);
      if (mine !== seq) return;
      clear(results, found.items.length
        ? found.items.map((hit) => itemRow(text ? { ...hit, body: hit.preview ?? '', metadata: {}, tags: [] } : hit, ctx, text ? hit.snippet?.replace(/[\u0001\u0002]/g, '') : undefined))
        : h('li', null, empty(text ? 'Nothing matches. Try fewer words.' : 'No items match these filters.')));
      clear(more, found.more ? moreButton(found.items.length, () => { want = found.items.length + PAGE; refresh(); }) : null);
    } catch (error) {
      if (mine === seq) clear(results, h('li', null, errorBox(error, refresh)));
    }
  }
  const restart = () => {
    want = PAGE;
    refresh();
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(restart, 250);
  };
  for (const control of [q, tag]) control.addEventListener('input', later);
  for (const control of [type, attention, review]) control.addEventListener('change', restart);

  const el = h('section', { class: 'view', 'aria-labelledby': 'search-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'search-heading' }, 'Search')),
    h('form', { class: 'filters', onSubmit: (e) => { e.preventDefault(); restart(); } },
      q, type, attention, tag, h('label', { class: 'check' }, review, 'Review only')),
    results, more);
  return { el, refresh: ({ poll } = {}) => (poll && el.contains(document.activeElement) ? undefined : refresh()) };
}

function createHighlightsView(ctx) {
  const SECTIONS = [
    ['Pinned', { pinned: true }, 'Pin items from their Organize panel.'],
    ['High attention', { attention: 'high' }, 'Nothing is marked high attention.'],
    ['Marked for review', { review: true }, 'Nothing is waiting for review.'],
    ['To revisit', { intent: 'revisit' }, 'Nothing is set to revisit.'],
    ['Saved but never opened (30+ days)', { unopened: 30 }, 'You’ve opened everything you saved over a month ago.'],
  ];
  const body = h('div', { class: 'highlights' });
  const wants = SECTIONS.map(() => PAGE);
  async function refresh() {
    if (!body.childElementCount) body.append(loading());
    const lists = await Promise.all(SECTIONS.map(([, filter], i) => itemsUpTo(filter, wants[i]).catch((error) => error)));
    clear(body, SECTIONS.map(([title, , none], i) => h('section', { class: 'panel' },
      h('h2', null, title),
      lists[i] instanceof Error ? errorBox(lists[i], refresh)
        : lists[i].items.length ? h('ul', { class: 'results' }, lists[i].items.map((item) => itemRow(item, ctx))) : empty(none),
      lists[i] instanceof Error || !lists[i].more ? null : moreButton(lists[i].items.length, () => { wants[i] = lists[i].items.length + PAGE; refresh(); }))));
  }
  const el = h('section', { class: 'view', 'aria-labelledby': 'highlights-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'highlights-heading' }, 'Highlights')),
    h('p', { class: 'hint' }, 'What you marked as important, plus things worth a second look.'),
    body);
  return { el, refresh };
}

function createProjectsView(ctx) {
  const list = h('div');
  const brief = h('div');
  let openId = null;
  let want = PAGE;

  async function refresh() {
    if (!list.childElementCount) list.append(loading());
    try {
      const projects = await get('/projects');
      clear(list, projects.length
        ? h('ul', { class: 'chips' }, projects.map((p) => h('li', null, h('button', {
          type: 'button', class: `chip${p.id === openId ? ' active' : ''}`, 'aria-pressed': p.id === openId ? 'true' : 'false',
          onClick: () => { openId = p.id; want = PAGE; refresh(); },
        }, p.name))))
        : empty('No projects yet.'));
      if (openId) await showBriefing(openId);
    } catch (error) {
      clear(list, errorBox(error, refresh));
    }
  }

  async function showBriefing(id) {
    try {
      const { project, decisions, openTasks } = await get(`/projects/${enc(id)}`);
      const { items, more } = await itemsUpTo({ project: project.slug }, want);
      clear(brief,
        h('h2', null, project.name),
        project.description ? h('p', null, project.description) : null,
        h('h3', null, 'Decisions'),
        decisions.length ? h('ul', { class: 'plain' }, decisions.filter((d) => !d.supersededBy).map((d) => h('li', null, h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(d.id) }, d.decision), d.reason ? h('span', { class: 'hint' }, ` — ${d.reason}`) : null))) : empty('No decisions recorded.'),
        h('h3', null, 'Open tasks'),
        openTasks.length ? h('ul', { class: 'results' }, openTasks.map((t) => itemRow(t, ctx, t.task.dueAt ? `due ${when(t.task.dueAt)}` : t.task.priority))) : empty('No open tasks.'),
        h('h3', null, 'Items'),
        items.length ? h('ul', { class: 'results' }, items.map((item) => itemRow(item, ctx))) : empty('Nothing filed here yet.'),
        more ? moreButton(items.length, () => { want = items.length + PAGE; showBriefing(id); }) : null);
    } catch (error) {
      clear(brief, errorBox(error, () => showBriefing(id)));
    }
  }

  const name = h('input', { type: 'text', placeholder: 'New project name', 'aria-label': 'New project name', required: true });
  const el = h('section', { class: 'view', 'aria-labelledby': 'projects-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'projects-heading' }, 'Projects')),
    can('write') ? h('form', { class: 'filters', onSubmit: async (e) => {
      e.preventDefault();
      const created = await ctx.run(() => post('/projects', { name: name.value.trim() }), { refreshOutline: false });
      if (created) {
        name.value = '';
        openId = created.id;
        refresh();
      }
    } }, name, h('button', { type: 'submit', class: 'btn small' }, 'Create')) : null,
    list, brief);
  return { el, refresh: ({ poll } = {}) => (poll && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' ? undefined : refresh()) };
}
