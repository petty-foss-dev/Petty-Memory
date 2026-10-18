import { type EnveMemory, MemoryError } from '@enve-memory/core';

/** Seconds from the start of the recording. Core's research service validates and normalizes these again before any save. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export const CAPTION_FORMATS = ['vtt', 'srt', 'json'] as const;
export type CaptionFormat = (typeof CAPTION_FORMATS)[number];

export interface ParsedTranscript {
  format: CaptionFormat | 'transcription';
  engine: string;
  segments: TranscriptSegment[];
  /** Cues with no text once markup was removed. */
  skipped: number;
}

/** Explicit, per-request settings. Nothing here comes from the configured text LLM. */
export interface TranscriptionConfig {
  /** An OpenAI-compatible base address such as `http://127.0.0.1:8080/v1`; `/audio/transcriptions` is appended. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export const CAPTION_LIMITS = { bytes: 5 * 1024 * 1024, segments: 2000, chars: 200_000 } as const;
export const TRANSCRIPTION_LIMITS = { audioBytes: 25 * 1024 * 1024, timeoutMs: 120_000, responseBytes: 4 * 1024 * 1024 } as const;

const TIME = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
const TIMING = /^(\S+)[ \t]+-->[ \t]+(\S+)/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
const CONFIG_FIELDS = ['baseUrl', 'model', 'apiKey'];

/** Reads WebVTT, SRT or timed JSON (`[{start, end, text, speaker?}]` or `{segments: […]}`). Pure: never touches the library. */
export function parseTranscript(input: string, format?: CaptionFormat): ParsedTranscript {
  if (typeof input !== 'string') throw invalid('Choose a caption file to import.');
  if (Buffer.byteLength(input) > CAPTION_LIMITS.bytes) throw invalid('Choose a caption file smaller than 5 MB.');
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  const chosen = format ?? detect(text);
  if (!(CAPTION_FORMATS as readonly string[]).includes(chosen)) throw invalid('Choose a WebVTT (.vtt), SubRip (.srt) or timed JSON transcript.');
  const parsed = bounded(chosen === 'json' ? parseJson(text) : parseCues(text, chosen === 'vtt'));
  return { format: chosen as CaptionFormat, engine: '', ...parsed };
}

/**
 * Sends one saved recording to an explicitly configured OpenAI-compatible `/audio/transcriptions` endpoint (a local
 * whisper server works) and returns timed segments for review. Writes nothing; the caller asks for consent first.
 */
export async function transcribeAudio(
  memory: EnveMemory, audioId: string, config: TranscriptionConfig, { fetch: send = fetch }: { fetch?: typeof fetch } = {},
): Promise<ParsedTranscript> {
  const { endpoint, model, apiKey } = transcriptionEndpoint(config);
  memory.research.transcripts(audioId, { limit: 1 });
  const item = memory.items.get(audioId);
  const attachment = item.attachments[0];
  if (item.type !== 'file' || !attachment?.mimeType.startsWith('audio/')) throw invalid('Choose a saved audio file, such as an MP3, M4A or WAV recording.');
  const { data } = memory.files.readAttachment(attachment.id, { maxBytes: TRANSCRIPTION_LIMITS.audioBytes });

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: attachment.mimeType }), attachment.filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const host = endpoint.host;
  let response: Response;
  try {
    response = await send(endpoint, {
      method: 'POST',
      body: form,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      // A redirect could carry the key and the recording to another host.
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(TRANSCRIPTION_LIMITS.timeoutMs),
    });
  } catch (error) {
    throw invalid((error as Error).name === 'TimeoutError'
      ? 'Transcription took longer than 2 minutes. Try a shorter recording or a faster server.'
      : `Couldn’t reach the transcription server at ${host}.`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw invalid(`The transcription server at ${host} tried to redirect. Enter its final address instead.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw invalid(`The transcription server at ${host} answered ${response.status}. Check the address, model and key.`);
  }
  let answer: string;
  try {
    answer = await boundedText(response);
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw invalid((error as Error).name === 'TimeoutError'
      ? 'Transcription took longer than 2 minutes. Try a shorter recording or a faster server.'
      : `The transcription server at ${host} stopped answering.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answer);
  } catch {
    throw invalid(`The transcription server at ${host} didn’t return JSON.`);
  }
  const segments = isObject(body) ? body.segments : undefined;
  if (!Array.isArray(segments)) {
    throw invalid('The server returned text without timings. Choose a server and model that return verbose_json segments.');
  }
  return { format: 'transcription', engine: `${model} · ${host}`.slice(0, 200), ...bounded(timedSegments(segments)) };
}

function detect(text: string): CaptionFormat | 'unknown' {
  const start = text.trimStart();
  if (/^WEBVTT(?:[ \t\n]|$)/.test(start)) return 'vtt';
  if (start.startsWith('{') || start.startsWith('[')) return 'json';
  const [first = '', second = ''] = start.split('\n');
  if (/^\d+$/.test(first.trim()) && second.includes('-->')) return 'srt';
  if (first.includes('-->')) return 'srt';
  return 'unknown';
}

function parseCues(text: string, vtt: boolean): { segments: TranscriptSegment[]; skipped: number } {
  const blocks = text.split(/\n{2,}/).map((block) => block.replace(/^\n+|\n+$/g, '')).filter(Boolean);
  if (vtt) {
    if (!/^WEBVTT(?:[ \t\n]|$)/.test(blocks[0] ?? '')) throw invalid('A WebVTT file must start with WEBVTT.');
    blocks.shift();
  }
  const segments: TranscriptSegment[] = [];
  let skipped = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (vtt && /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0]!)) continue;
    const at = TIMING.test(lines[0]!) ? 0 : TIMING.test(lines[1] ?? '') ? 1 : -1;
    const cue = segments.length + skipped + 1;
    if (at < 0) throw invalid(`Cue ${cue} has no "start --> end" timing line.`);
    const [, from, to] = TIMING.exec(lines[at]!)!;
    const payload = lines.slice(at + 1).join('\n');
    const speaker = vtt ? decode(/<v(?:\.[^\s>]*)?[ \t]+([^>]+)>/.exec(payload)?.[1] ?? '').trim() : '';
    const words = decode(payload.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')).replace(/\s+/g, ' ').trim();
    if (!words) {
      skipped++;
      continue;
    }
    push(segments, { start: time(from!, cue), end: time(to!, cue), text: words, ...(speaker ? { speaker } : {}) });
  }
  return { segments, skipped };
}

function parseJson(text: string): { segments: TranscriptSegment[]; skipped: number } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('That JSON transcript couldn’t be read. Check that it is valid JSON.');
  }
  const list = Array.isArray(value) ? value : isObject(value) ? value.segments : undefined;
  if (!Array.isArray(list)) throw invalid('A JSON transcript must be a list of {start, end, text} segments, or an object with a "segments" list.');
  return timedSegments(list);
}

/** Keeps only start, end, text and speaker from each entry, so extra provider fields never reach the library. */
function timedSegments(list: unknown[]): { segments: TranscriptSegment[]; skipped: number } {
  if (list.length > CAPTION_LIMITS.segments) throw tooMany();
  const segments: TranscriptSegment[] = [];
  let skipped = 0;
  list.forEach((entry, position) => {
    const n = position + 1;
    if (!isObject(entry)) throw invalid(`Segment ${n} must be an object with start, end and text.`);
    const { start, end, text, speaker } = entry;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
      throw invalid(`Segment ${n} needs start and end times as seconds from 0.`);
    }
    if (typeof text !== 'string') throw invalid(`Segment ${n} needs its text.`);
    if (speaker !== undefined && speaker !== null && typeof speaker !== 'string') throw invalid(`Segment ${n} speaker must be text.`);
    const words = text.replace(/\s+/g, ' ').trim();
    if (!words) {
      skipped++;
      return;
    }
    const name = typeof speaker === 'string' ? speaker.trim() : '';
    push(segments, { start, end, text: words, ...(name ? { speaker: name } : {}) });
  });
  return { segments, skipped };
}

function push(segments: TranscriptSegment[], segment: TranscriptSegment): void {
  if (segments.length === CAPTION_LIMITS.segments) throw tooMany();
  segments.push(segment);
}

function bounded(parsed: { segments: TranscriptSegment[]; skipped: number }): { segments: TranscriptSegment[]; skipped: number } {
  if (parsed.segments.length === 0) throw invalid('No timed text was found.');
  if (parsed.segments.reduce((sum, { text }) => sum + text.length, 0) > CAPTION_LIMITS.chars) {
    throw invalid('A transcript can hold at most 200,000 characters. Split the recording or its captions.');
  }
  return parsed;
}

function time(value: string, cue: number): number {
  const match = TIME.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw invalid(`Cue ${cue} has an unreadable time "${value.slice(0, 40)}". Use hh:mm:ss.mmm.`);
  }
  const [, hours = '0', minutes, seconds, millis = ''] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis.padEnd(3, '0')) / 1000;
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function transcriptionEndpoint(config: unknown): { endpoint: URL; model: string; apiKey: string } {
  if (!isObject(config)) throw invalid('Transcription needs a server address and model.');
  const unknown = Object.keys(config).find((key) => !CONFIG_FIELDS.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown transcription setting "${unknown}". Expected: ${CONFIG_FIELDS.join(', ')}.`);
  const { baseUrl, model, apiKey } = config;
  let url: URL;
  try {
    url = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '');
  } catch {
    throw invalid('Enter the transcription server’s address, such as http://127.0.0.1:8080/v1.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('The transcription server address must start with http:// or https://.');
  if (url.username || url.password) throw invalid('Put the key in the key field, not in the server address.');
  if (url.search || url.hash) throw invalid('Enter the transcription server address without a query or fragment.');
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\u0000-\u001f]/.test(model)) throw invalid('Enter the transcription model’s name.');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\s\u0000-\u001f]/.test(apiKey))) {
    throw invalid('The transcription key must be a single line without spaces.');
  }
  const endpoint = new URL(`${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`, url.origin);
  return { endpoint, model: model.trim(), apiKey: typeof apiKey === 'string' ? apiKey : '' };
}

async function boundedText(response: Response): Promise<string> {
  const tooLarge = () => invalid('The transcription server’s answer is too large. Try a shorter recording.');
  if (Number(response.headers.get('content-length') ?? 0) > TRANSCRIPTION_LIMITS.responseBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
    size += chunk.value.byteLength;
    if (size > TRANSCRIPTION_LIMITS.responseBytes) {
      await reader?.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const invalid = (message: string) => new MemoryError('invalid', message);
const tooMany = () => invalid(`A transcript can hold at most ${CAPTION_LIMITS.segments} segments. Split the recording or its captions.`);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
