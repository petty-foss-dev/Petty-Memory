import { can, enc, get, post, researchFile, uploadResearchFile } from './api.js';
import { showActions } from './chat.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { kget, kpost, plural, setStatus } from './knowledge.js';
import { canvasPng, createAudioRecorder, openResearchPdf } from './research-media.js';
import { displayTitle } from './text.js';

const ACCEPT = '.pdf,.mp3,.m4a,.wav,.ogg,.oga,.flac,.webm';
const CAPTION_ACCEPT = '.vtt,.srt,.json';
/** Captions travel inside a JSON request, which the server caps at 2 MB. */
const CAPTION_BYTES = 1_900_000;
const PASSAGE_SEGMENTS = 50;
const NOTE_MAX = 20_000;
const QUOTE_MAX = 5000;
const OCR_PNG_BYTES = 20 * 1024 * 1024;
const PREVIEW_SEGMENTS = 30;
const TASK_PROMPT = 'Suggest tasks with due dates for what still needs doing from this transcript, and write a short brief of what was discussed.';

const ANNOTATION_STATUS = {
  current: ['Current', 'The quote is where it was saved.'],
  moved: ['Moved', 'The quote is still on this page, at a different position.'],
  stale: ['Not found', 'The quote is no longer in this page’s text.'],
  'source-missing': ['Source missing', 'The PDF was archived or removed.'],
  'source-changed': ['File replaced', 'The PDF’s file changed since this was saved.'],
};

/** `m:ss`, or `h:mm:ss` from an hour, matching saved transcripts. */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

const kindOf = (item) => (item.attachments ?? []).some((a) => a.mimeType === 'application/pdf') ? 'pdf'
  : (item.attachments ?? []).some((a) => a.mimeType.startsWith('audio/')) ? 'audio' : null;

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function occurrences(text, needle) {
  const found = [];
  if (!needle) return found;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** Page text as text nodes, with an optional highlighted span. */
function textBlock(text, label, highlight) {
  const block = h('div', { class: 'pdf-text', tabIndex: 0, 'aria-label': label });
  if (highlight && highlight.start < highlight.end && highlight.end <= text.length) {
    block.append(text.slice(0, highlight.start), h('mark', null, text.slice(highlight.start, highlight.end)), text.slice(highlight.end));
  } else block.append(text);
  return block;
}

export function createResearchSection(ctx) {
  const writable = can('write');
  let alive = true;
  let suspended = false;
  let sources = [];
  let next = null;
  let pages = 0;
  let listSeq = 0;
  let workspace = null;
  let recorder = null;
  let recording = false;
  let draft = null;
  let uploading = null;

  const listBox = h('div');
  const moreBox = h('div');
  const workBox = h('div');
  const importStatus = h('p', { class: 'hint', role: 'status', hidden: true });
  const fileInput = h('input', { type: 'file', accept: ACCEPT, 'aria-label': 'PDF or audio file' });
  const importButton = h('button', { type: 'button', class: 'btn small primary', disabled: true }, 'Import');
  const recordButton = h('button', { type: 'button', class: 'btn small' }, 'Record');
  const stopButton = h('button', { type: 'button', class: 'btn small recording', hidden: true }, 'Stop');
  const recordState = h('span', { class: 'recording-status', role: 'status', hidden: true }, 'Recording. Press Stop when you’re done.');
  const draftBox = h('div', { 'aria-live': 'polite' });

  async function refreshList(more = false) {
    const mine = ++listSeq;
    if (!listBox.childElementCount) listBox.append(loading());
    try {
      const page = await kget(`/research/sources${more && next ? `?before=${enc(next)}` : ''}`);
      if (mine !== listSeq || !alive) return;
      sources = more ? sources.concat(page.items) : page.items;
      pages = more ? pages + 1 : 1;
      next = page.next;
      clear(listBox, sources.length
        ? h('ul', { class: 'plain research-sources' }, sources.map((item) => {
          const kind = kindOf(item);
          const file = item.attachments.find((a) => a.mimeType === 'application/pdf' || a.mimeType.startsWith('audio/'));
          return h('li', { class: workspace?.id === item.id ? 'active' : undefined },
            h('span', { class: 'badge' }, kind === 'pdf' ? 'PDF' : 'Audio'),
            h('button', { type: 'button', class: 'link-btn', onClick: () => openSource(item.id, kind) }, displayTitle(item)),
            h('span', { class: 'hint' }, [file?.filename, file ? megabytes(file.size) : null, `updated ${when(item.updatedAt)}`].filter(Boolean).join(' · ')),
            h('button', { type: 'button', class: 'btn small', 'aria-label': `Open the item for ${displayTitle(item)}`, onClick: () => ctx.select(item.id) }, 'Item'));
        }))
        : empty(writable ? 'No PDFs or recordings yet. Import one, or record audio.' : 'No PDFs or recordings yet.'));
      clear(moreBox, next ? h('button', { type: 'button', class: 'btn small', onClick: () => refreshList(true) }, 'Show older files') : null);
    } catch (error) {
      if (mine === listSeq && alive) clear(listBox, errorBox(error, () => refreshList()));
    }
  }

  function openSource(id, kind, target = {}) {
    if (!kind) return ctx.notify('That item is not a PDF or an audio recording.', 'error');
    if (workspace?.id === id && workspace.kind === kind) {
      workspace.reveal(target);
      return;
    }
    workspace?.close();
    workspace = kind === 'pdf' ? pdfWorkspace(id, target) : audioWorkspace(id, target);
    clear(workBox, workspace.el);
    listBox.querySelectorAll('li').forEach((li, index) => li.classList.toggle('active', sources[index]?.id === id));
    workBox.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  function closeWorkspace() {
    workspace?.close();
    workspace = null;
    clear(workBox);
    listBox.querySelectorAll('li.active').forEach((li) => li.classList.remove('active'));
  }

  async function importFile(file, { fromRecording = false } = {}) {
    uploading?.abort();
    const controller = new AbortController();
    uploading = controller;
    importButton.disabled = fileInput.disabled = true;
    renderDraft();
    setStatus(importStatus, `Saving ${file.name}…`);
    try {
      const { item, created } = await uploadResearchFile(file, { signal: controller.signal });
      if (!alive) return;
      setStatus(importStatus, created ? `Saved “${displayTitle(item)}”. The original file is kept unchanged.` : `“${displayTitle(item)}” is already in your library.`, 'ok');
      if (fromRecording) discardDraft();
      else fileInput.value = '';
      ctx.changed({ detail: false });
      await refreshList();
      if (!suspended) openSource(item.id, kindOf(item));
    } catch (error) {
      if (alive && error.name !== 'AbortError') setStatus(importStatus, `Not saved: ${error.message}`, 'error');
    } finally {
      if (uploading === controller) uploading = null;
      if (alive) {
        fileInput.disabled = false;
        importButton.disabled = !fileInput.files?.length;
        renderDraft();
      }
    }
  }

  function renderRecorder() {
    recordButton.hidden = recording;
    stopButton.hidden = !recording;
    recordState.hidden = !recording;
  }

  function discardDraft() {
    if (draft) URL.revokeObjectURL(draft.url);
    draft = null;
    renderDraft();
  }

  function setDraft(blob) {
    if (!alive) return;
    if (draft) URL.revokeObjectURL(draft.url);
    const type = blob.type || 'audio/webm';
    const extension = /mp4|m4a|aac/.test(type) ? 'm4a' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    draft = { blob, url: URL.createObjectURL(blob), file: new File([blob], `Recording ${stamp}.${extension}`, { type }) };
    renderDraft();
  }

  // The recording stays in this tab until Save recording; stopping never uploads it.
  function renderDraft() {
    if (!draft) return clear(draftBox);
    const player = h('audio', { controls: true, preload: 'metadata', src: draft.url, 'aria-label': 'Recorded audio preview' });
    player.addEventListener('error', () => setStatus(importStatus, 'This browser can’t preview the recording here, but you can still save it.', 'hint'), { once: true });
    clear(draftBox, h('div', { class: 'panel stack recording-draft' },
      h('p', null, `Unsaved recording · ${megabytes(draft.blob.size)}`),
      player,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small primary', disabled: Boolean(uploading), onClick: () => importFile(draft.file, { fromRecording: true }) }, 'Save recording'),
        h('button', { type: 'button', class: 'btn small', disabled: Boolean(uploading), onClick: async () => {
          if (await confirmDialog({ title: 'Discard this recording?', body: 'It was never saved, so it will be gone.', confirmLabel: 'Discard recording', danger: true })) discardDraft();
        } }, 'Discard'))));
  }

  fileInput.addEventListener('change', () => { importButton.disabled = !fileInput.files?.length || Boolean(uploading); });
  importButton.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (file) importFile(file);
  });
  // The microphone is requested only here, when the person presses Record.
  recordButton.addEventListener('click', () => {
    setStatus(importStatus, '');
    recorder ??= createAudioRecorder({
      onComplete: setDraft,
      onError: (message) => { if (alive) setStatus(importStatus, message, 'error'); },
      onState: (state) => { recording = state; if (alive) renderRecorder(); },
    });
    recorder.start();
  });
  stopButton.addEventListener('click', () => recorder?.stop());

  // ---------- PDF ----------

  function pdfWorkspace(id, target) {
    let closed = false;
    let paused = false;
    let source = null;
    let doc = null;
    let docLoading = null;
    let docFailed = null;
    let fetchAbort = null;
    let page = Number.isInteger(target.page) && target.page > 0 ? target.page : 1;
    let pageData = null;
    let pageSeq = 0;
    let renderSeq = 0;
    let ocrSeq = 0;
    let canvasReady = null;
    let mark = null;
    let cited = target.quote ? { page, quote: target.quote, sha256: target.sha256 ?? null } : null;
    const ocrDrafts = new Map();
    const quoteDraft = { page: null, quote: '', occurrence: 0, textSource: 'pdf', note: '' };

    const title = h('h3', null, 'PDF');
    const notice = h('div');
    const body = h('div');
    const canvas = h('canvas', { class: 'pdf-canvas', role: 'img', 'aria-label': 'Rendered PDF page' });
    const canvasStatus = h('p', { class: 'hint', role: 'status', hidden: true });
    const pageInput = h('input', { type: 'number', min: 1, step: 1, class: 'page-input', 'aria-label': 'Page number' });
    const pageCount = h('span', { class: 'hint' });
    const prev = h('button', { type: 'button', class: 'btn small', onClick: () => showPage(page - 1) }, 'Previous');
    const nextButton = h('button', { type: 'button', class: 'btn small', onClick: () => showPage(page + 1) }, 'Next');
    const textBox = h('div', { class: 'pdf-texts' });
    const ocrBox = h('div', { class: 'ocr-box' });
    const ocrStatus = h('p', { class: 'hint', role: 'status', hidden: true });
    const findInput = h('input', { type: 'search', maxlength: 500, placeholder: 'Find in this PDF', 'aria-label': 'Find in this PDF' });
    const findResults = h('div', { 'aria-live': 'polite' });
    const annotateBox = h('div');
    const annotationsBox = h('div', { 'aria-live': 'polite' });
    pageInput.addEventListener('change', () => showPage(Number(pageInput.value)));

    const el = h('section', { class: 'panel research-workspace', 'aria-label': 'PDF reader' },
      h('div', { class: 'view-head' }, title, h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(id) }, 'Open item'),
        h('button', { type: 'button', class: 'btn small', onClick: closeWorkspace }, 'Close'))),
      notice, body);

    async function load() {
      clear(body, loading('Opening the PDF…'));
      try {
        source = await kget(`/research/pdf/${enc(id)}`);
        if (closed) return;
        title.textContent = source.title || source.filename;
        render();
      } catch (error) {
        if (!closed) clear(body, errorBox(error, load));
      }
    }

    function render() {
      clear(notice,
        cited?.sha256 && cited.sha256 !== source.sha256 ? h('p', { class: 'chat-notice' }, 'This PDF’s file changed since it was cited, so the page and quote may no longer match.') : null,
        source.truncated ? h('p', { class: 'hint' }, `The library keeps text for ${plural(source.storedPages, 'page')} of ${source.pageCount}${source.clipped.length ? `; ${plural(source.clipped.length, 'page')} were cut at the per-page limit` : ''}. Reviewed OCR can supply text for the rest.`) : null);
      if (source.status === 'pending') {
        return clear(body, h('p', { class: 'hint' }, 'The library host is still extracting this PDF’s page text.'),
          h('button', { type: 'button', class: 'btn small', onClick: load }, 'Check again'));
      }
      if (source.status === 'unavailable') {
        return clear(body,
          h('p', { class: 'hint' }, 'Page text isn’t kept for this PDF yet. It was saved before page text was kept, or extraction failed. Indexing reads the original again; the file isn’t changed.'),
          writable ? h('button', { type: 'button', class: 'btn small primary', onClick: async (event) => {
            event.target.disabled = true;
            try {
              source = await kpost(`/research/pdf/${enc(id)}/index`);
              if (!closed) render();
            } catch (error) {
              event.target.disabled = false;
              if (!closed) body.append(errorBox(error));
            }
          } }, 'Index page text') : h('p', { class: 'hint' }, 'A read,write token can index it.'));
      }
      if (!source.pageCount) return clear(body, empty('This PDF has no pages.'));
      pageCount.textContent = `of ${source.pageCount}`;
      pageInput.max = source.pageCount;
      clear(body,
        h('div', { class: 'actions pdf-nav' }, prev, h('label', { class: 'check' }, 'Page', pageInput), pageCount, nextButton),
        h('div', { class: 'pdf-reader' },
          h('div', { class: 'pdf-page' }, canvas, canvasStatus),
          h('div', { class: 'pdf-side' }, textBox, ocrBox, ocrStatus)),
        h('form', { class: 'filters', role: 'search', onSubmit: (event) => { event.preventDefault(); find(); } },
          findInput, h('button', { type: 'submit', class: 'btn small' }, 'Find')),
        findResults,
        annotateBox,
        h('h4', null, 'Annotations'),
        annotationsBox);
      showPage(Math.min(page, source.pageCount));
      loadAnnotations();
    }

    function showPage(n) {
      if (!source || source.status !== 'ready' || !source.pageCount) return;
      if (!Number.isInteger(n) || n < 1 || n > source.pageCount) {
        pageInput.value = page;
        return ctx.notify(`Choose a page from 1 to ${source.pageCount}.`, 'info');
      }
      page = n;
      pageInput.value = n;
      prev.disabled = n <= 1;
      nextButton.disabled = n >= source.pageCount;
      loadPage(n);
      renderCanvas(n);
    }

    async function loadPage(n) {
      const mine = ++pageSeq;
      pageData = null;
      clear(textBox, loading('Loading page text…'));
      clear(ocrBox);
      try {
        const range = await kget(`/research/pdf/${enc(id)}/pages?from=${n}&limit=1`);
        if (closed || mine !== pageSeq) return;
        if (range.sha256 !== source.sha256) {
          clear(textBox, h('p', { class: 'chat-notice' }, 'This PDF’s file changed while it was open.'), h('button', { type: 'button', class: 'btn small', onClick: load }, 'Reopen it'));
          return;
        }
        pageData = range.pages[0];
        renderText();
        renderOcr();
        renderAnnotate();
      } catch (error) {
        if (!closed && mine === pageSeq) clear(textBox, errorBox(error, () => loadPage(n)));
      }
    }

    function highlightFor(textSource, text) {
      if (mark && mark.page === page && mark.textSource === textSource) return mark;
      if (cited && cited.page === page) {
        const at = text.indexOf(cited.quote);
        if (at >= 0) return { start: at, end: at + cited.quote.length };
      }
      return null;
    }

    function renderText() {
      const { text, available, clipped, ocr } = pageData;
      const citedHere = cited && cited.page === page;
      const foundCited = citedHere && (text.includes(cited.quote) || ocr?.text.includes(cited.quote));
      clear(textBox,
        citedHere ? h('div', { class: 'cited' },
          h('span', { class: 'field-label' }, 'Cited passage'),
          h('blockquote', null, cited.quote),
          foundCited ? null : h('p', { class: 'hint' }, 'This exact passage isn’t in the page text now; it may span pages or have been summarized.')) : null,
        h('h4', null, `Page ${page} text`),
        available
          ? (text.trim() ? textBlock(text, `Text of page ${page}`, highlightFor('pdf', text)) : empty('This page has no extractable text. It may be a scan; recognize it with OCR below.'))
          : h('p', { class: 'hint' }, `The library keeps text for the first ${source.storedPages} pages. Recognize this page with OCR below to read and quote it.`),
        clipped ? h('p', { class: 'hint' }, 'This page’s text was cut at the per-page limit.') : null,
        ocr ? [h('h4', null, 'Reviewed OCR text'), textBlock(ocr.text, `Reviewed OCR text of page ${page}`, highlightFor('ocr', ocr.text)),
          h('p', { class: 'hint' }, `Saved ${when(ocr.updatedAt)}. `, h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(ocr.id) }, 'Open the OCR note'))] : null);
    }

    const draftKey = () => `${source.sha256}:${page}`;

    function renderOcr() {
      if (!writable) return clear(ocrBox);
      const key = draftKey();
      const pending = ocrDrafts.get(key);
      const recognize = h('button', { type: 'button', class: 'btn small', disabled: canvasReady !== page, title: canvasReady === page ? undefined : 'Available once the page image has been drawn' },
        pageData.ocr ? 'Recognize again' : 'Recognize text on this page');
      recognize.addEventListener('click', () => runOcr(recognize));
      const edit = pageData.ocr && !pending ? h('button', { type: 'button', class: 'btn small', onClick: () => {
        ocrDrafts.set(key, { text: pageData.ocr.text, engine: '' });
        renderOcr();
      } }, 'Edit reviewed text') : null;
      if (!pending) return clear(ocrBox, h('div', { class: 'actions' }, recognize, edit),
        h('p', { class: 'hint' }, 'OCR reads the page image on the library host. You review the text before saving; the original PDF is unchanged.'));
      const text = h('textarea', { rows: 8, value: pending.text, 'aria-label': `OCR text for page ${page}` });
      const save = h('button', { type: 'submit', class: 'btn small primary', disabled: !pending.text.trim() }, 'Save reviewed text');
      text.addEventListener('input', () => { pending.text = text.value; save.disabled = !text.value.trim(); });
      const at = page;
      const sha = source.sha256;
      clear(ocrBox, h('form', { class: 'stack', 'aria-label': `Review OCR text for page ${at}`, onSubmit: async (event) => {
        event.preventDefault();
        if (!pending.text.trim()) return;
        save.disabled = text.disabled = true;
        setStatus(ocrStatus, 'Saving…');
        try {
          const { created } = await kpost('/research/ocr-pages', { sourceId: id, page: at, text: pending.text, sha256: sha, ...(pending.engine ? { engine: pending.engine } : {}) });
          if (closed) return;
          ocrDrafts.delete(`${sha}:${at}`);
          setStatus(ocrStatus, created ? `Saved page ${at}’s reviewed text as a note.` : `Updated page ${at}’s reviewed text; its history keeps the earlier version.`, 'ok');
          ctx.changed({ detail: false });
          source = await kget(`/research/pdf/${enc(id)}`);
          if (!closed && page === at) loadPage(at);
        } catch (error) {
          if (closed) return;
          save.disabled = text.disabled = false;
          setStatus(ocrStatus, `Not saved: ${error.message} Your text is still here.`, 'error');
        }
      } },
      h('p', { class: 'hint' }, pending.engine ? `Recognized with ${pending.engine}. Correct anything it misread, then save.` : 'Edit the reviewed text, then save. Saving again keeps the earlier version in history.'),
      text,
      h('div', { class: 'actions' }, save, recognize,
        h('button', { type: 'button', class: 'btn small', onClick: () => { ocrDrafts.delete(key); setStatus(ocrStatus, ''); renderOcr(); } }, 'Discard draft'))));
    }

    async function runOcr(button) {
      if (canvasReady !== page) return setStatus(ocrStatus, 'Wait for the page image to finish drawing.', 'error');
      const at = page;
      const sha = source.sha256;
      const mine = ++ocrSeq;
      button.disabled = true;
      setStatus(ocrStatus, `Recognizing text on page ${at} on the library host…`);
      try {
        const png = await canvasPng(canvas);
        if (png.size > OCR_PNG_BYTES) throw new Error('This page renders larger than the 20 MB recognition limit.');
        const result = await kpost('/research/ocr', { sourceId: id, page: at, sha256: sha, png: await base64(png) });
        if (closed || mine !== ocrSeq || result.page !== at || result.sha256 !== sha) return;
        ocrDrafts.set(`${sha}:${at}`, { text: result.text ?? '', engine: result.engine ?? '' });
        setStatus(ocrStatus, result.text?.trim() ? `Recognized page ${at}. Review the text before saving.` : `No text was recognized on page ${at}. You can type it instead.`);
        if (page === at && source.sha256 === sha) renderOcr();
      } catch (error) {
        if (!closed && mine === ocrSeq) setStatus(ocrStatus, error.message, 'error');
      } finally {
        if (!closed && button.isConnected) button.disabled = canvasReady !== page;
      }
    }

    function ensureDoc() {
      if (doc) return Promise.resolve(doc);
      docLoading ??= (async () => {
        fetchAbort = new AbortController();
        const blob = await researchFile(id, fetchAbort.signal);
        if (closed || paused) throw new DOMException('Stopped.', 'AbortError');
        const opened = await openResearchPdf(await blob.arrayBuffer());
        if (closed || paused) {
          await opened.close();
          throw new DOMException('Stopped.', 'AbortError');
        }
        doc = opened;
        return doc;
      })().finally(() => { docLoading = null; });
      return docLoading;
    }

    async function renderCanvas(n) {
      const mine = ++renderSeq;
      canvasReady = null;
      if (docFailed) return setStatus(canvasStatus, docFailed, 'error');
      setStatus(canvasStatus, doc ? 'Drawing the page…' : 'Loading the PDF to draw its pages…');
      let opening = !doc;
      try {
        const opened = await ensureDoc();
        opening = false;
        if (closed || paused || mine !== renderSeq) return;
        await opened.render(n, canvas);
        if (closed || paused || mine !== renderSeq) return;
        canvasReady = n;
        setStatus(canvasStatus, '');
        if (pageData) renderOcr();
      } catch (error) {
        if (closed || paused || error?.name === 'AbortError' || error?.name === 'RenderingCancelledException') return;
        const message = `The page image isn’t available: ${error.message} Page text, find and annotations still work.`;
        // A file that can't be downloaded or opened isn't fetched again on every page turn.
        if (opening) docFailed = message;
        if (mine === renderSeq) setStatus(canvasStatus, message, 'error');
      }
    }

    async function find() {
      const q = findInput.value.trim();
      if (!q) return clear(findResults);
      clear(findResults, loading('Searching this PDF…'));
      try {
        const matches = await kget(`/research/pdf/${enc(id)}/find?q=${enc(q)}&limit=50`);
        if (closed) return;
        clear(findResults, matches.length
          ? h('ul', { class: 'plain find-results' }, matches.map((match) => h('li', null, h('button', { type: 'button', class: 'link-btn', onClick: () => {
            mark = { page: match.page, textSource: match.textSource, start: match.start, end: match.end };
            if (match.page === page && pageData) renderText();
            else showPage(match.page);
          } }, h('strong', null, `Page ${match.page}${match.textSource === 'ocr' ? ' (reviewed OCR)' : ''}`), ' ', match.excerpt))))
          : empty(`“${q}” isn’t in this PDF’s kept text or reviewed OCR.`),
        matches.length === 50 ? h('p', { class: 'hint' }, 'Showing the first 50 matches. Add words to narrow the search.') : null);
      } catch (error) {
        if (!closed) clear(findResults, errorBox(error, find));
      }
    }

    function selectedQuote(blocks) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      for (const [textSource, block] of blocks) {
        if (!block || !block.contains(range.startContainer) || !block.contains(range.endContainer)) continue;
        const before = document.createRange();
        before.selectNodeContents(block);
        before.setEnd(range.startContainer, range.startOffset);
        const offset = before.toString().length;
        const quote = range.toString();
        const text = block.textContent;
        const occurrence = occurrences(text, quote).filter((at) => at < offset).length;
        return { textSource, quote, occurrence: occurrences(text, quote).includes(offset) ? occurrence : 0 };
      }
      return null;
    }

    /** An exact quote from the page text or its reviewed OCR, saved as a note linked to this page; no coordinates are invented. */
    function renderAnnotate() {
      if (!writable) return clear(annotateBox);
      const textSources = [pageData.available && pageData.text.trim() ? ['pdf', 'Page text'] : null, pageData.ocr ? ['ocr', 'Reviewed OCR text'] : null].filter(Boolean);
      const status = h('p', { class: 'hint', role: 'status', hidden: true });
      if (!textSources.length) return clear(annotateBox, h('p', { class: 'hint' }, 'Save reviewed OCR text for this page to quote it.'));
      if (!quoteDraft.quote && !textSources.some(([value]) => value === quoteDraft.textSource)) quoteDraft.textSource = textSources[0][0];
      const textSource = h('select', { 'aria-label': 'Quote from' }, textSources.map(([value, text]) => h('option', { value, selected: value === quoteDraft.textSource }, text)));
      const quote = h('textarea', { rows: 3, maxlength: QUOTE_MAX, value: quoteDraft.quote, placeholder: 'Select text in the page, then press Use selection, or paste the exact words.' });
      const note = h('textarea', { rows: 3, maxlength: NOTE_MAX, value: quoteDraft.note, placeholder: 'Your note (optional)' });
      const where = h('p', { class: 'hint' });
      const showWhere = () => {
        where.textContent = quoteDraft.quote
          ? `Quoting page ${quoteDraft.page}${quoteDraft.occurrence ? `, occurrence ${quoteDraft.occurrence + 1} on the page` : ''}.${quoteDraft.page !== page ? ' Go back to that page to check it, or replace the quote.' : ''}`
          : '';
      };
      textSource.addEventListener('change', () => { quoteDraft.textSource = textSource.value; quoteDraft.occurrence = 0; });
      quote.addEventListener('input', () => {
        quoteDraft.quote = quote.value;
        quoteDraft.page = page;
        quoteDraft.occurrence = 0;
        quoteDraft.textSource = textSource.value;
        showWhere();
      });
      note.addEventListener('input', () => { quoteDraft.note = note.value; });
      const save = h('button', { type: 'submit', class: 'btn small primary' }, 'Save annotation');
      clear(annotateBox, h('form', { class: 'panel stack annotate', 'aria-label': 'Annotate a passage', onSubmit: async (event) => {
        event.preventDefault();
        if (!quoteDraft.quote.trim()) return setStatus(status, 'Choose the exact passage to quote first.', 'error');
        save.disabled = true;
        setStatus(status, 'Saving…');
        try {
          const { created } = await kpost('/research/annotations', {
            sourceId: id, page: quoteDraft.page, quote: quoteDraft.quote, sha256: source.sha256, textSource: quoteDraft.textSource,
            occurrence: quoteDraft.occurrence, ...(quoteDraft.note.trim() ? { note: quoteDraft.note.trim() } : {}),
          });
          if (closed) return;
          Object.assign(quoteDraft, { page: null, quote: '', occurrence: 0, note: '' });
          ctx.notify(created ? 'Annotation saved as a note' : 'This annotation was already saved', 'ok');
          ctx.changed({ detail: false });
          renderAnnotate();
          loadAnnotations();
        } catch (error) {
          if (closed) return;
          save.disabled = false;
          setStatus(status, `Not saved: ${error.message}`, 'error');
        }
      } },
      h('h4', null, 'Annotate'),
      h('div', { class: 'actions' },
        field('Quote from', textSource),
        h('button', { type: 'button', class: 'btn small', onClick: () => {
          const picked = selectedQuote([
            ['pdf', textBox.querySelector('.pdf-text[aria-label^="Text of page"]')],
            ['ocr', textBox.querySelector('.pdf-text[aria-label^="Reviewed OCR"]')],
          ]);
          if (!picked) return setStatus(status, 'Select words inside the page text or reviewed OCR text first.', 'error');
          Object.assign(quoteDraft, { ...picked, page });
          quote.value = picked.quote;
          textSource.value = picked.textSource;
          setStatus(status, '');
          showWhere();
        } }, 'Use selection')),
      field('Exact quote', quote),
      where,
      field('Note', note),
      h('div', { class: 'actions' }, save),
      status));
      showWhere();
    }

    async function loadAnnotations() {
      if (!annotationsBox.childElementCount) annotationsBox.append(loading());
      try {
        const annotations = await kget(`/research/pdf/${enc(id)}/annotations?limit=200`);
        if (closed) return;
        clear(annotationsBox, annotations.length
          ? h('ul', { class: 'plain annotation-list' }, annotations.map((annotation) => {
            const [badge, explanation] = ANNOTATION_STATUS[annotation.status] ?? [annotation.status, ''];
            const locatable = annotation.status === 'current' || annotation.status === 'moved';
            return h('li', null,
              h('div', { class: 'actions' },
                h('span', { class: 'badge' }, `Page ${annotation.page}${annotation.textSource === 'ocr' ? ' · OCR' : ''}`),
                h('span', { class: `badge annotation-${annotation.status}`, title: explanation }, badge),
                h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(annotation.id) }, annotation.title)),
              h('blockquote', null, annotation.quote),
              h('p', { class: 'hint' }, explanation, ` Saved ${when(annotation.createdAt)}.`),
              locatable ? h('button', { type: 'button', class: 'btn small', onClick: () => {
                mark = { page: annotation.page, textSource: annotation.textSource, ...annotation.current };
                if (annotation.page === page && pageData) renderText();
                else showPage(annotation.page);
              } }, 'Show on page') : null);
          }))
          : empty('No annotations yet.'),
        annotations.length === 200 ? h('p', { class: 'hint' }, 'Showing the first 200 annotations in page order.') : null);
      } catch (error) {
        if (!closed) clear(annotationsBox, errorBox(error, loadAnnotations));
      }
    }

    function suspend() {
      paused = true;
      renderSeq++;
      fetchAbort?.abort();
      if (doc) doc.close();
      doc = null;
      canvasReady = null;
    }

    load();
    return {
      id, kind: 'pdf', el,
      close() {
        closed = true;
        suspend();
      },
      suspend,
      resume() {
        paused = false;
        if (source?.status === 'ready' && source.pageCount) renderCanvas(page);
      },
      async refresh() {
        if (!source) return;
        if (source.status !== 'ready') return load();
        loadAnnotations();
      },
      reveal(next) {
        if (Number.isInteger(next.page) && next.page > 0) page = next.page;
        cited = next.quote ? { page, quote: next.quote, sha256: next.sha256 ?? null } : null;
        mark = null;
        if (source?.status === 'ready') render();
      },
    };
  }

  // ---------- Audio ----------

  function audioWorkspace(id, target) {
    let closed = false;
    let item = null;
    let url = null;
    let fetchAbort = null;
    let mediaSeq = 0;
    let pendingSeek = Number.isFinite(target.start) ? target.start : null;
    let transcript = null;
    let transcriptSeq = 0;
    let segmentNodes = [];
    let passagesBox = null;
    let selected = new Set();
    let passageNote = '';
    let preview = null;
    let config = null;
    let aiConfigured = false;

    const title = h('h3', null, 'Recording');
    const player = h('audio', { controls: true, preload: 'metadata', class: 'research-audio', 'aria-label': 'Recording' });
    const playerStatus = h('p', { class: 'hint', role: 'status', hidden: true });
    const transcriptsBox = h('div');
    const importBox = h('div');
    const previewBox = h('div', { 'aria-live': 'polite' });
    const transcriptBox = h('div');

    player.addEventListener('loadedmetadata', () => {
      if (pendingSeek === null) return;
      player.currentTime = pendingSeek;
      setStatus(playerStatus, `Ready at ${formatTime(pendingSeek)}. Press play to listen.`);
      pendingSeek = null;
    });
    player.addEventListener('error', () => {
      if (url) setStatus(playerStatus, 'This browser couldn’t play the recording here. Transcripts, captions and passages still work.', 'error');
    });
    player.addEventListener('timeupdate', () => {
      if (!transcript) return;
      const time = player.currentTime;
      segmentNodes.forEach((node, index) => {
        const segment = transcript.segments[index];
        const active = time >= segment.start && time < segment.end;
        node.classList.toggle('active', active);
        if (active) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current');
      });
    });

    const el = h('section', { class: 'panel research-workspace', 'aria-label': 'Recording and transcripts' },
      h('div', { class: 'view-head' }, title, h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(id) }, 'Open item'),
        h('button', { type: 'button', class: 'btn small', onClick: closeWorkspace }, 'Close'))),
      player, playerStatus,
      h('h4', null, 'Transcripts'), transcriptsBox,
      transcriptBox,
      writable ? [h('h4', null, 'Add a transcript'), importBox, previewBox] : null);

    async function load() {
      try {
        const [loaded, transcription, ai] = await Promise.all([
          get(`/items/${enc(id)}`),
          kget('/research/transcription').catch(() => ({ configured: false })),
          get('/ai/status').catch(() => ({ configured: false })),
        ]);
        if (closed) return;
        item = loaded;
        config = transcription;
        aiConfigured = Boolean(ai.configured);
        title.textContent = displayTitle(item);
        renderImport();
      } catch (error) {
        if (!closed) clear(transcriptsBox, errorBox(error, load));
        return;
      }
      loadMedia();
      loadTranscripts();
      if (target.transcriptId) openTranscript(target.transcriptId);
    }

    async function loadMedia() {
      const mine = ++mediaSeq;
      fetchAbort?.abort();
      fetchAbort = new AbortController();
      setStatus(playerStatus, 'Loading the recording…');
      try {
        const blob = await researchFile(id, fetchAbort.signal);
        if (closed || mine !== mediaSeq) return;
        url = URL.createObjectURL(blob);
        player.src = url;
        if (pendingSeek === null) setStatus(playerStatus, '');
      } catch (error) {
        if (closed || mine !== mediaSeq || error.name === 'AbortError') return;
        setStatus(playerStatus, `Playback isn’t available here: ${error.message} Transcripts, captions and passages still work.`, 'error');
      }
    }

    function releaseMedia() {
      mediaSeq++;
      fetchAbort?.abort();
      player.pause();
      if (url) {
        player.removeAttribute('src');
        player.load();
        URL.revokeObjectURL(url);
        url = null;
      }
    }

    function seek(seconds, play) {
      if (!url) {
        pendingSeek = seconds;
        setStatus(playerStatus, `Will start at ${formatTime(seconds)} once the recording loads.`);
        return;
      }
      player.currentTime = seconds;
      if (play) player.play().catch(() => setStatus(playerStatus, `Press play to listen from ${formatTime(seconds)}.`));
      else setStatus(playerStatus, `Ready at ${formatTime(seconds)}. Press play to listen.`);
    }

    async function loadTranscripts() {
      if (!transcriptsBox.childElementCount) transcriptsBox.append(loading());
      try {
        const { transcripts } = await kget(`/research/audio/${enc(id)}`);
        if (closed) return;
        clear(transcriptsBox, transcripts.length
          ? h('ul', { class: 'plain' }, transcripts.map((summary) => h('li', null,
            h('button', { type: 'button', class: 'link-btn', 'aria-current': transcript?.id === summary.id ? 'true' : undefined, onClick: () => openTranscript(summary.id) }, summary.title),
            h('span', { class: 'hint' }, `${summary.format.toUpperCase()} · ${plural(summary.segmentCount, 'segment')} · ${formatTime(summary.duration)} · ${when(summary.createdAt)}`))))
          : empty(writable ? 'No transcript yet. Import captions below; no AI is needed.' : 'No transcript yet.'));
      } catch (error) {
        if (!closed) clear(transcriptsBox, errorBox(error, loadTranscripts));
      }
    }

    function renderImport() {
      if (!writable) return;
      const file = h('input', { type: 'file', accept: CAPTION_ACCEPT, 'aria-label': 'Caption file' });
      const text = h('textarea', { rows: 5, placeholder: 'Or paste WebVTT, SubRip or timed JSON here', 'aria-label': 'Caption text' });
      const format = h('select', { 'aria-label': 'Caption format' },
        h('option', { value: '' }, 'Detect format'), h('option', { value: 'vtt' }, 'WebVTT (.vtt)'), h('option', { value: 'srt' }, 'SubRip (.srt)'), h('option', { value: 'json' }, 'Timed JSON'));
      const status = h('p', { class: 'hint', role: 'status', hidden: true });
      const previewButton = h('button', { type: 'submit', class: 'btn small primary' }, 'Preview transcript');
      const dropPreview = () => {
        preview = null;
        clear(previewBox);
      };
      file.addEventListener('change', async () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        if (chosen.size > CAPTION_BYTES) {
          file.value = '';
          return setStatus(status, 'Choose a caption file under 1.9 MB, or split it.', 'error');
        }
        text.value = await chosen.text();
        if (!format.value) format.value = /\.vtt$/i.test(chosen.name) ? 'vtt' : /\.srt$/i.test(chosen.name) ? 'srt' : /\.json$/i.test(chosen.name) ? 'json' : '';
        setStatus(status, '');
        dropPreview();
      });
      text.addEventListener('input', dropPreview);
      format.addEventListener('change', dropPreview);

      const transcribe = config?.configured
        ? h('button', { type: 'button', class: 'btn small', onClick: async () => {
          const attachment = item.attachments.find((a) => a.mimeType.startsWith('audio/'));
          const ok = await confirmDialog({
            title: 'Send this recording for transcription?',
            body: `“${displayTitle(item)}”${attachment ? ` (${megabytes(attachment.size)})` : ''} will be sent to ${config.baseUrl}${config.model ? ` using ${config.model}` : ''}, the transcription server configured on the library host. Nothing is saved until you review the transcript and press Save transcript.`,
            confirmLabel: 'Send recording',
          });
          if (!ok || closed) return;
          setStatus(status, `Transcribing on ${config.baseUrl}… This can take a few minutes.`);
          try {
            const result = await kpost('/research/transcribe', { audioId: id, confirmed: true });
            if (closed) return;
            setStatus(status, '');
            showPreview(result, 'transcription');
          } catch (error) {
            if (!closed) setStatus(status, error.message, 'error');
          }
        } }, `Transcribe with ${config.model || config.baseUrl}…`)
        : null;

      clear(importBox, h('form', { class: 'stack', 'aria-label': 'Import captions', onSubmit: async (event) => {
        event.preventDefault();
        if (!text.value.trim()) return setStatus(status, 'Choose a caption file or paste captions first.', 'error');
        if (new Blob([text.value]).size > CAPTION_BYTES) return setStatus(status, 'These captions are over 1.9 MB. Split them first.', 'error');
        previewButton.disabled = true;
        setStatus(status, 'Checking the timings…');
        try {
          const result = await kpost('/research/transcripts/preview', { audioId: id, data: text.value, ...(format.value ? { format: format.value } : {}) });
          if (closed) return;
          setStatus(status, '');
          showPreview(result, 'captions');
        } catch (error) {
          if (!closed) setStatus(status, error.message, 'error');
        } finally {
          previewButton.disabled = false;
        }
      } },
      h('div', { class: 'grid2' }, field('Caption file', file), field('Format', format)),
      text,
      h('div', { class: 'actions' }, previewButton, transcribe),
      config?.configured ? null : h('p', { class: 'hint' }, 'Automatic transcription isn’t set up on the library host, and the browser can’t set host credentials. Configure it in the desktop app’s settings, or start the host with MEMORY_TRANSCRIPTION_URL, MEMORY_TRANSCRIPTION_MODEL and MEMORY_TRANSCRIPTION_KEY. Importing captions always works without AI.'),
      status));
    }

    function showPreview(result, origin) {
      preview = result;
      const name = h('input', { type: 'text', maxlength: 200, placeholder: `${displayTitle(item)} transcript`, 'aria-label': 'Transcript title' });
      const status = h('p', { class: 'hint', role: 'status', hidden: true });
      const save = h('button', { type: 'button', class: 'btn small primary' }, 'Save transcript');
      save.addEventListener('click', async () => {
        if (preview !== result) return;
        save.disabled = true;
        setStatus(status, 'Saving…');
        try {
          // Only the fields the service accepts; the reviewed fingerprint makes a changed recording or text fail.
          const { item: saved, created } = await kpost('/research/transcripts', {
            audioId: id, segments: result.segments, format: result.format, fingerprint: result.fingerprint,
            ...(result.engine ? { engine: result.engine } : {}), ...(name.value.trim() ? { title: name.value.trim() } : {}),
          });
          if (closed) return;
          preview = null;
          clear(previewBox, h('p', { class: 'ok', role: 'status' }, created ? 'Transcript saved as a searchable note.' : 'This transcript was already saved.'));
          importBox.querySelector('textarea').value = '';
          ctx.changed({ detail: false });
          loadTranscripts();
          openTranscript(saved.id);
        } catch (error) {
          if (closed) return;
          save.disabled = false;
          setStatus(status, `Not saved: ${error.message}`, 'error');
        }
      });
      clear(previewBox, h('div', { class: 'panel stack transcript-preview' },
        h('h4', null, origin === 'transcription' ? 'Transcription preview' : 'Caption preview'),
        h('p', { class: 'hint' }, [
          plural(result.segmentCount, 'segment'), formatTime(result.duration), plural(result.characters, 'character'),
          result.overlaps ? plural(result.overlaps, 'overlapping cue') : null,
          result.skipped ? `${plural(result.skipped, 'cue')} skipped (empty or unreadable)` : null,
          result.engine ? `by ${result.engine}` : null,
        ].filter(Boolean).join(' · ')),
        result.existingId ? h('p', { class: 'chat-notice' }, 'This exact transcript is already saved. ',
          h('button', { type: 'button', class: 'link-btn', onClick: () => openTranscript(result.existingId) }, 'Open it')) : null,
        h('ol', { class: 'plain segments preview' }, result.segments.slice(0, PREVIEW_SEGMENTS).map((segment) => h('li', null,
          h('span', { class: 'timestamp' }, formatTime(segment.start)),
          h('span', null, segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text)))),
        result.segments.length > PREVIEW_SEGMENTS ? h('p', { class: 'hint' }, `…and ${plural(result.segments.length - PREVIEW_SEGMENTS, 'more segment')}.`) : null,
        field('Title (optional)', name),
        h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn small', onClick: () => { preview = null; clear(previewBox); } }, 'Discard preview')),
        status));
      save.focus();
    }

    async function openTranscript(transcriptId, start) {
      const mine = ++transcriptSeq;
      clear(transcriptBox, loading('Opening the transcript…'));
      try {
        const view = await kget(`/research/transcripts/${enc(transcriptId)}`);
        if (closed || mine !== transcriptSeq) return;
        if (transcript?.id !== view.id) {
          selected = new Set();
          passageNote = '';
        }
        transcript = view;
        renderTranscript();
        loadTranscripts();
        if (Number.isFinite(start)) {
          const index = view.segments.findIndex((segment) => start >= segment.start && start < segment.end);
          segmentNodes[index]?.scrollIntoView?.({ block: 'center' });
        }
      } catch (error) {
        if (!closed && mine === transcriptSeq) clear(transcriptBox, errorBox(error, () => openTranscript(transcriptId, start)));
      }
    }

    function renderTranscript() {
      const view = transcript;
      const playable = view.audioStatus === 'ok' && view.audioId === id;
      const summary = h('p', { class: 'hint', role: 'status' });
      const note = h('textarea', { rows: 3, maxlength: NOTE_MAX, value: passageNote, placeholder: 'Your note about this passage (optional)', 'aria-label': 'Passage note' });
      note.addEventListener('input', () => { passageNote = note.value; });
      const save = h('button', { type: 'button', class: 'btn small primary' }, 'Save passage');
      const passageStatus = h('p', { class: 'hint', role: 'status', hidden: true });
      passagesBox = h('div');
      const range = () => selected.size ? [Math.min(...selected), Math.max(...selected)] : null;
      const update = () => {
        const chosen = range();
        const count = chosen ? chosen[1] - chosen[0] + 1 : 0;
        summary.textContent = chosen
          ? `Selected ${formatTime(view.segments[chosen[0]].start)}–${formatTime(Math.max(...view.segments.slice(chosen[0], chosen[1] + 1).map((s) => s.end)))} (${plural(count, 'segment')}).${count > PASSAGE_SEGMENTS ? ` Choose at most ${PASSAGE_SEGMENTS}.` : ''}`
          : 'Tick the first and last segments of a passage to save it with a note.';
        save.disabled = !chosen || count > PASSAGE_SEGMENTS || view.audioStatus !== 'ok';
        segmentNodes.forEach((node, index) => node.classList.toggle('in-range', Boolean(chosen) && index >= chosen[0] && index <= chosen[1]));
      };
      segmentNodes = view.segments.map((segment, index) => h('li', { class: 'segment' },
        writable ? h('input', { type: 'checkbox', checked: selected.has(index), 'aria-label': `Select segment at ${formatTime(segment.start)}`, onChange: (event) => {
          if (event.target.checked) selected.add(index); else selected.delete(index);
          update();
        } }) : null,
        h('button', { type: 'button', class: 'timestamp link-btn', disabled: !playable, title: playable ? `Play from ${formatTime(segment.start)}` : 'The recording isn’t available', onClick: () => seek(segment.start, true) }, formatTime(segment.start)),
        h('span', null, segment.speaker ? h('strong', null, `${segment.speaker}: `) : null, segment.text)));
      save.addEventListener('click', async () => {
        const chosen = range();
        if (!chosen) return;
        save.disabled = true;
        setStatus(passageStatus, 'Saving…');
        try {
          const { created } = await kpost('/research/passages', {
            transcriptId: view.id, fingerprint: view.fingerprint, from: chosen[0], to: chosen[1], ...(passageNote.trim() ? { note: passageNote.trim() } : {}),
          });
          if (closed || transcript !== view) return;
          selected = new Set();
          passageNote = '';
          note.value = '';
          segmentNodes.forEach((node) => { const box = node.querySelector('input'); if (box) box.checked = false; });
          setStatus(passageStatus, created ? 'Passage saved as a source-linked note.' : 'This passage was already saved.', 'ok');
          ctx.changed({ detail: false });
          update();
          if (passagesBox) loadPassages(view, passagesBox);
        } catch (error) {
          if (closed) return;
          setStatus(passageStatus, `Not saved: ${error.message}`, 'error');
          update();
        }
      });

      const warning = view.audioStatus === 'missing'
        ? 'The recording behind this transcript is archived or gone, so timestamps can’t play and passages can’t be saved.'
        : view.audioStatus === 'changed' ? 'The recording’s file was replaced after this transcript was made, so its timings may not match. Passages can’t be saved.'
          : view.audioId !== id ? 'This transcript belongs to another recording.' : null;
      clear(transcriptBox, h('section', { class: 'panel stack transcript-view', 'aria-label': `Transcript ${view.title}` },
        h('div', { class: 'view-head' }, h('h4', null, view.title), h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', onClick: () => ctx.select(view.id) }, 'Open note'),
          h('button', { type: 'button', class: 'btn small', onClick: () => {
            transcriptSeq++;
            transcript = null;
            segmentNodes = [];
            passagesBox = null;
            clear(transcriptBox);
            loadTranscripts();
          } }, 'Close transcript'))),
        h('p', { class: 'hint' }, `${view.format.toUpperCase()}${view.engine ? ` · ${view.engine}` : ''} · ${plural(view.segments.length, 'segment')} · ${formatTime(view.duration)}`),
        warning ? h('p', { class: 'chat-notice' }, warning) : null,
        h('ol', { class: 'plain segments' }, segmentNodes),
        writable ? [summary, field('Note', note), h('div', { class: 'actions' }, save), passageStatus] : null,
        h('h4', null, 'Saved passages'), passagesBox,
        writable ? taskPanel(view) : null));
      update();
      loadPassages(view, passagesBox);
    }

    async function loadPassages(view, box) {
      if (!box.childElementCount) box.append(loading());
      try {
        const passages = await kget(`/research/transcripts/${enc(view.id)}/passages?limit=200`);
        if (closed || transcript !== view) return;
        const playable = view.audioStatus === 'ok' && view.audioId === id;
        clear(box, passages.length
          ? h('ul', { class: 'plain passage-list' }, passages.map((passage) => h('li', null,
            h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'btn small', disabled: !playable, onClick: () => seek(passage.start, true) }, `Play ${formatTime(passage.start)}–${formatTime(passage.end)}`),
              h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(passage.id) }, passage.title)),
            h('blockquote', null, passage.quote))))
          : empty('No passages saved from this transcript yet.'));
      } catch (error) {
        if (!closed && transcript === view) clear(box, errorBox(error, () => loadPassages(view, box)));
      }
    }

    function taskPanel(view) {
      const out = h('div', { class: 'proposal', 'aria-live': 'polite' });
      if (!aiConfigured) return h('div', null, h('h4', null, 'Tasks and brief'), h('p', { class: 'hint' }, 'Suggesting tasks and a brief needs an AI provider on the library host. Choose one in the desktop app’s Settings → AI, or run petty-memory ai use.'));
      const instruction = h('textarea', { rows: 2, value: TASK_PROMPT, 'aria-label': 'What to suggest from this transcript' });
      const ask = h('button', { type: 'button', class: 'btn small', onClick: async () => {
        if (!instruction.value.trim()) return;
        ask.disabled = true;
        clear(out, loading('Asking the AI provider for suggestions…'));
        try {
          const reply = await post('/ai/chat', { mode: 'actions', rootId: view.id, messages: [{ role: 'user', content: instruction.value.trim() }] });
          if (closed || transcript !== view) return;
          if (reply?.kind !== 'actions') throw new Error('The server sent an unexpected reply.');
          if (!reply.proposal.operations.length) clear(out, empty(reply.proposal.summary || 'The AI didn’t suggest any actions.'));
          else {
            showActions(out, reply.proposal, {
              changed: () => ctx.changed(),
              open: (itemId) => ctx.select(itemId),
              onDiscard: () => clear(out, h('p', { class: 'hint' }, 'Suggestions discarded. Nothing was changed.')),
            });
            if (reply.proposal.summary) out.prepend(h('p', null, reply.proposal.summary));
          }
        } catch (error) {
          if (!closed) clear(out, errorBox(error));
        } finally {
          ask.disabled = false;
        }
      } }, 'Suggest tasks and a brief');
      return h('div', { class: 'stack' },
        h('h4', null, 'Tasks and brief'),
        h('p', { class: 'hint' }, 'The AI reads this transcript and suggests tasks, reminders or a brief. You tick the ones to keep; nothing changes until you apply them, and you can undo afterwards.'),
        instruction, h('div', { class: 'actions' }, ask), out);
    }

    load();
    return {
      id, kind: 'audio', el,
      close() {
        closed = true;
        releaseMedia();
      },
      // The position is kept so returning picks up where the person was, without playing by itself.
      suspend() {
        if (url && player.currentTime > 0) pendingSeek = player.currentTime;
        releaseMedia();
      },
      resume() {
        if (closed || !item) return;
        loadMedia();
      },
      refresh() {
        if (!item) return;
        loadTranscripts();
        if (transcript && passagesBox) loadPassages(transcript, passagesBox);
      },
      reveal(next) {
        if (next.transcriptId && next.transcriptId !== transcript?.id) openTranscript(next.transcriptId, next.start);
        if (Number.isFinite(next.start)) seek(next.start, false);
      },
    };
  }

  const el = h('section', { class: 'knowledge-section research', 'aria-labelledby': 'research-heading' },
    h('div', { class: 'view-head' }, h('h2', { id: 'research-heading' }, 'Research')),
    h('p', { class: 'hint' }, 'Read PDFs page by page, quote exact passages, review OCR for scanned pages, and play recordings with their transcripts. Originals are never changed; everything you save is an ordinary note linked to its source.'),
    writable ? h('div', { class: 'panel stack research-import' },
      h('div', { class: 'actions' }, fileInput, importButton),
      h('p', { class: 'hint' }, 'PDFs up to 32 MB; MP3, M4A, WAV, Ogg, FLAC or WebM recordings up to 25 MB.'),
      h('div', { class: 'actions' }, recordButton, stopButton, recordState),
      h('p', { class: 'hint' }, 'Recording asks for the microphone only when you press Record, stops if you leave this tab, and is saved only when you press Save recording.'),
      importStatus, draftBox) : null,
    h('h3', null, 'PDFs and recordings'),
    listBox, moreBox, workBox);

  return {
    el,
    refresh({ poll } = {}) {
      if (suspended) {
        suspended = false;
        workspace?.resume();
      }
      const lists = poll && pages > 1 ? null : refreshList();
      if (poll) workspace?.refresh();
      return lists;
    },
    // Leaving stops recording (the finished draft is kept) and releases the player and PDF; drafts and forms stay.
    leave() {
      if (recording) recorder?.stop();
      suspended = true;
      workspace?.suspend();
    },
    destroy() {
      alive = false;
      recorder?.dispose();
      recorder = null;
      uploading?.abort();
      if (draft) URL.revokeObjectURL(draft.url);
      draft = null;
      workspace?.close();
      workspace = null;
    },
    reveal(target) {
      if (typeof target.sourceId !== 'string' || !['pdf', 'audio'].includes(target.kind)) return;
      openSource(target.sourceId, target.kind, target);
    },
  };
}
