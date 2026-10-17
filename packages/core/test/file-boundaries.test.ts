import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, openDatabase, pathsFor } from '@enve-memory/core';

test('ordinary file deduplication cannot append plaintext to a secret note', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-file-dedup-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  memory.vault.setup('synthetic file test passphrase');
  const note = memory.vault.create({ title: 'Private receipt', body: 'PRIVATE_NOTE_CONTENT_47' });
  const file = memory.vault.attachFile(note.id, { data: new TextEncoder().encode('receipt bytes'), filename: 'receipt.txt' });
  const exported = readFileSync(memory.files.primary(note.id).path);
  const captured = memory.files.save({ data: exported, filename: file.filename, note: 'An ordinary capture annotation' });
  assert.equal(captured.created, true);
  assert.notEqual(captured.item.id, note.id);
  assert.equal(memory.items.get(note.id).body, '');
  assert.equal(memory.vault.read(note.id).body, 'PRIVATE_NOTE_CONTENT_47');
});

test('restoring history refuses an attachment currently owned by another item before changing text', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-file-owner-'));
  let memory = EnveMemory.open({ home, actor: 'test' });
  const first = memory.files.save({ data: new TextEncoder().encode('a shared file'), filename: 'shared.txt', note: 'Original annotation' }).item;
  const version = memory.versions.list(first.id).items[0]!;
  const second = memory.items.saveNote({ title: 'Current file owner', body: 'Owns the moved attachment' });
  memory.items.update(first.id, { body: 'New annotation' });
  memory.close();
  const db = openDatabase(pathsFor(home).database);
  db.prepare(`UPDATE attachments SET item_id = ? WHERE item_id = ?`).run(second.id, first.id);
  db.close();
  memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  assert.throws(() => memory.versions.restore(version.id), /belongs to another item/);
  assert.equal(memory.items.get(first.id).body, 'New annotation');
  assert.equal(memory.items.get(second.id).attachments.length, 1);
});

test('restoring a version restores a same-owner attachment whose bytes changed on a peer', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-file-version-'));
  let memory = EnveMemory.open({ home, actor: 'test' });
  const first = memory.files.save({ data: new TextEncoder().encode('the original bytes'), filename: 'original.txt' }).item;
  const version = memory.versions.list(first.id).items[0]!;
  const later = memory.files.save({ data: new TextEncoder().encode('later peer bytes'), filename: 'later.txt' }).item;
  const changed = memory.files.primary(later.id).attachment;
  memory.close();
  const db = openDatabase(pathsFor(home).database);
  db.prepare(`UPDATE attachments SET sha256 = ?, filename = ?, size = ? WHERE item_id = ?`).run(changed.sha256, changed.filename, changed.size, first.id);
  db.close();
  memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  assert.equal(readFileSync(memory.files.primary(first.id).path, 'utf8'), 'later peer bytes');
  assert.deepEqual(memory.versions.restore(version.id), { restored: 1 });
  const restored = memory.files.primary(first.id);
  assert.equal(restored.attachment.filename, 'original.txt');
  assert.equal(readFileSync(restored.path, 'utf8'), 'the original bytes');
});
