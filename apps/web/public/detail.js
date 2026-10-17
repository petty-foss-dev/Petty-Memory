import { can, del, enc, get, patch, post, query } from './api.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, promptDialog, when } from './dom.js';
import { applyEdit } from './edits.js';
import { pickItem } from './picker.js';
import { createShareForm } from './shares.js';
import { displayTitle, isSecret, presentationOf, renderText } from './text.js';
import { secretPanel } from './vault.js';

const RELATION_KINDS = [['related_to', 'Related to'], ['references', 'References'], ['derived_from', 'Derived from'], ['depends_on', 'Depends on']];
const AI_PRESETS = [
  ['Organize', 'Organize this into a clear nested structure with headings and sections where they help. Keep every idea.'],
  ['Correct', 'Correct spelling, grammar and punctuation without changing the meaning.'],
  ['Add', 'Add the missing points a careful reader would expect, as new child notes.'],
  ['Sort', 'Sort the children into a sensible order.'],
];
const VERSION_PAGE = 20;

// The formatted editor is a separate static bundle, fetched the first time something is edited.
let editorModule = null;
const loadEditor = () => (editorModule ??= import('./vendor/editor.js'));

/** Item ids shown by a reference token resolve to their current titles, cached for the session. */
const titles = new Map();
const resolved = new Map();
async function titleFor(id) {
  if (!titles.has(id)) {
    titles.set(id, get(`/items/${enc(id)}`).then((item) => (isSecret(item) ? 'Secret note' : displayTitle(item)), () => null));
    titles.get(id).then((title) => resolved.set(id, title));
  }
  return titles.get(id);
}

/** How a restore went, naming files whose bytes aren't on this device rather than claiming a full recovery. */
function recovery(done, { missingFiles = [] }) {
  if (!missingFiles.length) return { text: done, kind: 'ok' };
  const count = missingFiles.length === 1 ? '1 file isn’t' : `${missingFiles.length} files aren’t`;
  return {
    text: `${done}, but ${count} on the server (${missingFiles.map((f) => f.filename).join(', ')}). Sync with the device that has them, or restore a backup that does.`,
    kind: 'error',
  };
}

export function referenceLink(id, label, navigate) {
  const link = h('button', { type: 'button', class: 'ref', onClick: () => navigate(id) }, label ?? 'Linked item');
  titleFor(id).then((title) => {
    if (title) link.textContent = title;
    else {
      link.classList.add('broken');
      link.title = 'This item is missing or archived';
    }
  });
  return link;
}

export function createDetail(ctx) {
  const el = h('aside', { class: 'detail', 'aria-label': 'Item details', hidden: true });
  let current = null;

  const discard = () => confirmDialog({
    title: 'Discard unsaved changes?', body: 'Your edits to this item haven’t been saved.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true,
  });
  const leave = async () => !current?.dirty || discard();

  async function close() {
    if (!(await leave())) return false;
    current?.editor?.destroy();
    current = null;
    el.hidden = true;
    el.replaceChildren();
    return true;
  }

  /** Resolves false when the user keeps an unsaved draft instead of switching items. */
  async function open(id, { edit = false } = {}) {
    if (current?.id === id && current.editing) return true;
    if (current?.id !== id && !(await leave())) return false;
    current?.editor?.destroy();
    current = { id, item: null, editing: edit, dirty: false, draft: null, editor: null };
    el.hidden = false;
    clear(el, loading());
    load(current);
    return true;
  }

  async function load(state) {
    try {
      const [item, ancestors] = await Promise.all([get(`/items/${enc(state.id)}`), get(`/outline/${enc(state.id)}/ancestors`).catch(() => [])]);
      if (current !== state || state.editing && state.item) return;
      state.item = item;
      state.ancestors = ancestors;
      const shown = isSecret(item) ? 'Secret note' : displayTitle(item);
      titles.set(item.id, Promise.resolve(shown));
      resolved.set(item.id, shown);
      render(state);
    } catch (error) {
      if (current === state) clear(el, header(null), errorBox(error, () => load(state)));
    }
  }

  // Polling leaves an open editor alone, so an unsaved draft is never replaced by server data.
  async function refresh() {
    if (!current || current.editing) return;
    const state = current;
    if (isSecret(state.item)) return;
    if (state.interacting || state.historyOpen) {
      const item = await get(`/items/${enc(state.id)}`);
      if (current !== state || state.editing) return;
      state.item = item;
      el.querySelector('.content')?.replaceWith(contentSection(state));
      return;
    }
    await load(current);
  }

  function header(state) {
    const crumbs = state?.ancestors?.length
      ? h('nav', { class: 'crumbs', 'aria-label': 'Location in outline' },
        state.ancestors.map((a) => h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(a.id) }, isSecret(a) ? 'Secret note' : displayTitle(a))))
      : null;
    return h('header', { class: 'detail-head' },
      h('button', { type: 'button', class: 'btn small close', onClick: () => ctx.select(null), 'aria-label': 'Close details' }, 'Close'),
      crumbs);
  }

  function render(state) {
    const { item } = state;
    const secret = isSecret(item);
    const writable = can('write');
    clear(el,
      header(state),
      h('p', { class: 'meta' }, [item.type, item.project?.name, `updated ${when(item.updatedAt)}`].filter(Boolean).join(' · ')),
      secret ? secretPanel(item, ctx) : contentSection(state),
      secret ? null : presentationSection(state),
      connectionsSection(state),
      historySection(state),
      writable && !secret && item.type !== 'decision' ? aiSection(state) : null,
      writable && !secret ? h('section', { class: 'panel', onClick: () => { state.interacting = true; } }, h('h2', null, 'Public link'), createShareForm(item, ctx)) : null);
  }

  function contentSection(state) {
    const { item } = state;
    const section = h('section', { class: 'panel content' });
    const editable = can('write') && item.type !== 'decision';
    if (!state.editing) {
      clear(section,
        h('h1', { class: `item-title kind-${presentationOf(item).kind}` }, displayTitle(item)),
        item.url ? h('p', { class: 'url' }, safeUrl(item.url)) : null,
        item.body ? renderText(item.body, (id, label) => referenceLink(id, label, ctx.select)) : empty('No text yet.'),
        can('write') ? tagEditor(state) : item.tags.length ? h('p', { class: 'tags' }, item.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))) : null,
        item.type === 'decision' ? h('p', { class: 'hint' }, 'Decisions are append-only. Record a new decision to change one.') : null,
        editable ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => { state.editing = true; render(state); } }, 'Edit')) : null);
      return section;
    }

    state.draft ??= { title: item.title, body: item.body };
    const title = h('input', { type: 'text', value: state.draft.title, 'aria-label': 'Title', placeholder: 'Title', class: 'title-input' });
    const host = h('div', { class: 'body-editor' }, loading('Loading the editor…'));
    const status = h('p', { class: 'hint', role: 'status' });
    const markDirty = () => {
      state.draft = { title: title.value, body: state.editor?.getMarkdown() ?? state.draft.body };
      state.dirty = state.draft.title !== item.title || state.draft.body !== item.body;
      status.textContent = state.dirty ? 'Unsaved changes' : '';
    };
    title.addEventListener('input', markDirty);
    const finish = () => {
      state.editor?.destroy();
      Object.assign(state, { editing: false, dirty: false, draft: null, editor: null });
      render(state);
    };
    // Saved against the text this editor opened with, so a newer change from elsewhere is reported rather than overwritten.
    const save = async () => {
      markDirty();
      const { draft } = state;
      const command = { op: 'update', id: item.id };
      if (draft.title !== item.title) Object.assign(command, { title: draft.title, baseTitle: item.title });
      if (draft.body !== item.body) Object.assign(command, { body: draft.body, baseBody: item.body });
      if (command.title === undefined && command.body === undefined) return finish();
      status.textContent = 'Saving…';
      try {
        await applyEdit([command]);
        state.item = await get(`/items/${enc(item.id)}`);
        finish();
        ctx.changed({ detail: false });
      } catch (error) {
        status.textContent = `Not saved: ${error.message} Your text is still here.`;
      }
    };
    loadEditor().then(({ createMarkdownEditor, normalizeLink }) => {
      if (current !== state || !state.editing || !host.isConnected) return;
      host.replaceChildren();
      state.editor?.destroy();
      state.editor = createMarkdownEditor(host, {
        markdown: state.draft.body,
        label: 'Text',
        placeholder: 'Write freely. Use the toolbar for formatting, or switch to Markdown.',
        referenceTitle: (id) => {
          if (!resolved.has(id)) titleFor(id).then(() => state.editor?.refreshReferences());
          return resolved.get(id);
        },
        requestLink: (current) => promptDialog({
          title: current ? 'Edit link' : 'Add link', label: 'Web or email address', value: current ?? '', confirmLabel: current ? 'Update link' : 'Add link',
          hint: 'Use a web address (https://…) or an email address.', validate: normalizeLink,
          extras: current ? [{ label: 'Remove link', value: '' }] : [],
        }),
        requestReference: async () => {
          const target = await pickItem({ title: 'Insert a reference', exclude: new Set([item.id]) });
          return target ? { id: target.id, label: target.title } : null;
        },
        onChange: markDirty,
        onSubmit: save,
        onOpenReference: (id) => ctx.select(id),
        onOpenLink: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
      });
      if (state.draft.title) state.editor.focus();
    }, (error) => clear(host, errorBox(error)));
    clear(section,
      h('form', { class: 'editor', onSubmit: (e) => { e.preventDefault(); save(); } },
        title,
        host,
        h('div', { class: 'actions' },
          h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
          h('button', { type: 'button', class: 'btn', onClick: async () => {
            if (state.dirty && !(await discard())) return;
            finish();
          } }, 'Cancel')),
        status));
    if (!state.draft.title) queueMicrotask(() => title.focus());
    return section;
  }

  /** Tags change straight away; text typed but not added survives refreshes and failed requests. */
  function tagEditor(state) {
    const { item } = state;
    const input = h('input', { type: 'text', value: state.tagDraft ?? '', placeholder: 'Add tags, separated by commas', 'aria-label': 'Add tags' });
    input.addEventListener('input', () => { state.tagDraft = input.value; state.interacting = true; });
    const change = (body) => ctx.run(async () => {
      const updated = await post(`/items/${enc(item.id)}/tags`, body);
      if (body.add) state.tagDraft = '';
      return updated;
    }, { refreshOutline: false });
    return h('div', { class: 'tag-editor' },
      h('ul', { class: 'tags', 'aria-label': 'Tags' }, item.tags.map((tag) => h('li', { class: 'tag' }, `#${tag}`,
        h('button', { type: 'button', class: 'link-btn', 'aria-label': `Remove tag ${tag}`, onClick: () => change({ remove: [tag] }) }, '×')))),
      h('form', { class: 'actions', onSubmit: async (e) => {
        e.preventDefault();
        const add = input.value.split(',').map((t) => t.trim()).filter(Boolean);
        if (add.length) await change({ add });
      } }, input, h('button', { type: 'submit', class: 'btn small' }, 'Add')));
  }

  function presentationSection(state) {
    const { item } = state;
    const section = h('section', { class: 'panel' }, h('h2', null, 'Organize'), loading());
    const writable = can('write') && item.type !== 'decision';
    get(`/items/${enc(item.id)}/presentation`).then((p) => {
      const update = (change) => ctx.run(() => patch(`/items/${enc(item.id)}/presentation`, change));
      const select = (label, key, options) => field(label, h('select', { disabled: !writable, onChange: (e) => update({ [key]: e.target.value }) },
        options.map(([value, text]) => h('option', { value, selected: p[key] === value }, text))));
      const toggle = (label, key, hint) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: p[key], disabled: !writable, onChange: (e) => update({ [key]: e.target.checked }) }), label,
        hint ? h('span', { class: 'hint' }, hint) : null);
      const parent = state.ancestors?.at(-1);
      const inChecklist = p.checklist || (parent && presentationOf(parent).checklist);
      clear(section, h('h2', null, 'Organize'),
        h('div', { class: 'grid2' },
          select('Show as', 'kind', [['text', 'Text'], ['heading', 'Heading'], ['section', 'Section break']]),
          select('Attention', 'attention', [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']])),
        toggle('Marked for review', 'review'),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: Boolean(item.pinnedAt), disabled: !can('write'), onChange: (e) => ctx.run(() => post(`/items/${enc(item.id)}/pin`, { pinned: e.target.checked })) }),
          'Pinned highlight'),
        toggle('Checklist', 'checklist', 'Children get checkboxes'),
        p.checklist ? toggle('Hide completed', 'hideCompleted') : null,
        toggle('Let AI organize this in the background', 'autoOrganize', 'Needs an AI provider on the server; every change is kept in history'),
        inChecklist && item.type !== 'decision'
          ? h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: item.task ? item.task.status === 'done' : p.checked, disabled: !can('write'), onChange: (e) => ctx.run(() => applyEdit([{ op: 'check', id: item.id, checked: e.target.checked }])) }),
            p.checklist ? 'Done (applies to every entry inside)' : 'Done')
          : null,
        p.checklist ? checklistProgress(item) : null);
    }, (error) => clear(section, h('h2', null, 'Organize'), errorBox(error, () => render(state))));
    return section;
  }

  function checklistProgress(item) {
    const box = h('div', { class: 'progress' }, loading());
    get(`/items/${enc(item.id)}/checklist`).then(({ done, total }) => {
      clear(box,
        h('progress', { max: Math.max(total, 1), value: done, 'aria-label': 'Checklist progress' }),
        h('span', null, total ? `${done} of ${total} done` : 'No entries yet'),
        can('write') && done > 0
          ? h('button', { type: 'button', class: 'btn small', onClick: async () => {
            const ok = await confirmDialog({ title: 'Reset this checklist?', body: 'Every entry in it is unchecked.', confirmLabel: 'Uncheck all' });
            if (ok) ctx.run(() => post(`/items/${enc(item.id)}/checklist/reset`));
          } }, 'Reset')
          : null);
    }, (error) => clear(box, errorBox(error)));
    return box;
  }

  function connectionsSection(state) {
    const { item } = state;
    const section = h('section', { class: 'panel' }, h('h2', null, 'Connections'), loading());
    const writable = can('write');
    const relLink = (rel) => h('button', { type: 'button', class: 'ref', onClick: () => ctx.select(rel.id) }, rel.title || 'Untitled');
    get(`/items/${enc(item.id)}/references`).then(({ outgoing, incoming }) => {
      const explicit = item.relations.filter((r) => !(r.kind === 'references' && outgoing.some((o) => o.id === r.id)));
      const remove = (rel) => {
        const [from, to] = rel.direction === 'outgoing' ? [item.id, rel.id] : [rel.id, item.id];
        ctx.run(() => del(`/items/${enc(from)}/relations`, { toId: to, kind: rel.kind }));
      };
      const kind = h('select', { 'aria-label': 'Connection kind' }, RELATION_KINDS.map(([value, label]) => h('option', { value }, label)));
      const connect = async () => {
        const target = await pickItem({ title: 'Connect to…', exclude: new Set([item.id]) });
        if (target) ctx.run(() => post(`/items/${enc(item.id)}/relations`, { toId: target.id, kind: kind.value }));
      };
      const addReference = async () => {
        const target = await pickItem({ title: 'Add a reference to…', exclude: new Set([item.id]) });
        if (target) ctx.run(() => post(`/items/${enc(item.id)}/references`, { toId: target.id, label: target.title }));
      };
      const label = Object.fromEntries(RELATION_KINDS);
      clear(section, h('h2', null, 'Connections'),
        h('h3', null, 'References in this item'),
        outgoing.length ? h('ul', { class: 'plain' }, outgoing.map((r) => h('li', null, relLink(r)))) : empty('None.'),
        h('h3', null, 'Backlinks'),
        incoming.length ? h('ul', { class: 'plain' }, incoming.map((r) => h('li', null, relLink(r)))) : empty('Nothing references this yet.'),
        h('h3', null, 'Linked items'),
        explicit.length
          ? h('ul', { class: 'plain' }, explicit.map((r) => h('li', null,
            h('span', { class: 'hint' }, `${r.direction === 'outgoing' ? '' : '← '}${label[r.kind] ?? r.kind.replace('_', ' ')} `),
            relLink(r),
            writable && r.kind !== 'supersedes' ? h('button', { type: 'button', class: 'link-btn danger', onClick: () => remove(r), 'aria-label': `Remove connection to ${r.title}` }, 'Remove') : null)))
          : empty('No connections.'),
        writable ? h('div', { class: 'actions' },
          kind, h('button', { type: 'button', class: 'btn small', onClick: connect }, 'Connect…'),
          isSecret(item) || item.type === 'decision' ? null : h('button', { type: 'button', class: 'btn small', onClick: addReference }, 'Add reference…')) : null);
    }, (error) => clear(section, h('h2', null, 'Connections'), errorBox(error, () => render(state))));
    return section;
  }

  function historySection(state) {
    const { item } = state;
    const list = h('ol', { class: 'versions' });
    const compare = h('div', { class: 'compare' });
    const more = h('div');
    const section = h('section', { class: 'panel' }, h('h2', null, 'History'));
    let versions = [];
    let total = 0;
    const loadPage = async () => {
      clear(more, loading());
      try {
        const base = versions.length;
        const page = await get(`/items/${enc(item.id)}/versions${query({ offset: base, limit: VERSION_PAGE })}`);
        versions = versions.concat(page.items);
        total = page.total;
        list.append(...page.items.map((v, i) => h('li', null,
          h('button', { type: 'button', class: 'link-btn', onClick: () => show(base + i) },
            `${when(v.at)} · ${v.op} · ${v.actor}`))));
        clear(more, versions.length < total ? h('button', { type: 'button', class: 'btn small', onClick: loadPage }, `Older versions (${versions.length} of ${total})`) : null);
        if (!total) clear(more, empty('No versions recorded yet.'));
      } catch (error) {
        clear(more, errorBox(error, loadPage));
      }
    };
    const show = async (index) => {
      const summary = versions[index];
      clear(compare, loading('Loading version…'));
      try {
        // A version holds the state after its change; the next older one is the state before it.
        if (index + 1 >= versions.length && versions.length < total) await loadPage();
        const older = versions[index + 1];
        const [after, before] = await Promise.all([get(`/versions/${enc(summary.id)}`), older ? get(`/versions/${enc(older.id)}`) : null]);
        clear(compare,
          h('h3', null, `${summary.op} by ${summary.actor}, ${when(summary.at)}`),
          before ? null : h('p', { class: 'hint' }, 'This is the earliest recorded state; anything before it wasn’t captured.'),
          diffView(before?.snapshot ?? null, after.snapshot),
          can('write') && !(item.type === 'decision') && (!isSecret(item) || can('secrets'))
            ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: async () => {
              // A secret note's history goes back through the vault route, which only ever restores ciphertext.
              const secret = isSecret(item);
              const ok = await confirmDialog({
                title: 'Restore this version?',
                body: secret
                  ? `This secret note, its encrypted files and the secret notes inside it go back to how they were on ${when(summary.at)}. Only encrypted content is restored, as a new change.`
                  : `The item goes back to how it was on ${when(summary.at)}. This is saved as a new change, so you can restore the current state from history.`,
                confirmLabel: 'Restore version',
              });
              if (!ok) return;
              const result = await ctx.run(() => post(secret ? `/vault/versions/${enc(summary.id)}/restore` : `/versions/${enc(summary.id)}/restore`));
              if (result) {
                const { text, kind } = recovery('Version restored as a new change', result);
                ctx.notify(text, kind);
              }
            } }, 'Restore this version'))
            : null);
      } catch (error) {
        clear(compare, errorBox(error, () => show(index)));
      }
    };
    clear(section, h('h2', null, 'History'),
      h('button', { type: 'button', class: 'btn small', onClick: (e) => { state.historyOpen = true; e.target.remove(); loadPage(); } }, 'Show history'),
      list, more, compare);
    return section;
  }

  function aiSection(state) {
    const { item } = state;
    const instruction = h('textarea', { rows: 3, placeholder: 'Or describe the change you want', 'aria-label': 'AI instruction' });
    instruction.addEventListener('input', () => { state.interacting = true; });
    const out = h('div', { class: 'proposal', 'aria-live': 'polite' });
    const propose = async (text) => {
      if (!text.trim()) return ctx.notify('Choose a preset or describe the change first.', 'info');
      state.interacting = true;
      clear(out, loading('Asking the AI provider for a proposal…'));
      try {
        const proposal = await post('/ai/edit', { rootId: item.id, instruction: text });
        renderProposal(proposal);
      } catch (error) {
        clear(out, errorBox(error));
      }
    };
    const renderProposal = (proposal) => {
      const selected = new Set(proposal.operations.map((_, index) => index));
      const apply = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
        apply.disabled = true;
        try {
          const { applied, undo } = await post('/ai/apply', { proposal: { ...proposal, operations: proposal.operations.filter((_, index) => selected.has(index)) } });
          clear(out, h('p', { class: 'ok' }, `Applied ${applied} change${applied === 1 ? '' : 's'}.`));
          ctx.changed();
          if (undo) {
            out.append(h('button', { type: 'button', class: 'btn', onClick: async (event) => {
              event.target.disabled = true;
              try {
                const { text, kind } = recovery('AI changes undone as a new history entry', await post('/ai/undo', { receipt: undo }));
                clear(out, h('p', { class: kind }, text));
                ctx.changed();
              } catch (error) { out.append(errorBox(error)); }
            } }, 'Undo these changes'));
          }
        } catch (error) {
          out.append(errorBox(error));
          apply.disabled = selected.size === 0;
        }
      } }, 'Apply selected');
      clear(out,
        h('h3', null, 'Proposal'),
        h('p', null, proposal.summary || 'No summary.'),
        proposal.operations.length
          ? h('ol', { class: 'ops' }, proposal.operations.map((operation, index) => {
            const row = operationView(operation);
            row.prepend(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, 'aria-label': `Include change ${index + 1}`, onChange: (event) => {
              if (event.target.checked) selected.add(index); else selected.delete(index);
              apply.disabled = selected.size === 0;
            } }), 'Include this change'));
            return row;
          }))
          : empty('The model proposed no changes.'),
        h('div', { class: 'actions' },
          proposal.operations.length ? apply : null,
          h('button', { type: 'button', class: 'btn', onClick: () => { clear(out); state.interacting = false; } }, 'Discard')));
    };
    return h('section', { class: 'panel' },
      h('h2', null, 'Edit with AI'),
      h('p', { class: 'hint' }, 'Proposes changes to this item and everything inside it. Nothing changes until you apply.'),
      h('div', { class: 'actions' }, AI_PRESETS.map(([label, text]) => h('button', { type: 'button', class: 'btn small', onClick: () => propose(text) }, label))),
      instruction,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', onClick: () => propose(instruction.value) }, 'Propose')),
      out);
  }

  return { el, open, close, refresh, isDirty: () => Boolean(current?.dirty), currentId: () => current?.id ?? null };
}

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, raw);
  } catch {}
  return raw;
}

function titleNode(id) {
  const span = h('span', { class: 'op-target' }, 'item');
  titleFor(id).then((title) => { if (title) span.textContent = `“${title}”`; });
  return span;
}

const opField = (label, value) => h('div', { class: 'op-field' }, h('span', { class: 'hint' }, label), h('span', { class: 'op-value' }, value || '—'));

function operationView(op) {
  switch (op.op) {
    case 'update':
      return h('li', null, h('strong', null, 'Edit '), titleNode(op.id),
        op.title !== undefined && op.title !== op.before.title ? [opField('Title before', op.before.title), opField('Title after', op.title)] : null,
        op.body !== undefined && op.body !== op.before.body ? [opField('Text before', op.before.body), opField('Text after', op.body)] : null);
    case 'create':
      return h('li', null, h('strong', null, 'Add inside '), titleNode(op.parentId), opField('Title', op.title), opField('Text', op.body));
    case 'move':
      return h('li', null, h('strong', null, 'Move '), titleNode(op.id), ' into ', titleNode(op.parentId),
        op.beforeId ? [' before ', titleNode(op.beforeId)] : ' at the end');
    case 'presentation':
      return h('li', null, h('strong', null, 'Restyle '), titleNode(op.id),
        Object.entries(op.patch).map(([key, value]) => opField(key, `${op.before[key]} → ${value}`)));
    default:
      return h('li', null, h('strong', null, 'Unrecognised change'), opField('Raw', JSON.stringify(op)));
  }
}

function diffView(before, after) {
  const prior = new Map((before?.items ?? []).map((n) => [n.item.id, n]));
  const next = new Map(after.items.map((n) => [n.item.id, n]));
  const rows = [];
  for (const node of after.items) {
    const old = prior.get(node.item.id);
    const status = !before ? 'state' : !old ? 'added' : changed(old, node) ? 'changed' : 'same';
    rows.push(nodeDiff(status, old, node));
  }
  for (const node of before?.items ?? []) if (!next.has(node.item.id)) rows.push(nodeDiff('removed', node, null));
  const interesting = rows.filter((r) => r.dataset.status !== 'same');
  return h('div', { class: 'diff' }, interesting.length ? interesting : empty('No visible text or position changes in this version.'));
}

const changed = (a, b) => a.item.title !== b.item.title || a.item.body !== b.item.body || a.parentId !== b.parentId || a.position !== b.position
  || JSON.stringify(a.item.metadata?.presentation ?? null) !== JSON.stringify(b.item.metadata?.presentation ?? null) || a.item.archivedAt !== b.item.archivedAt
  || JSON.stringify(a.item.metadata?.vault ?? null) !== JSON.stringify(b.item.metadata?.vault ?? null) || fileSet(a) !== fileSet(b);
const fileSet = (node) => (node.item.attachments ?? []).map((f) => `${f.id}:${f.sha256}`).sort().join(',');

function nodeDiff(status, before, after) {
  const side = (label, node) => h('div', { class: 'diff-side' },
    h('span', { class: 'hint' }, label),
    node ? [
      h('strong', null, isSecret(node.item) ? 'Secret note (encrypted)' : displayTitle(node.item)),
      isSecret(node.item) ? h('p', { class: 'hint' }, `${(node.item.attachments ?? []).length} encrypted file(s)`) : h('p', { class: 'pre' }, node.item.body),
    ] : empty('—'));
  const label = { state: 'State', added: 'Added', changed: 'Changed', removed: 'Removed', same: 'Unchanged' }[status];
  return h('div', { class: `diff-row ${status}`, 'data-status': status },
    h('span', { class: 'badge' }, label),
    status === 'state' ? side('At this version', after) : h('div', { class: 'diff-pair' }, side('Before', before), side('After', after)));
}
