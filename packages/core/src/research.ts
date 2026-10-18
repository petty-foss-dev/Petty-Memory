import { createHash } from 'node:crypto';
import { type AttachmentRow, SHA256_PATTERN, toAttachment } from './blobs.ts';
import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, oneOf } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type ItemService, clampLimit } from './items.ts';
import { pathToRoot } from './placement.ts';
import type { Attachment, ItemDetail, ItemMetadata } from './types.ts';

export const RESEARCH_LIMITS = {
  transcriptSegments: 2000,
  transcriptChars: 200_000,
  speakerChars: 100,
  /** A cue may start this many seconds before the previous one ends. */
  overlapSeconds: 5,
  maxSeconds: 24 * 3600,
  passageSegments: 50,
  quoteChars: 5000,
  noteChars: 20_000,
  ocrChars: 100_000,
  pageBatch: 50,
  findResults: 50,
  findChars: 500,
  engineChars: 200,
  titleChars: 200,
  tags: 20,
} as const;

export const TRANSCRIPT_FORMATS = ['vtt', 'srt', 'json', 'transcription'] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];
export const PDF_TEXT_SOURCES = ['pdf', 'ocr'] as const;
export type PdfTextSource = (typeof PDF_TEXT_SOURCES)[number];

/** Seconds from the start of the recording, rounded to milliseconds. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** Bounded page text kept by PDF extraction: `pages[n - 1]` is page n, contiguous from page 1, never renumbered. */
export interface PdfPagesMetadata {
  version: 1;
  /** Pages in the document, including any whose text wasn't kept. */
  pageCount: number;
  pages: string[];
  /** Pages whose text was cut at the per-page limit. */
  clipped: number[];
  /** Fewer pages kept than the document has, or some page clipped. */
  truncated: boolean;
}

export interface AudioSource {
  itemId: string;
  title: string;
  attachmentId: string;
  sha256: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface TranscriptInput {
  audioId: string;
  segments: unknown;
  format: string;
  /** What produced the timings, e.g. a transcription model and host. */
  engine?: string;
}

export interface SaveTranscriptInput extends TranscriptInput {
  /** From the preview the person reviewed; a different recording or text is refused. */
  fingerprint: string;
  title?: string;
  project?: string;
  tags?: string[];
}

export interface TranscriptPreview {
  audio: AudioSource;
  format: TranscriptFormat;
  engine: string;
  segments: TranscriptSegment[];
  segmentCount: number;
  duration: number;
  characters: number;
  /** Cues starting before the previous one ends, within the tolerance. */
  overlaps: number;
  fingerprint: string;
  /** An active transcript already saved from the same recording and text. */
  existingId: string | null;
}

export interface TranscriptView {
  id: string;
  title: string;
  audioId: string;
  audio: AudioSource | null;
  /** `changed`: the recording's file is no longer the one transcribed. */
  audioStatus: 'ok' | 'missing' | 'changed';
  fingerprint: string;
  format: TranscriptFormat;
  engine: string;
  duration: number;
  segments: TranscriptSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSummary {
  id: string;
  title: string;
  fingerprint: string;
  format: TranscriptFormat;
  segmentCount: number;
  duration: number;
  createdAt: string;
}

export interface PlayLocator {
  audioId: string;
  attachmentId: string;
  sha256: string;
  filename: string;
  mimeType: string;
  start: number;
  end: number;
}

export interface TranscriptMoment {
  index: number;
  segment: TranscriptSegment;
  /** False when the time falls in a gap after this segment. */
  inside: boolean;
}

export interface PassageInput {
  transcriptId: string;
  fingerprint: string;
  /** Inclusive segment indexes. */
  from: number;
  to: number;
  note?: string;
  tags?: string[];
}

export interface PassageView {
  id: string;
  title: string;
  transcriptId: string;
  from: number;
  to: number;
  start: number;
  end: number;
  quote: string;
  createdAt: string;
}

export interface PdfSource {
  id: string;
  title: string;
  attachmentId: string;
  sha256: string;
  filename: string;
  /** `pending`: extraction hasn't finished; `unavailable`: no page text was kept (older save or failed extraction). */
  status: 'ready' | 'pending' | 'unavailable';
  pageCount: number;
  storedPages: number;
  truncated: boolean;
  clipped: number[];
  ocrPages: { page: number; id: string }[];
  annotations: number;
}

export interface PdfPage {
  page: number;
  text: string;
  /** False for pages beyond what the library keeps; reviewed OCR can still supply their text. */
  available: boolean;
  clipped: boolean;
  ocr: { id: string; text: string; updatedAt: string } | null;
}

export interface PdfPageRange {
  sourceId: string;
  sha256: string;
  pageCount: number;
  storedPages: number;
  truncated: boolean;
  pages: PdfPage[];
}

export interface PdfMatch {
  page: number;
  textSource: PdfTextSource;
  start: number;
  end: number;
  excerpt: string;
}

export interface OcrPageInput {
  sourceId: string;
  page: number;
  text: string;
  /** The PDF's attachment hash the page image was rendered from. */
  sha256: string;
  engine?: string;
}

/** UTF-16 offsets into the page text, with surrounding text to find the quote again if the page text shifts. */
export interface AnnotationLocator {
  page: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

export interface AnnotationInput {
  sourceId: string;
  page: number;
  quote: string;
  /** The PDF's attachment hash the person was reading. */
  sha256: string;
  note?: string;
  textSource?: PdfTextSource;
  /** Which match on the page, from 0, when the quote appears more than once. */
  occurrence?: number;
  project?: string;
  tags?: string[];
}

export type AnnotationStatus = 'current' | 'moved' | 'stale' | 'source-missing' | 'source-changed';

export interface PdfAnnotation {
  id: string;
  title: string;
  body: string;
  sourceId: string;
  sha256: string;
  page: number;
  quote: string;
  textSource: PdfTextSource;
  ocrId: string | null;
  locator: AnnotationLocator;
  status: AnnotationStatus;
  /** Where the quote is now, for `current` and `moved`. */
  current: { start: number; end: number } | null;
  createdAt: string;
}

interface TranscriptRecord {
  version: 1;
  kind: 'transcript';
  sourceId: string;
  attachmentId: string;
  sha256: string;
  fingerprint: string;
  format: TranscriptFormat;
  engine: string;
  duration: number;
  segments: TranscriptSegment[];
}

interface PassageRecord {
  version: 1;
  kind: 'transcriptPassage';
  sourceId: string;
  audioId: string;
  attachmentId: string;
  sha256: string;
  fingerprint: string;
  identity: string;
  from: number;
  to: number;
  start: number;
  end: number;
  quote: string;
  locator: { audioId: string; attachmentId: string; start: number; end: number };
}

interface AnnotationRecord {
  version: 1;
  kind: 'pdfAnnotation';
  sourceId: string;
  sha256: string;
  identity: string;
  page: number;
  quote: string;
  textSource: PdfTextSource;
  ocrId: string | null;
  locator: AnnotationLocator;
}

type Created = { item: ItemDetail; created: boolean };

const CONTEXT_CHARS = 32;
const EXCERPT_CHARS = 60;
const MAX_OCCURRENCES = 1000;
const TRANSCRIPT_FIELDS = ['audioId', 'segments', 'format', 'engine'] as const;
const SAVE_TRANSCRIPT_FIELDS = [...TRANSCRIPT_FIELDS, 'fingerprint', 'title', 'project', 'tags'] as const;
const SEGMENT_FIELDS = ['start', 'end', 'text', 'speaker'] as const;
const PASSAGE_FIELDS = ['transcriptId', 'fingerprint', 'from', 'to', 'note', 'tags'] as const;
const OCR_FIELDS = ['sourceId', 'page', 'text', 'sha256', 'engine'] as const;
const ANNOTATION_FIELDS = ['sourceId', 'page', 'quote', 'sha256', 'note', 'textSource', 'occurrence', 'project', 'tags'] as const;
const RESEARCH_NOTES = `i.type = 'note' AND i.archived_at IS NULL AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
  AND json_extract(i.metadata, '$.research.version') = 1 AND json_extract(i.metadata, '$.research.kind') = ?
  AND json_extract(i.metadata, '$.research.sourceId') = ?`;

/**
 * Timed transcripts of saved recordings and page-accurate PDF reading. Everything it writes is an ordinary note carrying
 * `metadata.research`, linked to its source; originals are never changed. Core reads only stored text: PDF page text from
 * ingestion's `metadata.pdfPages`, and OCR text the person reviewed.
 */
export class ResearchService {
  private readonly ctx: Context;
  private readonly items: ItemService;

  constructor(ctx: Context, items: ItemService) {
    this.ctx = ctx;
    this.items = items;
  }

  /** Validates timings against the recording and computes the import's identity. Writes nothing. */
  previewTranscript(input: TranscriptInput): TranscriptPreview {
    const fields = fieldsOf(input, TRANSCRIPT_FIELDS, 'transcript');
    const audio = this.audio(text(fields.audioId, 'audioId'));
    const format = oneOf(text(fields.format, 'format'), TRANSCRIPT_FORMATS, 'transcript format');
    const engine = fields.engine === undefined ? '' : text(fields.engine, 'engine', RESEARCH_LIMITS.engineChars);
    const { segments, characters, overlaps, duration } = validateSegments(fields.segments);
    const fingerprint = transcriptFingerprint(audio.sha256, segments);
    return {
      audio, format, engine, segments, segmentCount: segments.length, duration, characters, overlaps, fingerprint,
      existingId: this.findResearch('transcript', audio.itemId, 'fingerprint', fingerprint),
    };
  }

  /** Saving the same recording and text again returns the transcript already saved. */
  saveTranscript(input: SaveTranscriptInput): Created {
    const fields = fieldsOf(input, SAVE_TRANSCRIPT_FIELDS, 'transcript');
    const expected = text(fields.fingerprint, 'fingerprint');
    const title = fields.title === undefined ? '' : text(fields.title, 'title', RESEARCH_LIMITS.titleChars);
    const tags = tagList(fields.tags);
    const project = fields.project === undefined ? undefined : text(fields.project, 'project');
    return this.ctx.tx(() => {
      const preview = this.previewTranscript({ audioId: fields.audioId, segments: fields.segments, format: fields.format, engine: fields.engine } as TranscriptInput);
      if (preview.fingerprint !== expected) throw conflict('The recording or its transcript changed since the preview. Preview it again before saving.');
      if (preview.existingId) return { item: this.items.get(preview.existingId), created: false };
      const { audio, segments } = preview;
      const record: TranscriptRecord = {
        version: 1, kind: 'transcript', sourceId: audio.itemId, attachmentId: audio.attachmentId, sha256: audio.sha256,
        fingerprint: preview.fingerprint, format: preview.format, engine: preview.engine, duration: preview.duration, segments,
      };
      const lines = segments.map((segment) => `[${formatTimestamp(segment.start)}] ${speaking(segment)}`);
      const body = `Recording: ${reference(audio.itemId, audio.title)}\n\n${lines.join('\n')}`;
      const source = this.items.row(audio.itemId);
      return this.create({
        title: title || `${audio.title || audio.filename} transcript`, body, record, tags,
        project: project ?? source.project_id ?? undefined, links: [[audio.itemId, 'derived_from']],
      });
    });
  }

  transcript(id: string): TranscriptView {
    const { row, record } = this.transcriptRow(id);
    const audio = this.audioState(record);
    return {
      id: row.id, title: row.title, audioId: record.sourceId, audio: audio.source, audioStatus: audio.status,
      fingerprint: record.fingerprint, format: record.format, engine: record.engine, duration: record.duration,
      segments: record.segments, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  transcripts(audioId: string, { limit }: { limit?: number } = {}): TranscriptSummary[] {
    const audio = this.audio(audioId);
    return this.researchRows('transcript', audio.itemId, clampLimit(limit)).flatMap((row) => {
      const record = transcriptRecord(row);
      return record ? [{
        id: row.id, title: row.title, fingerprint: record.fingerprint, format: record.format,
        segmentCount: record.segments.length, duration: record.duration, createdAt: row.created_at,
      }] : [];
    });
  }

  /** The segment playing at `time` seconds, or the last one before it when the time falls in a gap. */
  passageAt(transcriptId: string, time: number): TranscriptMoment | null {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw invalid('Choose a time in seconds from 0.');
    const { segments } = this.transcriptRow(transcriptId).record;
    let low = 0;
    let high = segments.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (segments[middle]!.start <= time) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found < 0) return null;
    // Overlapping cues: prefer an earlier one that is still playing over a later one that has already ended.
    for (let at = found; at >= 0 && at > found - 8; at--) {
      if (time < segments[at]!.end) return { index: at, segment: segments[at]!, inside: true };
    }
    return { index: found, segment: segments[found]!, inside: false };
  }

  savePassage(input: PassageInput): Created {
    const fields = fieldsOf(input, PASSAGE_FIELDS, 'passage');
    const expected = text(fields.fingerprint, 'fingerprint');
    const note = fields.note === undefined ? '' : text(fields.note, 'note', RESEARCH_LIMITS.noteChars);
    const tags = tagList(fields.tags);
    return this.ctx.tx(() => {
      const { row, record } = this.transcriptRow(text(fields.transcriptId, 'transcriptId'));
      if (record.fingerprint !== expected) throw conflict('This transcript changed since you opened it. Reopen it and choose the passage again.');
      const audio = this.audioState(record);
      if (audio.status !== 'ok') throw conflict('The recording behind this transcript is missing or was replaced, so a passage can’t point into it.');
      const from = index(fields.from, 'from', record.segments.length);
      const to = index(fields.to, 'to', record.segments.length);
      if (to < from) throw invalid('A passage must end at or after the segment it starts with.');
      if (to - from + 1 > RESEARCH_LIMITS.passageSegments) throw invalid(`Choose at most ${RESEARCH_LIMITS.passageSegments} segments for one passage.`);
      const chosen = record.segments.slice(from, to + 1);
      const quote = chosen.map(speaking).join('\n');
      if (quote.length > RESEARCH_LIMITS.quoteChars) throw invalid(`Choose a shorter passage; quotes are limited to ${RESEARCH_LIMITS.quoteChars} characters.`);
      const start = chosen[0]!.start;
      const end = Math.max(...chosen.map((segment) => segment.end));
      const identity = digest([row.id, record.fingerprint, from, to, note]);
      const existing = this.findResearch('transcriptPassage', row.id, 'identity', identity);
      if (existing) return { item: this.items.get(existing), created: false };
      const passage: PassageRecord = {
        version: 1, kind: 'transcriptPassage', sourceId: row.id, audioId: record.sourceId, attachmentId: record.attachmentId,
        sha256: record.sha256, fingerprint: record.fingerprint, identity, from, to, start, end, quote,
        locator: { audioId: record.sourceId, attachmentId: record.attachmentId, start, end },
      };
      const quoted = blockquote(chosen.map((segment) => `[${formatTimestamp(segment.start)}] ${speaking(segment)}`).join('\n'));
      const body = [
        quoted, ...(note ? [note] : []),
        `Source: ${reference(row.id, row.title)} at ${formatTimestamp(start)} · recording ${reference(record.sourceId, audio.source!.title)}`,
      ].join('\n\n');
      return this.create({
        title: `${clip(row.title, 60)} ${formatTimestamp(start)}: “${clip(chosen.map((segment) => segment.text).join(' '), 60)}”`,
        body, record: passage, tags, project: row.project_id ?? undefined,
        links: [[row.id, 'derived_from'], [record.sourceId, 'references']],
      });
    });
  }

  passages(transcriptId: string, { limit }: { limit?: number } = {}): PassageView[] {
    const { row } = this.transcriptRow(transcriptId);
    return this.researchRows('transcriptPassage', row.id, clampLimit(limit), `json_extract(i.metadata, '$.research.start'), i.id`)
      .flatMap((passage) => {
        const record = passageRecord(passage);
        return record ? [{
          id: passage.id, title: passage.title, transcriptId: row.id, from: record.from, to: record.to,
          start: record.start, end: record.end, quote: record.quote, createdAt: passage.created_at,
        }] : [];
      });
  }

  /** Where to start playback for a transcript segment or a saved passage; refuses a recording that's gone or was replaced. */
  audioLocator(id: string, segment?: number): PlayLocator {
    const row = this.ordinary(id, 'That transcript or passage');
    const research = researchOf(row);
    let audioRecord: Pick<TranscriptRecord, 'sourceId' | 'attachmentId' | 'sha256'>;
    let span: { start: number; end: number };
    if (research?.kind === 'transcriptPassage') {
      if (segment !== undefined) throw invalid('A passage plays its own span; leave out the segment.');
      const record = passageRecord(row);
      if (!record) throw invalid('This passage’s stored location is damaged. Save the passage again from its transcript.');
      audioRecord = { sourceId: record.audioId, attachmentId: record.attachmentId, sha256: record.sha256 };
      span = { start: record.start, end: record.end };
    } else {
      const { record } = this.transcriptRow(row.id);
      const chosen = record.segments[index(segment ?? 0, 'segment', record.segments.length)]!;
      audioRecord = record;
      span = { start: chosen.start, end: chosen.end };
    }
    const audio = this.audioState(audioRecord);
    if (audio.status !== 'ok') throw conflict('The recording for this transcript is missing or was replaced.');
    const source = audio.source!;
    return {
      audioId: source.itemId, attachmentId: source.attachmentId, sha256: source.sha256, filename: source.filename,
      mimeType: source.mimeType, ...span,
    };
  }

  pdfSource(sourceId: string): PdfSource {
    const { row, attachment, pages } = this.pdf(sourceId);
    const ingest = metadataOf(row).ingest?.status;
    return {
      id: row.id, title: row.title, attachmentId: attachment.id, sha256: attachment.sha256, filename: attachment.filename,
      status: pages ? 'ready' : ingest === 'pending' ? 'pending' : 'unavailable',
      pageCount: pages?.pageCount ?? 0, storedPages: pages?.pages.length ?? 0, truncated: pages?.truncated ?? false,
      clipped: pages?.clipped ?? [],
      ocrPages: [...this.ocrPages(row.id, attachment.sha256).values()].map(({ page, row: ocr }) => ({ page, id: ocr.id })).sort((a, b) => a.page - b.page),
      annotations: this.ctx.get<{ count: number }>(
        `SELECT count(*) AS count FROM items i WHERE ${RESEARCH_NOTES}`, 'pdfAnnotation', row.id,
      )!.count,
    };
  }

  /** Queues extraction again for a PDF saved before page text was kept. The file and its existing text are unchanged until it runs. */
  requestPageText(sourceId: string): PdfSource {
    const { row, pages } = this.pdf(sourceId);
    if (!pages && metadataOf(row).ingest?.status !== 'pending') this.items.setSource(row.id, { metadata: { ingest: { status: 'pending' } } });
    return this.pdfSource(row.id);
  }

  pages(sourceId: string, { from = 1, limit = 20 }: { from?: number; limit?: number } = {}): PdfPageRange {
    const { row, attachment, pages } = this.pdf(sourceId);
    const stored = requirePages(pages);
    if (!Number.isInteger(limit) || limit < 1 || limit > RESEARCH_LIMITS.pageBatch) throw invalid(`Request from 1 to ${RESEARCH_LIMITS.pageBatch} pages at a time.`);
    const first = stored.pageCount === 0 ? 1 : pageNumber(from, stored.pageCount);
    const ocr = this.ocrPages(row.id, attachment.sha256);
    const range: PdfPage[] = [];
    for (let page = first; page <= Math.min(stored.pageCount, first + limit - 1); page++) {
      const overlay = ocr.get(page);
      range.push({
        page, text: stored.pages[page - 1] ?? '', available: page <= stored.pages.length, clipped: stored.clipped.includes(page),
        ocr: overlay ? { id: overlay.row.id, text: overlay.row.body, updatedAt: overlay.row.updated_at } : null,
      });
    }
    return { sourceId: row.id, sha256: attachment.sha256, pageCount: stored.pageCount, storedPages: stored.pages.length, truncated: stored.truncated, pages: range };
  }

  /** Case- and spacing-insensitive search of one PDF's kept page text and reviewed OCR, for jumping to a page. */
  findInPdf(sourceId: string, query: string, { limit }: { limit?: number } = {}): PdfMatch[] {
    const { row, attachment, pages } = this.pdf(sourceId);
    const stored = requirePages(pages);
    const needle = text(query, 'Search text', RESEARCH_LIMITS.findChars);
    if (!needle) throw invalid('Type some text to find.');
    const max = Math.min(clampLimit(limit), RESEARCH_LIMITS.findResults);
    const ocr = this.ocrPages(row.id, attachment.sha256);
    const sources: { page: number; textSource: PdfTextSource; text: string }[] = [];
    for (let page = 1; page <= stored.pageCount; page++) {
      if (page <= stored.pages.length) sources.push({ page, textSource: 'pdf', text: stored.pages[page - 1]! });
      const overlay = ocr.get(page);
      if (overlay) sources.push({ page, textSource: 'ocr', text: overlay.row.body });
    }
    const matches: PdfMatch[] = [];
    for (const source of sources) {
      for (const hit of looseMatches(source.text, needle, true, max - matches.length)) {
        matches.push({ page: source.page, textSource: source.textSource, ...hit, excerpt: excerpt(source.text, hit) });
      }
      if (matches.length >= max) break;
    }
    return matches;
  }

  /** Saves OCR text the person reviewed for one page; saving that page again revises the same note, keeping its history. */
  saveOcrPage(input: OcrPageInput): Created {
    const fields = fieldsOf(input, OCR_FIELDS, 'OCR page');
    const body = text(fields.text, 'OCR text', RESEARCH_LIMITS.ocrChars);
    if (!body) throw invalid('Review the recognized text before saving; it is empty.');
    const engine = fields.engine === undefined ? '' : text(fields.engine, 'engine', RESEARCH_LIMITS.engineChars);
    return this.ctx.tx(() => {
      const { row, attachment, pages } = this.pdf(text(fields.sourceId, 'sourceId'));
      expectHash(fields.sha256, attachment.sha256);
      const page = pageNumber(fields.page, requirePages(pages).pageCount);
      const existing = this.ocrPages(row.id, attachment.sha256).get(page);
      if (existing) {
        if (existing.row.body !== body) this.items.update(existing.row.id, { body });
        return { item: this.items.get(existing.row.id), created: false };
      }
      return this.create({
        title: `${clip(row.title, 80)} · page ${page} (reviewed OCR)`, body, tags: [], project: row.project_id ?? undefined,
        record: { version: 1, kind: 'pdfOcrPage', sourceId: row.id, page, sha256: attachment.sha256, engine },
        links: [[row.id, 'derived_from']],
      });
    });
  }

  /** An ordinary note quoting text that exists on that page of the PDF or its reviewed OCR. No coordinates are invented. */
  annotate(input: AnnotationInput): Created {
    const fields = fieldsOf(input, ANNOTATION_FIELDS, 'annotation');
    const quote = text(fields.quote, 'quote', RESEARCH_LIMITS.quoteChars);
    if (!quote) throw invalid('Select the passage to quote.');
    const note = fields.note === undefined ? '' : text(fields.note, 'note', RESEARCH_LIMITS.noteChars);
    const textSource = fields.textSource === undefined ? 'pdf' : oneOf(text(fields.textSource, 'textSource'), PDF_TEXT_SOURCES, 'text source');
    const occurrence = fields.occurrence === undefined ? 0 : fields.occurrence;
    if (!Number.isInteger(occurrence) || (occurrence as number) < 0 || (occurrence as number) >= MAX_OCCURRENCES) throw invalid('occurrence must be a whole number from 0.');
    const tags = tagList(fields.tags);
    const project = fields.project === undefined ? undefined : text(fields.project, 'project');
    return this.ctx.tx(() => {
      const { row, attachment, pages } = this.pdf(text(fields.sourceId, 'sourceId'));
      expectHash(fields.sha256, attachment.sha256);
      const stored = requirePages(pages);
      const page = pageNumber(fields.page, stored.pageCount);
      let pageText: string;
      let ocrId: string | null = null;
      if (textSource === 'ocr') {
        const overlay = this.ocrPages(row.id, attachment.sha256).get(page);
        if (!overlay) throw invalid(`Page ${page} has no reviewed OCR text. Run OCR on it and save the reviewed text first.`);
        pageText = overlay.row.body;
        ocrId = overlay.row.id;
      } else {
        if (page > stored.pages.length) {
          throw invalid(`The library keeps text for the first ${stored.pages.length} of ${stored.pageCount} pages of this PDF. Run OCR on page ${page} to quote it.`);
        }
        pageText = stored.pages[page - 1]!;
      }
      const match = findQuote(pageText, quote, occurrence as number);
      if (!match) {
        throw invalid(`That exact passage isn’t on page ${page}${textSource === 'ocr' ? ' of the reviewed OCR text' : ''}. Select it again from that page.`);
      }
      const exact = pageText.slice(match.start, match.end);
      const locator: AnnotationLocator = { page, ...match, ...context(pageText, match) };
      const identity = digest([row.id, attachment.sha256, page, textSource, ocrId, match.start, match.end, note]);
      const existing = this.findResearch('pdfAnnotation', row.id, 'identity', identity);
      if (existing) return { item: this.items.get(existing), created: false };
      const record: AnnotationRecord = {
        version: 1, kind: 'pdfAnnotation', sourceId: row.id, sha256: attachment.sha256, identity, page, quote: exact, textSource, ocrId, locator,
      };
      const body = [blockquote(exact), ...(note ? [note] : []), `Source: ${reference(row.id, row.title)}, page ${page}${textSource === 'ocr' ? ' (reviewed OCR)' : ''}`].join('\n\n');
      return this.create({
        title: `${clip(row.title, 60)} p. ${page}: “${clip(exact, 60)}”`, body, record, tags,
        project: project ?? row.project_id ?? undefined, links: [[row.id, 'derived_from']],
      });
    });
  }

  /** Page order. Each annotation reports whether its quote is still where it was. */
  annotations(sourceId: string, { limit }: { limit?: number } = {}): PdfAnnotation[] {
    const { row } = this.pdf(sourceId);
    return this.researchRows(
      'pdfAnnotation', row.id, clampLimit(limit),
      `json_extract(i.metadata, '$.research.page'), json_extract(i.metadata, '$.research.locator.start'), i.id`,
    ).flatMap((annotation) => {
      const view = this.annotationView(annotation);
      return view ? [view] : [];
    });
  }

  locateAnnotation(id: string): PdfAnnotation {
    const row = this.items.row(id);
    const view = researchOf(row)?.kind === 'pdfAnnotation' && row.type === 'note' ? this.annotationView(row) : null;
    if (!view) throw notFound(`No PDF annotation with id "${id}".`);
    return view;
  }

  private annotationView(row: ItemRow): PdfAnnotation | null {
    const record = annotationRecord(row);
    if (!record) return null;
    const base = {
      id: row.id, title: row.title, body: row.body, sourceId: record.sourceId, sha256: record.sha256, page: record.page,
      quote: record.quote, textSource: record.textSource, ocrId: record.ocrId, locator: record.locator, createdAt: row.created_at,
    };
    const source = this.usable(record.sourceId);
    if (!source) return { ...base, status: 'source-missing', current: null };
    if (this.attachment(source.id)?.sha256 !== record.sha256) return { ...base, status: 'source-changed', current: null };
    let pageText: string | undefined;
    if (record.textSource === 'ocr') {
      const ocr = record.ocrId ? this.usable(record.ocrId) : null;
      const ocrRecord = ocr ? researchOf(ocr) : null;
      if (ocr && ocrRecord?.kind === 'pdfOcrPage' && ocrRecord.sourceId === source.id && ocrRecord.page === record.page) pageText = ocr.body;
    } else {
      pageText = pdfPagesOf(metadataOf(source))?.pages[record.page - 1];
    }
    const current = pageText === undefined ? null : relocate(pageText, record);
    if (!current) return { ...base, status: 'stale', current: null };
    const moved = current.start !== record.locator.start || current.end !== record.locator.end;
    return { ...base, status: moved ? 'moved' : 'current', current };
  }

  private create(input: {
    title: string; body: string; record: object; tags: string[]; project: string | undefined; links: [string, 'derived_from' | 'references'][];
  }): Created {
    const id = this.items.insert({
      type: 'note', title: input.title, body: input.body, project: input.project, tags: input.tags, metadata: { research: input.record },
    });
    const projectId = this.items.row(id).project_id;
    for (const [target, kind] of input.links) this.items.link(id, target, kind, projectId);
    return { item: this.items.get(id), created: true };
  }

  private findResearch(kind: string, sourceId: string, key: 'fingerprint' | 'identity', value: string): string | null {
    return this.ctx.get<{ id: string }>(
      `SELECT i.id FROM items i WHERE ${RESEARCH_NOTES} AND json_extract(i.metadata, '$.research.${key}') = ? ORDER BY i.seq LIMIT 1`,
      kind, sourceId, value,
    )?.id ?? null;
  }

  private researchRows(kind: string, sourceId: string, limit: number, order = 'i.seq'): ItemRow[] {
    return this.ctx.all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${RESEARCH_NOTES} ORDER BY ${order} LIMIT ?`, kind, sourceId, limit);
  }

  /** Reviewed OCR notes for the PDF's current file, by page. */
  private ocrPages(sourceId: string, sha256: string): Map<number, { page: number; row: ItemRow }> {
    const pages = new Map<number, { page: number; row: ItemRow }>();
    const rows = this.ctx.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${RESEARCH_NOTES} AND json_extract(i.metadata, '$.research.sha256') = ? ORDER BY i.seq`,
      'pdfOcrPage', sourceId, sha256,
    );
    for (const row of rows) {
      const page = researchOf(row)?.page;
      if (Number.isInteger(page) && !pages.has(page as number) && !this.inDefinition(row.id)) pages.set(page as number, { page: page as number, row });
    }
    return pages;
  }

  private transcriptRow(id: string): { row: ItemRow; record: TranscriptRecord } {
    const row = this.ordinary(id, 'That transcript');
    if (row.type !== 'note' || researchOf(row)?.kind !== 'transcript') throw notFound(`No transcript with id "${id}".`);
    const record = transcriptRecord(row);
    if (!record) throw invalid('This transcript’s stored timings are damaged. Import its captions again.');
    return { row, record };
  }

  private audioState(record: Pick<TranscriptRecord, 'sourceId' | 'sha256'>): { source: AudioSource | null; status: TranscriptView['audioStatus'] } {
    const row = this.usable(record.sourceId);
    const attachment = row ? this.attachment(row.id) : null;
    if (!row || !attachment) return { source: null, status: 'missing' };
    const source = audioSource(row, attachment);
    return { source, status: attachment.sha256 === record.sha256 && attachment.mimeType.startsWith('audio/') ? 'ok' : 'changed' };
  }

  private audio(id: string): AudioSource {
    const row = this.ordinary(id, 'That recording');
    const attachment = this.attachment(row.id);
    if (row.type !== 'file' || !attachment?.mimeType.startsWith('audio/')) throw invalid('Choose a saved audio file, such as an MP3, M4A or WAV recording.');
    return audioSource(row, attachment);
  }

  private pdf(id: string): { row: ItemRow; attachment: Attachment; pages: PdfPagesMetadata | null } {
    const row = this.ordinary(id, 'That PDF');
    const attachment = this.attachment(row.id);
    if (row.type !== 'file' || attachment?.mimeType !== 'application/pdf') throw invalid('Choose a saved PDF file.');
    return { row, attachment, pages: pdfPagesOf(metadataOf(row)) };
  }

  private attachment(itemId: string): Attachment | null {
    const row = this.ctx.get<AttachmentRow>(`SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at LIMIT 1`, itemId);
    return row ? toAttachment(row) : null;
  }

  /** Active ordinary items only: never secrets, decisions, saved views, chats, workflow definitions or template notes. */
  private ordinary(id: string, label: string): ItemRow {
    const row = this.items.row(id);
    if (row.archived_at !== null) throw invalid(`${label} is archived. Unarchive it first.`);
    if (!this.isOrdinary(row)) throw invalid(`${label} must be an ordinary item, not a secret note, decision, saved view, chat, template or workflow definition.`);
    return row;
  }

  private usable(id: string): ItemRow | null {
    const row = this.ctx.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`, id);
    return row && row.archived_at === null && this.isOrdinary(row) ? row : null;
  }

  private isOrdinary(row: ItemRow): boolean {
    const metadata = metadataOf(row);
    return row.type !== 'decision' && metadata.secret !== true && metadata.savedView === undefined && metadata.conversation === undefined
      && metadata.knowledgeDefinition !== true && !this.inDefinition(row.id);
  }

  private inDefinition(id: string): boolean {
    return pathToRoot(this.ctx, id).some((ancestor) =>
      this.ctx.get(`SELECT 1 FROM items WHERE id = ? AND (json_extract(metadata, '$.template') IS NOT NULL
        OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1)`, ancestor) !== undefined);
  }
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Null when the metadata is missing or malformed, as synced metadata from an older or damaged build can be. */
export function pdfPagesOf(metadata: ItemMetadata): PdfPagesMetadata | null {
  const value = metadata.pdfPages;
  if (!isObject(value) || value.version !== 1) return null;
  const { pageCount, pages, clipped, truncated } = value;
  if (!Number.isInteger(pageCount) || (pageCount as number) < 0) return null;
  if (!Array.isArray(pages) || pages.length > (pageCount as number) || !pages.every((page) => typeof page === 'string')) return null;
  if (!Array.isArray(clipped) || !clipped.every((page) => Number.isInteger(page) && page >= 1 && page <= pages.length)) return null;
  if (typeof truncated !== 'boolean') return null;
  return { version: 1, pageCount: pageCount as number, pages, clipped, truncated };
}

/** Normalizes and bounds timed segments; the same rules apply to caption imports and transcription results. */
export function validateSegments(value: unknown): { segments: TranscriptSegment[]; characters: number; overlaps: number; duration: number } {
  if (!Array.isArray(value) || value.length === 0) throw invalid('A transcript needs at least one timed segment.');
  if (value.length > RESEARCH_LIMITS.transcriptSegments) {
    throw invalid(`A transcript can hold at most ${RESEARCH_LIMITS.transcriptSegments} segments. Split the recording or its captions.`);
  }
  const segments: TranscriptSegment[] = [];
  let characters = 0;
  let overlaps = 0;
  value.forEach((entry, position) => {
    const n = position + 1;
    const fields = fieldsOf(entry, SEGMENT_FIELDS, `segment ${n}`);
    const start = seconds(fields.start, n);
    const end = seconds(fields.end, n);
    if (end < start) throw invalid(`Segment ${n} ends before it starts.`);
    const previous = segments.at(-1);
    if (previous && start < previous.start) throw invalid(`Segment ${n} starts before segment ${n - 1}. Sort the cues by start time.`);
    if (previous && start < previous.end) {
      if (previous.end - start > RESEARCH_LIMITS.overlapSeconds) {
        throw invalid(`Segment ${n} overlaps segment ${n - 1} by more than ${RESEARCH_LIMITS.overlapSeconds} seconds. Check the cue timings.`);
      }
      overlaps++;
    }
    if (typeof fields.text !== 'string') throw invalid(`Segment ${n} needs its text.`);
    const words = fields.text.replace(/\s+/g, ' ').trim();
    if (!words) throw invalid(`Segment ${n} has no text.`);
    characters += words.length;
    if (characters > RESEARCH_LIMITS.transcriptChars) {
      throw invalid(`A transcript can hold at most ${RESEARCH_LIMITS.transcriptChars.toLocaleString('en-US')} characters. Split the recording or its captions.`);
    }
    const speaker = fields.speaker === undefined || fields.speaker === null ? '' : text(fields.speaker, `Segment ${n} speaker`, RESEARCH_LIMITS.speakerChars);
    segments.push({ start, end, text: words, ...(speaker ? { speaker } : {}) });
  });
  return { segments, characters, overlaps, duration: Math.max(...segments.map((segment) => segment.end)) };
}

function seconds(value: unknown, n: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > RESEARCH_LIMITS.maxSeconds) {
    throw invalid(`Segment ${n} needs start and end times in seconds, from 0 to ${RESEARCH_LIMITS.maxSeconds}.`);
  }
  return Math.round(value * 1000) / 1000;
}

function transcriptFingerprint(sha256: string, segments: TranscriptSegment[]): string {
  return digest([1, sha256, segments.map((segment) => [segment.start, segment.end, segment.speaker ?? null, segment.text])]);
}

function transcriptRecord(row: ItemRow): TranscriptRecord | null {
  const research = researchOf(row);
  if (research?.kind !== 'transcript' || !isString(research.sourceId) || !isString(research.attachmentId) || !isSha(research.sha256)
    || !isString(research.fingerprint) || !(TRANSCRIPT_FORMATS as readonly unknown[]).includes(research.format) || typeof research.engine !== 'string') return null;
  try {
    const { segments, duration } = validateSegments(research.segments);
    if (transcriptFingerprint(research.sha256, segments) !== research.fingerprint) return null;
    return { ...(research as unknown as TranscriptRecord), segments, duration };
  } catch {
    return null;
  }
}

function passageRecord(row: ItemRow): PassageRecord | null {
  const research = researchOf(row);
  const locator = research?.locator;
  if (research?.kind !== 'transcriptPassage' || !isString(research.sourceId) || !isString(research.audioId) || !isString(research.attachmentId)
    || !isSha(research.sha256) || !isString(research.quote) || !isObject(locator)) return null;
  const times = [research.from, research.to, research.start, research.end];
  if (!times.every((time) => typeof time === 'number' && Number.isFinite(time) && time >= 0)) return null;
  return research as unknown as PassageRecord;
}

function annotationRecord(row: ItemRow): AnnotationRecord | null {
  const research = researchOf(row);
  const locator = research?.locator;
  if (research?.kind !== 'pdfAnnotation' || !isString(research.sourceId) || !isSha(research.sha256) || !isString(research.quote)) return null;
  if (!(PDF_TEXT_SOURCES as readonly unknown[]).includes(research.textSource) || !(research.ocrId === null || isString(research.ocrId))) return null;
  if (!isObject(locator) || !Number.isInteger(research.page) || locator.page !== research.page || typeof locator.prefix !== 'string' || typeof locator.suffix !== 'string') return null;
  if (!Number.isInteger(locator.start) || !Number.isInteger(locator.end) || (locator.start as number) < 0 || (locator.end as number) < (locator.start as number)) return null;
  return research as unknown as AnnotationRecord;
}

function audioSource(row: ItemRow, attachment: Attachment): AudioSource {
  return {
    itemId: row.id, title: row.title, attachmentId: attachment.id, sha256: attachment.sha256, filename: attachment.filename,
    mimeType: attachment.mimeType, size: attachment.size,
  };
}

function requirePages(pages: PdfPagesMetadata | null): PdfPagesMetadata {
  if (!pages) throw invalid('Page text for this PDF isn’t available yet. Wait for extraction to finish, or request page text again.');
  return pages;
}

function expectHash(value: unknown, sha256: string): void {
  if (!isSha(value)) throw invalid('sha256 must be the PDF’s 64-character attachment hash.');
  if (value !== sha256) throw conflict('This PDF’s file changed since it was opened. Reopen it and try again.');
}

function pageNumber(value: unknown, pageCount: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > pageCount) {
    throw invalid(pageCount ? `Choose a page from 1 to ${pageCount}.` : 'This PDF has no pages.');
  }
  return value as number;
}

function index(value: unknown, label: string, length: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= length) throw invalid(`${label} must be a segment number from 0 to ${length - 1}.`);
  return value as number;
}

/** Exact first; then the same text with any run of spaces and line breaks treated as one space. Offsets are into `text`. */
function findQuote(text: string, quote: string, occurrence: number): { start: number; end: number } | null {
  const exact = occurrences(text, quote, occurrence + 1)[occurrence];
  return exact ?? looseMatches(text, quote, false, occurrence + 1)[occurrence] ?? null;
}

function occurrences(text: string, needle: string, max: number): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (let at = text.indexOf(needle); at >= 0 && found.length < max; at = text.indexOf(needle, at + 1)) found.push({ start: at, end: at + needle.length });
  return found;
}

function looseMatches(text: string, needle: string, fold: boolean, max: number): { start: number; end: number }[] {
  const target = collapse(needle, fold).text.trim();
  if (!target || max <= 0) return [];
  const haystack = collapse(text, fold);
  return occurrences(haystack.text, target, max).map((hit) => ({ start: haystack.starts[hit.start]!, end: haystack.ends[hit.end - 1]! }));
}

/** Whitespace runs become one space; `starts`/`ends` map each output position back to its span in the input. */
function collapse(text: string, fold: boolean): { text: string; starts: number[]; ends: number[] } {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at]!)) {
      let next = at;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      out += ' ';
      starts.push(at);
      ends.push(next);
      at = next;
      continue;
    }
    const lower = fold ? text[at]!.toLowerCase() : text[at]!;
    out += lower.length === 1 ? lower : text[at]!;
    starts.push(at);
    ends.push(at + 1);
    at++;
  }
  return { text: out, starts, ends };
}

function context(text: string, { start, end }: { start: number; end: number }): { prefix: string; suffix: string } {
  return { prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start), suffix: text.slice(end, end + CONTEXT_CHARS) };
}

/** The stored offsets if the quote is still there, else the occurrence whose surroundings best match. */
function relocate(text: string, record: AnnotationRecord): { start: number; end: number } | null {
  const { start, end, prefix, suffix } = record.locator;
  if (text.slice(start, end) === record.quote) return { start, end };
  const hits = occurrences(text, record.quote, MAX_OCCURRENCES);
  let best: { start: number; end: number; score: number } | null = null;
  for (const hit of hits) {
    const around = context(text, hit);
    const score = sharedSuffix(around.prefix, prefix) + sharedPrefix(around.suffix, suffix);
    if (!best || score > best.score || (score === best.score && Math.abs(hit.start - start) < Math.abs(best.start - start))) best = { ...hit, score };
  }
  return best && { start: best.start, end: best.end };
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function sharedSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function excerpt(text: string, { start, end }: { start: number; end: number }): string {
  const from = Math.max(0, start - EXCERPT_CHARS);
  const to = Math.min(text.length, end + EXCERPT_CHARS);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

const speaking = (segment: TranscriptSegment) => (segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text);
const blockquote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');
const reference = (id: string, label: string) => `[[item:${id}${clean(label) ? `|${clean(label)}` : ''}]]`;
const clean = (label: string) => label.replace(/[\]|\n\r]+/g, ' ').trim();
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message: string) => new MemoryError('conflict', message);
const metadataOf = (row: ItemRow) => JSON.parse(row.metadata) as ItemMetadata;
const researchOf = (row: ItemRow) => {
  const research = metadataOf(row).research;
  return isObject(research) && research.version === 1 ? research : null;
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isSha = (value: unknown): value is string => typeof value === 'string' && SHA256_PATTERN.test(value);

function tagList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) throw invalid('tags must be a list of tag names.');
  if (value.length > RESEARCH_LIMITS.tags) throw invalid(`Add at most ${RESEARCH_LIMITS.tags} tags at a time.`);
  return value;
}

function fieldsOf(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw invalid(`The ${label} must be an object.`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} field "${unknown}". Expected: ${allowed.join(', ')}.`);
  return value;
}

function text(value: unknown, label: string, max = Infinity): string {
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${label} is longer than ${max} characters.`);
  return trimmed;
}
