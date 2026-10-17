import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, type ItemState, MAX_LIMIT, type SecretEnvelope, type SyncRecord } from '@enve-memory/core';

const temp = (label: string) => mkdtempSync(join(tmpdir(), `enve-memory-parity-sync-${label}-`));
const pause = () => new Promise((r) => setTimeout(r, 5));
const later = (deviceId: string, ms = 1000) => `${new Date(Date.now() + ms).toISOString()}-000000-${deviceId}`;
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// A fictional client key, derived once.
const SALT = randomBytes(16);
const KEY = pbkdf2Sync('juniper orbit kettle'.normalize('NFKC'), SALT, 600_000, 32, 'sha256');
function seal(id: string, body: string): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify({ title: 'Safe', body }), 'utf8'), cipher.final()]);
  return {
    v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 }, salt: SALT.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}
function unseal(envelope: SecretEnvelope, id: string): string {
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(id, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return (JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) as { body: string }).body;
}

/** Every state an item's history holds, oldest last. */
const history = (memory: EnveMemory, id: string) => memory.versions.list(id, { limit: MAX_LIMIT }).items
  .map((v) => ({ op: v.op, node: memory.versions.get(v.id).snapshot.items[0]!.item }));

test('concurrent plain edits converge and the losing text stays in the item’s own history, once', async () => {
  const a = EnveMemory.open({ inMemory: true, actor: 'device-a' });
  const b = EnveMemory.open({ inMemory: true, actor: 'device-b' });
  const route = a.items.saveNote({ title: 'Route', body: 'Take the coast road' });
  const startA = a.sync.exportChanges();
  b.sync.applyChanges(startA.records);
  const startB = b.sync.exportChanges().nextCursor;

  a.items.update(route.id, { body: 'Take the mountain pass' });
  await pause();
  b.items.update(route.id, { body: 'Take the ferry' });
  const fromA = a.sync.exportChanges(startA.nextCursor).records;
  const fromB = b.sync.exportChanges(startB).records;
  assert.deepEqual(b.sync.applyChanges(fromA), { imported: 1, conflicts: 1, rejected: 0 });
  a.sync.applyChanges(fromB);

  for (const memory of [a, b]) {
    assert.equal(memory.items.get(route.id).body, 'Take the ferry');
    const states = history(memory, route.id);
    assert.equal(states[0]!.node.body, 'Take the ferry', 'the newest version is the live one');
    assert.ok(states.some((s) => s.node.id === route.id && s.node.body === 'Take the mountain pass'));
  }
  assert.ok(history(b, route.id).some((s) => s.op === 'conflict'));

  const versions = [a, b].map((m) => m.versions.list(route.id).total);
  const notes = [a, b].map((m) => m.items.list({}, MAX_LIMIT).length);
  assert.deepEqual(b.sync.applyChanges(fromA), { imported: 0, conflicts: 0, rejected: 0 });
  assert.deepEqual(a.sync.applyChanges(fromB), { imported: 0, conflicts: 0, rejected: 0 });
  assert.deepEqual([a, b].map((m) => m.versions.list(route.id).total), versions, 'replaying adds no history');
  assert.deepEqual([a, b].map((m) => m.items.list({}, MAX_LIMIT).length), notes, 'replaying adds no conflict notes');
});

test('concurrent sealed edits keep the losing ciphertext under its original id, across reopening and replay', async () => {
  const homes = [temp('a'), temp('b')];
  const a = EnveMemory.open({ home: homes[0]!, actor: 'device-a' });
  let b = EnveMemory.open({ home: homes[1]!, actor: 'device-b' });
  const id = uuidv7();
  a.vault.createSealed({ id, envelope: seal(id, 'first fictional code') });
  const startA = a.sync.exportChanges();
  b.sync.applyChanges(startA.records);
  const startB = b.sync.exportChanges().nextCursor;
  const items = [a, b].map((m) => m.items.list({}, MAX_LIMIT).length);

  const losing = seal(id, 'device A fictional code');
  const winning = seal(id, 'device B fictional code');
  a.vault.updateSealed(id, { envelope: losing });
  await pause();
  b.vault.updateSealed(id, { envelope: winning });
  const fromA = a.sync.exportChanges(startA.nextCursor).records;
  const fromB = b.sync.exportChanges(startB).records;
  assert.equal(b.sync.applyChanges(fromA).conflicts, 1);
  assert.equal(a.sync.applyChanges(fromB).conflicts, 1);

  b.close();
  b = EnveMemory.open({ home: homes[1]!, actor: 'device-b' });
  for (const memory of [a, b]) {
    assert.equal(memory.items.get(id).metadata.vault!.data, winning.data);
    const kept = history(memory, id).find((s) => s.node.metadata.vault?.data === losing.data);
    assert.ok(kept, 'the losing ciphertext is in history');
    assert.equal(kept.node.id, id);
    assert.equal(unseal(kept.node.metadata.vault!, id), 'device A fictional code', 'still opens with its original id as associated data');
  }
  assert.deepEqual([a, b].map((m) => m.items.list({}, MAX_LIMIT).length), items, 'no plaintext conflict copy is made for a secret');

  const total = b.versions.list(id).total;
  assert.deepEqual(b.sync.applyChanges(fromA), { imported: 0, conflicts: 0, rejected: 0 });
  assert.equal(b.versions.list(id).total, total);
  a.close();
  b.close();
});

test('sync never rewrites or deletes a decision', () => {
  const a = EnveMemory.open({ inMemory: true, actor: 'device-a' });
  const b = EnveMemory.open({ inMemory: true, actor: 'device-b' });
  a.projects.create({ name: 'Garage' });
  const decision = a.decisions.record({ project: 'garage', decision: 'Use pine', reason: 'cheap' });
  const records = a.sync.exportChanges().records;
  b.sync.applyChanges(records);
  const original = records.find((r): r is SyncRecord & { state: ItemState } => r.entity === 'item' && r.id === decision.id)!;

  const rewrite: SyncRecord = { ...original, hlc: later(a.deviceId), state: { ...original.state, item: { ...original.state.item, title: 'Use oak' } } };
  const tombstone: SyncRecord = { ...original, hlc: later(a.deviceId, 2000), state: null };
  const refused = (r: SyncRecord) => ({ imported: 0, conflicts: 0, rejected: 1, rejectedRecords: [{ entity: r.entity, id: r.id, hlc: r.hlc }] });
  assert.deepEqual(b.sync.applyChanges([rewrite]), refused(rewrite));
  assert.deepEqual(b.sync.applyChanges([tombstone]), refused(tombstone));
  assert.equal(b.items.get(decision.id).title, 'Use pine');
  assert.deepEqual(b.decisions.list('garage').map((d) => d.id), [decision.id]);
});

test('folder sync carries nesting, presentation and checklist state, and synced child edits reach the parent’s history', () => {
  const folder = temp('folder');
  const [a, b] = ['device-a', 'device-b'].map((actor) => {
    const memory = EnveMemory.open({ home: temp(actor), actor });
    memory.settings.set('syncFolder', folder);
    return memory;
  }) as [EnveMemory, EnveMemory];
  const syncAll = () => {
    for (let round = 0; round < 2; round++) for (const m of [a, b]) m.sync.run();
  };

  const hike = a.outline.createNote({ parentId: null, title: 'Hike' }).item.id;
  a.presentation.update(hike, { checklist: true, attention: 'high' });
  const water = a.outline.createNote({ parentId: hike, title: 'Water' }).item.id;
  a.presentation.toggle(water, true);
  const { id: boots } = a.tasks.create({ title: 'Boots' });
  a.outline.move(boots, { parentId: hike });
  a.tasks.complete(boots);
  syncAll();

  assert.deepEqual(b.outline.children(hike).items.map((e) => e.item.id), [water, boots]);
  assert.deepEqual([b.presentation.get(hike).checklist, b.presentation.get(hike).attention], [true, 'high']);
  assert.deepEqual(b.presentation.progress(hike), { done: 2, total: 2 });
  assert.ok(b.versions.list(hike).total >= 1, 'synced items get history on the receiving device');

  b.items.update(water, { title: 'Two litres of water' });
  syncAll();
  assert.equal(a.items.get(water).title, 'Two litres of water');
  const [latest] = a.versions.list(hike).items;
  assert.equal(latest!.op, 'subtree');
  assert.equal(latest!.actor, 'device-b');
  assert.equal(a.versions.get(latest!.id).snapshot.items.find((n) => n.item.id === water)?.item.title, 'Two litres of water');
  a.close();
  b.close();
});
