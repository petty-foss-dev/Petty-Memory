import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorInfo, displayTitle, dueInfo, formatReminder, providedSourceLink, snippetParts } from '../src/renderer/lib/format.ts';

test('provided book links allow web and Enve sources without executing other schemes or carrying credentials', () => {
  assert.equal(providedSourceLink('enve://book/example?position=0.2'), 'enve://book/example?position=0.2');
  assert.equal(providedSourceLink('https://example.test/passage'), 'https://example.test/passage');
  for (const url of ['javascript:alert(1)', 'file:///tmp/notes', 'data:text/plain,hello', 'https://user:password@example.test/', 'enve://user:password@book/1', '', null, {}]) {
    assert.equal(providedSourceLink(url), null);
  }
});

test('search snippets split into highlighted and plain parts', () => {
  assert.deepEqual(snippetParts('the [rolling] code [replay] attack'), [
    { text: 'the ', match: false }, { text: 'rolling', match: true }, { text: ' code ', match: false }, { text: 'replay', match: true }, { text: ' attack', match: false },
  ]);
  assert.deepEqual(snippetParts('no matches'), [{ text: 'no matches', match: false }]);
});

test('untitled notes show their first line', () => {
  assert.equal(displayTitle({ title: '', body: '\n## Bench rig\nmore' }), 'Bench rig');
  assert.equal(displayTitle({ title: '', body: '', url: 'https://x.test/' }), 'https://x.test/');
  assert.equal(displayTitle({ title: 'Kept', body: 'ignored' }), 'Kept');
});

test('due dates read as today, tomorrow, overdue or a date', () => {
  const now = new Date(2026, 8, 24, 15);
  assert.deepEqual(dueInfo('2026-09-24', now), { label: 'Today', tone: 'soon' });
  assert.deepEqual(dueInfo('2026-09-25', now), { label: 'Tomorrow', tone: 'soon' });
  assert.equal(dueInfo('2026-09-20', now)?.tone, 'overdue');
  assert.equal(dueInfo('2026-12-01', now)?.tone, 'later');
  assert.equal(dueInfo(null, now), null);
});

test('actors read as people and tools', () => {
  assert.deepEqual(actorInfo('mcp:claude-code'), { label: 'claude-code · MCP', kind: 'ai' });
  assert.deepEqual(actorInfo('api:Chrome extension'), { label: 'Chrome extension · API', kind: 'device' });
  assert.equal(actorInfo('desktop').kind, 'you');
  assert.equal(actorInfo('ingest').kind, 'background');
});

test('reminder times read relative to now', () => {
  const now = new Date(2026, 8, 24, 10);
  const at = (days: number, hour: number) => new Date(2026, 8, 24 + days, hour).toISOString();
  assert.match(formatReminder(at(0, 20), now), /^Tonight /);
  assert.match(formatReminder(at(0, 11), now), /^Today /);
  assert.match(formatReminder(at(1, 9), now), /^Tomorrow /);
  assert.match(formatReminder(at(-1, 9), now), /^Yesterday /);
  assert.match(formatReminder(at(3, 10), now), /^Sun /);
  assert.match(formatReminder(at(20, 9), now), /^Oct 14, /);
});
