import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';
import { PDF_PAGE_LIMITS, extractPdf } from '../src/pdf.ts';
import { parseTranscript, transcribeAudio } from '../src/research.ts';

function open(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'memory-research-ingest-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  return memory;
}

/** A multi-page PDF built by hand, so no binary fixture is needed. */
function makePdf(pages: string[]): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: string[] = [];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000000 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const invalid = (pattern: RegExp) => (error: unknown) => error instanceof MemoryError && error.code === 'invalid' && pattern.test(error.message);

test('WebVTT cues keep timings and voice names, without markup, notes or styles', () => {
  const vtt = [
    `${String.fromCharCode(0xfeff)}WEBVTT - fictional garden club`,
    '',
    'NOTE recorded on a phone',
    '',
    'STYLE',
    '::cue { color: lime }',
    '',
    'intro',
    '00:00.000 --> 00:04.250 align:start',
    '<v Ada Wrench>Welcome to the <b>orchard</b> survey &amp; plan.</v>',
    '',
    '00:00:04.250 --> 00:00:09.000',
    '<v.loud Bo>Bee counts rose</v>',
    'by <00:00:06.000>twelve percent.',
    '',
    '00:00:09.000 --> 00:00:10.000',
    '<i></i>',
  ].join('\r\n');
  const parsed = parseTranscript(vtt);
  assert.equal(parsed.format, 'vtt');
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.segments, [
    { start: 0, end: 4.25, text: 'Welcome to the orchard survey & plan.', speaker: 'Ada Wrench' },
    { start: 4.25, end: 9, text: 'Bee counts rose by twelve percent.', speaker: 'Bo' },
  ]);
});

test('SubRip cues parse with or without index lines and drop styling', () => {
  const srt = '1\n00:00:01,500 --> 00:00:03,000\n<i>Hive one</i> is {\\an8}quiet.\n\n2\n01:00:00,000 --> 01:00:02,5\nSecond hour.\n';
  assert.deepEqual(parseTranscript(srt).segments, [
    { start: 1.5, end: 3, text: 'Hive one is quiet.' },
    { start: 3600, end: 3602.5, text: 'Second hour.' },
  ]);
  assert.equal(parseTranscript('00:00:01,000 --> 00:00:02,000\nNo index line.').segments[0]!.text, 'No index line.');
});

test('timed JSON keeps only start, end, text and speaker', () => {
  const verbose = JSON.stringify({ text: 'ignored', segments: [{ id: 0, seek: 0, start: 0.5, end: 2, text: ' Hello  there ', tokens: [1, 2], speaker: 'Ada' }] });
  assert.deepEqual(parseTranscript(verbose).segments, [{ start: 0.5, end: 2, text: 'Hello there', speaker: 'Ada' }]);
  assert.deepEqual(parseTranscript('[{"start":1,"end":2,"text":"Plain list"}]', 'json').segments, [{ start: 1, end: 2, text: 'Plain list' }]);
});

test('caption parsing refuses unreadable or oversized input before anything is saved', () => {
  assert.throws(() => parseTranscript('just some words'), invalid(/WebVTT/));
  assert.throws(() => parseTranscript('WEBVTT\n\ncue without timing\nhello'), invalid(/timing line/));
  assert.throws(() => parseTranscript('WEBVTT\n\n00:99.000 --> 01:00.000\nhello'), invalid(/unreadable time/));
  assert.throws(() => parseTranscript('NOT VTT\n\n00:01.000 --> 00:02.000\nhello', 'vtt'), invalid(/start with WEBVTT/));
  assert.throws(() => parseTranscript('{"segments": [', 'json'), invalid(/valid JSON/));
  assert.throws(() => parseTranscript('[{"start":-1,"end":2,"text":"x"}]'), invalid(/seconds from 0/));
  assert.throws(() => parseTranscript('[{"start":1,"end":2,"text":7}]'), invalid(/needs its text/));
  assert.throws(() => parseTranscript('WEBVTT\n\n00:01.000 --> 00:02.000\n<b></b>'), invalid(/No timed text/));
  const many = JSON.stringify(Array.from({ length: 2001 }, (_, i) => ({ start: i, end: i + 1, text: 'x' })));
  assert.throws(() => parseTranscript(many), invalid(/at most 2000 segments/));
  const long = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ start: i, end: i + 1, text: 'y'.repeat(70_000) })));
  assert.throws(() => parseTranscript(long), invalid(/200,000 characters/));
  assert.throws(() => parseTranscript(`WEBVTT\n\n${'z'.repeat(5 * 1024 * 1024)}`), invalid(/smaller than 5 MB/));
});

test('PDF extraction keeps page-indexed text with blank pages in place', async () => {
  const extracted = await extractPdf(makePdf(['Alpha orchard survey', '', 'Gamma hive weights']));
  const pdfPages = extracted.metadata.pdfPages as { version: number; pageCount: number; pages: string[]; clipped: number[]; truncated: boolean };
  assert.equal(extracted.metadata.pageCount, 3);
  assert.equal(pdfPages.version, 1);
  assert.equal(pdfPages.pageCount, 3);
  assert.equal(pdfPages.pages.length, 3);
  assert.match(pdfPages.pages[0]!, /Alpha orchard survey/);
  assert.equal(pdfPages.pages[1], '');
  assert.match(pdfPages.pages[2]!, /Gamma hive weights/);
  assert.deepEqual(pdfPages.clipped, []);
  assert.equal(pdfPages.truncated, false);
  assert.match(extracted.content, /Alpha orchard survey[\s\S]*Gamma hive weights/);
});

test('PDF page text stops at the total budget and clips long pages without renumbering', async () => {
  const pages = Array.from({ length: 22 }, (_, i) => `P${i + 1} ${'word '.repeat(i === 0 ? 24_000 : 19_990)}`.trim());
  const extracted = await extractPdf(makePdf(pages));
  const pdfPages = extracted.metadata.pdfPages as { pageCount: number; pages: string[]; clipped: number[]; truncated: boolean };
  assert.equal(pdfPages.pageCount, 22);
  assert.ok(pdfPages.pages.length < 22 && pdfPages.pages.length > 15, `kept ${pdfPages.pages.length} pages`);
  assert.equal(pdfPages.truncated, true);
  assert.deepEqual(pdfPages.clipped, [1]);
  assert.equal(pdfPages.pages[0]!.length, PDF_PAGE_LIMITS.pageChars);
  pdfPages.pages.forEach((text, i) => assert.ok(text.startsWith(`P${i + 1} `), `page ${i + 1} kept its number`));
  assert.ok(pdfPages.pages.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= PDF_PAGE_LIMITS.totalBytes);
  assert.ok(extracted.content.length > 0);
});

function fakeServer(reply: (request: { url: string; init: RequestInit }) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(url), init: init ?? {} };
    calls.push(request);
    return reply(request);
  }) as typeof fetch;
  return { calls, send };
}

const verboseJson = () => new Response(JSON.stringify({
  task: 'transcribe', language: 'en', duration: 6, text: 'Morning standup. Bees are fine.',
  segments: [
    { id: 0, seek: 0, start: 0, end: 2.5, text: ' Morning standup.', avg_logprob: -0.2 },
    { id: 1, seek: 0, start: 2.5, end: 6, text: ' Bees are fine.', no_speech_prob: 0.01 },
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('transcription posts the saved recording to the configured endpoint and writes nothing', async (t) => {
  const memory = open(t);
  const audio = memory.files.save({ data: Buffer.from('ID3 fictional standup audio'), filename: 'standup.mp3' }).item;
  const before = memory.activity.recent({}, 1)[0]!.id;
  const server = fakeServer(verboseJson);
  const result = await transcribeAudio(memory, audio.id, { baseUrl: 'http://127.0.0.1:8080/v1/', model: 'whisper-small', apiKey: 'sk-fictional' }, { fetch: server.send });
  assert.deepEqual(result, {
    format: 'transcription', engine: 'whisper-small · 127.0.0.1:8080', skipped: 0,
    segments: [{ start: 0, end: 2.5, text: 'Morning standup.' }, { start: 2.5, end: 6, text: 'Bees are fine.' }],
  });
  assert.equal(server.calls.length, 1);
  const { url, init } = server.calls[0]!;
  assert.equal(url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(init.headers, { Authorization: 'Bearer sk-fictional' });
  const form = init.body as FormData;
  assert.equal(form.get('model'), 'whisper-small');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('timestamp_granularities[]'), 'segment');
  const file = form.get('file') as File;
  assert.equal(file.name, 'standup.mp3');
  assert.equal(file.type, 'audio/mpeg');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'ID3 fictional standup audio');
  assert.equal(memory.activity.recent({}, 1)[0]!.id, before, 'recognition never saves');

  const keyless = fakeServer(verboseJson);
  await transcribeAudio(memory, audio.id, { baseUrl: 'https://whisper.example.test', model: 'base' }, { fetch: keyless.send });
  assert.equal(keyless.calls[0]!.url, 'https://whisper.example.test/audio/transcriptions');
  assert.deepEqual(keyless.calls[0]!.init.headers, {});
});

test('transcription refuses unsafe settings and unsuitable recordings without contacting the server', async (t) => {
  const memory = open(t);
  const audio = memory.files.save({ data: Buffer.from('ID3 fictional'), filename: 'call.m4a' }).item;
  const server = fakeServer(verboseJson);
  const run = (config: unknown, id = audio.id) => transcribeAudio(memory, id, config as never, { fetch: server.send });
  await assert.rejects(run({ baseUrl: 'ftp://127.0.0.1/v1', model: 'base' }), invalid(/http:\/\/ or https:\/\//));
  await assert.rejects(run({ baseUrl: 'http://user:secret@127.0.0.1/v1', model: 'base' }), invalid(/key field/));
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1?key=secret', model: 'base' }), invalid(/without a query/));
  await assert.rejects(run({ baseUrl: 'not a url', model: 'base' }), invalid(/address/));
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: ' ' }), invalid(/model/));
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: 'base', apiKey: 'two words' }), invalid(/single line/));
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: 'base', provider: 'openai' }), invalid(/Unknown transcription setting/));
  const text = memory.files.save({ data: Buffer.from('not audio'), filename: 'notes.txt' }).item;
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: 'base' }, text.id), invalid(/audio file/));
  memory.items.archive(audio.id);
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: 'base' }), invalid(/archived/));
  const large = memory.files.save({ data: Buffer.alloc(25 * 1024 * 1024 + 1, 1), filename: 'long-lecture.wav' }).item;
  await assert.rejects(run({ baseUrl: 'http://127.0.0.1/v1', model: 'base' }, large.id), invalid(/smaller than 25 MB/));
  assert.equal(server.calls.length, 0);
});

test('transcription answers are bounded and never followed through redirects', async (t) => {
  const memory = open(t);
  const audio = memory.files.save({ data: Buffer.from('ID3 fictional'), filename: 'call.mp3' }).item;
  const config = { baseUrl: 'http://127.0.0.1:8080/v1', model: 'base', apiKey: 'sk-never-shown' };
  const attempt = (reply: () => Response) => transcribeAudio(memory, audio.id, config, { fetch: fakeServer(reply).send });
  await assert.rejects(attempt(() => new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/' } })), invalid(/tried to redirect/));
  await assert.rejects(attempt(() => new Response('sk-never-shown is wrong', { status: 401 })), (error) =>
    invalid(/answered 401/)(error) && !(error as Error).message.includes('sk-never-shown'));
  await assert.rejects(attempt(() => new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } })), invalid(/too large/));
  await assert.rejects(attempt(() => new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 200 })), invalid(/too large/));
  await assert.rejects(attempt(() => new Response('<html>', { status: 200 })), invalid(/didn’t return JSON/));
  await assert.rejects(attempt(() => new Response(JSON.stringify({ text: 'No timings' }), { status: 200 })), invalid(/without timings/));
  await assert.rejects(attempt(() => { throw new TypeError('fetch failed'); }), invalid(/Couldn’t reach/));
});
