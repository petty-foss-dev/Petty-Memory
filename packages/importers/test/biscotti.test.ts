import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { EnveMemory, normalizeTag } from '@enve-memory/core';
import {
  BISCOTTI_MAX_BYTES, BISCOTTI_MAX_MEETINGS, type BiscottiMeeting, importBiscottiMeetings, listBiscottiMeetings, parseBiscottiTurns,
  previewBiscottiImport,
} from '@enve-memory/importers';

const MEETING_ID = '7F1C2D3E-4A5B-4C6D-8E9F-0A1B2C3D4E5F';
const TRANSCRIPT = '[0:05] Steve\nMorning, everyone.\n\n[0:23] Priya: The "east" deck needs two weeks.\n[1:02:03] Steve: Agreed.';
const EXPORT = '﻿ Document ID ,DOCUMENT TITLE,document created,Summary,Notes,Transcript\r\n'
  + `${MEETING_ID},Garden committee,2026-10-14T09:30:00-07:00,"Agreed on the gazebo, finally.","- Order ""cedar"" boards\n- Call Priya","${TRANSCRIPT.replaceAll('"', '""')}"\r\n`
  + 'standup-42,Standup,2026-10-13,,Short one.,\r\n';

const HEADER = ['id', 'title', 'created', 'summary', 'notes', 'transcript'];
const quote = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const toCsv = (rows: string[][], header = HEADER) => `${[header, ...rows].map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
const row = (id: string, title: string, created: string, summary = '', notes = '', transcript = '') => [id, title, created, summary, notes, transcript];
const open = (t: TestContext) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  return memory;
};
const everything = (memory: EnveMemory) => memory.items.list({ includeArchived: true });
const meeting = (id: string, date: string, extra: Partial<BiscottiMeeting> = {}): BiscottiMeeting => ({
  id, title: `Meeting ${id}`, date, summary: '', notes: '', transcript: '', participants: [], tags: [], ...extra,
});

test('a real quoted Biscotti CSV previews without writing and imports a chosen meeting as a searchable, journaled note', (t) => {
  const memory = open(t);
  memory.projects.create({ name: 'Garden' });
  const preview = previewBiscottiImport(memory, EXPORT);
  assert.equal(everything(memory).length, 0);
  assert.equal(preview.source, 'csv');
  assert.equal(preview.skipped, 0);
  assert.deepEqual(preview.warnings, []);
  assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(previewBiscottiImport(memory, EXPORT).fingerprint, preview.fingerprint);

  const [garden, standup] = preview.entries;
  assert.equal(preview.entries.length, 2);
  assert.equal(garden!.id, MEETING_ID.toLowerCase());
  assert.equal(garden!.title, 'Garden committee');
  assert.equal(garden!.date, '2026-10-14T16:30:00.000Z');
  assert.equal(garden!.summary, 'Agreed on the gazebo, finally.');
  assert.equal(garden!.notes, '- Order "cedar" boards\n- Call Priya');
  assert.equal(garden!.transcript, TRANSCRIPT);
  assert.deepEqual(garden!.speakers, ['Steve', 'Priya']);
  assert.deepEqual(garden!.turns, [
    { start: 5, speaker: 'Steve', text: 'Morning, everyone.' },
    { start: 23, speaker: 'Priya', text: 'The "east" deck needs two weeks.' },
    { start: 3723, speaker: 'Steve', text: 'Agreed.' },
  ]);
  assert.deepEqual([garden!.participants, garden!.tags, garden!.existingId], [[], [], null]);
  assert.equal(standup!.date, '2026-10-13T00:00:00.000Z');
  assert.deepEqual([standup!.notes, standup!.transcript, standup!.turns], ['Short one.', '', []]);

  const result = importBiscottiMeetings(memory, { data: EXPORT, source: 'csv', fingerprint: preview.fingerprint, includeIds: [garden!.id], project: 'garden' });
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.failed, []);
  assert.equal(result.items.length, 1);
  const { id } = result.items[0]!;
  assert.deepEqual(result.items[0], { id, sourceId: garden!.id, title: 'Garden committee', created: true });
  assert.equal(everything(memory).length, 1, 'only the selected meeting is written');

  const item = memory.items.get(id);
  assert.equal(item.type, 'note');
  assert.equal(item.title, 'Garden committee');
  assert.equal(item.createdAt, garden!.date);
  assert.equal(item.project?.name, 'Garden');
  assert.equal(item.source, 'test');
  assert.deepEqual(item.tags, ['biscotti', 'meeting']);
  assert.ok(item.body.includes('- Date: 2026-10-14T16:30:00.000Z'));
  assert.ok(item.body.includes('Biscotti CSV export'));
  const summary = item.body.indexOf('## Summary\n\nAgreed on the gazebo, finally.');
  const notes = item.body.indexOf('## Notes\n\n- Order "cedar" boards\n- Call Priya');
  const transcript = item.body.indexOf(`## Transcript\n\n${TRANSCRIPT}`);
  assert.ok(summary >= 0 && notes > summary && transcript > notes);
  assert.deepEqual(item.metadata.importedFrom, { kind: 'biscotti', path: garden!.id });
  assert.deepEqual(item.metadata.biscottiMeeting, {
    version: 1, id: garden!.id, date: garden!.date, source: 'csv', summary: garden!.summary,
    speakers: ['Steve', 'Priya'], participants: [],
    moments: [{ start: 5, speaker: 'Steve' }, { start: 23, speaker: 'Priya' }, { start: 3723, speaker: 'Steve' }],
  });
  assert.ok(!JSON.stringify(item.metadata.biscottiMeeting).includes('Morning'), 'the transcript lives in the body only');

  assert.ok(memory.search.query('gazebo').some((hit) => hit.id === id));
  assert.ok(memory.search.query('cedar').some((hit) => hit.id === id));
  const history = memory.versions.list(id);
  assert.ok(history.total >= 1 && history.items.every((version) => version.actor === 'test'));
  assert.ok(memory.activity.recent({ entityId: id }).some((change) => change.op === 'create' && change.actor === 'test'));
});

test('turns use documented markers, keep multiline text and never invent times for unmarked text', () => {
  const text = 'Recorded in the hall.\n[0:00] Ana\nHello\nthere\n\n[12:07] Ben: Hi: again\n[1:00:00] Ana:\nLate\n[0:75] Not a marker\n[2:3] nor this\n[0:09]\n';
  assert.deepEqual(parseBiscottiTurns(text), [
    { start: 0, speaker: 'Ana', text: 'Hello\nthere' },
    { start: 727, speaker: 'Ben', text: 'Hi: again' },
    { start: 3600, speaker: 'Ana', text: 'Late\n[0:75] Not a marker\n[2:3] nor this\n[0:09]' },
  ]);
  assert.deepEqual(parseBiscottiTurns('[0:01] A\r\nx\r\n'), [{ start: 1, speaker: 'A', text: 'x' }]);
  assert.deepEqual(parseBiscottiTurns('Just notes, no times.'), []);
  assert.deepEqual(parseBiscottiTurns(''), []);
});

test('re-importing an edited or archived meeting skips it and never overwrites or revives the earlier note', (t) => {
  const memory = open(t);
  const original = toCsv([row('a-1', 'Original', '2026-10-01', 'First summary'), row('b-2', 'Second', '2026-10-02')]);
  const first = previewBiscottiImport(memory, original);
  const imported = importBiscottiMeetings(memory, { data: original, source: 'csv', fingerprint: first.fingerprint, includeIds: ['a-1', 'b-2'] });
  assert.equal(imported.created, 2);
  const [a, b] = imported.items.map((item) => item.id);

  const edited = toCsv([row('a-1', 'Edited title', '2026-10-01', 'Rewritten summary', 'New notes'), row('b-2', 'Second', '2026-10-02')]);
  const again = previewBiscottiImport(memory, edited);
  assert.notEqual(again.fingerprint, first.fingerprint);
  assert.deepEqual(again.entries.map((entry) => entry.existingId), [a, b]);
  memory.items.archive(b!);
  assert.equal(previewBiscottiImport(memory, edited).entries[1]!.existingId, b, 'archived imports are still found');

  const result = importBiscottiMeetings(memory, { data: edited, source: 'csv', fingerprint: again.fingerprint, includeIds: ['a-1', 'b-2'] });
  assert.deepEqual(result, {
    created: 0, skipped: 2, failed: [],
    items: [
      { id: a, sourceId: 'a-1', title: 'Edited title', created: false },
      { id: b, sourceId: 'b-2', title: 'Second', created: false },
    ],
  });
  assert.equal(memory.items.get(a!).title, 'Original');
  assert.ok(memory.items.get(a!).body.includes('First summary'));
  assert.ok(!memory.items.get(a!).body.includes('Rewritten summary'));
  assert.notEqual(memory.items.get(b!).archivedAt, null);
  assert.equal(everything(memory).length, 2);
});

test('a repeated meeting ID keeps the first row, case-insensitively for UUIDs, and warns with the row number', (t) => {
  const memory = open(t);
  const data = toCsv([row(MEETING_ID, 'First', '2026-10-01'), row('other', 'Other', '2026-10-02'), row(MEETING_ID.toLowerCase(), 'Second', '2026-10-03')]);
  const preview = previewBiscottiImport(memory, data);
  assert.deepEqual(preview.entries.map((entry) => entry.title), ['First', 'Other']);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.warnings.length, 1);
  assert.equal(preview.warnings[0]!.row, 4);
  assert.match(preview.warnings[0]!.message, /already appears in row 2/);
});

test('malformed quoting is refused outright', (t) => {
  const memory = open(t);
  assert.throws(() => previewBiscottiImport(memory, 'id,title,created\n"a-1,Unclosed,2026-10-14\n'), { code: 'invalid', message: /never closed/ });
  assert.throws(() => previewBiscottiImport(memory, 'id,title,created\na"1,Stray,2026-10-14\n'), { code: 'invalid', message: /inside an unquoted cell/ });
  assert.throws(() => previewBiscottiImport(memory, 'id,title,created\n"a-1"x,Trailing,2026-10-14\n'), { code: 'invalid', message: /follows a closing quote/ });
});

test('headers tolerate case, spaces and aliases but refuse missing, duplicate and ambiguous required columns', (t) => {
  const memory = open(t);
  assert.throws(() => previewBiscottiImport(memory, 'id,title,summary\nx,y,z\n'), /no created column/);
  assert.throws(() => previewBiscottiImport(memory, 'title,notes\n'), /no id, created columns/);
  assert.throws(() => previewBiscottiImport(memory, 'id,title,Title,created\n'), /"title" appears more than once/);
  assert.throws(() => previewBiscottiImport(memory, 'id,Document ID,title,created\n'), /"id" and "document_id" both name the meeting id/);

  const extra = previewBiscottiImport(memory, 'ID,  Title ,Created,Mood,NOTES\nm-1,Retro,2026-10-14,happy,Went well\n');
  assert.equal(extra.entries.length, 1);
  assert.equal(extra.entries[0]!.notes, 'Went well');
  assert.equal(extra.entries[0]!.transcript, '');
  assert.deepEqual(extra.warnings.map((warning) => warning.row), [1]);
  assert.match(extra.warnings[0]!.message, /"Mood"/);

  for (const empty of ['', '﻿', '\r\n\r\n', `${HEADER.join(',')}\r\n`]) {
    const preview = previewBiscottiImport(memory, empty);
    assert.deepEqual([preview.entries, preview.skipped, preview.warnings], [[], 0, []]);
    assert.throws(() => importBiscottiMeetings(memory, { data: empty, source: 'csv', fingerprint: preview.fingerprint, includeIds: [] }), /at least one/);
  }
});

test('dates accept zoned ISO times, UTC calendar dates and epoch seconds or milliseconds, and refuse rollover', (t) => {
  const memory = open(t);
  const accepted: [string, string][] = [
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2026-10-14T09:30:00-07:00', '2026-10-14T16:30:00.000Z'],
    ['2026-10-14T23:30:00+0530', '2026-10-14T18:00:00.000Z'],
    ['2026-10-14T16:30:00.5704Z', '2026-10-14T16:30:00.570Z'],
    ['2026-10-14T16:30Z', '2026-10-14T16:30:00.000Z'],
    ['1760459400', new Date(1760459400 * 1000).toISOString()],
    ['1760459400123', new Date(1760459400123).toISOString()],
  ];
  const rejected = [
    '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-14T24:00:00Z', '2026-10-14T10:60:00Z', '2026-10-14T10:00:60Z',
    '2026-10-14T10:00:00', '2026-10-14T10:00:00+24:00', 'next Tuesday', '20261014', '12345',
  ];
  const data = toCsv([
    ...accepted.map(([input], index) => row(`ok-${index}`, `Accepted ${index}`, input)),
    ...rejected.map((input, index) => row(`bad-${index}`, `Rejected ${index}`, input)),
    row('undated', 'No date', ''),
  ]);
  const preview = previewBiscottiImport(memory, data);
  assert.deepEqual(preview.entries.map((entry) => entry.date), accepted.map(([, iso]) => iso));
  assert.equal(preview.skipped, rejected.length + 1);
  assert.deepEqual(preview.warnings.map((warning) => warning.row), [...rejected, ''].map((_, index) => accepted.length + index + 2));
  for (const [index, input] of rejected.entries()) assert.ok(preview.warnings[index]!.message.includes(`"${input}" is not a valid date`), input);
  assert.match(preview.warnings.at(-1)!.message, /has no date/);
});

test('size, count and length bounds reject the export or skip only the offending rows', (t) => {
  const memory = open(t);
  assert.throws(() => previewBiscottiImport(memory, 'x'.repeat(BISCOTTI_MAX_BYTES + 1)), /8 MB/);
  const many = (count: number) => toCsv(Array.from({ length: count }, (_, index) => row(`m-${index}`, `Meeting ${index}`, '2026-10-14')));
  assert.equal(previewBiscottiImport(memory, many(BISCOTTI_MAX_MEETINGS)).entries.length, BISCOTTI_MAX_MEETINGS);
  assert.throws(() => previewBiscottiImport(memory, many(BISCOTTI_MAX_MEETINGS + 1)), /at most 500 meetings/);

  const oversized = [
    [row('i'.repeat(201), 'Long ID', '2026-10-14'), /ID is longer than 200/],
    [row('long-title', 'T'.repeat(501), '2026-10-14'), /title is longer than 500/],
    [row('long-summary', 'Summary', '2026-10-14', 'S'.repeat(100_001)), /summary is longer than 100000/],
    [row('long-notes', 'Notes', '2026-10-14', '', 'N'.repeat(100_001)), /notes is longer than 100000/],
    [row('long-transcript', 'Transcript', '2026-10-14', '', '', 'x'.repeat(500_001)), /transcript is longer than 500000/],
    [row('combined', 'Combined', '2026-10-14', 'S'.repeat(100_000), 'N'.repeat(100_000), 'x'.repeat(400_000)), /more than 600000 characters/],
    [['short', 'Too few', '2026-10-14', ''], /has 4 cells but the header has 6/],
    [row('', 'No ID', '2026-10-14'), /has no ID/],
    [row('untitled', '  ', '2026-10-14'), /has no title/],
  ] as const;
  const preview = previewBiscottiImport(memory, toCsv([...oversized.map(([cells]) => [...cells]), row('fine', 'Fine', '2026-10-14', 'S'.repeat(100_000))]));
  assert.deepEqual(preview.entries.map((entry) => entry.id), ['fine']);
  assert.equal(preview.skipped, oversized.length);
  oversized.forEach(([, pattern], index) => {
    assert.equal(preview.warnings[index]!.row, index + 2);
    assert.match(preview.warnings[index]!.message, pattern);
  });

  const transcript = Array.from({ length: 2001 }, (_, index) => `[${Math.floor(index / 60)}:${String(index % 60).padStart(2, '0')}] Speaker ${index % 3}: line ${index}`).join('\n');
  const long = previewBiscottiImport(memory, [meeting('long-call', '2026-10-14', { transcript })], 'mcp');
  assert.equal(long.entries[0]!.turns.length, 2000);
  assert.equal(long.entries[0]!.transcript, transcript);
  assert.deepEqual(long.entries[0]!.speakers, ['Speaker 0', 'Speaker 1', 'Speaker 2']);
  assert.deepEqual(long.warnings.map((warning) => warning.row), [1]);
  assert.match(long.warnings[0]!.message, /first 2000 of 2001/);
});

test('MCP meetings use the same bounds, normalize names and tags, and keep the caller’s actor', (t) => {
  const memory = open(t);
  assert.throws(() => previewBiscottiImport(memory, 'id,title,created\n', 'mcp'), /meetings array/);
  assert.throws(() => previewBiscottiImport(memory, [], 'csv'), /CSV import needs/);
  assert.throws(() => previewBiscottiImport(memory, [], 'xml' as never), /"csv" or "mcp"/);
  assert.throws(() => previewBiscottiImport(memory, Array.from({ length: 501 }, (_, index) => meeting(`m-${index}`, '2026-10-14')), 'mcp'), /at most 500/);

  const meetings = [
    meeting('n-1', '2026-10-14T16:30:00Z', { participants: [' Ana   Lee ', 'Ben', 'Ben'], tags: ['Q4 Planning', '#garden', ''], transcript: '[0:01] Ana: Hello' }),
    { id: 'n-2', title: 42, date: '2026-10-14' },
    'not a meeting',
    { ...meeting('n-4', '2026-10-14'), tags: 'garden' },
    meeting('n-5', '2026-10-14', { summary: 'S'.repeat(100_001) }),
  ];
  const preview = previewBiscottiImport(memory, meetings, 'mcp');
  assert.equal(preview.source, 'mcp');
  assert.deepEqual(preview.entries.map((entry) => entry.id), ['n-1']);
  assert.deepEqual(preview.entries[0]!.participants, ['Ana Lee', 'Ben']);
  assert.deepEqual(preview.entries[0]!.tags, [normalizeTag('Q4 Planning'), 'garden']);
  assert.equal(preview.skipped, 4);
  assert.deepEqual(preview.warnings.map((warning) => warning.row), [2, 3, 4, 5]);
  assert.match(preview.warnings[0]!.message, /title must be text/);
  assert.match(preview.warnings[1]!.message, /not an object/);
  assert.match(preview.warnings[2]!.message, /tags must be a list/);
  assert.match(preview.warnings[3]!.message, /summary is longer/);

  assert.throws(() => importBiscottiMeetings(memory, { data: toCsv([]), source: 'mcp', fingerprint: preview.fingerprint, includeIds: ['n-1'] }), /meetings array/);
  const result = memory.withActor('mcp:claude-code', () =>
    importBiscottiMeetings(memory, { data: meetings as unknown as BiscottiMeeting[], source: 'mcp', fingerprint: preview.fingerprint, includeIds: ['n-1'] }));
  assert.equal(result.created, 1);
  const item = memory.items.get(result.items[0]!.id);
  assert.equal(item.source, 'mcp:claude-code');
  assert.equal(memory.actor, 'test');
  assert.deepEqual(item.tags, ['biscotti', 'garden', 'meeting', normalizeTag('Q4 Planning')].sort());
  assert.ok(item.body.includes('- Participants: Ana Lee, Ben'));
  assert.ok(item.body.includes('Biscotti Mac app'));
  const metadata = item.metadata.biscottiMeeting as Record<string, unknown>;
  assert.deepEqual([metadata.source, metadata.participants, metadata.speakers], ['mcp', ['Ana Lee', 'Ben'], ['Ana']]);
});

test('a stale preview, a bad selection or an unknown project fails before anything is written', (t) => {
  const memory = open(t);
  memory.projects.create({ name: 'Garden' });
  const data = toCsv([row('a-1', 'Planning', '2026-10-01', 'Plan'), row('b-2', 'Review', '2026-10-02', 'Review')]);
  const preview = previewBiscottiImport(memory, data);
  const request = { data, source: 'csv' as const, fingerprint: preview.fingerprint, includeIds: ['a-1', 'b-2'] };
  const edited = toCsv([row('a-1', 'Planning, revised', '2026-10-01', 'Plan'), row('b-2', 'Review', '2026-10-02', 'Review')]);

  assert.throws(() => importBiscottiMeetings(memory, { ...request, data: edited }), { code: 'conflict', message: /changed since it was previewed/ });
  assert.throws(() => importBiscottiMeetings(memory, { ...request, source: 'mcp' }), /meetings array/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, fingerprint: '' }), /fingerprint/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, includeIds: [] }), /at least one/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, includeIds: ['a-1', 'a-1'] }), /only once/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, includeIds: ['a-1', 'nope'] }), /"nope" is not a meeting in this preview/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, includeIds: [42] as never }), /at least one/);
  assert.throws(() => importBiscottiMeetings(memory, { ...request, project: 'nowhere' }), { code: 'not_found' });
  assert.throws(() => importBiscottiMeetings(memory, { ...request, project: '  ' }), /project/);
  assert.equal(everything(memory).length, 0);

  const first = importBiscottiMeetings(memory, { ...request, includeIds: ['a-1'], project: 'garden' });
  assert.equal(first.created, 1);
  assert.equal(previewBiscottiImport(memory, data).fingerprint, preview.fingerprint, 'existing imports do not change the fingerprint');
  const second = importBiscottiMeetings(memory, request);
  assert.deepEqual([second.created, second.skipped], [1, 1]);
  assert.deepEqual(second.items.map((item) => [item.sourceId, item.created]), [['a-1', false], ['b-2', true]]);
  assert.equal(second.items[0]!.id, first.items[0]!.id);
  assert.equal(memory.items.get(first.items[0]!.id).project?.name, 'Garden');
  assert.equal(everything(memory).length, 2);
});

test('saved meetings page newest first, filter by project and include only valid Biscotti notes', (t) => {
  const memory = open(t);
  const garden = memory.projects.create({ name: 'Garden' });
  memory.projects.create({ name: 'Studio' });
  const gardenMeetings = [1, 2, 3, 4, 5].map((day) => meeting(`g-${day}`, `2026-10-0${day}`, {
    summary: day === 5 ? 'ab'.repeat(400) : '', transcript: '[0:00] Ana: Hi\n[0:30] Ben: Hello',
  }));
  const looseMeetings = [meeting('s-1', '2026-09-01'), meeting('s-2', '2026-09-02')];
  const load = (meetings: BiscottiMeeting[], project?: string) => {
    const preview = previewBiscottiImport(memory, meetings, 'mcp');
    return importBiscottiMeetings(memory, { data: meetings, source: 'mcp', fingerprint: preview.fingerprint, includeIds: meetings.map((m) => m.id), project });
  };
  const imported = load(gardenMeetings, 'garden');
  load(looseMeetings);
  memory.items.archive(imported.items.find((item) => item.sourceId === 'g-3')!.id);
  memory.items.saveNote({ body: 'Not a meeting', createdAt: '2026-10-10T00:00:00.000Z' });
  memory.items.insert({
    type: 'note', title: 'Tampered', createdAt: '2026-08-01T00:00:00.000Z',
    metadata: { importedFrom: { kind: 'biscotti', path: 't-1' }, biscottiMeeting: { version: 1, id: 'other' } },
  }, { automations: false });

  const seen: string[] = [];
  let before: string | undefined;
  let pages = 0;
  do {
    const page = listBiscottiMeetings(memory, { limit: 3, before });
    seen.push(...page.items.map((item) => item.meetingId));
    before = page.next ?? undefined;
    pages++;
  } while (before);
  assert.deepEqual(seen, ['g-5', 'g-4', 'g-2', 'g-1', 's-2', 's-1']);
  assert.equal(pages, 3, 'the tampered note still advances the cursor without being returned');

  const inGarden = listBiscottiMeetings(memory, { project: 'garden' });
  assert.deepEqual(inGarden.items.map((item) => item.meetingId), ['g-5', 'g-4', 'g-2', 'g-1']);
  assert.equal(inGarden.next, null);
  assert.deepEqual(listBiscottiMeetings(memory, { project: 'studio' }), { items: [], next: null });
  const latest = inGarden.items[0]!;
  assert.deepEqual(latest, {
    id: imported.items.find((item) => item.sourceId === 'g-5')!.id, meetingId: 'g-5', title: 'Meeting g-5', date: '2026-10-05T00:00:00.000Z',
    summary: 'ab'.repeat(250), speakers: ['Ana', 'Ben'], participants: [], project: { id: garden.id, name: 'Garden' }, source: 'mcp',
    moments: [{ start: 0, speaker: 'Ana' }, { start: 30, speaker: 'Ben' }],
  });
  assert.equal(listBiscottiMeetings(memory, { limit: 1000 }).items.length, 6);

  for (const options of [{ limit: 0 }, { limit: 1.5 }, { limit: '5' as never }]) {
    assert.throws(() => listBiscottiMeetings(memory, options), /positive integer/);
  }
  assert.throws(() => listBiscottiMeetings(memory, { project: 5 as never }), /project/);
  assert.throws(() => listBiscottiMeetings(memory, { before: 'nonsense' }), /before/);
  assert.throws(() => listBiscottiMeetings(memory, { project: 'nowhere' }), { code: 'not_found' });
});
