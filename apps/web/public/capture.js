import { can, get, post } from './api.js';
import { clear, empty, errorBox, field, h, loading } from './dom.js';
import { providedSourceLink } from './text.js';
import { NOTE_DICTATION_NOTE, appendDictation, createDictation, platformOf, speechRecognizer, systemDictationHelp } from './voice.js';

/** Mirrors the desktop's MAX_HIGHLIGHT_FILE_BYTES. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SHOWN = 100;
const EXTENSIONS = /\.(json|md|markdown)$/i;
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A note written or dictated here, and book highlights from an Enve export. Nothing is saved or imported without a button press. */
export function createCaptureView(ctx) {
  const writable = can('write');
  const projectSelects = [];
  const projectSelect = (label) => {
    const select = h('select', { 'aria-label': label }, h('option', { value: '' }, 'Inbox'));
    projectSelects.push(select);
    return select;
  };

  // Note
  const Recognition = speechRecognizer(window);
  let voice = { status: 'idle' };
  let dictation = null;
  let noteSaving = false;
  const title = h('input', { type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Note title' });
  const text = h('textarea', { rows: 6, 'aria-label': 'Note text', placeholder: 'Write or dictate a note' });
  const noteProject = projectSelect('Save the note to');
  const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save note');
  const dictate = h('button', { type: 'button', class: 'btn', onClick: () => startDictation() }, 'Dictate');
  const stop = h('button', { type: 'button', class: 'btn recording', onClick: () => dictation?.stop() }, 'Stop');
  const listening = h('span', { class: 'recording-status', role: 'status', hidden: true });
  const voiceError = h('p', { class: 'error', role: 'alert', hidden: true });
  const systemHelp = h('p', { class: 'hint', hidden: true });
  const privacy = h('p', { class: 'hint', hidden: true }, NOTE_DICTATION_NOTE);
  const noteStatus = h('div', { 'aria-live': 'polite' });

  const show = (node, value) => {
    node.textContent = value ?? '';
    node.hidden = !value;
  };
  const recording = () => voice.status === 'starting' || voice.status === 'listening';

  function renderNote() {
    dictate.hidden = recording();
    stop.hidden = !recording();
    show(listening, voice.status === 'starting' ? 'Starting dictation…' : voice.status === 'listening'
      ? (voice.interim ? `${voice.interim}…` : 'Listening. Press Stop, then Save when it reads right.') : '');
    save.disabled = noteSaving || recording() || !text.value.trim();
    title.disabled = text.disabled = noteProject.disabled = dictate.disabled = noteSaving;
  }

  function setVoice(state) {
    voice = state;
    show(voiceError, state.status === 'failed' ? state.message : '');
    if (state.status === 'failed' && state.useSystem) show(systemHelp, systemDictationHelp(platformOf(navigator), 'note'));
    renderNote();
  }

  function startDictation() {
    privacy.hidden = false;
    show(voiceError, '');
    show(systemHelp, '');
    text.focus();
    if (!Recognition) return show(systemHelp, systemDictationHelp(platformOf(navigator), 'note'));
    dictation ??= createDictation(Recognition, {
      lang: navigator.language,
      onText: (heard) => {
        text.value = appendDictation(text.value, heard);
        renderNote();
      },
      onState: setVoice,
    });
    dictation.start();
  }

  function stopDictation() {
    dictation?.cancel();
    if (voice.status !== 'failed') setVoice({ status: 'idle' });
  }

  text.addEventListener('input', renderNote);
  const noteForm = h('form', { class: 'panel stack', 'aria-labelledby': 'capture-note-heading', onSubmit: async (event) => {
    event.preventDefault();
    if (noteSaving || recording() || !text.value.trim()) return;
    noteSaving = true;
    renderNote();
    try {
      const note = await post('/items', { type: 'note', title: title.value.trim() || undefined, body: text.value.trim(), project: noteProject.value || undefined });
      title.value = '';
      text.value = '';
      clear(noteStatus, h('p', { class: 'ok', role: 'status' }, 'Note saved. ', h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(note.id) }, 'Open it')));
      ctx.changed({ detail: false });
    } catch (error) {
      clear(noteStatus, errorBox(error));
    } finally {
      noteSaving = false;
      renderNote();
    }
  } },
  h('h2', { id: 'capture-note-heading' }, 'New note'),
  title, text,
  h('div', { class: 'actions' }, field('Save to', noteProject), dictate, stop, listening, save),
  voiceError, systemHelp, privacy, noteStatus);

  // Enve highlights
  const file = h('input', { type: 'file', accept: '.json,.md,.markdown,application/json,text/markdown', 'aria-label': 'Enve highlights export' });
  const importProject = projectSelect('Put imported highlights in');
  const importBox = h('div', { 'aria-live': 'polite' });

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    if (!EXTENSIONS.test(chosen.name)) return clear(importBox, errorBox(new Error('Choose the .json or .md file that Enve exported.')));
    if (chosen.size > MAX_FILE_BYTES) {
      return clear(importBox, errorBox(new Error(`That file is ${megabytes(chosen.size)}; exports can be at most 2 MB. Export fewer books at a time.`)));
    }
    clear(importBox, loading('Reading the export…'));
    file.disabled = true;
    try {
      const data = await chosen.text();
      showPreview(chosen.name, data, await post('/imports/enve-highlights/preview', { data }));
    } catch (error) {
      clear(importBox, errorBox(error));
    } finally {
      file.disabled = false;
    }
  });

  function showPreview(name, data, preview) {
    const { entries } = preview;
    const books = new Set(entries.map((entry) => `${entry.bookTitle}\u0000${entry.author}`)).size;
    const run = h('button', { type: 'button', class: 'btn primary', disabled: entries.length === 0 }, `Import ${entries.length} highlight${entries.length === 1 ? '' : 's'}`);
    const cancel = h('button', { type: 'button', class: 'btn', onClick: () => clear(importBox) }, 'Cancel');
    run.addEventListener('click', async () => {
      run.disabled = cancel.disabled = true;
      file.disabled = importProject.disabled = true;
      run.textContent = 'Importing…';
      try {
        const result = await post('/imports/enve-highlights', { data, ...(importProject.value ? { project: importProject.value } : {}) });
        clear(importBox,
          h('p', { class: 'ok', role: 'status' }, `${name}: imported ${result.created}, skipped ${result.skipped} already saved${result.failed.length ? `, ${result.failed.length} failed` : ''}.`),
          result.failed.length ? h('ul', { class: 'plain' }, result.failed.slice(0, 20).map((f) => h('li', null, h('code', null, f.source), ' ', h('span', { class: 'error' }, f.error)))) : null);
        ctx.changed();
      } catch (error) {
        run.disabled = cancel.disabled = false;
        run.textContent = `Import ${entries.length} highlight${entries.length === 1 ? '' : 's'}`;
        importBox.append(errorBox(error));
      } finally {
        file.disabled = importProject.disabled = false;
      }
    });
    clear(importBox,
      h('p', null, h('strong', null, name), ` (${preview.format}): ${entries.length} highlight${entries.length === 1 ? '' : 's'} from ${books} book${books === 1 ? '' : 's'}`,
        preview.skipped ? `, ${preview.skipped} entr${preview.skipped === 1 ? 'y' : 'ies'} that can’t be imported` : '', '.'),
      entries.length ? h('ul', { class: 'plain highlight-list' }, entries.slice(0, SHOWN).map((entry) => {
        const link = providedSourceLink(entry.sourceUrl);
        return h('li', null,
          h('blockquote', null, entry.text),
          entry.note ? h('p', null, entry.note) : null,
          h('p', { class: 'hint' }, [entry.bookTitle, entry.author, entry.location].filter(Boolean).join(' · '),
            link ? [' · ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open source')] : null));
      })) : empty('Nothing in this file can be imported.'),
      entries.length > SHOWN ? h('p', { class: 'hint' }, `And ${entries.length - SHOWN} more.`) : null,
      h('div', { class: 'actions' }, run, cancel));
  }

  const importPanel = h('section', { class: 'panel stack', 'aria-labelledby': 'capture-import-heading' },
    h('h2', { id: 'capture-import-heading' }, 'Enve book highlights'),
    h('p', { class: 'hint' }, 'The highlights and notes file that Enve exports (.json or .md). Each passage keeps its book, location and a link back when Enve provides one. Passages already imported are skipped.'),
    h('div', { class: 'actions' }, field('Export file', file), field('Put them in', importProject)),
    importBox);

  const el = h('section', { class: 'view capture-view', 'aria-labelledby': 'capture-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'capture-heading' }, 'Capture & import')),
    writable ? [noteForm, importPanel] : empty('Adding notes and importing need a token with the write scope.'));

  const onHidden = () => {
    if (document.hidden) stopDictation();
  };
  document.addEventListener('visibilitychange', onHidden);
  renderNote();

  async function refresh() {
    try {
      const projects = await get('/projects');
      for (const select of projectSelects) {
        const chosen = select.value;
        clear(select, h('option', { value: '' }, 'Inbox'), projects.map((p) => h('option', { value: p.id, selected: p.id === chosen }, p.name)));
      }
    } catch (error) {
      ctx.notify(`Couldn’t load projects: ${error.message}`, 'error');
    }
  }

  return {
    el,
    // Polling leaves the forms alone while someone is typing or choosing.
    refresh: ({ poll } = {}) => (poll && el.contains(document.activeElement) ? undefined : refresh()),
    leave: stopDictation,
    dispose() {
      dictation?.cancel();
      document.removeEventListener('visibilitychange', onHidden);
    },
  };
}
