import { createHash } from 'node:crypto';
import { type EnveMemory, MemoryError } from '@enve-memory/core';
import { emptyResult, type ImportResult, record } from './result.ts';

export interface EnveHighlight {
  id: string;
  bookTitle: string;
  author: string;
  text: string;
  note: string;
  location: string;
  sourceUrl: string | null;
}
export interface EnveHighlightPreview { format: string; entries: EnveHighlight[]; skipped: number }

export const ENVE_HIGHLIGHT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const fail = (message: string) => new MemoryError('invalid', message);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function previewEnveHighlights(data: unknown): EnveHighlightPreview {
  let input = data;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > ENVE_HIGHLIGHT_MAX_BYTES) throw fail('Choose an Enve export smaller than 2 MB.');
    const raw = input.replace(/^\uFEFF/, '').trim();
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try { input = JSON.parse(raw); }
      catch { throw fail('That file is not valid JSON. Export the annotations again from Enve.'); }
    } else return markdown(raw);
  }
  if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > ENVE_HIGHLIGHT_MAX_BYTES) throw fail('Choose an Enve annotations JSON or Markdown export.');
  const entries: EnveHighlight[] = [];
  let format: string;
  if (input.format === 'petty-memory-enve-highlights' && input.version === 1 && Array.isArray(input.entries)) {
    format = 'Enve highlights interchange v1';
    if (input.entries.length > MAX_ENTRIES) throw fail(`Import at most ${MAX_ENTRIES} passages at a time.`);
    for (const raw of input.entries as unknown[]) {
      if (!object(raw)) throw fail('Every highlight must be an object.');
      entries.push(entry(raw));
    }
  } else {
    format = 'Enve Book Player annotations JSON';
    const bookTitle = value(input.bookTitle, 'Book title', 500, true);
    const author = value(input.bookAuthor, 'Author', 500);
    if (!Array.isArray(input.annotations) || (input.bookmarks !== undefined && !Array.isArray(input.bookmarks))) throw fail('That is not an Enve annotations export. Choose JSON or Markdown from Enve’s Export sheet.');
    const annotations = input.annotations as unknown[];
    const bookmarks = (input.bookmarks ?? []) as unknown[];
    if (annotations.length + bookmarks.length > MAX_ENTRIES) throw fail(`Import at most ${MAX_ENTRIES} passages at a time.`);
    for (const raw of annotations) {
      if (!object(raw) || typeof raw.position !== 'number' || !Number.isFinite(raw.position) || raw.position < 0 || raw.position > 1) throw fail('An annotation has an invalid reading position. Export it again from Enve.');
      entries.push(entry({ ...raw, bookTitle, author, location: `${Math.trunc(raw.position * 100)}%`, sourceUrl: raw.sourceUrl ?? input.sourceUrl }));
    }
    for (const raw of bookmarks) {
      if (!object(raw)) throw fail('Every bookmark must be an object.');
      entries.push(entry({
        bookTitle, author, text: value(raw.chapter, 'Chapter', 500) || value(raw.title, 'Bookmark title', 500, true),
        note: raw.note, location: value(raw.position, 'Bookmark position', 300), sourceUrl: raw.sourceUrl ?? input.sourceUrl,
      }));
    }
  }
  return unique(format, entries);
}

export function importEnveHighlights(memory: EnveMemory, data: unknown, options: { project?: string } = {}): ImportResult {
  const preview = previewEnveHighlights(data);
  const project = options.project ? memory.projects.resolve(options.project).id : undefined;
  const result = emptyResult();
  result.skipped = preview.skipped;
  for (const highlight of preview.entries) {
    record(result, `${highlight.bookTitle} ${highlight.location}`.trim(), () => {
      if (memory.items.findImported('enve-highlights', highlight.id)) return false;
      const source = [highlight.bookTitle, highlight.author ? `by ${highlight.author}` : '', highlight.location].filter(Boolean).join(' · ');
      const body = [
        highlight.text.split('\n').map((line) => `> ${line}`).join('\n'),
        highlight.note ? `## Annotation\n\n${highlight.note}` : '',
        `Source: ${source}`,
        highlight.sourceUrl ? `[Open source](<${highlight.sourceUrl}>)` : '',
      ].filter(Boolean).join('\n\n');
      memory.items.insert({
        type: 'note', title: `${highlight.bookTitle.slice(0, 180)}${highlight.location ? ` · ${highlight.location}` : ''}`,
        body, project, tags: ['enve', 'highlights'],
        metadata: {
          importedFrom: { kind: 'enve-highlights', path: highlight.id },
          enveHighlight: { version: 1, ...highlight },
        },
      }, { automations: false });
      return true;
    });
  }
  return result;
}

function entry(raw: Record<string, unknown>): EnveHighlight {
  const bookTitle = value(raw.bookTitle, 'Book title', 500, true);
  const author = value(raw.author, 'Author', 500);
  const text = value(raw.text, 'Highlight text', 50_000);
  const note = value(raw.note, 'Annotation', 20_000);
  if (!text && !note) throw fail('A passage must contain highlight text or an annotation.');
  const location = value(raw.location, 'Reading location', 300);
  const sourceUrl = sourceLink(raw.sourceUrl);
  const sourceId = value(raw.id, 'Passage id', 2000);
  const identity = [bookTitle, author, sourceId || text, sourceId ? '' : location, sourceId ? '' : note].map((part) => part.normalize('NFKC').replace(/\s+/g, ' ').trim());
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { id, bookTitle, author, text, note, location, sourceUrl };
}

function unique(format: string, all: EnveHighlight[]): EnveHighlightPreview {
  const seen = new Set<string>();
  const entries = all.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { format, entries, skipped: all.length - entries.length };
}

function markdown(raw: string): EnveHighlightPreview {
  const bookTitle = /^# (.+)$/m.exec(raw)?.[1]?.trim();
  if (!bookTitle || !/^## (Highlights & Annotations|Bookmarks)\s*$/m.test(raw)) throw fail('Choose the Markdown or JSON annotations file made by Enve’s Export sheet.');
  const author = /^\*\*([^\n]+)\*\*\s*$/m.exec(raw.split('\n---')[0]!)?.[1] ?? '';
  const entries: EnveHighlight[] = [];
  const highlightSection = raw.split(/^## Highlights & Annotations\s*$/m)[1]?.split(/^## Bookmarks\s*$/m)[0] ?? '';
  const heading = /^### .+? at ([\d.]+)%\s*\n/gm;
  const headings = [...highlightSection.matchAll(heading)];
  for (let index = 0; index < headings.length; index++) {
    const match = headings[index]!;
    let chunk = highlightSection.slice(match.index! + match[0].length, headings[index + 1]?.index ?? highlightSection.length);
    chunk = chunk.split(/^---\s*$/m)[0]!.trim().replace(/\n+\*[^*\n]+\*\s*$/, '').trim();
    const [quote = '', annotation = ''] = chunk.split(/^\*\*Annotation:\*\*\s*$/m);
    entries.push(entry({ bookTitle, author, text: unquote(quote), note: unquote(annotation), location: `${match[1]}%` }));
  }
  const bookmarkSection = raw.split(/^## Bookmarks\s*$/m)[1]?.split(/^\*Exported from Enve on /m)[0] ?? '';
  const bookmarkHeads = [...bookmarkSection.matchAll(/^- \*\*(.*?)\*\*\s+\((.*?)\)\s*$/gm)];
  for (let index = 0; index < bookmarkHeads.length; index++) {
    const match = bookmarkHeads[index]!;
    const note = bookmarkSection.slice(match.index! + match[0].length, bookmarkHeads[index + 1]?.index ?? bookmarkSection.length).trim().replace(/^- /, '');
    entries.push(entry({ bookTitle, author, text: match[1], note, location: match[2] }));
  }
  if (entries.length > MAX_ENTRIES) throw fail(`Import at most ${MAX_ENTRIES} passages at a time.`);
  return unique('Enve Book Player annotations Markdown', entries);
}

const unquote = (input: string) => input.split('\n').map((line) => line.replace(/^> ?/, '')).join('\n').trim();
function value(input: unknown, label: string, max: number, required = false): string {
  if (input === undefined || input === null) {
    if (required) throw fail(`${label} is missing.`);
    return '';
  }
  if (typeof input !== 'string' || input.length > max || (required && !input.trim())) throw fail(`${label} must be text with at most ${max} characters.`);
  return input.trim();
}
function sourceLink(input: unknown): string | null {
  const text = value(input, 'Source link', 2000);
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); }
  catch { throw fail('A source link is not a valid URL.'); }
  if (!['http:', 'https:', 'enve:'].includes(url.protocol) || url.username || url.password || /[<>\r\n]/.test(text)) throw fail('Source links must use HTTP, HTTPS or Enve and contain no credentials.');
  return url.href;
}
