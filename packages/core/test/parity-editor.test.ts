import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, type ItemState, MAX_LIMIT, MIGRATIONS, MemoryError, openDatabase } from '@enve-memory/core';

const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const tempHome = (label: string) => mkdtempSync(join(tmpdir(), `enve-memory-${label}-`));
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const ids = (memory: EnveMemory, parentId: string | null) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((e) => e.item.id);
const note = (memory: EnveMemory, title: string, parentId: string | null = null, body?: string) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const placement = (memory: EnveMemory, parentId: string) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT, includeArchived: true }).items.map((e) => [e.item.id, e.position, e.item.archivedAt === null]);

test('a batch creates notes under client ids, can refer to them, and undoes and redoes as one action', () => {
  const memory = open();
  const list = note(memory, 'Groceries');
  const milk = note(memory, 'Milk', list);
  const dairy = uuidv7();
  const cheese = uuidv7();
  const actionId = uuidv7();
  const commands = [
    { op: 'create', id: dairy, parentId: list, beforeId: milk, title: 'Dairy' },
    { op: 'create', id: cheese, parentId: dairy, body: 'Cheddar' },
    { op: 'move', id: milk, parentId: dairy, beforeId: cheese },
    { op: 'presentation', id: dairy, patch: { kind: 'heading' } },
  ] as const;
  const result = memory.editor.apply([...commands], { id: actionId });
  assert.deepEqual(result, { actionId, focusId: dairy, createdIds: [dairy, cheese], label: 'Edit outline' });
  assert.deepEqual(ids(memory, list), [dairy]);
  assert.deepEqual(ids(memory, dairy), [milk, cheese]);
  assert.deepEqual(memory.editor.apply([...commands], { id: actionId }), result, 'a retried action is not applied twice');
  assert.deepEqual(ids(memory, dairy), [milk, cheese]);
  assert.throws(() => memory.editor.apply([{ op: 'update', id: milk, title: 'Oat milk' }], { id: actionId }), failsWith('conflict'));
  assert.throws(() => memory.editor.apply([{ op: 'create', id: milk, parentId: null, title: 'Again' }]), failsWith('conflict'));
  assert.throws(() => memory.editor.apply([{ op: 'create', id: dairy.toUpperCase(), parentId: null, title: 'Upper' }]), failsWith('invalid', /UUIDv7/));
  assert.throws(() => memory.outline.createNote({ id: 'not-an-id', parentId: null, title: 'x' }), failsWith('invalid', /UUIDv7/));

  const versions = memory.versions.list(milk).total;
  assert.throws(() => memory.editor.apply([
    { op: 'update', id: milk, title: 'Whole milk' },
    { op: 'move', id: list, parentId: milk },
  ]), failsWith('invalid'), 'a cycle anywhere rolls back the whole batch');
  assert.equal(memory.items.get(milk).title, 'Milk');
  assert.equal(memory.versions.list(milk).total, versions);

  const undone = memory.editor.undo(actionId);
  assert.equal(undone.focusId, list, 'focus returns to where the first new note was made');
  assert.deepEqual(ids(memory, list), [milk]);
  assert.ok(memory.items.get(dairy).archivedAt && memory.items.get(cheese).archivedAt, 'created notes are archived, not deleted');
  assert.equal(memory.presentation.get(dairy).kind, 'heading');
  assert.deepEqual(memory.editor.undo(actionId), undone, 'undo is idempotent');

  memory.editor.redo(actionId);
  assert.deepEqual(ids(memory, list), [dairy]);
  assert.deepEqual(ids(memory, dairy), [milk, cheese]);
  assert.equal(memory.items.get(cheese).archivedAt, null);
  assert.equal(memory.activity.recent({ entityId: milk })[0]!.op, 'redo');
  assert.throws(() => memory.editor.undo(uuidv7()), failsWith('not_found'));
});

test('split and merge keep identities, children and text recoverable, and undo restores both sides', () => {
  const memory = open();
  const trip = note(memory, 'Trip');
  const plan = note(memory, 'Pack 🎒 tent', trip, 'Body stays');
  const after = note(memory, 'After', trip);
  const child = note(memory, 'Stakes', plan);

  assert.throws(() => memory.editor.apply([{ op: 'split', id: plan, field: 'title', offset: 6, baseText: 'Pack 🎒 tent' }]), failsWith('invalid', /inside a character/));
  assert.throws(() => memory.editor.apply([{ op: 'split', id: plan, field: 'title', offset: 4, baseText: 'Pack tent' }]), failsWith('conflict'));
  assert.throws(() => memory.editor.apply([{ op: 'split', id: plan, field: 'title', offset: 12, baseText: 'Pack 🎒 tent' }]), failsWith('invalid', /Nothing follows/));
  assert.throws(() => memory.editor.apply([{ op: 'split', id: trip, field: 'body', offset: 0, baseText: '' }]), failsWith('invalid'));

  const split = memory.editor.apply([{ op: 'split', id: plan, field: 'title', offset: 7, baseText: 'Pack 🎒 tent' }]);
  const [tail] = split.createdIds;
  assert.deepEqual([memory.items.get(plan).title, memory.items.get(plan).body], ['Pack 🎒', 'Body stays']);
  assert.deepEqual([memory.items.get(tail!).title, memory.items.get(tail!).body], ['tent', '']);
  assert.deepEqual(ids(memory, trip), [plan, tail, after], 'the new note follows the original');
  assert.deepEqual(ids(memory, plan), [child], 'children stay on the original');

  const bodySplit = memory.editor.apply([{ op: 'split', id: plan, field: 'body', offset: 4, baseText: 'Body stays', newId: uuidv7() }]);
  const [bodyTail] = bodySplit.createdIds;
  assert.deepEqual([memory.items.get(bodyTail!).title, memory.items.get(bodyTail!).body], ['', 'stays']);
  assert.equal(memory.items.get(plan).title, 'Pack 🎒');

  assert.throws(() => memory.editor.apply([{ op: 'merge', id: tail!, previousId: plan }]), failsWith('conflict'), 'only the exact previous sibling');
  const merge = memory.editor.apply([{ op: 'merge', id: bodyTail!, previousId: plan }]);
  assert.equal(merge.focusId, plan);
  const moved = note(memory, 'Lantern', tail!);
  const second = memory.editor.apply([{ op: 'merge', id: tail!, previousId: plan }]);
  assert.deepEqual([memory.items.get(plan).title, memory.items.get(plan).body], ['Pack 🎒 tent', 'Body\n\nstays']);
  assert.deepEqual(ids(memory, plan), [child, moved], 'the source’s children are appended');
  assert.ok(memory.items.get(tail!).archivedAt, 'the source is archived');

  memory.editor.undo(second.actionId);
  assert.deepEqual(ids(memory, tail!), [moved]);
  assert.deepEqual(ids(memory, plan), [child]);
  assert.equal(memory.items.get(tail!).archivedAt, null);
  assert.equal(memory.items.get(plan).title, 'Pack 🎒');
  memory.items.delete(moved);
  memory.editor.undo(merge.actionId);
  memory.editor.undo(bodySplit.actionId);
  memory.editor.undo(split.actionId);
  assert.deepEqual([memory.items.get(plan).title, memory.items.get(plan).body], ['Pack 🎒 tent', 'Body stays']);
  assert.deepEqual(ids(memory, trip), [plan, after]);

  memory.projects.create({ name: 'Camping' });
  const decision = memory.decisions.record({ project: 'camping', decision: 'Use the green tent' }).id;
  assert.throws(() => memory.editor.apply([{ op: 'update', id: decision, title: 'Changed' }]), failsWith('invalid'));
  assert.throws(() => memory.editor.apply([{ op: 'split', id: decision, field: 'title', offset: 3, baseText: 'Use the green tent' }]), failsWith('invalid'));
});

test('undo refuses after a later edit to anything the action changed, but ignores unrelated work and opening', () => {
  const memory = open();
  const list = note(memory, 'Chores');
  const a = note(memory, 'Dishes', list);
  const b = note(memory, 'Laundry', list);
  const other = note(memory, 'Unrelated');
  memory.presentation.update(list, { checklist: true });

  const check = memory.editor.apply([{ op: 'check', id: list, checked: true }]);
  assert.deepEqual([a, b].map((id) => memory.presentation.get(id).checked), [true, true], 'descendants are checked with it');
  memory.items.update(other, { body: 'still unrelated' });
  memory.items.markOpened(a);
  const opened = memory.items.get(a).openedAt;
  memory.editor.undo(check.actionId);
  assert.deepEqual([list, a, b].map((id) => memory.presentation.get(id).checked), [false, false, false]);
  assert.equal(memory.items.get(a).openedAt, opened, 'opening isn’t an edit, and is kept');
  assert.equal(memory.items.get(other).body, 'still unrelated');

  memory.editor.redo(check.actionId);
  memory.presentation.toggle(b, false);
  const before = memory.versions.list(a).total;
  assert.throws(() => memory.editor.undo(check.actionId), failsWith('conflict', /edited since/));
  assert.equal(memory.presentation.get(a).checked, true, 'nothing is half undone');
  assert.equal(memory.versions.list(a).total, before);

  const edit = memory.editor.apply([{ op: 'update', id: a, body: 'with soap', baseBody: '' }]);
  assert.throws(() => memory.editor.apply([{ op: 'update', id: a, body: 'stale', baseBody: '' }]), failsWith('conflict'));
  memory.editor.undo(edit.actionId);
  memory.items.update(a, { body: 'typed meanwhile' });
  assert.throws(() => memory.editor.redo(edit.actionId), failsWith('conflict'));
  assert.equal(memory.items.get(a).body, 'typed meanwhile');
});

test('undo puts back siblings that a crowded insert respaced', () => {
  const memory = open();
  const list = note(memory, 'List');
  const first = note(memory, 'first', list);
  const last = note(memory, 'last', list);
  const original = placement(memory, list);
  const actions: string[] = [];
  for (let i = 0; i < 40; i++) {
    actions.push(memory.editor.apply([{ op: 'create', parentId: list, beforeId: last, title: `item ${i}` }]).actionId);
  }
  assert.notDeepEqual(placement(memory, list).filter(([id]) => id === first || id === last), original, 'the list was respaced');
  for (const actionId of actions.reverse()) memory.editor.undo(actionId);
  assert.deepEqual(placement(memory, list).filter(([, , active]) => active), original);
});

test('a synced protection or type change invalidates both sides of an older editor action', () => {
  for (const direction of ['undo', 'redo'] as const) {
    for (const protection of ['secret', 'decision'] as const) {
      const memory = open();
      try {
        const id = note(memory, direction === 'undo' ? 'Private draft' : 'Secret note');
        const action = memory.editor.apply([{ op: 'update', id, title: direction === 'undo' ? 'Secret note' : 'Private draft' }]);
        if (direction === 'redo') memory.editor.undo(action.actionId);
        const original = memory.sync.exportChanges(0).records.find((record) => record.id === id)!;
        const state = structuredClone(original.state) as ItemState;
        if (protection === 'decision') state.item.type = 'decision';
        else state.item.metadata = JSON.stringify({
          secret: true, vault: {
            v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 },
            salt: Buffer.alloc(16).toString('base64'), iv: Buffer.alloc(12).toString('base64'),
            tag: Buffer.alloc(16).toString('base64'), data: Buffer.alloc(30).toString('base64'),
          },
        });
        const device = uuidv7();
        const applied = memory.sync.applyChanges([{
          ...original, base: original.hlc, state, device, hlc: `${new Date(Date.now() + 1000).toISOString()}-000000-${device}`,
        }]);
        assert.equal(applied.imported, 1);
        assert.throws(() => memory.editor[direction](action.actionId), failsWith('conflict'));
        assert.equal(memory.items.get(id).title, 'Secret note');
        assert.equal(memory.items.get(id).type, protection === 'decision' ? 'decision' : 'note');
      } finally {
        memory.close();
      }
    }
  }
});

test('project memory history is paged, includes text synced from another device, and never invents older remote text', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  for (const text of ['one', 'two', 'two', 'three']) memory.projects.setMemory('garage', text);
  const page = memory.projects.memoryHistory('garage', { limit: 2 });
  assert.equal(page.total, 3, 'an unchanged write adds nothing');
  assert.deepEqual(page.items.map((v) => v.memory), ['three', 'two']);
  assert.deepEqual(memory.projects.memoryHistory('garage', { offset: 2 }).items.map((v) => [v.memory, v.op, v.actor]), [['one', 'set_memory', 'test']]);
  assert.throws(() => memory.projects.memoryHistory('garage', { offset: -1 }), failsWith('invalid'));

  const peer = open();
  peer.actor = 'laptop';
  peer.sync.applyChanges(memory.sync.exportChanges(0).records);
  peer.projects.setMemory('garage', 'four from the laptop');
  memory.sync.applyChanges(peer.sync.exportChanges(0, undefined, { base: 'synced' }).records);
  const [latest] = memory.projects.memoryHistory('garage').items;
  assert.deepEqual([latest!.memory, latest!.op, latest!.actor], ['four from the laptop', 'sync', 'laptop']);
  assert.equal(memory.projects.memoryHistory('garage').total, 4);
});

test('a populated library upgrades with truthful memory history and a working editor journal', () => {
  const home = tempHome('memory-history');
  const previous = MIGRATIONS.length - 1;
  const db = openDatabase(join(home, 'memory.sqlite'), { migrations: MIGRATIONS.slice(0, previous) });
  const at = (minute: number) => `2026-05-01T10:0${minute}:00.000Z`;
  const project = db.prepare(`INSERT INTO projects (id, name, slug, memory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  project.run('p-local', 'Local', 'local', 'second', at(0), at(2));
  project.run('p-synced', 'Synced', 'synced', 'edited on another device', at(0), at(3));
  project.run('p-remote', 'Remote', 'remote', 'arrived by sync', at(0), at(0));
  project.run('p-empty', 'Empty', 'empty', '', at(0), at(0));
  const change = db.prepare(
    `INSERT INTO changes (id, device_id, actor, entity, entity_id, op, project_id, data, at, hlc) VALUES (?, 'dev', 'cli', 'project', ?, 'set_memory', ?, ?, ?, ?)`,
  );
  change.run(uuidv7(), 'p-local', 'p-local', JSON.stringify({ memory: 'first' }), at(1), `${at(1)}-000000-dev`);
  change.run(uuidv7(), 'p-local', 'p-local', JSON.stringify({ memory: 'second' }), at(2), `${at(2)}-000000-dev`);
  change.run(uuidv7(), 'p-synced', 'p-synced', JSON.stringify({ memory: 'written here' }), at(1), `${at(1)}-000001-dev`);
  db.prepare(`INSERT INTO items (id, type, title, body, source, created_at, updated_at, parent_id, sort_order) VALUES ('n1', 'note', 'Old note', 'kept', 'cli', ?, ?, NULL, 1000)`).run(at(0), at(0));
  db.close();

  const memory = EnveMemory.open({ home, actor: 'test' });
  assert.equal(memory.schemaVersion, MIGRATIONS.length);
  assert.ok(readdirSync(join(home, 'backups')).some((file) => file.startsWith(`pre-migration-v${previous}-`)));
  const history = (ref: string) => memory.projects.memoryHistory(ref).items.map((v) => [v.memory, v.op, v.actor]);
  assert.deepEqual(history('local'), [['second', 'set_memory', 'cli'], ['first', 'set_memory', 'cli']]);
  assert.deepEqual(memory.projects.memoryHistory('local').items.map((v) => v.at), [at(2), at(1)]);
  assert.deepEqual(history('synced'), [['edited on another device', 'baseline', 'migration'], ['written here', 'set_memory', 'cli']]);
  assert.deepEqual(history('remote'), [['arrived by sync', 'baseline', 'migration']]);
  assert.deepEqual(memory.projects.memoryHistory('empty'), { items: [], total: 0 });
  assert.ok(memory.projects.memoryHistory('local').items.every((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.id)));

  memory.projects.setMemory('remote', 'edited after upgrade');
  assert.equal(memory.projects.memoryHistory('remote').total, 2);
  const split = memory.editor.apply([{ op: 'split', id: 'n1', field: 'title', offset: 3, baseText: 'Old note' }]);
  memory.editor.undo(split.actionId);
  assert.deepEqual([memory.items.get('n1').title, memory.items.get('n1').body], ['Old note', 'kept']);
  memory.close();
});

test('file bytes that history refers to survive old trash and come back on restore; missing bytes are reported', () => {
  const home = tempHome('file-history');
  const memory = EnveMemory.open({ home, actor: 'test' });
  const { item } = memory.files.save({ data: new TextEncoder().encode('wiring diagram'), filename: 'wiring.txt' });
  const sha = item.attachments[0]!.sha256;
  const version = memory.versions.list(item.id).items[0]!.id;
  const live = memory.files.primary(item.id).path;
  memory.items.delete(item.id);
  const trashed = join(home, 'attachments', '.trash', sha);
  assert.ok(existsSync(trashed) && !existsSync(live));

  const stray = join(home, 'attachments', '.trash', 'a'.repeat(64));
  writeFileSync(stray, 'nobody refers to this');
  const old = new Date(Date.now() - 60 * 86_400_000);
  utimesSync(trashed, old, old);
  utimesSync(stray, old, old);
  memory.backups.runSchedule();
  assert.ok(existsSync(trashed), 'bytes a version refers to are kept past the trash window');
  assert.equal(existsSync(stray), false, 'unreferenced trash is still emptied');

  const restored = memory.versions.restore(version);
  assert.deepEqual(restored, { restored: 1 });
  assert.equal(memory.files.read(item.id).data.toString(), 'wiring diagram');

  const second = memory.files.save({ data: new TextEncoder().encode('lost bytes'), filename: 'lost.txt' }).item;
  const secondVersion = memory.versions.list(second.id).items[0]!.id;
  const secondSha = second.attachments[0]!.sha256;
  memory.items.delete(second.id);
  rmSync(join(home, 'attachments', '.trash', secondSha));
  const partial = memory.versions.restore(secondVersion);
  assert.equal(partial.restored, 1);
  assert.deepEqual(partial.missingFiles, [{ itemId: second.id, attachmentId: second.attachments[0]!.id, sha256: secondSha, filename: 'lost.txt' }]);
  memory.close();
});

test('the library feed pages current ordinary state and hides secrets', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const parent = note(memory, 'Parent');
  const child = note(memory, 'Child', parent, 'text');
  const secretId = uuidv7();
  memory.vault.createSealed({
    id: secretId,
    envelope: {
      v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 },
      salt: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64'),
      tag: randomBytes(16).toString('base64'), data: randomBytes(48).toString('base64'),
    },
  });
  memory.items.relate(child, secretId, 'related_to');
  memory.items.relate(child, parent, 'references');

  const all = memory.feed.page();
  assert.equal(all.cursor, memory.feed.revision);
  assert.equal(all.hasMore, false);
  assert.deepEqual(all.items.map((e) => [e.item.id, e.parentId]), [[parent, null], [child, parent]]);
  assert.deepEqual(all.deletedItemIds, [secretId]);
  assert.deepEqual(all.projects.map((p) => p.slug), ['garage']);
  assert.deepEqual(all.relations.map((r) => [r.fromId, r.toId, r.kind]), [[child, parent, 'references']]);
  assert.equal(all.deletedRelationIds.length, 1, 'a relation to a secret is never sent');

  const first = memory.feed.page(0, 2);
  assert.equal(first.hasMore, true);
  const rest = memory.feed.page(first.cursor, 500);
  assert.equal(rest.cursor, all.cursor);
  memory.items.delete(child);
  assert.deepEqual(memory.feed.page(all.cursor).deletedItemIds, [child]);
  assert.equal(memory.feed.page(all.cursor + 1000).reset, true);
  assert.throws(() => memory.feed.page(-1), failsWith('invalid'));
});

test('a secret move into a secret parent undoes and redoes without changing its envelope', () => {
  const memory = open();
  memory.vault.setup('synthetic editor vault');
  const parent = memory.vault.create({ title: 'Parent secret', body: '' });
  const child = memory.vault.create({ title: 'Child secret', body: '' });
  const sealed = memory.items.get(child.id).metadata.vault;
  const action = memory.editor.apply([{ op: 'move', id: child.id, parentId: parent.id }]);
  assert.equal(memory.outline.get(child.id).parentId, parent.id);
  memory.editor.undo(action.actionId);
  assert.equal(memory.outline.get(child.id).parentId, null);
  memory.editor.redo(action.actionId);
  assert.equal(memory.outline.get(child.id).parentId, parent.id);
  assert.deepEqual(memory.items.get(child.id).metadata.vault, sealed);
  assert.equal(memory.vault.read(child.id).title, 'Child secret');
  memory.close();
});
