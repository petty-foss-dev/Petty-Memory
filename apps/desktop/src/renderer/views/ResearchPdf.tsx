import type { ItemDetail, PdfAnnotation, PdfMatch, PdfPageRange, PdfSource, PdfTextSource } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { canvasPng, openResearchPdf } from '../../../../web/public/research-media.js';
import { call, errorMessage } from '../lib/api.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Icon, useFeedback } from '../ui.tsx';
import { LiveStatus, knowledgePath, plural, useKnowledge } from './KnowledgeCommon.tsx';

type PdfDocument = Awaited<ReturnType<typeof openResearchPdf>>;

const QUOTE_MAX = 5000;
const NOTE_MAX = 20_000;
const OCR_MAX = 100_000;
const PNG_MAX = 20 * 1024 * 1024;

const STATUS_LABELS: Record<PdfAnnotation['status'], string> = {
  current: 'Quote in place', moved: 'Quote moved on the page', stale: 'Quote no longer found', 'source-missing': 'PDF missing', 'source-changed': 'PDF replaced',
};

interface Selection {
  quote: string;
  occurrence: number;
  textSource: PdfTextSource;
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(new Error('The page image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/** A PNG of the rendered page small enough for text recognition, scaled down only when needed. */
async function pagePng(canvas: HTMLCanvasElement): Promise<Blob> {
  let blob = await canvasPng(canvas);
  for (const scale of [0.75, 0.5, 0.35]) {
    if (blob.size <= PNG_MAX) return blob;
    const smaller = document.createElement('canvas');
    smaller.width = Math.round(canvas.width * scale);
    smaller.height = Math.round(canvas.height * scale);
    smaller.getContext('2d')!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    blob = await canvasPng(smaller);
  }
  if (blob.size > PNG_MAX) throw new Error('This page is too detailed to recognize in one image.');
  return blob;
}

/** Start positions of `needle` in `text`, overlapping, as core counts occurrences. */
function positions(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** The selected quote and which occurrence it is, measured in the page text shown, never invented. */
function readSelection(container: HTMLElement, text: string, textSource: PdfTextSource): Selection | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote || quote.length > QUOTE_MAX) return null;
  const start = before.toString().length + (raw.length - raw.trimStart().length);
  if (text.slice(start, start + quote.length) !== quote) return null;
  return { quote, occurrence: positions(text, quote).filter((at) => at < start).length, textSource };
}

function PageText({ text, highlight, textRef }: { text: string; highlight: string | null; textRef: React.RefObject<HTMLDivElement | null> }) {
  const at = highlight ? text.indexOf(highlight) : -1;
  return (
    <div ref={textRef} className="research-page-text" tabIndex={0} aria-label="Page text. Select a passage to quote it.">
      {at < 0 ? text : <>{text.slice(0, at)}<mark>{highlight}</mark>{text.slice(at + highlight!.length)}</>}
    </div>
  );
}

/** Reads one saved PDF page by page: the rendered page beside its kept text, quotes, reviewed OCR and search. The original file never changes. */
export function PdfReader({ item, initialPage, quote }: { item: ItemDetail; initialPage?: number; quote?: string }) {
  const { openItem } = useApp();
  const { toast, confirm } = useFeedback();
  const source = useKnowledge<PdfSource>(`/research/pdf/${encodeURIComponent(item.id)}`);
  const ready = source.data?.status === 'ready';
  const [page, setPage] = useState(initialPage ?? 1);
  const [pageInput, setPageInput] = useState(String(initialPage ?? 1));
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [fileSha, setFileSha] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [textSource, setTextSource] = useState<PdfTextSource>('pdf');
  const [pending, setPending] = useState<Selection | null>(null);
  const [annotating, setAnnotating] = useState<(Selection & { page: number }) | null>(null);
  const [note, setNote] = useState('');
  const [ocr, setOcr] = useState<{ page: number; text: string; engine: string } | null>(null);
  const [busy, setBusy] = useState<'index' | 'ocr' | 'save-ocr' | 'annotate' | 'find' | null>(null);
  const [find, setFind] = useState('');
  const [matches, setMatches] = useState<PdfMatch[] | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const pageText = useKnowledge<PdfPageRange>(ready ? knowledgePath(`/research/pdf/${encodeURIComponent(item.id)}/pages`, { from: page, limit: 1 }) : null);
  const annotations = useKnowledge<PdfAnnotation[]>(ready ? `/research/pdf/${encodeURIComponent(item.id)}/annotations` : null);
  const loaded = pageText.data?.pages[0];
  const current = loaded?.page === page ? loaded : undefined;
  const pageCount = source.data?.pageCount || doc?.pageCount || 0;
  const shownSource: PdfTextSource = textSource === 'ocr' && current?.ocr ? 'ocr' : current && (!current.available || !current.text.trim()) && current.ocr ? 'ocr' : 'pdf';
  const shownText = shownSource === 'ocr' ? current?.ocr?.text ?? '' : current?.text ?? '';
  const changed = Boolean(fileSha && source.data && fileSha !== source.data.sha256);

  useEffect(() => {
    let open: PdfDocument | null = null;
    let gone = false;
    call('research.file', item.id)
      .then(async (file) => {
        if (gone) return;
        setFileSha(file.sha256);
        open = await openResearchPdf(file.data);
        if (gone) await open.close();
        else setDoc(open);
      })
      .catch((error: unknown) => !gone && setDocError(errorMessage(error)));
    return () => {
      gone = true;
      void open?.close();
    };
  }, [item.id]);

  useEffect(() => {
    if (initialPage) {
      setPage(initialPage);
      setPageInput(String(initialPage));
    }
  }, [initialPage, quote]);

  useEffect(() => {
    if (!doc || !canvas.current || page < 1 || page > doc.pageCount) return;
    let gone = false;
    setRendering(true);
    doc.render(page, canvas.current)
      .then(() => !gone && setDocError(null))
      .catch((error: unknown) => {
        if (!gone && !(error instanceof Error && error.name === 'RenderingCancelledException')) setDocError(errorMessage(error));
      })
      .finally(() => !gone && setRendering(false));
    return () => {
      gone = true;
    };
  }, [doc, page]);

  useEffect(() => {
    const onChange = () => {
      if (textRef.current) setPending(readSelection(textRef.current, shownText, shownSource));
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [shownText, shownSource]);

  const goTo = async (next: number, nextSource: PdfTextSource = 'pdf') => {
    if (!pageCount || !Number.isInteger(next) || next < 1 || next > pageCount) {
      setPageInput(String(page));
      return;
    }
    if (next !== page && (ocr || annotating) && !(await confirm({
      title: 'Leave this page?',
      body: <p>{ocr ? 'The recognized text you haven’t saved' : 'The annotation you’re writing'} will be discarded.</p>,
      confirmLabel: 'Discard and go',
    }))) {
      setPageInput(String(page));
      return;
    }
    if (next !== page) {
      setOcr(null);
      setAnnotating(null);
      setNote('');
      setPending(null);
    }
    setPage(next);
    setPageInput(String(next));
    setTextSource(nextSource);
  };

  const prepare = async () => {
    setBusy('index');
    try {
      await knowledgeRequest(`/research/pdf/${encodeURIComponent(item.id)}/index`, 'POST');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const recognize = async () => {
    if (!canvas.current || !source.data) return;
    setBusy('ocr');
    try {
      const png = await blobBase64(await pagePng(canvas.current));
      const result = await knowledgeRequest<{ text: string; engine: string }>('/research/ocr', 'POST', { sourceId: item.id, sha256: source.data.sha256, page, png });
      if (!result.text.trim()) toast('No text was recognized on this page.', 'error');
      else setOcr({ page, text: result.text.slice(0, OCR_MAX), engine: result.engine });
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveOcr = async () => {
    if (!ocr || !source.data) return;
    setBusy('save-ocr');
    try {
      await knowledgeRequest('/research/ocr-pages', 'POST', { sourceId: item.id, page: ocr.page, text: ocr.text, sha256: source.data.sha256, engine: ocr.engine });
      setOcr(null);
      setTextSource('ocr');
      toast(`Saved reviewed text for page ${ocr.page}`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const annotate = async () => {
    if (!annotating || !source.data) return;
    setBusy('annotate');
    try {
      const { item: saved, created } = await knowledgeRequest<{ item: ItemDetail; created: boolean }>('/research/annotations', 'POST', {
        sourceId: item.id, page: annotating.page, quote: annotating.quote, sha256: source.data.sha256, textSource: annotating.textSource,
        occurrence: annotating.occurrence, ...(note.trim() ? { note: note.trim() } : {}),
      });
      setAnnotating(null);
      setNote('');
      toast(created ? 'Quote saved as a note' : 'That quote and note were already saved');
      if (!created) openItem(saved.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const search = async () => {
    if (!find.trim()) return;
    setBusy('find');
    try {
      setMatches(await knowledgeRequest<PdfMatch[]>(knowledgePath(`/research/pdf/${encodeURIComponent(item.id)}/find`, { q: find.trim() })));
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="research-reader">
      <LiveStatus live={source} label="Opening the PDF…" />
      {source.data && source.data.status !== 'ready' && (
        <div className="error-box">
          {source.data.status === 'pending' ? (
            <p role="status">Reading the page text. This page updates when it’s done.</p>
          ) : (
            <>
              <p>This PDF was saved before page text was kept, or reading it failed. Prepare its page text to quote, search and annotate pages. The file itself isn’t changed.</p>
              <button className="button small" disabled={busy === 'index'} onClick={() => void prepare()}>{busy === 'index' ? 'Preparing…' : 'Prepare page text'}</button>
            </>
          )}
        </div>
      )}
      {changed && <p className="error-text" role="alert">This PDF’s file was replaced after it was opened. Close it and open it again before quoting.</p>}
      {source.data?.truncated && (
        <p className="note">The library keeps text for the first {plural(source.data.storedPages, 'page')} of {source.data.pageCount}{source.data.clipped.length ? ', and some long pages are cut short' : ''}. Recognize later pages with OCR to quote them.</p>
      )}

      <div className="toolbar research-pages">
        <button className="button small" disabled={page <= 1} onClick={() => void goTo(page - 1)} aria-label="Previous page">Previous</button>
        <form className="inline-actions" onSubmit={(event) => { event.preventDefault(); void goTo(Number(pageInput)); }}>
          <input className="research-page-number" type="number" min={1} max={pageCount || undefined} value={pageInput} onChange={(event) => setPageInput(event.target.value)} aria-label="Page number (press Enter to go)" />
          <span className="muted small">of {pageCount || '…'}</span>
        </form>
        <button className="button small" disabled={!pageCount || page >= pageCount} onClick={() => void goTo(page + 1)} aria-label="Next page">Next</button>
        <form className="inline-actions research-find" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <input type="search" aria-label="Find in this PDF" placeholder="Find in this PDF" maxLength={500} value={find} disabled={!ready} onChange={(event) => setFind(event.target.value)} />
          <button className="button small" type="submit" disabled={!ready || !find.trim() || busy === 'find'}><Icon name="search" size={14} /> Find</button>
        </form>
      </div>
      {matches && (
        <div className="research-matches">
          <div className="panel-header">
            <span className="muted small" role="status">{matches.length ? plural(matches.length, 'match', 'matches') : 'No matches.'}</span>
            <button className="button small ghost" onClick={() => setMatches(null)}>Close results</button>
          </div>
          <ul className="mini-list">
            {matches.map((match, index) => (
              <li key={index}>
                <button onClick={() => void goTo(match.page, match.textSource)}>
                  <span>p. {match.page}{match.textSource === 'ocr' ? ' (OCR)' : ''} · {match.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="research-page">
        <div className="research-canvas">
          {docError && <p className="error-text small" role="alert">The page image isn’t available: {docError} Its saved text is still shown.</p>}
          {!doc && !docError && <p className="muted small" role="status">Loading the page image…</p>}
          <canvas ref={canvas} aria-label={`Page ${page} as rendered`} hidden={!doc} />
          {doc && (
            <div className="inline-actions">
              <button className="button small" disabled={rendering || busy === 'ocr' || changed || !ready} onClick={() => void recognize()}>
                <Icon name="text" size={14} /> {busy === 'ocr' ? 'Recognizing…' : 'Recognize text on this page'}
              </button>
            </div>
          )}
        </div>
        <div className="research-text">
          {current?.ocr && current.available && (
            <div className="segmented small" role="radiogroup" aria-label="Text shown">
              <button role="radio" aria-checked={shownSource === 'pdf'} className={shownSource === 'pdf' ? 'active' : ''} onClick={() => setTextSource('pdf')}>PDF text</button>
              <button role="radio" aria-checked={shownSource === 'ocr'} className={shownSource === 'ocr' ? 'active' : ''} onClick={() => setTextSource('ocr')}>Reviewed OCR</button>
            </div>
          )}
          {ready && <LiveStatus live={pageText} label="Loading page text…" />}
          {current && !current.available && !current.ocr && (
            <p className="muted small">The library didn’t keep text for this page. Recognize it with OCR to quote it.</p>
          )}
          {current?.clipped && shownSource === 'pdf' && <p className="muted small">This page’s text was cut short at the library’s limit.</p>}
          {current && (shownSource === 'ocr' || current.available) && (shownText ? <PageText text={shownText} highlight={quote ?? null} textRef={textRef} /> : <p className="muted small">This page has no text. If it’s a scan, recognize it with OCR.</p>)}
          {pending && !annotating && (
            <div className="research-selection">
              <span className="small">Selected “{pending.quote.length > 120 ? `${pending.quote.slice(0, 119)}…` : pending.quote}”</span>
              <button className="button small primary" disabled={changed} onClick={() => setAnnotating({ ...pending, page })}><Icon name="note" size={14} /> Quote with a note…</button>
            </div>
          )}
          {annotating && (
            <form className="ocr-draft" onSubmit={(event) => { event.preventDefault(); void annotate(); }}>
              <blockquote className="research-quote">{annotating.quote}</blockquote>
              <label className="field">
                <span>Your note (optional)</span>
                <textarea rows={3} maxLength={NOTE_MAX} value={note} autoFocus onChange={(event) => setNote(event.target.value)} />
              </label>
              <div className="inline-actions">
                <button type="submit" className="button small primary" disabled={busy === 'annotate'}>{busy === 'annotate' ? 'Saving…' : 'Save quote'}</button>
                <button type="button" className="button small ghost" disabled={busy === 'annotate'} onClick={() => { setAnnotating(null); setNote(''); }}>Cancel</button>
                <span className="muted small">Saved as a note linked to page {annotating.page}{annotating.textSource === 'ocr' ? ' (reviewed OCR)' : ''}.</span>
              </div>
            </form>
          )}
          {ocr && ocr.page === page && (
            <form className="ocr-draft" onSubmit={(event) => { event.preventDefault(); void saveOcr(); }}>
              <p className="small"><strong>Recognized text for page {ocr.page}.</strong> Correct it before saving; recognition makes mistakes. The PDF itself isn’t changed.</p>
              <textarea aria-label={`Recognized text for page ${ocr.page}`} rows={10} maxLength={OCR_MAX} value={ocr.text} onChange={(event) => setOcr({ ...ocr, text: event.target.value })} />
              <div className="inline-actions">
                <button type="submit" className="button small primary" disabled={busy === 'save-ocr' || !ocr.text.trim()}>{busy === 'save-ocr' ? 'Saving…' : 'Save recognized page'}</button>
                <button type="button" className="button small ghost" disabled={busy === 'save-ocr'} onClick={() => setOcr(null)}>Discard</button>
                {ocr.engine && <span className="muted small">{ocr.engine}</span>}
              </div>
            </form>
          )}
        </div>
      </div>

      {ready && (
        <section className="detail-section">
          <h2>Annotations</h2>
          <LiveStatus live={annotations} />
          {annotations.data?.length === 0 && <p className="muted small">Select a passage in the page text to quote it with a note.</p>}
          <ul className="insight-list">
            {(annotations.data ?? []).map((annotation) => (
              <li key={annotation.id}>
                <div className="insight-main">
                  <blockquote className="research-quote">{annotation.quote}</blockquote>
                  <span className="muted small">
                    Page {annotation.page}{annotation.textSource === 'ocr' ? ' (reviewed OCR)' : ''} · <span className={`badge ${annotation.status === 'current' || annotation.status === 'moved' ? '' : 'failed'}`}>{STATUS_LABELS[annotation.status]}</span>
                  </span>
                </div>
                <div className="inline-actions">
                  <button className="button small" onClick={() => void goTo(annotation.page, annotation.textSource)}>Page {annotation.page}</button>
                  <button className="button small ghost" onClick={() => openItem(annotation.id)}>Open note</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
