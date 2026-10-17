import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, type ItemState, MemoryError, type SyncRecord } from '@enve-memory/core';

// Fictional values only.
const PASSPHRASE = 'quartz meadow lantern';

const temp = (label: string) => mkdtempSync(join(tmpdir(), `petty-review-fixes-${label}-`));
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const blobFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();

test('a secret note refuses a link, title or body through ordinary updates, unchanged, but keeps project and tags editable', () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.vault.setup(PASSPHRASE);
  const secret = memory.vault.create({ title: 'Locker', body: 'fictional combination' });
  const before = memory.items.get(secret.id);
  const versions = memory.versions.list(secret.id).total;
  for (const input of [{ url: 'https://example.com/leak' }, { url: null }, { title: 'Plain' }, { body: 'Plain' }]) {
    assert.throws(() => memory.items.update(secret.id, input), failsWith('invalid', /secret note/));
  }
  assert.deepEqual(memory.items.get(secret.id), before);
  assert.equal(memory.versions.list(secret.id).total, versions);

  memory.projects.create({ name: 'Errands' });
  assert.equal(memory.items.update(secret.id, { project: 'errands' }).project?.name, 'Errands');
  assert.deepEqual(memory.items.tag(secret.id, { add: ['private'] }).tags, ['private']);
  assert.equal(memory.items.get(secret.id).url, null);
  assert.equal(memory.vault.read(secret.id).body, 'fictional combination');
  memory.close();
});

test('vault.create refuses a missing title or body with a readable error', () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.vault.setup(PASSPHRASE);
  const loose = memory.vault as unknown as { create: (input: Record<string, unknown>) => unknown };
  assert.throws(() => loose.create({ title: undefined, body: 'some text' }), failsWith('invalid', /as text/));
  assert.throws(() => loose.create({ title: 'Some title', body: undefined }), failsWith('invalid', /as text/));
  assert.throws(() => loose.create({ title: 7, body: 'x' }), failsWith('invalid', /as text/));
  assert.equal(memory.items.list({ secret: true }).length, 0);
  memory.close();
});

test('a removed encrypted attachment id stays bound to its file and owner while history can restore it', () => {
  const memory = EnveMemory.open({ home: temp('rebind'), actor: 'test' });
  try {
    memory.vault.setup(PASSPHRASE);
    const note = memory.vault.create({ title: 'Scans', body: 'fictional' });
    const other = memory.vault.create({ title: 'Other', body: 'fictional' });
    const id = uuidv7();
    const original = randomBytes(1024);
    const stored = memory.vault.attachFile(note.id, { id, data: original, filename: 'scan.bin' });
    const envelope = memory.vault.sealedAttachment(note.id, id);
    assert.deepEqual(memory.vault.removeFile(note.id, id), { removed: true });

    const blobs = blobFiles(memory.paths!.attachments);
    assert.throws(() => memory.vault.attachFile(note.id, { id, data: randomBytes(1024), filename: 'scan.bin' }), failsWith('conflict'));
    assert.throws(() => memory.vault.attachSealed(other.id, id, envelope), failsWith('conflict'), 'another note can’t take the id');
    assert.deepEqual(blobFiles(memory.paths!.attachments), blobs, 'a refused payload never reaches the disk');
    assert.deepEqual(memory.items.get(note.id).attachments, []);
    assert.deepEqual(memory.items.get(other.id).attachments, []);

    const before = memory.versions.list(note.id).items.map((v) => memory.versions.get(v.id))
      .find((v) => v.snapshot.items[0]!.item.attachments.length === 1)!;
    assert.deepEqual(memory.vault.restoreVersion(before.id), { restored: 1 });
    assert.deepEqual(memory.items.get(note.id).attachments.map((a) => [a.id, a.sha256]), [[id, stored.sha256]]);
    assert.deepEqual(Buffer.from(memory.vault.readFile(note.id, id).data), original);

    memory.vault.removeFile(note.id, id);
    assert.equal(memory.vault.attachSealed(note.id, id, envelope).sha256, stored.sha256, 'the same file may come back under its id');
    assert.deepEqual(Buffer.from(memory.vault.readFile(note.id, id).data), original);
  } finally {
    memory.close();
  }
});

test('synced records with timestamps clients can’t decode are refused one by one; valid records still land', () => {
  const a = EnveMemory.open({ inMemory: true, actor: 'device-a' });
  const b = EnveMemory.open({ inMemory: true, actor: 'device-b' });
  const project = a.projects.create({ name: 'Garage' });
  const notes = Array.from({ length: 6 }, (_, i) => a.items.saveNote({ body: `note ${i}` }));
  const dayTask = a.tasks.create({ title: 'Order relays', due: '2026-10-01' });
  const timeTask = a.tasks.create({ title: 'Call supplier', due: '2026-10-01T09:30:00.000Z' });
  a.tasks.complete(timeTask.id);
  const badDue = a.tasks.create({ title: 'Bad due', due: '2026-10-02' });
  const badDay = a.tasks.create({ title: 'Bad day', due: '2026-10-03' });
  const badDone = a.tasks.create({ title: 'Bad done' });
  a.tasks.complete(badDone.id);
  const { records } = a.sync.exportChanges();
  const item = (id: string) => (records.find((r) => r.id === id)!.state as ItemState);
  item(notes[0]!.id).item.created_at = 'yesterday';
  item(notes[1]!.id).item.updated_at = '2026-10-17 12:00:00';
  item(notes[2]!.id).item.pinned_at = 'soon';
  item(notes[3]!.id).item.remind_at = '2026-13-01T00:00:00.000Z';
  item(notes[4]!.id).item.archived_at = '2026-02-30T00:00:00.000Z';
  item(badDue.id).task!.due_at = 'next week';
  item(badDay.id).task!.due_at = '2026-02-30';
  item(badDone.id).task!.completed_at = 'done';
  const malformed = [notes[0]!, notes[1]!, notes[2]!, notes[3]!, notes[4]!, badDue, badDay, badDone].map((n) => n.id);

  const applied = b.sync.applyChanges(records as SyncRecord[]);
  assert.equal(applied.rejected, malformed.length);
  assert.deepEqual(applied.rejectedRecords!.map((r) => r.id).sort(), [...malformed].sort());
  for (const id of malformed) assert.throws(() => b.items.get(id), failsWith('not_found'));
  assert.equal(b.items.get(notes[5]!.id).body, 'note 5');
  assert.equal(b.projects.resolve(project.id).name, 'Garage');
  assert.equal(b.tasks.get(dayTask.id).task.dueAt, '2026-10-01');
  assert.equal(b.tasks.get(timeTask.id).task.dueAt, '2026-10-01T09:30:00.000Z');
  assert.equal(b.tasks.get(timeTask.id).task.status, 'done');
  a.close();
  b.close();
});
