import { can, enc, get, post, query } from './api.js';
import { referenceLink } from './detail.js';
import { clear, empty, errorBox, field, h, loading, when } from './dom.js';
import { plural, projectOptions, setStatus } from './knowledge.js';
import { formatTime } from './knowledge-research.js';
import { renderText } from './text.js';

/** Mirrors BISCOTTI_MAX_BYTES in @enve-memory/importers. */
const MAX_BYTES = 8 * 1024 * 1024;
const PAGE = 50;
const SOURCES = { csv: 'From CSV', mcp: 'From the desktop connection' };
const WRITE_REASON = 'Needs a read,write token.';

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const titleOf = (meeting) => meeting.title || 'Untitled meeting';
const about = (meeting) => `the meeting “${titleOf(meeting)}”${meeting.date ? ` on ${meeting.date}` : ''}`;

// Drafts name the exact title and source date so retrieval finds the meeting; action drafts are also scoped to its note.
const DRAFTS = [
  ['ask', 'Ask about meeting', (m) => `What was discussed and decided in ${about(m)}?`],
  ['ask', 'Prepare next meeting', (m) => `Help me prepare for the next meeting after ${about(m)}: what was left open, what was promised, and what should I bring up? Use only what my notes say.`],
  ['actions', 'Find follow-ups', (m) => `Suggest follow-up tasks for what was agreed in ${about(m)}. Only name people and due dates that the notes state; otherwise leave them out.`],
  ['actions', 'Write a brief', (m) => `Write a short brief of ${about(m)} as a note: purpose, decisions, open questions and follow-ups. Don’t add people, dates or quotes that aren’t in the notes.`],
];

// A bare day is a calendar date, not UTC midnight, so it must not shift with the time zone.
function meetingDate(value) {
  if (!value) return 'No date';
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).toLocaleDateString(undefined, { dateStyle: 'medium' }) : when(value);
}

function speakerChips(speakers) {
  return speakers.length
    ? h('ul', { class: 'meetings-speakers', 'aria-label': 'Speakers' }, speakers.map((speaker) => h('li', { class: 'meetings-speaker' }, speaker)))
    : null;
}

export function createMeetingsSection(ctx) {
  const writable = can('write');
  const reference = (id, label) => referenceLink(id, label, ctx.select);
  let alive = true;
  let projects = [];
  let fileSeq = 0;
  let staged = null;
  let importing = false;
  let meetings = [];
  let next = null;
  let listSeq = 0;
  let loadingMore = false;

  const file = h('input', { type: 'file', accept: '.csv,text/csv', disabled: !writable });
  const importProject = h('select', { disabled: !writable }, projectOptions([], '', 'Inbox'));
  const importBox = h('div', { 'aria-live': 'polite' });
  const listProject = h('select', null, projectOptions([], '', 'All projects'));
  const filter = h('input', { type: 'search', maxlength: 200, placeholder: 'Title, summary or speaker', autocomplete: 'off' });
  const listCount = h('p', { class: 'hint', role: 'status', hidden: true });
  const projectNote = h('p', { class: 'error', role: 'alert', hidden: true });
  const listBox = h('div');

  function meetingContent(entry) {
    return [
      h('h4', null, 'Summary'),
      entry.summary.trim() ? renderText(entry.summary, reference) : empty('No summary in the export.'),
      h('h4', null, 'Notes'),
      entry.notes.trim() ? renderText(entry.notes, reference) : empty('No notes in the export.'),
      h('h4', null, entry.turns.length ? `Speaker text (${plural(entry.turns.length, 'turn')})` : 'Transcript'),
      entry.turns.length
        ? h('ol', { class: 'meetings-turns', tabIndex: 0, 'aria-label': `Speaker text of ${titleOf(entry)}` }, entry.turns.map((turn) => h('li', null,
          h('span', { class: 'timestamp' }, Number.isFinite(turn.start) ? formatTime(turn.start) : '–'),
          h('span', { class: 'meetings-turn-speaker' }, turn.speaker || 'Unnamed speaker'),
          h('span', { class: 'meetings-turn-text' }, turn.text))))
        : entry.transcript.trim() ? h('div', { class: 'queue-text meetings-transcript', tabIndex: 0 }, entry.transcript) : empty('No transcript in the export.'),
      entry.turns.length ? h('details', null, h('summary', null, 'Full original transcript'), h('div', { class: 'queue-text meetings-transcript', tabIndex: 0 }, entry.transcript)) : null,
    ];
  }

  // Built on first open: an export can hold hundreds of full transcripts.
  function entryDetails(entry) {
    const body = h('div');
    const details = h('details', { class: 'meetings-detail' }, h('summary', null, 'Summary, notes and speaker text'), body);
    details.addEventListener('toggle', () => {
      if (details.open && !body.childElementCount) body.append(...meetingContent(entry));
    });
    return details;
  }

  function previewEntry(entry, stage) {
    const title = titleOf(entry);
    let head;
    if (entry.existingId) {
      head = h('div', { class: 'actions' },
        h('strong', null, title), h('span', { class: 'badge' }, 'Already imported'),
        h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(entry.existingId) }, 'Open saved note'));
    } else {
      const box = h('input', { type: 'checkbox', value: entry.id, checked: stage.chosen.has(entry.id), onChange: () => {
        if (box.checked) stage.chosen.add(entry.id); else stage.chosen.delete(entry.id);
        stage.sync();
      } });
      stage.boxes.push(box);
      head = h('label', { class: 'check meetings-pick' }, box, h('strong', null, title));
    }
    return h('li', { class: `meetings-entry${entry.existingId ? ' saved' : ''}` },
      head,
      h('p', { class: 'hint' }, [
        meetingDate(entry.date),
        entry.participants.length ? `with ${entry.participants.join(', ')}` : null,
        entry.turns.length ? plural(entry.turns.length, 'speaker turn') : null,
      ].filter(Boolean).join(' · ')),
      speakerChips(entry.speakers),
      entry.tags.length ? h('p', { class: 'hint' }, entry.tags.map((tag) => h('span', { class: 'tag' }, `#${tag} `))) : null,
      entryDetails(entry));
  }

  function syncFile() {
    file.disabled = importing || !writable;
    importProject.disabled = importing || !writable;
  }

  /** The preview, the exact text it was made from and its fingerprint travel together; a new file replaces all three. */
  function showPreview(stage) {
    const { name, preview } = stage;
    const fresh = preview.entries.filter((entry) => !entry.existingId);
    const already = preview.entries.length - fresh.length;
    const count = h('p', { class: 'hint', role: 'status' });
    const importButton = h('button', { type: 'button', class: 'btn primary', onClick: () => runImport(stage) });
    const all = h('button', { type: 'button', class: 'btn small', onClick: () => {
      fresh.forEach((entry) => stage.chosen.add(entry.id));
      stage.sync();
    } }, 'Select all');
    const none = h('button', { type: 'button', class: 'btn small', onClick: () => {
      stage.chosen.clear();
      stage.sync();
    } }, 'Select none');
    const discard = h('button', { type: 'button', class: 'btn', onClick: () => {
      if (importing) return;
      staged = null;
      fileSeq++;
      clear(importBox);
      file.focus();
    } }, 'Discard preview');
    stage.boxes = [];
    stage.outcome = h('div', { 'aria-live': 'polite' });
    stage.sync = () => {
      const n = stage.chosen.size;
      count.textContent = `${n.toLocaleString()} of ${plural(fresh.length, 'new meeting')} selected.`;
      importButton.textContent = importing ? 'Importing…' : n ? `Import ${plural(n, 'meeting')}` : 'Select meetings to import';
      importButton.disabled = importing || !n || !writable;
      all.disabled = importing || n === fresh.length;
      none.disabled = importing || !n;
      discard.disabled = importing;
      stage.boxes.forEach((box) => {
        box.checked = stage.chosen.has(box.value);
        box.disabled = importing;
      });
      syncFile();
    };

    const list = h('ul', { class: 'meetings-preview-list', 'aria-label': `Meetings in ${name}` }, preview.entries.map((entry) => previewEntry(entry, stage)));
    clear(importBox, h('section', { class: 'meetings-preview stack', 'aria-label': `Preview of ${name}` },
      h('h4', null, `Preview of ${name}`),
      h('p', null, preview.entries.length
        ? `${plural(preview.entries.length, 'meeting')} found: ${fresh.length.toLocaleString()} new, ${already.toLocaleString()} already in your library.`
        : 'No meetings in this file could be read.',
      preview.skipped ? ` ${plural(preview.skipped, 'row')} couldn’t be read as a meeting and will be left out.` : ''),
      preview.warnings.length ? h('details', { class: 'meetings-warnings', open: preview.warnings.length <= 5 },
        h('summary', null, plural(preview.warnings.length, 'warning')),
        h('ul', { class: 'plain' }, preview.warnings.map((warning) => h('li', null, h('span', { class: 'badge' }, `Row ${warning.row}`), warning.message)))) : null,
      fresh.length ? h('div', { class: 'actions' }, all, none, count) : null,
      preview.entries.length ? list : null,
      fresh.length
        ? [
          h('p', { class: 'hint' }, 'Importing copies the selected meetings’ titles, dates, summaries, notes and speaker text into your library as ordinary notes. Like any note they follow your sync and AI settings: they sync to your devices and can be sent to your AI provider when you use AI. Audio stays in Biscotti.'),
          h('div', { class: 'actions' }, field('File into', importProject), importButton, discard),
        ]
        : [
          preview.entries.length ? h('p', { class: 'hint' }, 'Every meeting in this file is already in your library. Nothing to import.') : null,
          h('div', { class: 'actions' }, discard),
        ],
      stage.outcome));
    stage.sync();
  }

  async function previewFile(mine, name, data) {
    clear(importBox, loading(`Reading meetings from ${name}…`));
    try {
      const preview = await post('/imports/biscotti/preview', { data, source: 'csv' });
      if (!alive || mine !== fileSeq) return;
      staged = { name, data, preview, chosen: new Set(preview.entries.filter((entry) => !entry.existingId).map((entry) => entry.id)) };
      showPreview(staged);
    } catch (error) {
      if (alive && mine === fileSeq) clear(importBox, errorBox(error, () => previewFile(mine, name, data)));
    }
  }

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    const mine = ++fileSeq;
    staged = null;
    file.value = '';
    if (!chosen) return clear(importBox);
    if (!/\.csv$/i.test(chosen.name)) return clear(importBox, errorBox(new Error('Choose the .csv file that Biscotti exported.')));
    if (!chosen.size) return clear(importBox, errorBox(new Error(`${chosen.name} is empty. Export the meetings from Biscotti again.`)));
    if (chosen.size > MAX_BYTES) {
      return clear(importBox, errorBox(new Error(`${chosen.name} is ${megabytes(chosen.size)}; a Biscotti export can be at most 8 MB. Export fewer meetings at a time.`)));
    }
    clear(importBox, loading(`Reading ${chosen.name}…`));
    let data;
    try {
      data = new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer());
    } catch {
      if (alive && mine === fileSeq) clear(importBox, errorBox(new Error(`${chosen.name} isn’t UTF-8 text. Export it from Biscotti again as CSV.`)));
      return;
    }
    if (alive && mine === fileSeq) previewFile(mine, chosen.name, data);
  });

  async function runImport(stage) {
    if (importing || stage !== staged || !stage.chosen.size || !writable) return;
    importing = true;
    stage.sync();
    clear(stage.outcome, loading(`Importing ${plural(stage.chosen.size, 'meeting')}…`));
    let result;
    try {
      result = await post('/imports/biscotti', {
        data: stage.data, source: 'csv', fingerprint: stage.preview.fingerprint, includeIds: [...stage.chosen],
        ...(importProject.value ? { project: importProject.value } : {}),
      });
    } catch (error) {
      importing = false;
      if (!alive) return;
      clear(stage.outcome, errorBox(error, () => runImport(stage)));
      stage.sync();
      return;
    }
    importing = false;
    if (!alive) return;
    staged = null;
    syncFile();
    clear(importBox,
      h('p', { class: 'ok', role: 'status' }, `${stage.name}: imported ${plural(result.created, 'meeting')}`,
        result.skipped ? `, skipped ${result.skipped.toLocaleString()} already in your library` : '',
        result.failed.length ? `, ${result.failed.length.toLocaleString()} failed` : '', '.'),
      result.items.length ? h('ul', { class: 'plain', 'aria-label': 'Import results' }, result.items.map((item) => h('li', null,
        h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(item.id) }, item.title || 'Untitled meeting'),
        h('span', { class: 'hint' }, item.created ? 'new note' : 'already saved')))) : null,
      result.failed.length ? h('ul', { class: 'plain', 'aria-label': 'Meetings that failed' }, result.failed.map((failure) => h('li', null,
        h('code', null, failure.source), h('span', { class: 'error' }, failure.error)))) : null,
      h('p', { class: 'hint' }, 'Choose another CSV to import more.'));
    ctx.notify(`Imported ${plural(result.created, 'meeting')} from Biscotti`, result.failed.length ? 'error' : 'ok');
    await ctx.changed({ detail: false });
  }

  function meetingCard(meeting) {
    const title = titleOf(meeting);
    const drafts = DRAFTS.map(([mode, label, text]) => {
      const locked = mode !== 'ask' && !writable;
      return h('button', {
        type: 'button', class: 'btn small', disabled: locked, title: locked ? WRITE_REASON : undefined,
        onClick: () => ctx.startChat({
          mode, text: text(meeting),
          ...(mode === 'ask' ? { project: meeting.project?.id ?? '', projectName: meeting.project?.name } : { root: { id: meeting.id, title } }),
        }),
      }, label);
    });
    const review = h('button', {
      type: 'button', class: 'btn small', disabled: !writable, title: writable ? undefined : WRITE_REASON,
      onClick: async () => {
        review.disabled = true;
        const due = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString();
        const done = await ctx.run(() => post(`/review/${enc(meeting.id)}`, { days: 7 }), { success: `“${title}” comes back for review on ${due}`, refreshOutline: false });
        if (done) review.textContent = `Review on ${due}`;
        else review.disabled = false;
      },
    }, 'Review in a week');
    return h('li', { class: 'card meetings-card' },
      h('div', { class: 'view-head' },
        h('h3', null, h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(meeting.id) }, title)),
        h('span', { class: 'badge' }, SOURCES[meeting.source] ?? meeting.source)),
      h('p', { class: 'hint' }, `${meetingDate(meeting.date)} · ${meeting.project?.name ?? 'Inbox'}`),
      meeting.summary.trim() ? h('div', { class: 'meetings-summary' }, renderText(meeting.summary, reference)) : empty('No summary.'),
      speakerChips(meeting.speakers),
      h('div', { class: 'actions', role: 'group', 'aria-label': `AI chat about ${title}` }, drafts),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(meeting.id) }, 'Open note'),
        review));
  }

  function renderList() {
    const needle = filter.value.trim().toLocaleLowerCase();
    const shown = needle
      ? meetings.filter((meeting) => [meeting.title, meeting.summary, ...meeting.speakers].some((text) => text?.toLocaleLowerCase().includes(needle)))
      : meetings;
    setStatus(listCount, !meetings.length ? ''
      : needle ? `${shown.length.toLocaleString()} of ${plural(meetings.length, 'loaded meeting')} match.`
        : `${plural(meetings.length, 'meeting')} loaded${next ? '; older ones can be loaded below' : ''}.`);
    clear(listBox,
      shown.length ? h('ul', { class: 'cards meetings-list', 'aria-label': 'Imported meetings' }, shown.map(meetingCard))
        : empty(meetings.length ? `No loaded meeting mentions “${filter.value.trim()}”.${next ? ' Load more to include older ones.' : ''}`
          : listProject.value ? 'No imported meetings in this project.'
            : writable ? 'No imported meetings yet. Import a Biscotti CSV above.' : 'No imported meetings yet.'),
      next ? h('button', { type: 'button', class: 'btn small', onClick: loadMore }, 'Load more') : null);
  }

  /** Reloads newest first, following the cursor until as many meetings as were shown are back. */
  async function loadList(want = PAGE) {
    const mine = ++listSeq;
    if (!meetings.length) clear(listBox, loading('Loading imported meetings…'));
    try {
      const items = [];
      let cursor = null;
      do {
        const page = await get(`/meetings/biscotti${query({ project: listProject.value, before: cursor, limit: PAGE })}`);
        if (!alive || mine !== listSeq) return;
        items.push(...page.items);
        cursor = page.next;
      } while (cursor && items.length < want);
      meetings = items;
      next = cursor;
      renderList();
    } catch (error) {
      if (alive && mine === listSeq) clear(listBox, errorBox(error, () => loadList(want)));
    }
  }

  async function loadMore(event) {
    const button = event.currentTarget;
    if (!next || loadingMore) return;
    const mine = listSeq;
    loadingMore = true;
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      const page = await get(`/meetings/biscotti${query({ project: listProject.value, before: next, limit: PAGE })}`);
      if (!alive || mine !== listSeq) return;
      meetings = meetings.concat(page.items);
      next = page.next;
      renderList();
    } catch (error) {
      if (!alive || mine !== listSeq) return;
      button.disabled = false;
      button.textContent = 'Load more';
      ctx.notify(`Couldn’t load more meetings: ${error.message}`, 'error');
    } finally {
      loadingMore = false;
    }
  }

  async function refreshProjects() {
    try {
      projects = await get('/projects');
    } catch (error) {
      if (alive) setStatus(projectNote, `Couldn’t load projects: ${error.message}`, 'error');
      return;
    }
    if (!alive) return;
    setStatus(projectNote, '');
    for (const [select, anyLabel] of [[importProject, 'Inbox'], [listProject, 'All projects']]) {
      if (document.activeElement !== select) clear(select, projectOptions(projects, select.value, anyLabel));
    }
  }

  listProject.addEventListener('change', () => {
    meetings = [];
    next = null;
    loadList();
  });
  filter.addEventListener('input', renderList);

  const el = h('section', { class: 'knowledge-section meetings', 'aria-labelledby': 'meetings-heading' },
    h('div', { class: 'view-head' }, h('h2', { id: 'meetings-heading' }, 'Meetings')),
    h('p', { class: 'hint' }, 'Meetings from Biscotti, kept as ordinary notes you can open, search and edit on every device.'),
    projectNote,
    h('section', { class: 'panel stack meetings-import', 'aria-labelledby': 'meetings-import-heading' },
      h('h3', { id: 'meetings-import-heading' }, 'Import from Biscotti'),
      h('p', { class: 'hint' }, 'In Biscotti, export your meetings as CSV, then choose the file here to preview them. Nothing is saved until you choose meetings and press Import. The desktop app on a Mac can also connect to Biscotti directly; this browser only reads files you choose.'),
      writable ? null : h('p', { class: 'hint' }, 'Previewing and importing need a read,write token. You can still open, search and ask about imported meetings.'),
      field('Biscotti CSV export', file, 'Up to 8 MB, UTF-8.'),
      importBox),
    h('section', { class: 'panel stack', 'aria-labelledby': 'meetings-list-heading' },
      h('h3', { id: 'meetings-list-heading' }, 'Imported meetings'),
      h('p', { class: 'hint' }, writable
        ? 'The AI buttons open AI chat with a draft you can edit. Nothing is sent until you press Send, and suggested tasks, reminders or briefs change nothing until you review and apply them.'
        : 'Ask about meeting and Prepare next meeting open AI chat with a draft you can edit. Follow-ups, briefs and review scheduling need a read,write token.'),
      h('div', { class: 'filters' }, field('Project', listProject), field('Filter loaded meetings', filter)),
      listCount,
      listBox));

  return {
    el,
    // A poll leaves the preview and its ticks alone, and skips the list while someone is using it.
    async refresh({ poll } = {}) {
      const busy = poll && (loadingMore || listBox.contains(document.activeElement));
      await Promise.all([refreshProjects(), busy ? null : loadList(Math.max(PAGE, meetings.length))]);
    },
    destroy() {
      alive = false;
      fileSeq++;
      listSeq++;
      staged = null;
    },
  };
}
