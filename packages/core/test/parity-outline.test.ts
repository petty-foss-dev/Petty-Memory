import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_PRESENTATION, EnveMemory, MAX_LIMIT, MIGRATIONS, MemoryError, type SyncRecord, openDatabase, referencedIds,
} from '@enve-memory/core';

const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const ids = (memory: EnveMemory, parentId: string | null) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((e) => e.item.id);
const note = (memory: EnveMemory, title: string, parentId: string | null = null, body?: string) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const task = (memory: EnveMemory, title: string, parentId: string) => {
  const { id } = memory.tasks.create({ title });
  memory.outline.move(id, { parentId });
  return id;
};
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
// Shape-valid ciphertext; these tests never decrypt it.
const opaqueEnvelope = () => ({
  v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 },
  salt: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64'),
  tag: randomBytes(16).toString('base64'), data: randomBytes(48).toString('base64'),
});

test('a populated v10 library upgrades with a truthful subtree baseline, its hierarchy and its search index', () => {
  const home = mkdtempSync(join(tmpdir(), 'enve-memory-parity-v10-'));
  const v10 = openDatabase(join(home, 'memory.sqlite'), { migrations: MIGRATIONS.slice(0, 10) });
  const at = '2026-03-01T10:00:00.000Z';
  const insert = v10.prepare(
    `INSERT INTO items (id, type, title, body, source, created_at, updated_at, parent_id, sort_order) VALUES (?, ?, ?, ?, 'cli', ?, ?, ?, ?)`,
  );
  insert.run('trip', 'note', 'Lake trip', 'Weekend plan', at, at, null, 1000);
  insert.run('tent', 'note', 'Tent', 'Borrow the green tent', at, at, 'trip', 1000);
  insert.run('stakes', 'task', 'Buy stakes', '', at, at, 'tent', 1000);
  insert.run('loose', 'note', '', 'Unrelated root', at, at, null, 2000);
  v10.prepare(`INSERT INTO tasks (item_id, status) VALUES ('stakes', 'done')`).run();
  v10.close();

  const memory = EnveMemory.open({ home, actor: 'test' });
  assert.equal(memory.schemaVersion, MIGRATIONS.length);
  const history = memory.versions.list('trip');
  assert.equal(history.total, 1, 'earlier states are not invented');
  assert.deepEqual([history.items[0]!.op, history.items[0]!.actor], ['baseline', 'migration']);
  const baseline = memory.versions.get(history.items[0]!.id).snapshot;
  assert.deepEqual(baseline.items.map((n) => [n.item.id, n.parentId]), [['trip', null], ['tent', 'trip'], ['stakes', 'tent']]);
  assert.equal(baseline.items[2]!.item.task?.status, 'done');

  assert.deepEqual(ids(memory, 'trip'), ['tent']);
  assert.deepEqual(memory.outline.ancestors('stakes').map((i) => i.id), ['trip', 'tent']);
  assert.deepEqual(memory.search.query('green tent').map((h) => h.id), ['tent']);

  memory.items.update('tent', { body: 'Bring our own shelter' });
  const [latest] = memory.versions.list('trip').items;
  assert.equal(latest!.op, 'subtree', 'a child edit shows in its parent’s history');
  assert.deepEqual(memory.search.query('green'), []);

  assert.equal(memory.versions.restore(history.items[0]!.id).restored, 3);
  assert.equal(memory.items.get('tent').body, 'Borrow the green tent');
  assert.deepEqual(memory.search.query('green').map((h) => h.id), ['tent']);
  assert.deepEqual(ids(memory, null), ['trip', 'loose']);
  memory.close();
  assert.equal(readdirSync(join(home, 'backups')).length, 1);
});

test('a populated v11 library keeps later history out of the baseline snapshot after upgrading', () => {
  const home = mkdtempSync(join(tmpdir(), 'enve-memory-parity-v11-'));
  const file = join(home, 'memory.sqlite');
  const v10 = openDatabase(file, { migrations: MIGRATIONS.slice(0, 10) });
  const at = '2026-04-01T09:00:00.000Z';
  const insert = v10.prepare(
    `INSERT INTO items (id, type, title, body, source, created_at, updated_at, parent_id, sort_order) VALUES (?, 'note', ?, ?, 'cli', ?, ?, ?, ?)`,
  );
  insert.run('essay', 'Essay', 'Outline', at, at, null, 1000);
  insert.run('draft', 'Draft', 'First draft', at, at, 'essay', 1000);
  v10.close();

  const v11 = openDatabase(file, { migrations: MIGRATIONS.slice(0, 11) });
  // What a v11 build would have recorded after its baseline: a later edit of the child.
  const { state } = v11.prepare(`SELECT state FROM item_versions WHERE item_id = 'draft'`).get() as { state: string };
  const edited = JSON.parse(state) as { item: Record<string, unknown> };
  edited.item.body = 'Second draft';
  v11.prepare(`UPDATE items SET body = 'Second draft' WHERE id = 'draft'`).run();
  v11.prepare(`INSERT INTO item_versions (id, item_id, parent_id, at, actor, op, state) VALUES (?, 'draft', 'essay', ?, 'cli', 'update', ?)`)
    .run(uuidv7(), new Date().toISOString(), JSON.stringify(edited));
  v11.close();

  const memory = EnveMemory.open({ home, actor: 'test' });
  assert.equal(memory.schemaVersion, MIGRATIONS.length);
  const [baseline] = memory.versions.list('essay').items;
  assert.equal(baseline!.op, 'baseline');
  const snapshot = memory.versions.get(baseline!.id).snapshot.items;
  assert.deepEqual(snapshot.map((n) => [n.item.id, n.item.body]), [['essay', 'Outline'], ['draft', 'First draft']]);
  const draftHistory = memory.versions.list('draft').items;
  assert.deepEqual(draftHistory.map((v) => v.op), ['update', 'baseline']);
  assert.equal(memory.versions.get(draftHistory[0]!.id).snapshot.items[0]!.item.body, 'Second draft');
  assert.deepEqual(memory.search.query('second').map((h) => h.id), ['draft']);
  memory.close();
});

test('nested checklists mix tasks and notes, with task status the only authority for tasks', () => {
  const memory = open();
  const list = note(memory, 'Camping list');
  assert.deepEqual(memory.presentation.get(list), DEFAULT_PRESENTATION);
  memory.presentation.update(list, { checklist: true });
  const tent = task(memory, 'Pack tent', list);
  const food = note(memory, 'Food', list);
  const fuel = task(memory, 'Stove fuel', food);
  const snacks = note(memory, 'Snacks', food);
  const maps = note(memory, 'Maps', list);
  memory.items.archive(note(memory, 'Old checklist entry', list));
  assert.deepEqual(memory.presentation.progress(list), { done: 0, total: 4 }, 'tent, fuel, snacks and maps count; archived items don’t');

  memory.presentation.toggle(food, true);
  assert.equal(memory.tasks.get(fuel).task.status, 'done');
  assert.equal(memory.presentation.get(fuel).checked, true, 'presentation projects the task status');
  assert.equal(memory.items.get(fuel).metadata.presentation?.checked, undefined, 'completion is not duplicated in metadata');
  assert.equal(memory.presentation.get(snacks).checked, true);
  assert.deepEqual(memory.presentation.progress(food), { done: 2, total: 2 });
  memory.tasks.complete(tent);
  assert.deepEqual(memory.presentation.progress(list), { done: 3, total: 4 });
  memory.presentation.toggle(tent, false);
  assert.equal(memory.tasks.get(tent).task.status, 'open');
  memory.tasks.complete(tent);

  assert.deepEqual(memory.presentation.reset(list), { updated: 4 }, 'food, fuel, snacks and tent were checked');
  assert.deepEqual(memory.presentation.progress(list), { done: 0, total: 4 });
  assert.deepEqual([tent, fuel].map((id) => memory.tasks.get(id).task.status), ['open', 'open']);

  memory.projects.create({ name: 'Garage' });
  const decision = memory.decisions.record({ project: 'garage', decision: 'Camp by the lake' }).id;
  assert.throws(() => memory.presentation.toggle(decision, true), failsWith('invalid'));
  assert.throws(() => memory.presentation.update(decision, { review: true }), failsWith('invalid'));
  assert.throws(() => memory.presentation.update(maps, { attention: 'urgent' } as never), failsWith('invalid'));
  assert.throws(() => memory.presentation.update(maps, { colour: 'red' } as never), failsWith('invalid'));

  memory.presentation.update(maps, { review: true, attention: 'high' });
  memory.presentation.update(snacks, { attention: 'low' });
  assert.deepEqual(memory.items.list({ review: true }).map((i) => i.id), [maps]);
  assert.deepEqual(memory.items.list({ attention: 'high' }).map((i) => i.id), [maps]);
  assert.deepEqual(memory.items.list({ attention: 'low' }).map((i) => i.id), [snacks]);
  const normal = memory.items.list({ attention: 'normal' }).map((i) => i.id);
  assert.ok(normal.includes(list) && !normal.includes(maps) && !normal.includes(snacks));
  assert.deepEqual(memory.search.query('maps', { review: true }).map((h) => h.id), [maps]);
  assert.deepEqual(memory.search.query('snacks', { review: true }), []);
  assert.throws(() => memory.items.list({ attention: 'urgent' }), failsWith('invalid'));
});

test('an entry whose only children are archived still counts toward checklist progress', () => {
  const memory = open();
  const list = note(memory, 'Errands');
  const post = note(memory, 'Post office', list);
  const bank = note(memory, 'Bank', list);
  memory.items.archive(note(memory, 'Old bank form', bank));
  assert.equal(memory.outline.get(bank).childCount, 0, 'the active outline shows Bank as a plain entry');
  memory.presentation.toggle(post, true);
  assert.deepEqual(memory.presentation.progress(list), { done: 1, total: 2 });
  memory.presentation.toggle(bank, true);
  assert.deepEqual(memory.presentation.progress(list), { done: 2, total: 2 });
});

test('root history captures child edits as whole transactions and restores a subtree without touching later work', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const root = note(memory, 'Shelf build');
  const cut = note(memory, 'Cut boards', root);
  const sand = note(memory, 'Sand', cut);
  const paint = note(memory, 'Paint', root);
  const unrelated = note(memory, 'Unrelated');

  memory.presentation.toggle(root, true);
  const [checked] = memory.versions.list(root).items;
  const checkedSnapshot = memory.versions.get(checked!.id).snapshot.items;
  assert.deepEqual(
    checkedSnapshot.map((n) => [n.item.id, n.item.metadata.presentation?.checked]),
    [[root, true], [cut, true], [paint, true], [sand, true]],
    'descendants written after the root in the same transaction are in its snapshot',
  );

  memory.items.update(sand, { body: 'Use 120 grit' });
  const [good] = memory.versions.list(root).items;
  assert.equal(good!.op, 'subtree');
  assert.equal(memory.versions.get(good!.id).snapshot.items.find((n) => n.item.id === sand)?.item.body, 'Use 120 grit');
  assert.equal(memory.versions.list(cut).items[0]!.op, 'subtree', 'intermediate ancestors get the change too');

  memory.items.update(cut, { title: 'Cut boards badly' });
  memory.outline.move(sand, { parentId: null });
  memory.items.delete(paint);
  const later = note(memory, 'Added later', root);
  memory.items.update(unrelated, { body: 'edited elsewhere' });
  const decision = memory.decisions.record({ project: 'garage', decision: 'Use pine' }).id;
  const total = memory.versions.list(root).total;

  assert.deepEqual(memory.versions.restore(good!.id), { restored: 4 });
  assert.deepEqual(ids(memory, root), [cut, paint, later], 'the deleted child returns and a later child stays');
  assert.equal(memory.items.get(cut).title, 'Cut boards');
  assert.equal(memory.outline.get(sand).parentId, cut);
  assert.equal(memory.items.get(sand).body, 'Use 120 grit');
  assert.equal(memory.presentation.get(paint).checked, true);
  assert.equal(memory.items.get(unrelated).body, 'edited elsewhere');
  assert.equal(memory.activity.recent({ entityId: paint })[0]!.op, 'restore');
  const after = memory.versions.list(root);
  assert.ok(after.total > total, 'restore is a new version, not a rewrite');
  assert.equal(after.items[0]!.op, 'restore');

  const deletion = memory.versions.list(paint, { limit: MAX_LIMIT }).items.find((v) => v.op === 'delete')!;
  assert.throws(() => memory.versions.restore(deletion.id), failsWith('invalid'));
  const [recorded] = memory.versions.list(decision).items;
  assert.deepEqual(memory.versions.restore(recorded!.id), { restored: 0 }, 'decisions are never rewritten');
  assert.equal(memory.items.get(decision).title, 'Use pine');
});

test('history pages newest first with exact totals and validated paging', () => {
  const memory = open();
  const draft = note(memory, 'Draft');
  for (let i = 1; i <= 30; i++) memory.items.update(draft, { body: `revision ${i}` });
  const seen: string[] = [];
  for (let offset = 0; ; offset += 7) {
    const page = memory.versions.list(draft, { offset, limit: 7 });
    assert.equal(page.total, 31);
    if (page.items.length === 0) break;
    seen.push(...page.items.map((v) => v.id));
  }
  assert.equal(new Set(seen).size, 31);
  const all = memory.versions.list(draft, { limit: MAX_LIMIT }).items;
  assert.deepEqual(all.map((v) => v.id), seen);
  assert.equal(memory.versions.get(all[0]!.id).snapshot.items[0]!.item.body, 'revision 30');
  assert.equal(all.at(-1)!.op, 'create');
  assert.throws(() => memory.versions.list(draft, { offset: -1 }), failsWith('invalid'));
  assert.throws(() => memory.versions.list(draft, { limit: 0 }), failsWith('invalid'));
  assert.throws(() => memory.versions.list('missing'), failsWith('not_found'));
  assert.throws(() => memory.versions.get('missing'), failsWith('not_found'));
});

test('inline references follow renames and backlinks follow the text', () => {
  const memory = open();
  const gear = note(memory, 'Gear list');
  const trip = note(memory, 'Trip', null, 'Plan');
  memory.references.insert(trip, gear, 'Gear | old]name');
  const body = memory.items.get(trip).body;
  assert.match(body, /^Plan\n\[\[item:[0-9a-f-]+\|[^\]|]+\]\]$/);
  assert.deepEqual(referencedIds(body), [gear]);

  memory.items.update(gear, { title: 'Packing gear' });
  assert.deepEqual(memory.references.list(trip).outgoing, [
    { kind: 'references', direction: 'outgoing', id: gear, type: 'note', title: 'Packing gear' },
  ]);
  assert.deepEqual(memory.references.list(gear).incoming.map((r) => [r.id, r.title]), [[trip, 'Trip']]);

  assert.throws(() => memory.references.insert(trip, trip), failsWith('invalid'));
  assert.throws(() => memory.references.insert(trip, 'missing'), failsWith('not_found'));
  memory.items.update(trip, { body: 'Plan without links' });
  assert.deepEqual(memory.references.list(gear).incoming, []);
});

test('removing a connection is logged and syncs as a tombstone; superseding never comes undone', () => {
  const a = open();
  const b = open();
  a.projects.create({ name: 'Garage' });
  const x = note(a, 'Opener');
  const y = note(a, 'Relay');
  a.items.relate(x, y, 'related_to');
  const old = a.decisions.record({ project: 'garage', decision: 'Use ESP32' });
  a.decisions.record({ project: 'garage', decision: 'Use ESP32-S3', supersedes: [old.id] });
  const first = a.sync.exportChanges();
  b.sync.applyChanges(first.records);
  assert.deepEqual(b.items.get(x).relations.map((r) => r.id), [y]);

  a.items.unrelate(x, y, 'related_to');
  assert.deepEqual(a.items.get(x).relations, []);
  assert.ok(a.activity.recent({}, MAX_LIMIT).some((c) => c.entity === 'relation' && c.op === 'delete'));
  assert.throws(() => a.items.unrelate(x, y, 'related_to'), failsWith('not_found'));
  assert.throws(() => a.items.unrelate(old.id, old.id, 'supersedes'), failsWith('invalid'));

  const removal = a.sync.exportChanges(first.nextCursor);
  assert.ok(removal.records.some((r) => r.entity === 'relation' && r.state === null));
  b.sync.applyChanges(removal.records);
  assert.deepEqual(b.items.get(x).relations, []);

  const supersedes = first.records.find((r) => r.entity === 'relation' && (r.state as { kind?: string }).kind === 'supersedes')!;
  const forged: SyncRecord = { ...supersedes, hlc: `${new Date(Date.now() + 1000).toISOString()}-000000-${a.deviceId}`, state: null };
  b.sync.applyChanges([forged]);
  assert.notEqual(b.decisions.list('garage').find((d) => d.id === old.id)?.supersededBy, null);
});

test('edit proposals are scoped, carry trusted before-state, and apply selectively, atomically and only when fresh', () => {
  const memory = open();
  const list = note(memory, 'Groceries');
  const milk = note(memory, 'Milk', list, 'two litres');
  const eggs = note(memory, 'Eggs', list);
  const aisle = note(memory, 'Old aisle', list);
  const hidden = note(memory, 'Under the archived aisle', aisle);
  memory.items.archive(aisle);
  const secret = uuidv7();
  memory.vault.createSealed({ id: secret, envelope: opaqueEnvelope() });
  memory.outline.move(secret, { parentId: list });
  const outside = note(memory, 'Outside');

  const scope = memory.edits.scope(list);
  assert.deepEqual(scope.nodes.map((n) => n.id), [list, milk, eggs], 'archived and secret branches are pruned with their descendants');
  assert.throws(() => memory.edits.scope(secret), failsWith('invalid'));
  assert.throws(() => memory.edits.scope(aisle), failsWith('invalid'));

  const proposal = memory.edits.prepare(list, scope.baseHash, 'Tidy up', [
    { op: 'update', id: milk, title: 'Oat milk', before: { title: 'forged', body: 'forged', parentId: null } },
    { op: 'update', id: secret, title: 'leak' },
    { op: 'update', id: hidden, title: 'reach into the archive' },
    { op: 'update', id: outside, title: 'reach outside' },
    { op: 'delete', id: eggs },
    { op: 'create', parentId: list, title: 'Bread' },
    { op: 'move', id: eggs, parentId: list, beforeId: milk },
    { op: 'move', id: list, parentId: milk },
    { op: 'presentation', id: list, patch: { checklist: true } },
  ]);
  assert.deepEqual(proposal.operations.map((o) => o.op), ['update', 'create', 'move', 'presentation']);
  assert.deepEqual((proposal.operations[0] as { before: unknown }).before, { title: 'Milk', body: 'two litres', parentId: list });
  assert.equal(memory.items.get(milk).title, 'Milk', 'preparing applies nothing');

  const chosen = { ...proposal, operations: [proposal.operations[0]!, proposal.operations[2]!] };
  assert.equal(memory.edits.apply(chosen).applied, 2);
  assert.equal(memory.items.get(milk).title, 'Oat milk');
  assert.deepEqual(ids(memory, list).slice(0, 2), [eggs, milk]);
  assert.equal(memory.presentation.get(list).checklist, false, 'unchosen operations stay unapplied');
  assert.throws(() => memory.edits.apply(proposal), failsWith('conflict'), 'the rest of the proposal is now stale');
  assert.deepEqual(memory.search.query('bread'), []);

  const fresh = memory.edits.scope(list);
  const next = memory.edits.prepare(list, fresh.baseHash, '', [
    { op: 'update', id: eggs, title: 'Free-range eggs' },
    { op: 'create', parentId: list, title: 'Bread' },
  ]);
  // Passes validation but fails while applying, after the earlier operations have been written.
  const poisoned = { ...next, operations: [...next.operations, { op: 'move', id: eggs, parentId: eggs, beforeId: null }] };
  assert.throws(() => memory.edits.apply(poisoned as never), failsWith('invalid', /under itself/));
  assert.equal(memory.items.get(eggs).title, 'Eggs', 'all or nothing');
  assert.deepEqual(memory.search.query('bread'), []);

  memory.items.update(milk, { body: 'two litres, unsweetened' });
  assert.throws(() => memory.edits.apply(next), failsWith('conflict'));
  assert.equal(memory.items.get(eggs).title, 'Eggs');
});

test('undoing an applied proposal restores the earlier subtree and archives what it created, but not after later edits', () => {
  const memory = open();
  const list = note(memory, 'Packing');
  const socks = note(memory, 'Socks', list);
  const hat = note(memory, 'Hat', list);
  const scope = memory.edits.scope(list);
  const proposal = memory.edits.prepare(list, scope.baseHash, 'Group clothes', [
    { op: 'update', id: socks, title: 'Wool socks' },
    { op: 'create', parentId: list, title: 'Clothes' },
    { op: 'move', id: hat, parentId: list, beforeId: socks },
  ]);
  const { applied, undo } = memory.edits.apply(proposal);
  assert.equal(applied, 3);
  assert.ok(undo);
  const [created] = undo.createdIds;
  assert.equal(memory.items.get(created!).title, 'Clothes');

  assert.throws(() => memory.edits.undo({ ...undo, createdIds: [socks] }), failsWith('invalid'), 'only items the edit created are archived');
  memory.edits.undo(undo);
  assert.equal(memory.items.get(socks).title, 'Socks');
  assert.deepEqual(ids(memory, list), [socks, hat]);
  assert.notEqual(memory.items.get(created!).archivedAt, null, 'the created note is archived, not deleted');
  assert.throws(() => memory.edits.undo(undo), failsWith('conflict'), 'an undo applies once');

  const again = memory.edits.apply(memory.edits.prepare(list, memory.edits.scope(list).baseHash, '', [
    { op: 'update', id: hat, title: 'Sun hat' },
  ]));
  memory.items.update(socks, { body: 'pack three pairs' });
  assert.throws(() => memory.edits.undo(again.undo!), failsWith('conflict'));
  assert.equal(memory.items.get(hat).title, 'Sun hat');
  assert.equal(memory.items.get(socks).body, 'pack three pairs');
});
