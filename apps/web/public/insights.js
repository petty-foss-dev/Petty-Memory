import { can, enc, get, post } from './api.js';
import { clear, empty, errorBox, field, h, loading } from './dom.js';
import { displayTitle } from './text.js';

const GROUPS = [
  ['mentions', 'Unlinked mentions', 'No other notes mention this one without linking to it.'],
  ['related', 'Related notes', 'Nothing else looks closely related.'],
  ['duplicates', 'Possible duplicates', 'No likely duplicates.'],
];

/** Search snippets mark matches as [term]; shown as <mark> text nodes, never parsed as HTML. */
function snippet(text) {
  const out = h('p', { class: 'hint' });
  let last = 0;
  for (const match of text.matchAll(/\[([^[\]]+)\]/g)) {
    out.append(text.slice(last, match.index), h('mark', null, match[1]));
    last = match.index + match[0].length;
  }
  out.append(text.slice(last));
  return out;
}

/** Connections found without AI. Each one is accepted on its own; duplicates can be merged after a preview. */
export function insightsPanel(state, ctx, { onConnected }) {
  const { item } = state;
  const writable = can('write');
  const results = h('div', { 'aria-live': 'polite' });
  const find = h('button', { type: 'button', class: 'btn small', onClick: () => load() }, 'Find connections');
  const connected = new Set(item.relations.map((relation) => relation.id));

  async function load() {
    state.interacting = true;
    find.disabled = true;
    clear(results, loading('Looking through your library…'));
    try {
      const insights = await get(`/items/${enc(item.id)}/insights`);
      const found = GROUPS.reduce((sum, [group]) => sum + insights[group].length, 0);
      clear(results,
        h('p', { class: 'hint', role: 'status' }, `${found ? `Found ${found} suggestion${found === 1 ? '' : 's'}` : 'Found no suggestions'}${insights.scanned < insights.total
          ? ` after checking ${insights.scanned.toLocaleString()} of ${insights.total.toLocaleString()} items.`
          : ` after checking all ${insights.total.toLocaleString()} items.`}`),
        GROUPS.map(([group, title, none]) => [
          h('h3', null, title),
          insights[group].length ? h('ul', { class: 'plain insight-list' }, insights[group].map((suggestion) => suggestionRow(group, suggestion))) : empty(none),
        ]));
      find.textContent = 'Check again';
    } catch (error) {
      clear(results, errorBox(error, load));
    } finally {
      find.disabled = false;
    }
  }

  function suggestionRow(group, suggestion) {
    const title = suggestion.title || 'Untitled';
    const actions = h('div', { class: 'actions' });
    const connect = h('button', { type: 'button', class: 'btn small', onClick: async () => {
      connect.disabled = true;
      try {
        await post(`/items/${enc(item.id)}/relations`, { toId: suggestion.id, kind: 'related_to' });
        connected.add(suggestion.id);
        connect.replaceWith(h('span', { class: 'badge' }, 'Connected'));
        ctx.notify(`Connected to “${title}”`, 'ok');
        onConnected();
      } catch (error) {
        connect.disabled = false;
        ctx.notify(error.message, 'error');
      }
    } }, 'Connect');
    const mergeBox = h('div');
    if (writable) {
      actions.append(connected.has(suggestion.id) ? h('span', { class: 'badge' }, 'Connected') : connect);
      if (group === 'duplicates' && item.type === 'note' && !item.archivedAt) {
        actions.append(h('button', { type: 'button', class: 'btn small', onClick: () => mergeForm(mergeBox, suggestion) }, 'Merge…'));
      }
    }
    return h('li', null,
      h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(suggestion.id) }, title),
      suggestion.snippet ? snippet(suggestion.snippet) : null,
      h('p', { class: 'hint' }, suggestion.reason),
      actions, mergeBox);
  }

  /** Previews the merge, needs explicit consent, then offers the journal's undo and redo. */
  function mergeForm(box, other) {
    state.interacting = true;
    const otherTitle = other.title || 'Untitled';
    const keep = h('select', { 'aria-label': 'Which note to keep' },
      h('option', { value: 'this' }, `Keep this note; merge “${otherTitle}” into it`),
      h('option', { value: 'other' }, `Keep “${otherTitle}”; merge this note into it`));
    const preview = h('div', { 'aria-live': 'polite' });
    const consent = h('input', { type: 'checkbox' });
    const merge = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Merge');
    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => { generation++; clear(box); } }, 'Cancel');
    let proposal = null;
    let generation = 0;

    async function prepare() {
      const run = ++generation;
      proposal = null;
      consent.checked = false;
      merge.disabled = true;
      clear(preview, loading('Preparing a preview…'));
      const [sourceId, targetId] = keep.value === 'this' ? [other.id, item.id] : [item.id, other.id];
      try {
        const next = await post('/insights/merge/preview', { sourceId, targetId });
        if (run !== generation) return;
        proposal = next;
        clear(preview,
          h('p', null, `“${proposal.sourceTitle}” goes into “${proposal.targetTitle}”, which will read:`),
          h('strong', null, proposal.preview.title),
          h('div', { class: 'pre merge-preview', tabIndex: 0, 'aria-label': 'Merged text preview' }, proposal.preview.body),
          h('label', { class: 'check' }, consent,
            `Archive “${proposal.sourceTitle}” after merging. Its files stay on the archived original, and you can unarchive it or undo the merge later.`));
      } catch (error) {
        if (run === generation) clear(preview, errorBox(error, prepare));
      }
    }

    consent.addEventListener('change', () => { merge.disabled = !proposal || !consent.checked; });
    keep.addEventListener('change', prepare);
    merge.addEventListener('click', async () => {
      if (!proposal || !consent.checked) return;
      merge.disabled = true;
      keep.disabled = cancel.disabled = consent.disabled = true;
      const applied = proposal;
      try {
        const result = await post('/insights/merge', { proposal: applied });
        ctx.changed({ detail: false });
        showMerged(box, applied, result.actionId);
      } catch (error) {
        merge.disabled = false;
        keep.disabled = cancel.disabled = consent.disabled = false;
        preview.append(errorBox(error, prepare));
      }
    });
    clear(box, h('div', { class: 'merge-form' },
      h('h4', null, 'Merge notes'),
      field('Keep', keep),
      preview,
      h('div', { class: 'actions' }, merge, cancel)));
    prepare();
  }

  function showMerged(box, proposal, actionId) {
    let undone = false;
    const message = h('p', { class: 'ok', role: 'status' });
    const toggle = h('button', { type: 'button', class: 'btn' });
    const open = h('button', { type: 'button', class: 'btn', onClick: () => ctx.select(proposal.targetId) }, `Open “${proposal.targetTitle}”`);
    const label = () => {
      message.textContent = undone
        ? `Undone. “${proposal.sourceTitle}” and “${proposal.targetTitle}” are separate again.`
        : `Merged “${proposal.sourceTitle}” into “${proposal.targetTitle}”. The original is archived with its files.`;
      toggle.textContent = undone ? 'Redo merge' : 'Undo merge';
      open.hidden = undone;
    };
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await post(`/editor/actions/${enc(actionId)}/${undone ? 'redo' : 'undo'}`);
        undone = !undone;
        label();
        ctx.changed({ detail: false });
      } catch (error) {
        box.append(errorBox(error));
      } finally {
        toggle.disabled = false;
      }
    });
    label();
    clear(box, message, h('div', { class: 'actions' }, toggle, open));
  }

  return h('section', { class: 'panel insights' },
    h('h2', null, 'Suggested connections'),
    h('div', { class: 'actions' }, find),
    results);
}

/** Reads text out of one image attachment on request; it becomes a note only after review, and the image stays. */
export function imageTextPanel(state, ctx) {
  const { item } = state;
  const images = item.attachments.filter((attachment) => attachment.mimeType.startsWith('image/'));
  const label = displayTitle(item).replace(/[\]\n\r]+/g, ' ');
  const out = h('div', { 'aria-live': 'polite' });
  const buttons = [];
  let working = false;

  async function extract(attachment, button) {
    if (working) return;
    working = true;
    state.interacting = true;
    buttons.forEach((entry) => { entry.disabled = true; });
    clear(out, loading(`Reading text from ${attachment.filename}…`));
    try {
      const { text, engine } = await post('/capture/ocr', { attachmentId: attachment.id });
      if (!text.trim()) return clear(out, empty(`No text was found in ${attachment.filename}.`));
      draft(text.trim(), engine);
    } catch (error) {
      clear(out, errorBox(error, () => extract(attachment, button)));
    } finally {
      working = false;
      buttons.forEach((entry) => { entry.disabled = false; });
    }
  }

  function draft(text, engine) {
    let saving = false;
    const title = h('input', { type: 'text', value: `Text from ${label}` });
    const body = h('textarea', { rows: 8, value: text });
    const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save as note');
    body.addEventListener('input', () => { save.disabled = saving || !body.value.trim(); });
    const discard = h('button', { type: 'button', class: 'btn', onClick: () => clear(out) }, 'Discard');
    clear(out, h('form', { class: 'stack', onSubmit: async (event) => {
      event.preventDefault();
      if (saving || !body.value.trim()) return;
      saving = true;
      save.disabled = title.disabled = body.disabled = discard.disabled = true;
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const note = await post('/items', {
          type: 'note', title: title.value.trim() || undefined, body: `${body.value.trim()}\n\nFrom [[item:${item.id}|${label}]]`, project: item.project?.id,
        });
        clear(out, h('p', { class: 'ok', role: 'status' }, 'Saved as a note. The image is unchanged. ',
          h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(note.id) }, 'Open the note')));
        ctx.changed({ detail: false });
      } catch (error) {
        save.disabled = title.disabled = body.disabled = discard.disabled = false;
        out.append(errorBox(error));
      } finally {
        saving = false;
        buttons.forEach((button) => { button.disabled = false; });
      }
    } },
    h('p', { class: 'hint' }, `Read with ${engine}. Correct anything it misread before saving.`),
    field('Note title', title),
    field('Text', body),
    h('div', { class: 'actions' }, save, discard)));
    body.focus();
  }

  return h('section', { class: 'panel' },
    h('h2', null, images.length === 1 ? 'Text in the image' : 'Text in images'),
    h('ul', { class: 'plain' }, images.map((attachment) => {
      const button = h('button', { type: 'button', class: 'btn small', onClick: () => extract(attachment, button) }, 'Extract text');
      buttons.push(button);
      return h('li', { class: 'actions' }, h('span', null, attachment.filename), button);
    })),
    out);
}
