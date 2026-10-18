import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { EnveMemory, MAX_LIMIT, MemoryError, type ReviewSchedule } from '@enve-memory/core';

const START = Date.parse('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;
const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const fails = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!pattern || pattern.test(error.message));
const changes = (memory: EnveMemory) => memory.activity.recent({}, MAX_LIMIT).length;
const titles = (memory: EnveMemory, options?: { limit?: number; project?: string }) => memory.review.queue(options).map((card) => card.item.title);

/** A frozen clock that moves only when told, so creation order and due dates are exact. */
function clock(t: TestContext) {
  let now = START;
  t.mock.timers.enable({ apis: ['Date'], now });
  return (ms = 1000) => {
    now += ms;
    t.mock.timers.setTime(now);
    return new Date(now).toISOString();
  };
}

test('the queue holds only ordinary knowledge and never writes', (t) => {
  const advance = clock(t);
  const memory = open();
  const note = memory.items.saveNote({ title: 'Wiring', body: 'Terminals 1 and 2' }).id;
  advance();
  const link = memory.items.saveLink({ url: 'https://example.com/opener', title: 'Opener manual', ingest: false }).item.id;
  advance();
  memory.projects.create({ name: 'Garage' });
  memory.tasks.create({ title: 'Replace battery' });
  memory.decisions.record({ project: 'garage', decision: 'Keep the opener' });
  memory.views.create({ name: 'Garage view', query: 'garage' });
  const source = memory.outline.createNote({ parentId: null, title: 'Checklist' }).item.id;
  const step = memory.outline.createNote({ parentId: source, title: 'Step' }).item.id;
  const template = memory.templates.create(source, 'Checklist template');
  memory.outline.createNote({ parentId: template.id, title: 'Added later' });
  memory.chats.save({ mode: 'ask', messages: [{ role: 'user', content: 'Which opener?' }] });
  memory.items.archive(memory.items.saveNote({ title: 'Old', body: 'gone' }).id);
  memory.vault.setup('correct horse battery staple');
  memory.vault.create({ title: 'Code', body: '4471' });
  memory.items.archive(step);
  memory.items.archive(source);

  const before = changes(memory);
  const cards = memory.review.queue({ limit: 100 });
  assert.deepEqual(cards.map((card) => card.item.id), [note, link]);
  assert.deepEqual(cards[0], {
    item: memory.items.list({}, MAX_LIMIT).find((item) => item.id === note), dueAt: null, lastReviewedAt: null, reviewCount: 0, reason: 'Not reviewed yet',
  });
  assert.equal(changes(memory), before, 'the queue only reads');
});

test('due items come first, oldest due first, then unreviewed pinned or marked items, then the rest oldest first', (t) => {
  const advance = clock(t);
  const memory = open();
  const make = (title: string) => {
    advance();
    return memory.items.saveNote({ title, body: `${title} text` }).id;
  };
  const oldest = make('Oldest');
  const pinned = make('Pinned');
  const important = make('Important');
  const marked = make('Marked');
  const soon = make('Soon');
  const later = make('Later');
  memory.items.pin(pinned, true);
  memory.presentation.update(important, { attention: 'high' });
  memory.presentation.update(marked, { review: true });
  assert.deepEqual(titles(memory), ['Pinned', 'Important', 'Marked', 'Oldest', 'Soon', 'Later']);
  assert.deepEqual(memory.review.queue().map((card) => card.reason), [
    'Pinned and not reviewed yet', 'Marked important and not reviewed yet', 'Marked for review and not reviewed yet',
    'Not reviewed yet', 'Not reviewed yet', 'Not reviewed yet',
  ]);

  const reviewedAt = advance();
  const scheduled = memory.review.schedule(later, 1);
  memory.review.schedule(soon, 3);
  assert.deepEqual(scheduled.metadata.reviewSchedule, {
    version: 1, dueAt: new Date(Date.parse(reviewedAt) + DAY).toISOString(), lastReviewedAt: reviewedAt, count: 1, history: [{ at: reviewedAt, days: 1 }],
  } satisfies ReviewSchedule);
  assert.deepEqual(titles(memory), ['Pinned', 'Important', 'Marked', 'Oldest'], 'scheduled items wait until they are due');

  advance(DAY);
  assert.deepEqual(titles(memory, { limit: 2 }), ['Later', 'Pinned']);
  const due = memory.review.queue()[0]!;
  assert.deepEqual(
    [due.reason, due.dueAt, due.lastReviewedAt, due.reviewCount],
    ['Due for review', (scheduled.metadata.reviewSchedule as ReviewSchedule).dueAt, reviewedAt, 1],
  );
  advance(3 * DAY);
  assert.deepEqual(titles(memory).slice(0, 2), ['Later', 'Soon'], 'the longest overdue comes first');
  assert.equal(memory.items.get(oldest).metadata.reviewSchedule, undefined);
});

test('scheduling appends bounded history and keeps everything else about the item', (t) => {
  const advance = clock(t);
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const id = memory.items.saveNote({ title: 'Wiring', body: 'Terminals', project: 'garage', tags: ['opener'] }).id;
  memory.presentation.update(id, { attention: 'high' });
  memory.items.pin(id, true);
  const updatedAt = memory.items.get(id).updatedAt;
  let last = '';
  for (let i = 0; i < 55; i++) {
    last = advance();
    memory.review.schedule(id, 7);
  }
  const item = memory.items.get(id);
  const schedule = item.metadata.reviewSchedule as ReviewSchedule;
  assert.equal(schedule.count, 55);
  assert.equal(schedule.history.length, 50);
  assert.deepEqual(schedule.history.at(-1), { at: last, days: 7 });
  assert.equal(schedule.dueAt, new Date(Date.parse(last) + 7 * DAY).toISOString());
  assert.equal(item.metadata.presentation?.attention, 'high');
  assert.notEqual(item.pinnedAt, null);
  assert.deepEqual(item.tags, ['opener']);
  assert.equal(item.project?.name, 'Garage');
  assert.equal(item.body, 'Terminals');
  assert.equal(item.updatedAt, updatedAt, 'reviewing isn’t editing');
  assert.equal(memory.versions.list(id, { limit: MAX_LIMIT }).items[0]!.op, 'review', 'each review is journalled');
});

test('days, limits and projects are validated, and only knowledge can be scheduled', () => {
  const memory = open();
  const garage = memory.projects.create({ name: 'Garage' });
  const note = memory.items.saveNote({ body: 'In the garage', project: 'garage' }).id;
  memory.items.saveNote({ body: 'Elsewhere' });
  for (const days of [0, 3651, 1.5, Number.NaN, '3' as unknown as number]) {
    assert.throws(() => memory.review.schedule(note, days), fails('invalid', /whole number from 1 to 3650/));
  }
  assert.equal((memory.review.schedule(note, 3650).metadata.reviewSchedule as ReviewSchedule).history[0]!.days, 3650);
  for (const limit of [0, 101, 2.5]) assert.throws(() => memory.review.queue({ limit }), fails('invalid', /limit/));
  assert.deepEqual(titles(memory, { project: garage.id }), [], 'a scheduled item in the project isn’t due');
  assert.deepEqual(memory.review.queue({ project: 'garage', limit: 100 }).length, 0);
  assert.equal(memory.review.queue().length, 1);
  assert.throws(() => memory.review.queue({ project: 'nowhere' }), fails('not_found'));

  for (let i = 0; i < 12; i++) memory.items.saveNote({ body: `Note ${i}` });
  assert.equal(memory.review.queue().length, 10, 'ten by default');
  assert.equal(memory.review.queue({ limit: 100 }).length, 13);

  const task = memory.tasks.create({ title: 'Replace battery' }).id;
  const decision = memory.decisions.record({ project: 'garage', decision: 'Keep the opener' }).id;
  const view = memory.views.create({ name: 'Garage view', query: 'garage' }).id;
  const template = memory.templates.create(memory.outline.createNote({ parentId: null, title: 'Checklist' }).item.id).id;
  const member = memory.outline.createNote({ parentId: template, title: 'Added later' }).item.id;
  const chat = memory.chats.save({ mode: 'ask', messages: [{ role: 'user', content: 'Which opener?' }] }).id;
  memory.vault.setup('correct horse battery staple');
  const secret = memory.vault.create({ title: 'Code', body: '4471' }).id;
  for (const id of [task, decision, view, template, member, chat, secret]) {
    assert.throws(() => memory.review.schedule(id, 1), fails('invalid', /Only notes, links, files and images can be reviewed/));
  }
  memory.items.archive(note);
  assert.throws(() => memory.review.schedule(note, 1), fails('invalid', /archived/));
  assert.throws(() => memory.review.schedule('0190f1f2-0000-7000-8000-000000000000', 1), fails('not_found'));
});

test('schedules survive reopening and sync, and a malformed schedule from another device starts over', () => {
  const home = mkdtempSync(join(tmpdir(), 'petty-review-'));
  const first = EnveMemory.open({ home, actor: 'test' });
  const id = first.items.saveNote({ title: 'Wiring', body: 'Terminals' }).id;
  const scheduled = first.review.schedule(id, 2).metadata.reviewSchedule;
  first.close();

  const reopened = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(reopened.items.get(id).metadata.reviewSchedule, scheduled);
  assert.deepEqual(reopened.review.queue(), []);
  const peer = open();
  peer.sync.applyChanges(reopened.sync.exportChanges().records);
  assert.deepEqual(peer.items.get(id).metadata.reviewSchedule, scheduled);
  assert.deepEqual(peer.review.queue(), []);
  reopened.close();

  const other = open();
  const odd = other.items.saveNote({ title: 'Odd', body: 'from a buggy client' }).id;
  const records = other.sync.exportChanges().records.map((record) => {
    if (record.id !== odd || record.state === null || record.entity !== 'item') return record;
    const state = record.state as { item: Record<string, unknown> };
    const metadata = { reviewSchedule: { version: 1, dueAt: 'soon', lastReviewedAt: 42, count: -3, history: 'none' } };
    return { ...record, state: { ...state, item: { ...state.item, metadata: JSON.stringify(metadata) } } };
  });
  const target = open();
  target.sync.applyChanges(records as never);
  const [card] = target.review.queue();
  assert.deepEqual([card!.item.id, card!.dueAt, card!.lastReviewedAt, card!.reviewCount, card!.reason], [odd, null, null, 0, 'Not reviewed yet']);
  const repaired = target.review.schedule(odd, 1).metadata.reviewSchedule as ReviewSchedule;
  assert.deepEqual([repaired.count, repaired.history.length], [1, 1]);
});
