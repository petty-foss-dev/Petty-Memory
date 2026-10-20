import { createHash } from 'node:crypto';
import { type EnveMemory, type Item, MemoryError, normalizeTag, pageCursor } from '@enve-memory/core';
import {
  BISCOTTI_MAX_BYTES, BISCOTTI_MAX_MEETINGS, type BiscottiImportRequest, type BiscottiImportResult, type BiscottiMeeting,
  type BiscottiMeetingPage, type BiscottiPreview, type BiscottiPreviewEntry, type BiscottiSavedMeeting, type BiscottiTurn,
} from './biscotti-types.ts';
import { emptyResult, record } from './result.ts';

type Source = BiscottiPreview['source'];
type Warning = BiscottiPreview['warnings'][number];
interface Parsed { meetings: { meeting: BiscottiMeeting; row: number }[]; skipped: number; warnings: Warning[] }

const MAX_ID = 200;
const MAX_TITLE = 500;
const MAX_SECTION = 100_000;
const MAX_TRANSCRIPT = 500_000;
const MAX_COMBINED = 600_000;
const MAX_TURNS = 2000;
const MAX_NAMES = 100;
const MAX_NAME = 200;
const MAX_SPEAKER = 100;
const SUMMARY_EXCERPT = 500;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const FIELDS = ['id', 'title', 'created', 'summary', 'notes', 'transcript'] as const;
type Field = (typeof FIELDS)[number];
const REQUIRED: Field[] = ['id', 'title', 'created'];
const HEADERS = new Map<string, Field>([
  ...FIELDS.map((field) => [field, field] as const),
  ['document_id', 'id'], ['document_title', 'title'], ['document_created', 'created'],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/i;
const MARKER = /^\[(?:(\d{1,3}):)?(\d{1,4}):(\d{2})\]\s*(.+)$/;

const fail = (message: string) => new MemoryError('invalid', message);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value);

export function previewBiscottiImport(memory: EnveMemory, data: unknown, source: Source = 'csv'): BiscottiPreview {
  const parsed = parse(data, sourceOf(source));
  const warnings = [...parsed.warnings];
  const entries = parsed.meetings.map(({ meeting, row }): BiscottiPreviewEntry => {
    const { turns, speakers, total } = conversation(meeting.transcript);
    if (total > MAX_TURNS) {
      warnings.push({ row, message: `Only the first ${MAX_TURNS} of ${total} transcript turns are shown. The full transcript is still imported.` });
    }
    return { ...meeting, speakers, turns, existingId: memory.items.findImported('biscotti', meeting.id) };
  });
  warnings.sort((a, b) => a.row - b.row);
  return { entries, skipped: parsed.skipped, warnings, fingerprint: fingerprint(parsed, source), source };
}

export function importBiscottiMeetings(memory: EnveMemory, request: BiscottiImportRequest): BiscottiImportResult {
  if (!object(request)) throw fail('Send the previewed export, its fingerprint and the meetings to import.');
  const source = sourceOf(request.source);
  const { fingerprint: expected, includeIds, project } = request;
  if (typeof expected !== 'string' || !expected) throw fail('Preview the export first and send its fingerprint with the import.');
  if (!Array.isArray(includeIds) || includeIds.length === 0 || !includeIds.every((id) => typeof id === 'string')) {
    throw fail('Choose at least one previewed meeting to import.');
  }
  if (new Set(includeIds).size !== includeIds.length) throw fail('Each meeting can be chosen only once.');
  if (project !== undefined && (typeof project !== 'string' || !project.trim())) throw fail('The project must be a project name, slug or id.');
  const parsed = parse(request.data, source);
  if (fingerprint(parsed, source) !== expected) {
    throw new MemoryError('conflict', 'The export changed since it was previewed. Preview it again, then choose the meetings to import.');
  }
  const available = new Set(parsed.meetings.map(({ meeting }) => meeting.id));
  const unknown = includeIds.find((id) => !available.has(id));
  if (unknown !== undefined) throw fail(`"${short(unknown)}" is not a meeting in this preview. Choose from the previewed meetings.`);
  const projectId = project === undefined ? undefined : memory.projects.resolve(project).id;
  const chosen = new Set(includeIds);
  const result: BiscottiImportResult = { ...emptyResult(), items: [] };
  for (const { meeting } of parsed.meetings) {
    if (!chosen.has(meeting.id)) continue;
    record(result, meeting.title, () => {
      const existing = memory.items.findImported('biscotti', meeting.id);
      if (existing) {
        result.items.push({ id: existing, sourceId: meeting.id, title: meeting.title, created: false });
        return false;
      }
      const { turns, speakers } = conversation(meeting.transcript);
      const id = memory.items.insert({
        type: 'note', title: meeting.title, body: body(meeting, source), project: projectId, createdAt: meeting.date,
        tags: [...new Set(['biscotti', 'meeting', ...meeting.tags])],
        metadata: {
          importedFrom: { kind: 'biscotti', path: meeting.id },
          biscottiMeeting: {
            version: 1, id: meeting.id, date: meeting.date, source,
            summary: [...meeting.summary].slice(0, SUMMARY_EXCERPT).join(''),
            speakers, participants: meeting.participants,
            moments: turns.map(({ start, speaker }) => ({ start, speaker })),
          },
        },
      }, { automations: false });
      result.items.push({ id, sourceId: meeting.id, title: meeting.title, created: true });
      return true;
    });
  }
  return result;
}

/** Turns start at `[M:SS] Speaker` or `[H:MM:SS] Speaker: words`; text before the first marker has no time and isn't a turn. */
export function parseBiscottiTurns(text: string): BiscottiTurn[] {
  if (typeof text !== 'string') throw fail('A transcript must be text.');
  const turns: BiscottiTurn[] = [];
  const lines: string[][] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = MARKER.exec(line);
    const turn = match && toTurn(match);
    if (turn) {
      turns.push(turn);
      lines.push([turn.text]);
    } else lines.at(-1)?.push(line);
  }
  return turns.map((turn, index) => ({ ...turn, text: lines[index]!.join('\n').trim() }));
}

export function listBiscottiMeetings(
  memory: EnveMemory, options: { project?: string; before?: string; limit?: number } = {},
): BiscottiMeetingPage {
  if (!object(options)) throw fail('List options must be an object.');
  const { project, before, limit = DEFAULT_PAGE } = options;
  if (project !== undefined && typeof project !== 'string') throw fail('The project must be a project name, slug or id.');
  if (before !== undefined && typeof before !== 'string') throw fail('"before" must be the cursor returned with the previous page.');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw fail('Limit must be a positive integer.');
  const size = Math.min(limit, MAX_PAGE);
  const rows = memory.items.list({ type: 'note', importedKind: 'biscotti', secret: false, project, before }, size + 1);
  const page = rows.slice(0, size);
  return { items: page.flatMap(savedMeeting), next: rows.length > size ? pageCursor(page.at(-1)!) : null };
}

function sourceOf(value: unknown): Source {
  if (value !== 'csv' && value !== 'mcp') throw fail('The source must be "csv" or "mcp".');
  return value;
}

function parse(data: unknown, source: Source): Parsed {
  return source === 'csv' ? fromCsv(data) : fromMcp(data);
}

function fromCsv(data: unknown): Parsed {
  if (typeof data !== 'string') throw fail('A CSV import needs the text of a Biscotti CSV export.');
  if (Buffer.byteLength(data) > BISCOTTI_MAX_BYTES) throw fail('Choose a Biscotti export smaller than 8 MB.');
  const records = csvRecords(data.replace(/^﻿/, ''));
  const parsed: Parsed = { meetings: [], skipped: 0, warnings: [] };
  const headerAt = records.findIndex((cells) => !blank(cells));
  if (headerAt < 0) return parsed;
  const header = records[headerAt]!;
  const columns = headerColumns(header, headerAt + 1, parsed);
  const rows = records.map((cells, index) => ({ cells, row: index + 1 })).slice(headerAt + 1).filter(({ cells }) => !blank(cells));
  if (rows.length > BISCOTTI_MAX_MEETINGS) throw fail(`Import at most ${BISCOTTI_MAX_MEETINGS} meetings at a time. Export fewer meetings from Biscotti.`);
  for (const { cells, row } of rows) {
    accept(parsed, row, () => {
      if (cells.length !== header.length) throw fail(`The row has ${cells.length} cells but the header has ${header.length}.`);
      const cell = (field: Field) => {
        const index = columns.get(field);
        return index === undefined ? '' : cells[index]!;
      };
      return normalize({
        id: cell('id'), title: cell('title'), date: cell('created'),
        summary: cell('summary'), notes: cell('notes'), transcript: cell('transcript'),
      });
    });
  }
  return parsed;
}

function fromMcp(data: unknown): Parsed {
  if (!Array.isArray(data)) throw fail('An MCP import needs a meetings array.');
  if (data.length > BISCOTTI_MAX_MEETINGS) throw fail(`Import at most ${BISCOTTI_MAX_MEETINGS} meetings at a time.`);
  if (Buffer.byteLength(JSON.stringify(data)) > BISCOTTI_MAX_BYTES) throw fail('Send less than 8 MB of meetings at a time.');
  const parsed: Parsed = { meetings: [], skipped: 0, warnings: [] };
  data.forEach((raw: unknown, index) => accept(parsed, index + 1, () => {
    if (!object(raw)) throw fail('The meeting is not an object.');
    return normalize(raw);
  }));
  return parsed;
}

/** RFC 4180, strictly: a quote may only open a cell, and a closing quote must end it. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let started = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' && !started) {
      i++;
      for (;;) {
        if (i >= text.length) throw fail('A quoted cell is never closed. Export the meetings from Biscotti again.');
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          cell += '"';
          i += 2;
        } else cell += text[i++];
      }
      i++;
      if (i < text.length && !',\r\n'.includes(text[i]!)) throw fail(`Text follows a closing quote in CSV record ${records.length + 1}. Export the meetings from Biscotti again.`);
      started = true;
    } else if (c === '"') {
      throw fail(`A quote appears inside an unquoted cell in CSV record ${records.length + 1}. Export the meetings from Biscotti again.`);
    } else if (c === ',') {
      cells.push(cell);
      cell = '';
      started = false;
      i++;
    } else if (c === '\r' || c === '\n') {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = '';
      started = false;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += c;
      started = true;
      i++;
    }
  }
  if (started || cells.length) {
    cells.push(cell);
    records.push(cells);
  }
  return records;
}

const blank = (cells: string[]) => cells.length === 1 && cells[0] === '';

function headerColumns(header: string[], row: number, parsed: Parsed): Map<Field, number> {
  const columns = new Map<Field, number>();
  const names = new Map<Field, string>();
  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase().replace(/[\s_]+/g, '_');
    const field = HEADERS.get(name);
    if (!field) {
      if (name) parsed.warnings.push({ row, message: `The column "${short(raw.trim())}" is not part of a Biscotti export and was ignored.` });
      return;
    }
    const previous = names.get(field);
    if (previous === name) throw fail(`The column "${name}" appears more than once. Keep one and try again.`);
    if (previous !== undefined) throw fail(`The columns "${previous}" and "${name}" both name the meeting ${field}. Keep one and try again.`);
    columns.set(field, index);
    names.set(field, name);
  });
  const missing = REQUIRED.filter((field) => !columns.has(field));
  if (missing.length) {
    throw fail(`The CSV has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. Export the meetings from Biscotti as CSV again.`);
  }
  return columns;
}

function accept(parsed: Parsed, row: number, build: () => BiscottiMeeting): void {
  let meeting: BiscottiMeeting;
  try {
    meeting = build();
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    parsed.skipped++;
    parsed.warnings.push({ row, message: `${error.message} This meeting was skipped.` });
    return;
  }
  const first = parsed.meetings.find((entry) => entry.meeting.id === meeting.id);
  if (first) {
    parsed.skipped++;
    parsed.warnings.push({ row, message: `Meeting "${short(meeting.id)}" already appears in row ${first.row}; the first one is kept.` });
    return;
  }
  parsed.meetings.push({ meeting, row });
}

function normalize(raw: Record<string, unknown>): BiscottiMeeting {
  const id = sourceId(raw.id);
  const title = text(raw.title, 'title', MAX_TITLE).replace(/\s+/g, ' ').trim();
  if (!title) throw fail('The meeting has no title.');
  const date = meetingDate(raw.date);
  const summary = text(raw.summary, 'summary', MAX_SECTION);
  const notes = text(raw.notes, 'notes', MAX_SECTION);
  const transcript = text(raw.transcript, 'transcript', MAX_TRANSCRIPT);
  if (title.length + summary.length + notes.length + transcript.length > MAX_COMBINED) {
    throw fail(`The meeting has more than ${MAX_COMBINED} characters of text.`);
  }
  const participants = names(raw.participants, 'participants', (name) => name.replace(/\s+/g, ' ').trim());
  const tags = names(raw.tags, 'tags', (tag) => (tag.trim() ? normalizeTag(tag) : ''));
  return { id, title, date, summary, notes, transcript, participants, tags };
}

function sourceId(value: unknown): string {
  const id = required(value, 'ID');
  if (id.length > MAX_ID) throw fail(`The meeting ID is longer than ${MAX_ID} characters.`);
  if (/\p{Cc}/u.test(id)) throw fail('The meeting ID contains control characters.');
  return UUID.test(id) ? id.toLowerCase() : id;
}

function required(value: unknown, label: string): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw fail(`The meeting ${label} must be text.`);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw fail(`The meeting has no ${label}.`);
  return trimmed;
}

function text(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(`The meeting ${label} must be text.`);
  if (value.length > max) throw fail(`The meeting ${label} is longer than ${max} characters.`);
  return value;
}

function names(value: unknown, label: string, clean: (value: string) => string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_NAMES || !value.every((entry) => typeof entry === 'string' && entry.length <= MAX_NAME)) {
    throw fail(`The meeting ${label} must be a list of at most ${MAX_NAMES} entries of up to ${MAX_NAME} characters.`);
  }
  return [...new Set((value as string[]).map(clean).filter(Boolean))];
}

/** Calendar dates are midnight UTC, so the same export imports identically in every time zone. */
function meetingDate(value: unknown): string {
  const input = required(value, 'date');
  const invalidDate = fail(`"${short(input)}" is not a valid date. Use an ISO time with a time zone, a calendar date (YYYY-MM-DD) or epoch seconds or milliseconds.`);
  let time: number;
  if (/^\d{9,10}$/.test(input)) time = Number(input) * 1000;
  else if (/^\d{12,13}$/.test(input)) time = Number(input);
  else {
    const match = TIMESTAMP.exec(input);
    if (!match) throw invalidDate;
    const [, year, month, day, hours = '0', minutes = '0', seconds = '0', fraction, zone] = match;
    const [y, mo, d, h, mi, s] = [year, month, day, hours, minutes, seconds].map(Number) as [number, number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) throw invalidDate;
    let offset = 0;
    if (zone && zone.toUpperCase() !== 'Z') {
      const [, sign, zoneHours, zoneMinutes] = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
      if (Number(zoneHours) > 23 || Number(zoneMinutes) > 59) throw invalidDate;
      offset = (sign === '-' ? -1 : 1) * (Number(zoneHours) * 60 + Number(zoneMinutes)) * 60_000;
    }
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, s, fraction ? Number(fraction.slice(1, 4).padEnd(3, '0')) : 0);
    time = date.getTime() - offset;
  }
  const iso = Number.isFinite(time) ? new Date(time).toISOString() : '';
  if (!/^\d{4}-/.test(iso)) throw invalidDate;
  return iso;
}

const daysIn = (year: number, month: number) =>
  month === 2 ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

function toTurn([, hours, minutes, seconds, rest]: RegExpExecArray): BiscottiTurn | null {
  if (Number(seconds) > 59 || (hours !== undefined && (minutes!.length !== 2 || Number(minutes) > 59))) return null;
  const colon = rest!.indexOf(':');
  const speaker = (colon > 0 ? rest!.slice(0, colon) : rest!).trim();
  if (!speaker || speaker.length > MAX_SPEAKER) return null;
  const start = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  if (start > 86_400) return null;
  return {
    start,
    speaker,
    text: colon > 0 ? rest!.slice(colon + 1).trim() : '',
  };
}

function conversation(transcript: string): { turns: BiscottiTurn[]; speakers: string[]; total: number } {
  const turns = parseBiscottiTurns(transcript);
  const speakers = [...new Set(turns.map((turn) => turn.speaker))];
  return { turns: turns.slice(0, MAX_TURNS), speakers: speakers.slice(0, MAX_TURNS), total: turns.length };
}

function fingerprint(parsed: Parsed, source: Source): string {
  const meetings = parsed.meetings.map(({ meeting: m }) => [m.id, m.title, m.date, m.summary, m.notes, m.transcript, m.participants, m.tags]);
  return createHash('sha256').update(JSON.stringify([1, source, meetings])).digest('hex');
}

function body(meeting: BiscottiMeeting, source: Source): string {
  const section = (heading: string, value: string) => (value.trim() ? `## ${heading}\n\n${value}` : '');
  return [
    section('Summary', meeting.summary),
    section('Notes', meeting.notes),
    section('Transcript', meeting.transcript),
    [
      `- Date: ${meeting.date}`,
      `- Source: Biscotti ${source === 'csv' ? 'CSV export' : 'Mac app'}`,
      meeting.participants.length ? `- Participants: ${meeting.participants.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n\n');
}

function savedMeeting(item: Item): BiscottiSavedMeeting[] {
  const from = item.metadata.importedFrom;
  const meeting = item.metadata.biscottiMeeting;
  if (!object(from) || from.kind !== 'biscotti' || !object(meeting) || meeting.version !== 1) return [];
  const { id, date, source, summary, speakers, participants, moments } = meeting;
  if (typeof id !== 'string' || id !== from.path || typeof date !== 'string' || (source !== 'csv' && source !== 'mcp')
    || typeof summary !== 'string' || !strings(speakers) || !strings(participants) || !Array.isArray(moments)
    || !moments.every((moment) => object(moment) && typeof moment.start === 'number' && typeof moment.speaker === 'string')) return [];
  return [{
    id: item.id, meetingId: id, title: item.title, date, summary, speakers, participants,
    project: item.project ? { id: item.project.id, name: item.project.name } : null,
    source, moments: (moments as { start: number; speaker: string }[]).map(({ start, speaker }) => ({ start, speaker })),
  }];
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
