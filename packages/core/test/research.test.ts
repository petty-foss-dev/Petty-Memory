import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';

function open(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'memory-research-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  return memory;
}

const fails = (code: string, pattern: RegExp) => (error: unknown) => error instanceof MemoryError && error.code === code && pattern.test(error.message);
const lastChange = (memory: EnveMemory) => memory.activity.recent({}, 1)[0]?.id;

const PAGES = [
  'Fictional orchard field guide.\nThe orchard   survey begins at dawn.',
  'Page two notes the\nbee counts rose by 12 percent.',
  'Closing remarks: bee counts rose.',
];
let fileCount = 0;

/** What ingestion leaves on a PDF; core reads only this stored text. */
function savePdf(memory: EnveMemory, pages = PAGES, pageCount = pages.length) {
  const saved = memory.files.save({ data: Buffer.from(`%PDF-1.7 fictional ${++fileCount}`), filename: 'orchard.pdf' }).item;
  memory.items.setSource(saved.id, {
    content: pages.join('\n\n'),
    metadata: { pageCount, ingest: { status: 'done' }, pdfPages: { version: 1, pageCount, pages, clipped: [], truncated: pages.length < pageCount } },
  });
  return memory.items.get(saved.id);
}

function saveAudio(memory: EnveMemory, filename = 'standup.mp3') {
  return memory.files.save({ data: Buffer.from(`ID3 fictional recording ${++fileCount}`), filename }).item;
}

const SEGMENTS = [
  { start: 0, end: 4.2, text: 'Welcome to the  orchard standup.', speaker: 'Ada' },
  { start: 4.2, end: 9.0004, text: 'Pollination is ahead of plan.', speaker: 'Bo' },
  { start: 12, end: 15, text: 'Hive three needs a new queen.' },
];

test('PDF pages come from kept page text, with explicit truncation', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory, PAGES, 5);
  const source = memory.research.pdfSource(pdf.id);
  assert.deepEqual(
    [source.status, source.pageCount, source.storedPages, source.truncated, source.sha256],
    ['ready', 5, 3, true, pdf.attachments[0]!.sha256],
  );
  const range = memory.research.pages(pdf.id, { from: 2, limit: 10 });
  assert.deepEqual(range.pages.map((page) => [page.page, page.available]), [[2, true], [3, true], [4, false], [5, false]]);
  assert.equal(range.pages[0]!.text, PAGES[1]);
  assert.equal(range.pages[2]!.text, '');
  assert.throws(() => memory.research.pages(pdf.id, { from: 6 }), fails('invalid', /page from 1 to 5/));
  assert.throws(() => memory.research.pages(pdf.id, { limit: 51 }), fails('invalid', /1 to 50 pages/));
  assert.deepEqual(memory.research.findInPdf(pdf.id, 'BEE   counts').map((match) => [match.page, match.textSource]), [[2, 'pdf'], [3, 'pdf']]);
});

test('annotations quote exact page text, link their source and leave it unchanged', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory, PAGES, 5);
  const sha256 = pdf.attachments[0]!.sha256;
  const { item, created } = memory.research.annotate({
    sourceId: pdf.id, page: 2, quote: 'bee counts rose by 12 percent', sha256, note: 'Compare with last spring.',
  });
  assert.equal(created, true);
  assert.equal(item.type, 'note');
  assert.equal(item.body, `> bee counts rose by 12 percent\n\nCompare with last spring.\n\nSource: [[item:${pdf.id}|orchard.pdf]], page 2`);
  const research = item.metadata.research as { kind: string; page: number; quote: string; sha256: string; locator: { page: number; start: number; end: number } };
  assert.equal(research.kind, 'pdfAnnotation');
  assert.equal(research.sha256, sha256);
  assert.deepEqual(research.locator.page, 2);
  assert.equal(PAGES[1]!.slice(research.locator.start, research.locator.end), 'bee counts rose by 12 percent');
  assert.deepEqual(item.relations.map((r) => [r.kind, r.direction, r.id]), [['derived_from', 'outgoing', pdf.id]]);

  const spaced = memory.research.annotate({ sourceId: pdf.id, page: 1, quote: 'The orchard survey begins', sha256 }).item;
  assert.equal((spaced.metadata.research as { quote: string }).quote, 'The orchard   survey begins', 'the stored quote is the page’s exact text');
  assert.equal(memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'bee counts rose by 12 percent', sha256, note: 'Compare with last spring.' }).created, false);

  const after = memory.items.get(pdf.id);
  assert.deepEqual([after.title, after.body, after.content, after.metadata], [pdf.title, pdf.body, pdf.content, pdf.metadata]);

  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'bee counts rose by 13 percent', sha256 }), fails('invalid', /isn’t on page 2/));
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'Closing remarks', sha256 }), fails('invalid', /isn’t on page 2/));
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 3, quote: 'bee counts rose', sha256, occurrence: 1 }), fails('invalid', /isn’t on page 3/));
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'bee counts', sha256: 'a'.repeat(64) }), fails('conflict', /changed since/));
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 4, quote: 'anything', sha256 }), fails('invalid', /first 3 of 5 pages/));
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'bee', sha256, highlight: [0, 0, 10, 10] } as never), fails('invalid', /Unknown annotation field "highlight"/));

  const listed = memory.research.annotations(pdf.id);
  assert.deepEqual(listed.map((annotation) => [annotation.page, annotation.status]), [[1, 'current'], [2, 'current']]);
});

test('annotations remain locatable at page boundaries, including a whole page', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory, ['The Aurora rocket burns methane.']);
  const sha256 = pdf.attachments[0]!.sha256;
  for (const quote of ['The Aurora', 'methane.', 'The Aurora rocket burns methane.']) {
    const { item } = memory.research.annotate({ sourceId: pdf.id, page: 1, quote, sha256 });
    assert.equal(memory.research.locateAnnotation(item.id).status, 'current');
  }
  assert.equal(memory.research.annotations(pdf.id).length, 3);
});

test('research refuses archived, secret, non-PDF and not-yet-extracted sources', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory);
  const sha256 = pdf.attachments[0]!.sha256;
  memory.items.archive(pdf.id);
  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 1, quote: 'orchard', sha256 }), fails('invalid', /archived/));
  assert.throws(() => memory.research.pages(pdf.id), fails('invalid', /archived/));
  memory.items.unarchive(pdf.id);
  memory.items.setSource(pdf.id, { metadata: { secret: true } });
  assert.throws(() => memory.research.pdfSource(pdf.id), fails('invalid', /ordinary item/));

  const text = memory.files.save({ data: Buffer.from('plain notes'), filename: 'notes.txt' }).item;
  assert.throws(() => memory.research.pdfSource(text.id), fails('invalid', /saved PDF/));
  memory.projects.create({ name: 'Orchard' });
  const decision = memory.decisions.record({ project: 'orchard', decision: 'Survey at dawn' });
  assert.throws(() => memory.research.pdfSource(decision.id), fails('invalid', /ordinary item/));
  assert.throws(() => memory.research.pdfSource('0190b2c4-0000-7000-8000-000000000000'), fails('not_found', /No item/));

  const pending = memory.files.save({ data: Buffer.from('%PDF-1.7 not yet read'), filename: 'pending.pdf' }).item;
  assert.equal(memory.research.pdfSource(pending.id).status, 'pending');
  assert.throws(() => memory.research.pages(pending.id), fails('invalid', /isn’t available yet/));
  memory.items.setSource(pending.id, { metadata: { ingest: { status: 'failed', error: 'old build' }, pdfPages: { version: 1, pageCount: 2, pages: ['a', 'b', 'c'], clipped: [], truncated: false } } });
  assert.equal(memory.research.pdfSource(pending.id).status, 'unavailable', 'malformed page text is never trusted');
  assert.equal(memory.research.requestPageText(pending.id).status, 'pending');
});

test('reviewed OCR pages supply quotable text, and revisions mark quotes moved or stale', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory, PAGES, 5);
  const sha256 = pdf.attachments[0]!.sha256;
  const before = lastChange(memory);
  assert.throws(() => memory.research.saveOcrPage({ sourceId: pdf.id, page: 6, text: 'x', sha256 }), fails('invalid', /page from 1 to 5/));
  assert.throws(() => memory.research.saveOcrPage({ sourceId: pdf.id, page: 4, text: '   ', sha256 }), fails('invalid', /empty/));
  assert.throws(() => memory.research.saveOcrPage({ sourceId: pdf.id, page: 4, text: 'x', sha256: 'b'.repeat(64) }), fails('conflict', /changed since/));
  assert.equal(lastChange(memory), before);

  const ocr = memory.research.saveOcrPage({ sourceId: pdf.id, page: 4, text: 'Scanned appendix: hive weights logged weekly.', sha256, engine: 'Tesseract · English' });
  assert.equal(ocr.created, true);
  assert.match(ocr.item.title, /page 4 \(reviewed OCR\)/);
  assert.deepEqual(ocr.item.relations.map((r) => [r.kind, r.id]), [['derived_from', pdf.id]]);
  assert.equal(memory.research.pages(pdf.id, { from: 4, limit: 1 }).pages[0]!.ocr?.text, 'Scanned appendix: hive weights logged weekly.');
  assert.deepEqual(memory.research.pdfSource(pdf.id).ocrPages, [{ page: 4, id: ocr.item.id }]);
  assert.deepEqual(memory.research.findInPdf(pdf.id, 'HIVE weights').map((match) => [match.page, match.textSource]), [[4, 'ocr']]);

  assert.throws(() => memory.research.annotate({ sourceId: pdf.id, page: 5, quote: 'hive', sha256, textSource: 'ocr' }), fails('invalid', /no reviewed OCR/));
  const annotation = memory.research.annotate({ sourceId: pdf.id, page: 4, quote: 'hive weights logged weekly', sha256, textSource: 'ocr' }).item;
  assert.equal((annotation.metadata.research as { ocrId: string }).ocrId, ocr.item.id);
  assert.match(annotation.body, /page 4 \(reviewed OCR\)$/);
  assert.equal(memory.research.locateAnnotation(annotation.id).status, 'current');

  const revised = memory.research.saveOcrPage({ sourceId: pdf.id, page: 4, text: 'Corrected. Scanned appendix: hive weights logged weekly.', sha256 });
  assert.deepEqual([revised.created, revised.item.id], [false, ocr.item.id]);
  const moved = memory.research.locateAnnotation(annotation.id);
  assert.equal(moved.status, 'moved');
  assert.equal(moved.current!.start, moved.locator.start + 'Corrected. '.length);

  memory.research.saveOcrPage({ sourceId: pdf.id, page: 4, text: 'Scanned appendix: hive weights logged monthly.', sha256 });
  assert.equal(memory.research.locateAnnotation(annotation.id).status, 'stale');
  assert.ok(memory.versions.list(ocr.item.id).total >= 3, 'each revision keeps its history');
});

test('annotations notice re-extracted pages and missing sources', (t) => {
  const memory = open(t);
  const pdf = savePdf(memory);
  const sha256 = pdf.attachments[0]!.sha256;
  const annotation = memory.research.annotate({ sourceId: pdf.id, page: 2, quote: 'bee counts rose by 12 percent', sha256 }).item;
  const reextract = (pages: string[]) => memory.items.setSource(pdf.id, {
    metadata: { pdfPages: { version: 1, pageCount: pages.length, pages, clipped: [], truncated: false } },
  });
  reextract([PAGES[0]!, `Header line\n${PAGES[1]}`, PAGES[2]!]);
  assert.equal(memory.research.locateAnnotation(annotation.id).status, 'moved');
  reextract([PAGES[0]!, 'Page two was replaced.', PAGES[2]!]);
  assert.equal(memory.research.locateAnnotation(annotation.id).status, 'stale');
  memory.items.archive(pdf.id);
  const missing = memory.research.locateAnnotation(annotation.id);
  assert.deepEqual([missing.status, missing.current], ['source-missing', null]);
  assert.throws(() => memory.research.locateAnnotation(pdf.id), fails('not_found', /No PDF annotation/));
});

test('transcript previews validate timings against the recording and write nothing', (t) => {
  const memory = open(t);
  const audio = saveAudio(memory);
  const before = lastChange(memory);
  const preview = memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt' });
  assert.equal(lastChange(memory), before);
  assert.deepEqual([preview.audio.itemId, preview.audio.mimeType, preview.segmentCount, preview.duration, preview.overlaps, preview.existingId], [audio.id, 'audio/mpeg', 3, 15, 0, null]);
  assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.segments[0], { start: 0, end: 4.2, text: 'Welcome to the orchard standup.', speaker: 'Ada' });
  assert.equal(preview.segments[1]!.end, 9);
  assert.equal(memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'srt' }).fingerprint, preview.fingerprint, 'identity ignores the caption format');

  const check = (segments: unknown, pattern: RegExp) =>
    assert.throws(() => memory.research.previewTranscript({ audioId: audio.id, segments, format: 'json' }), fails('invalid', pattern));
  check([], /at least one/);
  check([{ start: -1, end: 1, text: 'x' }], /from 0 to 86400/);
  check([{ start: Number.NaN, end: 1, text: 'x' }], /from 0 to 86400/);
  check([{ start: 0, end: Number.POSITIVE_INFINITY, text: 'x' }], /from 0 to 86400/);
  check([{ start: 3, end: 2, text: 'x' }], /ends before it starts/);
  check([{ start: 5, end: 6, text: 'x' }, { start: 4, end: 7, text: 'y' }], /Sort the cues/);
  check([{ start: 0, end: 20, text: 'x' }, { start: 10, end: 21, text: 'y' }], /more than 5 seconds/);
  check([{ start: 0, end: 1, text: '   ' }], /no text/);
  check([{ start: 0, end: 1, text: 'x', confidence: 0.9 }], /Unknown segment 1 field "confidence"/);
  check(Array.from({ length: 2001 }, (_, i) => ({ start: i, end: i + 1, text: 'x' })), /at most 2000 segments/);
  check(Array.from({ length: 3 }, (_, i) => ({ start: i, end: i + 1, text: 'y'.repeat(70_000) })), /200,000 characters/);
  assert.equal(memory.research.previewTranscript({
    audioId: audio.id, format: 'json', segments: [{ start: 0, end: 10, text: 'x' }, { start: 6, end: 12, text: 'y' }],
  }).overlaps, 1);
  assert.throws(() => memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'docx' }), fails('invalid', /transcript format/));

  const text = memory.files.save({ data: Buffer.from('not audio'), filename: 'agenda.txt' }).item;
  assert.throws(() => memory.research.previewTranscript({ audioId: text.id, segments: SEGMENTS, format: 'vtt' }), fails('invalid', /audio file/));
  memory.items.archive(audio.id);
  assert.throws(() => memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt' }), fails('invalid', /archived/));
});

test('saving a transcript is explicit, searchable, linked to its recording and repeat-safe', (t) => {
  const memory = open(t);
  memory.projects.create({ name: 'Orchard' });
  const audio = memory.files.save({ data: Buffer.from('ID3 fictional standup'), filename: 'standup.m4a', project: 'orchard' }).item;
  const { fingerprint } = memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt' });
  assert.throws(() => memory.research.saveTranscript({ audioId: audio.id, segments: SEGMENTS.slice(1), format: 'vtt', fingerprint }), fails('conflict', /Preview it again/));

  const { item, created } = memory.research.saveTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt', fingerprint, tags: ['standup'] });
  assert.equal(created, true);
  assert.equal(item.title, 'standup.m4a transcript');
  assert.equal(item.project?.name, 'Orchard');
  assert.deepEqual(item.tags, ['standup']);
  assert.equal(item.body, [
    `Recording: [[item:${audio.id}|standup.m4a]]`, '',
    '[0:00] Ada: Welcome to the orchard standup.', '[0:04] Bo: Pollination is ahead of plan.', '[0:12] Hive three needs a new queen.',
  ].join('\n'));
  assert.deepEqual(item.relations.map((r) => [r.kind, r.id]), [['derived_from', audio.id]]);
  assert.ok(memory.search.query('pollination ahead').some((hit) => hit.id === item.id));
  assert.deepEqual(memory.items.get(audio.id).attachments, audio.attachments, 'the recording is kept as it was');

  const again = memory.research.saveTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'srt', fingerprint });
  assert.deepEqual([again.created, again.item.id], [false, item.id]);
  assert.equal(memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt' }).existingId, item.id);
  assert.deepEqual(memory.research.transcripts(audio.id).map((summary) => [summary.id, summary.segmentCount]), [[item.id, 3]]);
  const view = memory.research.transcript(item.id);
  assert.deepEqual([view.audioStatus, view.audio?.attachmentId, view.duration], ['ok', audio.attachments[0]!.id, 15]);
});

test('passages quote transcript segments with play-at locators and refuse stale sources', (t) => {
  const memory = open(t);
  const audio = saveAudio(memory);
  const { fingerprint } = memory.research.previewTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt' });
  const transcript = memory.research.saveTranscript({ audioId: audio.id, segments: SEGMENTS, format: 'vtt', fingerprint }).item;

  assert.equal(memory.research.passageAt(transcript.id, 5)?.index, 1);
  assert.deepEqual(memory.research.passageAt(transcript.id, 10.5), { index: 1, segment: { start: 4.2, end: 9, text: 'Pollination is ahead of plan.', speaker: 'Bo' }, inside: false });
  assert.equal(memory.research.passageAt(transcript.id, 12)?.index, 2);
  assert.throws(() => memory.research.passageAt(transcript.id, -1), fails('invalid', /seconds from 0/));
  assert.deepEqual(memory.research.audioLocator(transcript.id, 2), {
    audioId: audio.id, attachmentId: audio.attachments[0]!.id, sha256: audio.attachments[0]!.sha256,
    filename: 'standup.mp3', mimeType: 'audio/mpeg', start: 12, end: 15,
  });

  assert.throws(() => memory.research.savePassage({ transcriptId: transcript.id, fingerprint: 'c'.repeat(64), from: 0, to: 1 }), fails('conflict', /changed since/));
  assert.throws(() => memory.research.savePassage({ transcriptId: transcript.id, fingerprint, from: 2, to: 1 }), fails('invalid', /end at or after/));
  assert.throws(() => memory.research.savePassage({ transcriptId: transcript.id, fingerprint, from: 0, to: 3 }), fails('invalid', /from 0 to 2/));
  assert.throws(() => memory.research.savePassage({ transcriptId: audio.id, fingerprint, from: 0, to: 0 }), fails('not_found', /No transcript/));

  const { item, created } = memory.research.savePassage({ transcriptId: transcript.id, fingerprint, from: 1, to: 2, note: 'Order a queen.' });
  assert.equal(created, true);
  assert.match(item.body, /^> \[0:04\] Bo: Pollination is ahead of plan\.\n> \[0:12\] Hive three needs a new queen\.\n\nOrder a queen\.\n\nSource: /);
  assert.ok(item.body.endsWith(`at 0:04 · recording [[item:${audio.id}|standup.mp3]]`));
  assert.deepEqual(item.relations.map((r) => [r.kind, r.id]).sort(), [['derived_from', transcript.id], ['references', audio.id]].sort());
  const research = item.metadata.research as { locator: { start: number; end: number }; quote: string };
  assert.deepEqual(research.locator, { audioId: audio.id, attachmentId: audio.attachments[0]!.id, start: 4.2, end: 15 });
  assert.equal(research.quote, 'Bo: Pollination is ahead of plan.\nHive three needs a new queen.');
  assert.deepEqual([memory.research.audioLocator(item.id).start, memory.research.audioLocator(item.id).end], [4.2, 15]);
  assert.equal(memory.research.savePassage({ transcriptId: transcript.id, fingerprint, from: 1, to: 2, note: 'Order a queen.' }).created, false);
  assert.deepEqual(memory.research.passages(transcript.id).map((passage) => passage.id), [item.id]);

  memory.items.archive(audio.id);
  assert.equal(memory.research.transcript(transcript.id).audioStatus, 'missing');
  assert.throws(() => memory.research.savePassage({ transcriptId: transcript.id, fingerprint, from: 0, to: 0 }), fails('conflict', /missing or was replaced/));
  assert.throws(() => memory.research.audioLocator(item.id), fails('conflict', /missing or was replaced/));
});
