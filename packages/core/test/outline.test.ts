import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { EnveMemory, MAX_LIMIT, MemoryError } from '@enve-memory/core';

const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const ids = (memory: EnveMemory, parentId: string | null, options = {}) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT, ...options }).items.map((e) => e.item.id);
const note = (memory: EnveMemory, title: string, parentId: string | null = null) => memory.outline.createNote({ parentId, title }).item.id;

test('everything saved through existing paths becomes an ordered root, and items keep their shape', () => {
  const memory = EnveMemory.open({ home: mkdtempSync(join(tmpdir(), 'enve-memory-outline-files-')), actor: 'test' });
  memory.settings.set('fetchLinks', false);
  memory.projects.create({ name: 'Garage' });
  const saved = [
    memory.items.saveNote({ body: 'a note' }).id,
    memory.items.saveLink({ url: 'https://example.com/spec' }).item.id,
    memory.tasks.create({ title: 'Order relays', project: 'garage' }).id,
    memory.files.save({ data: new TextEncoder().encode('pins'), filename: 'pins.txt' }).item.id,
    memory.decisions.record({ project: 'garage', decision: 'Use ESP32' }).id,
  ];
  assert.deepEqual(ids(memory, null), saved);
  const entry = memory.outline.get(saved[0]!);
  assert.equal(entry.parentId, null);
  assert.equal(entry.childCount, 0);
  assert.ok(Number.isFinite(entry.position));
  assert.equal('parentId' in memory.items.get(saved[0]!), false, 'Item JSON is unchanged; placement lives on OutlineEntry');
  memory.close();
});

test('notes are created nested, reordered with beforeId, and keep their order after reopening', () => {
  const home = mkdtempSync(join(tmpdir(), 'enve-memory-outline-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  const trip = note(memory, 'Trip');
  const packing = note(memory, 'Packing', trip);
  const bookings = note(memory, 'Bookings', trip);
  const budget = note(memory, 'Budget', trip);
  assert.deepEqual(ids(memory, trip), [packing, bookings, budget]);

  memory.outline.move(budget, { parentId: trip, beforeId: packing });
  memory.outline.move(packing, { parentId: trip, beforeId: bookings });
  assert.deepEqual(ids(memory, trip), [budget, packing, bookings]);
  memory.outline.move(budget, { parentId: trip });
  assert.deepEqual(ids(memory, trip), [packing, bookings, budget], 'no beforeId appends');
  const before = memory.activity.recent({ entityId: budget }).length;
  memory.outline.move(budget, { parentId: trip });
  assert.equal(memory.activity.recent({ entityId: budget }).length, before, 'a move to where it already is records nothing');

  assert.throws(() => memory.outline.createNote({ parentId: trip, title: '  ', body: '' }), failsWith('invalid'));
  assert.equal(memory.outline.createNote({ parentId: trip, body: 'body only' }).item.body, 'body only');
  memory.close();

  const reopened = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(ids(reopened, trip).slice(0, 3), [packing, bookings, budget]);
  assert.equal(reopened.outline.get(trip).childCount, 4);
  reopened.close();
});

test('deep nesting keeps whole subtrees together and reports ancestors from the top down', () => {
  const memory = open();
  const chain = [note(memory, 'level 0')];
  for (let depth = 1; depth < 60; depth++) chain.push(note(memory, `level ${depth}`, chain.at(-1)!));
  const deepest = chain.at(-1)!;
  assert.deepEqual(memory.outline.ancestors(deepest).map((i) => i.id), chain.slice(0, -1));
  assert.deepEqual(memory.outline.ancestors(chain[0]!), []);

  const shelf = note(memory, 'Shelf');
  memory.outline.move(chain[10]!, { parentId: shelf });
  assert.deepEqual(memory.outline.ancestors(deepest).map((i) => i.id), [shelf, ...chain.slice(10, -1)]);
  assert.deepEqual(ids(memory, chain[9]!), []);
  assert.equal(memory.outline.get(chain[10]!).childCount, 1);
});

test('moves that would make a loop or land somewhere invalid are refused and change nothing', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const root = note(memory, 'Root');
  const child = note(memory, 'Child', root);
  const grandchild = note(memory, 'Grandchild', child);
  const other = note(memory, 'Other');
  const decision = memory.decisions.record({ project: 'garage', decision: 'Use ESP32' }).id;
  const archived = note(memory, 'Archived');
  memory.items.archive(archived);
  const history = memory.activity.recent({}, MAX_LIMIT).length;

  assert.throws(() => memory.outline.move(root, { parentId: root }), failsWith('invalid', /itself or one of its own descendants/));
  assert.throws(() => memory.outline.move(root, { parentId: grandchild }), failsWith('invalid', /descendants/));
  assert.throws(() => memory.outline.move(child, { parentId: 'missing' }), failsWith('not_found'));
  assert.throws(() => memory.outline.move(child, { parentId: archived }), failsWith('invalid', /archived/));
  assert.throws(() => memory.outline.move(child, { parentId: decision }), failsWith('invalid', /Decisions/));
  assert.throws(() => memory.outline.move(decision, { parentId: root }), failsWith('invalid', /append-only/));
  assert.throws(() => memory.outline.move(decision, { parentId: null }), failsWith('invalid', /append-only/));
  assert.throws(() => memory.outline.move(child, { parentId: root, beforeId: other }), failsWith('invalid', /isn't a sibling/));
  assert.throws(() => memory.outline.move(child, { parentId: root, beforeId: child }), failsWith('invalid', /isn't a sibling/));
  assert.throws(() => memory.outline.move(child, { parentId: root, beforeId: 'missing' }), failsWith('not_found'));
  assert.throws(() => memory.outline.move(child, {} as never), failsWith('invalid'));
  assert.throws(() => memory.outline.createNote({ parentId: decision, title: 'x' }), failsWith('invalid'));
  assert.throws(() => memory.outline.createNote({ parentId: 'missing', title: 'Orphan' }), failsWith('not_found'));

  assert.equal(memory.search.query('orphan').length, 0, 'a failed nested create leaves no item behind');
  assert.equal(memory.activity.recent({}, MAX_LIMIT).length, history);
  assert.deepEqual(memory.outline.ancestors(grandchild).map((i) => i.id), [root, child]);
});

test('nesting never changes projects, in either direction', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  memory.projects.create({ name: 'Travel' });
  const plan = memory.outline.createNote({ parentId: null, title: 'Plan', project: 'travel' }).item.id;
  const wiring = memory.items.saveNote({ body: 'Wiring', project: 'garage' }).id;
  const loose = memory.items.saveNote({ body: 'Loose' }).id;
  memory.outline.move(wiring, { parentId: plan });
  memory.outline.move(loose, { parentId: plan });
  const nested = memory.outline.createNote({ parentId: plan, title: 'Nested', project: 'garage' });

  assert.equal(memory.items.get(wiring).project?.name, 'Garage');
  assert.equal(memory.items.get(loose).project, null);
  assert.equal(nested.item.project?.name, 'Garage');
  assert.deepEqual(memory.items.list({ project: 'garage' }).map((i) => i.id).sort(), [wiring, nested.item.id].sort());
  assert.deepEqual(memory.items.list({ inbox: true }).map((i) => i.id), [loose]);
});

test('children page through every sibling with an exact total and validated paging', () => {
  const memory = open();
  const parent = note(memory, 'Parent');
  const children = Array.from({ length: 205 }, (_, i) => note(memory, `Entry ${i}`, parent));
  const first = memory.outline.children(parent, { limit: 500 });
  assert.equal(first.total, 205);
  assert.equal(first.items.length, MAX_LIMIT);
  const rest = memory.outline.children(parent, { offset: 200, limit: 200 });
  assert.deepEqual([...first.items, ...rest.items].map((e) => e.item.id), children);
  assert.equal(memory.outline.children(parent, { offset: 205 }).items.length, 0);
  assert.equal(memory.outline.children(parent).items.length, 50);

  for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => memory.outline.children(parent, options), failsWith('invalid'), JSON.stringify(options));
  }
  assert.throws(() => memory.outline.children('missing'), failsWith('not_found'));
});

test('deleting a parent hands its children to the grandparent in its place, logged in the same transaction', () => {
  const memory = open();
  const root = note(memory, 'Root');
  const before = note(memory, 'Before', root);
  const doomed = note(memory, 'Doomed', root);
  const after = note(memory, 'After', root);
  const kids = [note(memory, 'Kid 1', doomed), note(memory, 'Kid 2', doomed)];
  const grandkid = note(memory, 'Grandkid', kids[0]!);

  memory.actor = 'desktop';
  memory.items.delete(doomed);
  assert.deepEqual(ids(memory, root), [before, ...kids, after]);
  assert.deepEqual(memory.outline.ancestors(grandkid).map((i) => i.id), [root, kids[0]]);
  const moves = kids.map((kid) => memory.activity.recent({ entityId: kid })[0]!);
  assert.deepEqual(moves.map((m) => [m.op, m.actor, m.data?.parentId]), [['move', 'desktop', root], ['move', 'desktop', root]]);
  assert.equal(memory.activity.recent({ entityId: doomed })[0]?.op, 'delete');

  const top = note(memory, 'Top');
  const orphan = note(memory, 'Orphan', top);
  memory.items.delete(top);
  assert.equal(memory.outline.get(orphan).parentId, null);
  assert.ok(ids(memory, null).includes(orphan));
});

test('archiving a parent lifts its active children to the top level until it comes back', () => {
  const memory = open();
  const project = note(memory, 'Project');
  const keep = note(memory, 'Keep', project);
  const done = note(memory, 'Done', project);
  const subtask = note(memory, 'Subtask', keep);
  memory.items.archive(done);
  assert.deepEqual(ids(memory, project), [keep]);
  assert.equal(memory.outline.get(project).childCount, 1);
  assert.deepEqual(ids(memory, project, { includeArchived: true }), [keep, done]);
  assert.equal(memory.outline.children(project, { includeArchived: true }).items[0]!.childCount, 1);

  memory.items.archive(project);
  const roots = ids(memory, null);
  assert.ok(roots.includes(keep), 'an active child of an archived parent is still reachable');
  assert.equal(roots.includes(project), false);
  assert.equal(roots.includes(subtask), false, 'only the top of the active subtree is lifted');
  assert.equal(memory.outline.get(keep).parentId, project, 'the stored parent is kept');
  assert.deepEqual(ids(memory, keep), [subtask]);
  assert.deepEqual(memory.outline.children(project), { items: [], total: 0 });
  assert.deepEqual(ids(memory, null, { includeArchived: true }).includes(keep), false);
  assert.equal(memory.outline.get(project).childCount, 2, 'an archived item is described in the stored tree');
  assert.throws(() => memory.outline.createNote({ parentId: project, title: 'x' }), failsWith('invalid', /archived/));

  memory.outline.move(note(memory, 'Sibling of archived', null), { parentId: null, beforeId: project });
  memory.items.unarchive(project);
  assert.deepEqual(ids(memory, project), [keep]);
  assert.equal(ids(memory, null).includes(keep), false);
});

test('moves are attributed to the acting client and carry the new placement', () => {
  const memory = open();
  const a = note(memory, 'A');
  const b = note(memory, 'B');
  memory.actor = 'mcp:claude-code';
  const moved = memory.outline.move(b, { parentId: a });
  const [change] = memory.activity.recent({ entityId: b });
  assert.equal(change?.op, 'move');
  assert.equal(change?.actor, 'mcp:claude-code');
  assert.deepEqual(change?.data, { parentId: a, sortOrder: moved.position });
  assert.equal(memory.activity.recent({ entityId: a }).length, 1, 'the parent itself is not edited');
});

test('inserting again and again at one spot stays ordered, with every key finite', () => {
  const memory = open();
  const parent = note(memory, 'Parent');
  const last = note(memory, 'Last', parent);
  const expected = [last];
  for (let i = 0; i < 120; i++) {
    const id = note(memory, `n${i}`, parent);
    memory.outline.move(id, { parentId: parent, beforeId: last });
    expected.splice(expected.length - 1, 0, id);
  }
  const page = memory.outline.children(parent, { limit: MAX_LIMIT });
  assert.deepEqual(page.items.map((e) => e.item.id), expected);
  assert.ok(page.items.every((e, i) => Number.isFinite(e.position) && (i === 0 || e.position > page.items[i - 1]!.position)));
});

test('keys pushed to the edge of the safe range still give valid, correctly ordered placements', () => {
  const home = mkdtempSync(join(tmpdir(), 'enve-memory-outline-edge-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  const parent = note(memory, 'Parent');
  const tied = [note(memory, 'x', parent), note(memory, 'y', parent), note(memory, 'z', parent)];
  const low = note(memory, 'low', parent);
  memory.close();
  // Another device can legitimately deliver keys right at the limit (see sync); simulate that state directly.
  const raw = new DatabaseSync(join(home, 'memory.sqlite'));
  raw.prepare(`UPDATE items SET sort_order = ? WHERE id IN (?, ?, ?)`).run(2 ** 53, ...tied);
  raw.prepare(`UPDATE items SET sort_order = ? WHERE id = ?`).run(-(2 ** 53), low);
  raw.close();

  const reopened = EnveMemory.open({ home, actor: 'test' });
  const ordered = [low, ...tied].sort((a, b) => (a === low ? -1 : b === low ? 1 : a < b ? -1 : 1));
  assert.deepEqual(ids(reopened, parent), ordered);
  const appended = note(reopened, 'appended', parent);
  reopened.outline.move(ordered[1]!, { parentId: parent });
  const between = note(reopened, 'between', parent);
  reopened.outline.move(between, { parentId: parent, beforeId: ordered[3]! });
  const first = note(reopened, 'first', parent);
  reopened.outline.move(first, { parentId: parent, beforeId: low });

  const page = reopened.outline.children(parent, { limit: MAX_LIMIT }).items;
  assert.deepEqual(page.map((e) => e.item.id), [first, low, ordered[2], between, ordered[3], appended, ordered[1]]);
  for (const [i, entry] of page.entries()) {
    assert.ok(Math.abs(entry.position) <= 2 ** 53, `key ${entry.position} stays in range`);
    if (i > 0) assert.ok(entry.position > page[i - 1]!.position, 'keys are strictly increasing');
  }
  reopened.close();
});
