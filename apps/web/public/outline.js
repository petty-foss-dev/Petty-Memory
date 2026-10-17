import { can, enc, get, query } from './api.js';
import { clear, empty, errorBox, h, loading } from './dom.js';
import { applyEdit, editHistory, onEditHistory } from './edits.js';
import { pickItem } from './picker.js';
import { displayTitle, isSecret, presentationOf } from './text.js';

const PAGE = 50;
const MAX_PAGE = 200;
const ROOT = 'root';
const keyOf = (parentId) => parentId ?? ROOT;
const parentOf = (key) => (key === ROOT ? null : key);
const canContain = (item, child) => item.type !== 'decision' && (!isSecret(item) || child && isSecret(child));
const isChecked = (item) => (item.type === 'task' && item.task ? item.task.status === 'done' : presentationOf(item).checked);
const mergeable = (entry) => entry?.item.type === 'note' && !entry.item.archivedAt && !isSecret(entry.item);
const isMac = /Mac|iP(hone|ad)/.test(navigator.platform);

export function createOutline(ctx) {
  const lists = new Map();
  const listOf = new Map();
  const entries = new Map();
  const expanded = new Set();
  const showCompleted = new Set();
  let inline = null;
  let renaming = null;
  let visible = [];

  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Outline', onKeydown: keydown });
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Outline actions' });
  const el = h('section', { class: 'view outline-view', 'aria-labelledby': 'outline-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'outline-heading' }, 'Outline'), toolbar),
    tree);

  async function fetchList(key, want) {
    const items = [];
    let total = 0;
    do {
      const page = await get(`/outline${query({ parent: parentOf(key), offset: items.length, limit: Math.min(MAX_PAGE, want - items.length) })}`);
      items.push(...page.items);
      total = page.total;
      if (page.items.length === 0) break;
    } while (items.length < Math.min(want, total));
    return { items, total };
  }

  function store(key, page) {
    lists.set(key, { ...page, loading: false, error: null });
    for (const entry of page.items) {
      entries.set(entry.item.id, entry);
      listOf.set(entry.item.id, key);
    }
  }

  async function load(key, want = PAGE) {
    const prior = lists.get(key);
    lists.set(key, { items: prior?.items ?? [], total: prior?.total ?? 0, loading: true, error: null });
    render();
    try {
      store(key, await fetchList(key, want));
    } catch (error) {
      lists.set(key, { items: prior?.items ?? [], total: prior?.total ?? 0, loading: false, error });
    }
    render();
  }

  async function loadMore(key) {
    const list = lists.get(key);
    await load(key, list.items.length + PAGE);
  }

  async function refresh() {
    const keys = [...lists.keys()].filter((key) => key === ROOT || expanded.has(key));
    await Promise.all(keys.map(async (key) => {
      try {
        store(key, await fetchList(key, Math.max(PAGE, lists.get(key)?.items.length ?? 0)));
      } catch (error) {
        lists.set(key, { ...lists.get(key), loading: false, error });
      }
    }));
    render();
  }

  // Polling skips while the user is typing in the tree so an inline draft is never replaced.
  const busy = () => inline !== null || renaming !== null || tree.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';

  function toggle(id, open = !expanded.has(id)) {
    if (open) {
      expanded.add(id);
      if (!lists.has(id)) return load(id);
    } else expanded.delete(id);
    render();
  }

  function render() {
    const focusedId = tree.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    const typing = Boolean(document.activeElement?.closest?.('.inline-create')) || inline?.autofocus;
    if (inline) inline.autofocus = false;
    const field = tree.querySelector('.rename');
    if (renaming && field === document.activeElement) renaming.caret = [field.selectionStart, field.selectionEnd];
    const renameFocus = renaming && (field === document.activeElement || renaming.autofocus);
    if (renaming) renaming.autofocus = false;
    visible = [];
    const root = lists.get(ROOT);
    clear(tree, root ? group(ROOT, 1) : loading());
    if (root && !root.loading && !root.error && root.items.length === 0 && !inline) {
      tree.append(empty(can('write') ? 'Nothing here yet. Add a note to start your outline.' : 'Nothing here yet.'));
    }
    renderToolbar();
    const target = tree.querySelector(`[data-id="${CSS.escape(focusedId ?? ctx.selectedId() ?? '')}"]`);
    if (focusedId && target) target.focus();
    const input = tree.querySelector('.inline-create input');
    if (input && typing) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    const rename = tree.querySelector('.rename');
    if (rename && renameFocus) {
      rename.focus();
      rename.setSelectionRange(...(renaming.caret ?? [rename.value.length, rename.value.length]));
    }
  }

  function group(key, level) {
    const list = lists.get(key);
    const parent = key === ROOT ? null : entries.get(key)?.item;
    const p = parent ? presentationOf(parent) : null;
    const hiding = p?.checklist && p.hideCompleted && !showCompleted.has(key);
    const shown = hiding ? list.items.filter((e) => !isChecked(e.item)) : list.items;
    const nodes = [];
    for (const entry of shown) {
      if (inline && inline.beforeId === entry.item.id) nodes.push(inlineRow(level));
      nodes.push(row(entry, level, p?.checklist ?? false));
      if (expanded.has(entry.item.id) && lists.has(entry.item.id)) nodes.push(group(entry.item.id, level + 1));
      if (inline && inline.afterId === entry.item.id) nodes.push(inlineRow(level));
    }
    if (inline && keyOf(inline.parentId) === key && !inline.afterId && !(inline.beforeId && shown.some((e) => e.item.id === inline.beforeId))) {
      nodes.push(inlineRow(level));
    }
    if (hiding && shown.length < list.items.length) {
      nodes.push(h('button', { type: 'button', class: 'link-btn indent', style: pad(level), onClick: () => { showCompleted.add(key); render(); } },
        `Show ${list.items.length - shown.length} completed`));
    } else if (p?.checklist && p.hideCompleted && showCompleted.has(key)) {
      nodes.push(h('button', { type: 'button', class: 'link-btn indent', style: pad(level), onClick: () => { showCompleted.delete(key); render(); } }, 'Hide completed'));
    }
    if (list.loading) nodes.push(h('div', { style: pad(level) }, loading()));
    if (list.error) nodes.push(h('div', { style: pad(level) }, errorBox(list.error, () => load(key, Math.max(PAGE, list.items.length)))));
    if (!list.loading && list.items.length < list.total) {
      nodes.push(h('button', { type: 'button', class: 'link-btn indent', style: pad(level), onClick: () => loadMore(key) },
        `Show more (${list.items.length} of ${list.total})`));
    }
    return h('div', { role: key === ROOT ? 'presentation' : 'group' }, nodes);
  }

  const pad = (level) => ({ '--depth': level - 1 });

  function row(entry, level, inChecklist) {
    const { item, childCount } = entry;
    const p = presentationOf(item);
    const open = expanded.has(item.id);
    const selected = ctx.selectedId() === item.id;
    visible.push(item.id);
    const label = isSecret(item) ? `🔒 ${item.title || 'Secret note'}` : displayTitle(item);
    const done = isChecked(item);
    return h('div', {
      class: `node kind-${p.kind} attention-${p.attention}${selected ? ' selected' : ''}${done && inChecklist ? ' done' : ''}`,
      role: 'treeitem', 'aria-level': level, 'aria-selected': selected ? 'true' : 'false',
      'aria-expanded': childCount > 0 ? String(open) : undefined,
      tabIndex: selected || (!ctx.selectedId() && visible.length === 1) ? 0 : -1,
      'data-id': item.id, style: pad(level),
      onClick: (e) => {
        if (e.target.closest('button, input')) return;
        ctx.select(item.id);
      },
    },
    childCount > 0
      ? h('button', { type: 'button', class: 'twisty', 'aria-label': open ? 'Collapse' : 'Expand', tabIndex: -1, onClick: () => toggle(item.id) }, open ? '▾' : '▸')
      : h('span', { class: 'twisty-spacer', 'aria-hidden': 'true' }),
    inChecklist && item.type !== 'decision' && !isSecret(item)
      ? h('input', {
        type: 'checkbox', checked: done, disabled: !can('write'), tabIndex: -1, 'aria-label': `Done: ${label}`,
        onChange: (e) => ctx.run(() => applyEdit([{ op: 'check', id: item.id, checked: e.target.checked }])),
      })
      : null,
    renaming?.id === item.id ? renameField(entry) : h('span', { class: 'node-title' }, label),
    p.review ? h('span', { class: 'badge review', title: 'Marked for review' }, 'Review') : null,
    item.pinnedAt ? h('span', { class: 'badge', title: 'Pinned' }, 'Pinned') : null,
    p.checklist ? h('span', { class: 'badge', title: 'Checklist' }, 'Checklist') : null,
    item.type !== 'note' ? h('span', { class: 'badge muted' }, item.type) : null,
    childCount > 0 && !open ? h('span', { class: 'count', 'aria-label': `${childCount} children` }, String(childCount)) : null);
  }

  function inlineRow(level) {
    const input = h('input', {
      type: 'text', placeholder: 'Write a note and press Enter', 'aria-label': 'New note', value: inline.text,
      onInput: (e) => { inline.text = e.target.value; },
      onKeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitInline(); }
        if (e.key === 'Escape') { inline = null; render(); }
      },
      onBlur: () => setTimeout(() => {
        if (inline && !inline.text.trim() && !inline.saving) { inline = null; render(); }
      }, 150),
    });
    return h('form', { class: 'inline-create', style: pad(level), onSubmit: (e) => { e.preventDefault(); submitInline(); } },
      input, h('button', { type: 'submit', class: 'btn small primary' }, 'Add'));
  }

  async function submitInline() {
    const draft = inline;
    if (!draft?.text.trim() || draft.saving) return;
    draft.saving = true;
    try {
      const beforeId = draft.beforeId ?? (draft.afterId ? await siblingAfter(draft.afterId) : null);
      const result = await applyEdit([{ op: 'create', parentId: draft.parentId, beforeId, title: draft.text.trim() }]);
      const id = result.createdIds[0] ?? result.focusId;
      // Keeps the row open for the next line, as in a list editor.
      inline = { parentId: draft.parentId, afterId: draft.afterId ? id : null, beforeId: draft.beforeId ?? null, text: '', autofocus: true };
      if (draft.parentId) expanded.add(draft.parentId);
      await refreshAround(draft.parentId);
      ctx.select(id, { keepFocus: true });
    } catch (error) {
      draft.saving = false;
      ctx.notify(error.message, 'error');
    }
  }

  async function refreshAround(parentId) {
    if (parentId && !lists.has(parentId)) await load(parentId);
    await refresh();
  }

  function startCreate(parentId, afterId = null, beforeId = null) {
    if (!can('write')) return ctx.notify('This token is read-only. Create one with `--scope read,write` to add notes.', 'error');
    if (parentId) {
      const parent = entries.get(parentId)?.item;
      if (parent && !canContain(parent)) return ctx.notify(isSecret(parent) ? 'Use the Vault to add a secret note inside this one.' : 'Decisions can’t contain other items.', 'error');
      expanded.add(parentId);
      if (!lists.has(parentId)) load(parentId);
    }
    inline = { parentId, afterId, beforeId, text: '', autofocus: true };
    render();
  }

  /** The id after `id` among its loaded siblings, loading the next page if `id` is last of a partial list. */
  async function siblingAfter(id) {
    const key = listOf.get(id);
    let list = lists.get(key);
    let i = list.items.findIndex((e) => e.item.id === id);
    if (i === list.items.length - 1 && list.items.length < list.total) {
      await loadMore(key);
      list = lists.get(key);
      i = list.items.findIndex((e) => e.item.id === id);
    }
    return list.items[i + 1]?.item.id ?? null;
  }

  async function move(id, parentId, beforeId) {
    await ctx.run(async () => {
      await applyEdit([{ op: 'move', id, parentId, beforeId }]);
      if (parentId) expanded.add(parentId);
      await refreshAround(parentId);
    }, { refreshOutline: false });
  }

  const position = (id) => {
    const key = listOf.get(id);
    const list = lists.get(key);
    return { key, list, index: list ? list.items.findIndex((e) => e.item.id === id) : -1 };
  };

  async function moveUp(id) {
    const { key, list, index } = position(id);
    if (index <= 0) return;
    await move(id, parentOf(key), list.items[index - 1].item.id);
  }

  async function moveDown(id) {
    const next = await siblingAfter(id);
    if (!next) return;
    const { key } = position(id);
    await move(id, parentOf(key), await siblingAfter(next));
  }

  async function indent(id) {
    const { list, index } = position(id);
    if (index <= 0) return ctx.notify('There’s no item above this one to nest it under.', 'info');
    const target = list.items[index - 1].item;
    if (!canContain(target, entries.get(id)?.item)) return ctx.notify(isSecret(target) ? 'A secret note can only contain other secret notes.' : 'Decisions can’t contain other items.', 'error');
    await move(id, target.id, null);
  }

  async function outdent(id) {
    const { key } = position(id);
    if (key === ROOT) return ctx.notify('This item is already at the top level.', 'info');
    const grandKey = listOf.get(key) ?? keyOf(entries.get(key)?.parentId ?? null);
    await move(id, parentOf(grandKey), lists.has(grandKey) ? await siblingAfter(key) : null);
  }

  async function moveTo(id) {
    const choice = await pickItem({
      title: 'Move to…',
      exclude: new Set([id]),
      extras: [{ label: 'Top level', hint: 'Outside any parent', value: ROOT }],
    });
    if (!choice) return;
    if (choice === ROOT) return move(id, null, null);
    const target = await get(`/items/${enc(choice.id)}`).catch((error) => ctx.notify(error.message, 'error'));
    if (!target) return;
    if (!canContain(target, entries.get(id)?.item)) return ctx.notify(isSecret(target) ? 'A secret note can only contain other secret notes.' : 'Decisions can’t contain other items.', 'error');
    await move(id, target.id, null);
  }

  function startRename(id) {
    const entry = entries.get(id);
    if (!entry || !can('write') || entry.item.type === 'decision' || entry.item.archivedAt || isSecret(entry.item)) return;
    renaming = { id, value: entry.item.title || displayTitle(entry.item), caret: null, autofocus: true, saving: false };
    render();
  }

  function endRename(focusId = renaming?.id) {
    renaming = null;
    render();
    if (focusId) focus(focusId);
  }

  const titleUpdate = (entry, title) => (title === entry.item.title ? [] : [{ op: 'update', id: entry.item.id, title, baseTitle: entry.item.title }]);

  /** The note right above `id` that it can merge into, when both are active ordinary notes. */
  function previousNote(id) {
    const { key, list, index } = position(id);
    const previous = list?.items[index - 1];
    return index > 0 && mergeable(entries.get(id)) && mergeable(previous) && previous.parentId === parentOf(key) ? previous : null;
  }

  /** Runs a structural change from the rename field; a failure keeps the typed text there. */
  async function structural(change) {
    if (!renaming || renaming.saving) return;
    renaming.saving = true;
    try {
      await change();
    } catch (error) {
      if (renaming) renaming.saving = false;
      ctx.notify(error.message, 'error');
      render();
    }
  }

  async function renameTo(entry, value, then) {
    const title = value.trim();
    if (title && title !== entry.item.title) await applyEdit(titleUpdate(entry, title));
    await refresh();
    then();
  }

  function renameField(entry) {
    const field = h('input', {
      type: 'text', class: 'rename', value: renaming.value, 'aria-label': 'Title', readOnly: renaming.saving,
      onInput: (e) => { renaming.value = e.target.value; },
      // A re-render swaps in a new field and focuses it, which isn't leaving the rename.
      onBlur: () => setTimeout(() => {
        if (renaming?.id !== entry.item.id || renaming.saving || document.activeElement === tree.querySelector('.rename')) return;
        structural(() => renameTo(entry, renaming.value, () => endRename(null)));
      }, 0),
      onKeydown: (e) => {
        if (e.isComposing) return;
        const { selectionStart: start, selectionEnd: end, value } = e.target;
        const note = mergeable(entry);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          endRename();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const after = value.slice(start);
          if (!note || e.shiftKey || start !== end) return structural(() => renameTo(entry, value, () => endRename()));
          if (!after.trim()) return structural(() => renameTo(entry, value, () => { renaming = null; startCreate(parentOf(listOf.get(entry.item.id)), entry.item.id); }));
          if (!value.slice(0, start).trim()) return structural(() => renameTo(entry, value, () => { renaming = null; startCreate(parentOf(listOf.get(entry.item.id)), null, entry.item.id); }));
          structural(async () => {
            const result = await applyEdit([...titleUpdate(entry, value), { op: 'split', id: entry.item.id, field: 'title', offset: start, baseText: value }]);
            await refresh();
            renaming = null;
            startRename(result.focusId);
            if (renaming) renaming.caret = [0, 0];
            render();
          });
        } else if (e.key === 'Backspace' && start === 0 && end === 0 && note && previousNote(entry.item.id)) {
          e.preventDefault();
          e.stopPropagation();
          const previous = previousNote(entry.item.id);
          structural(async () => {
            const result = await applyEdit([...titleUpdate(entry, value), { op: 'merge', id: entry.item.id, previousId: previous.item.id }]);
            await refresh();
            renaming = null;
            startRename(result.focusId);
            const kept = previous.item.title;
            const caret = kept.length + (kept && value.trim() ? 1 : 0);
            if (renaming) renaming.caret = [caret, caret];
            render();
          });
        }
      },
    });
    return field;
  }

  function focus(id) {
    if (!id || !entries.has(id)) return;
    render();
    tree.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  function renderToolbar() {
    const id = ctx.selectedId();
    const entry = id ? entries.get(id) : null;
    const writable = can('write');
    const movable = entry && writable && entry.item.type !== 'decision';
    const button = (label, action, enabled, shortcut) => h('button', {
      type: 'button', class: 'btn small', disabled: !enabled, onClick: action, title: shortcut ? `${label} (${shortcut})` : label,
    }, label);
    const history = editHistory();
    const mod = isMac ? '⌘' : 'Ctrl+';
    clear(toolbar,
      writable ? button(history.undo ? `Undo ${history.undo.label}` : 'Undo', () => ctx.undo(false), Boolean(history.undo) && !history.busy, `${mod}Z`) : null,
      writable ? button(history.redo ? `Redo ${history.redo.label}` : 'Redo', () => ctx.undo(true), Boolean(history.redo) && !history.busy, isMac ? '⌘⇧Z' : 'Ctrl+Y') : null,
      writable ? button('New note', () => startCreate(null), true) : null,
      writable ? button('Add child', () => startCreate(id), entry && canContain(entry.item)) : null,
      writable ? button('Add below', () => startCreate(parentOf(listOf.get(id)), id), entry) : null,
      writable ? button('Indent', () => indent(id), movable, 'Tab') : null,
      writable ? button('Outdent', () => outdent(id), movable, 'Shift+Tab') : null,
      writable ? button('Up', () => moveUp(id), movable, 'Alt+↑') : null,
      writable ? button('Down', () => moveDown(id), movable, 'Alt+↓') : null,
      writable ? button('Rename', () => startRename(id), movable && !isSecret(entry.item) && !entry.item.archivedAt, 'F2') : null,
      writable ? button('Join with note above', () => mergeFromToolbar(id), Boolean(id && previousNote(id))) : null,
      writable ? button('Move to…', () => moveTo(id), movable) : null,
      button('Refresh', () => refresh(), true));
  }

  function keydown(e) {
    if (e.target.tagName === 'INPUT') return;
    const id = e.target.closest?.('[data-id]')?.dataset.id;
    if (!id) return;
    const i = visible.indexOf(id);
    const focus = (target) => {
      if (!target) return;
      ctx.select(target, { keepFocus: true });
      tree.querySelector(`[data-id="${CSS.escape(target)}"]`)?.focus();
    };
    const entry = entries.get(id);
    const writable = can('write') && entry?.item.type !== 'decision';
    if (e.altKey && e.key === 'ArrowUp' && writable) { e.preventDefault(); moveUp(id); }
    else if (e.altKey && e.key === 'ArrowDown' && writable) { e.preventDefault(); moveDown(id); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focus(visible[i + 1]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focus(visible[i - 1]); }
    else if (e.key === 'ArrowRight' && entry?.childCount > 0 && !expanded.has(id)) { e.preventDefault(); toggle(id, true); }
    else if (e.key === 'ArrowLeft' && expanded.has(id)) { e.preventDefault(); toggle(id, false); }
    else if (e.key === 'ArrowLeft' && listOf.get(id) !== ROOT) { e.preventDefault(); focus(listOf.get(id)); }
    else if (e.key === 'Tab' && writable) { e.preventDefault(); e.shiftKey ? outdent(id) : indent(id); }
    else if (e.key === 'Enter') { e.preventDefault(); ctx.select(id, { edit: true }); }
    else if (e.key === 'F2') { e.preventDefault(); startRename(id); }
  }

  async function mergeFromToolbar(id) {
    const entry = entries.get(id);
    const previous = previousNote(id);
    if (!entry || !previous) return;
    await ctx.run(async () => {
      const result = await applyEdit([{ op: 'merge', id, previousId: previous.item.id }]);
      await refresh();
      focus(result.focusId);
    }, { refreshOutline: false });
  }

  onEditHistory(renderToolbar);
  load(ROOT);
  return { el, refresh, busy, render, focus };
}
