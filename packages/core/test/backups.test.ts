import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MemoryError, pathsFor, restoreBackup, verifyBackup } from '@enve-memory/core';

const tempHome = () => mkdtempSync(join(tmpdir(), 'enve-memory-backups-'));
const hours = (n: number) => n * 3_600_000;

test('the schedule takes hourly, daily and monthly snapshots and keeps a bounded number', () => {
  const memory = EnveMemory.open({ home: tempHome(), actor: 'test' });
  memory.items.saveNote({ body: 'keep me' });
  const start = Date.parse('2026-01-01T00:00:00Z');

  assert.deepEqual(memory.backups.runSchedule(new Date(start)).map((b) => b.kind).sort(), ['daily', 'hourly', 'monthly']);
  assert.deepEqual(memory.backups.runSchedule(new Date(start + hours(0.5))), [], 'nothing is due yet');
  assert.deepEqual(memory.backups.runSchedule(new Date(start + hours(1))).map((b) => b.kind), ['hourly']);

  for (let h = 2; h <= 30; h++) memory.backups.runSchedule(new Date(start + hours(h)));
  const kinds = memory.backups.list().map((b) => b.kind);
  assert.equal(kinds.filter((k) => k === 'hourly').length, 24);
  assert.equal(kinds.filter((k) => k === 'daily').length, 2);
  assert.equal(kinds.filter((k) => k === 'monthly').length, 1);

  const newest = memory.backups.list()[0]!;
  assert.equal(verifyBackup(newest.path).schemaVersion, memory.schemaVersion);
});

test('restoring swaps in the snapshot, keeps the current library as an undo, and brings back its files', () => {
  const home = tempHome();
  const paths = pathsFor(home);
  const memory = EnveMemory.open({ home, actor: 'test' });
  const kept = memory.items.saveNote({ body: 'written before the snapshot' });
  const file = memory.files.save({ data: new TextEncoder().encode('schematic'), filename: 'schematic.txt' }).item;
  const blob = memory.files.primary(file.id).path;
  const snapshot = memory.backups.create('manual');

  memory.items.saveNote({ body: 'written after the snapshot' });
  memory.items.delete(file.id);
  assert.equal(existsSync(blob), false, 'deleted files leave the store…');
  assert.ok(readdirSync(join(paths.attachments, '.trash')).length === 1, '…for the trash');
  memory.close();

  const { saved } = restoreBackup(paths, snapshot.path);
  const restored = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(restored.items.list().map((i) => i.body).sort(), ['', 'written before the snapshot'].sort());
  assert.equal(restored.items.get(kept.id).body, 'written before the snapshot');
  assert.equal(readFileSync(restored.files.primary(file.id).path, 'utf8'), 'schematic');
  restored.close();

  restoreBackup(paths, saved);
  const undone = EnveMemory.open({ home, actor: 'test' });
  assert.ok(undone.items.list().some((i) => i.body === 'written after the snapshot'));
  undone.close();
});

test('restore refuses files that are not sound libraries', () => {
  const home = tempHome();
  const bogus = join(home, 'bogus.sqlite');
  writeFileSync(bogus, 'not a database');
  assert.throws(() => restoreBackup(pathsFor(home), bogus), MemoryError);
});

test('restoring changes the writer identity and clears peer cursors before log positions can be reused', () => {
  const home = tempHome();
  const memory = EnveMemory.open({ home, actor: 'test' });
  const identity = memory.deviceId;
  const note = memory.items.saveNote({ body: 'Before rewind' });
  memory.sync.setPeerState('https://peer.example/api/v1', { deviceId: identity, pushedCursor: 1, pulledCursor: 1, uploads: [], downloads: [] });
  const snapshot = memory.backups.create('manual');
  const cursor = memory.feed.revision;
  memory.items.saveNote({ body: 'After the snapshot' });
  memory.close();
  restoreBackup(pathsFor(home), snapshot.path);
  const restored = EnveMemory.open({ home, actor: 'test' });
  try {
    restored.items.update(note.id, { body: 'New timeline' });
    assert.ok(restored.feed.revision >= cursor);
    assert.notEqual(restored.feed.page(cursor).deviceId, identity, 'clients reset even when the numeric cursor fits');
    assert.equal(restored.sync.peerState('https://peer.example/api/v1'), null);
    assert.notEqual(restored.sync.exportChanges(cursor).deviceId, identity);
  } finally {
    restored.close();
  }
});

test('export writes readable Markdown per project plus complete metadata', () => {
  const home = tempHome();
  const memory = EnveMemory.open({ home, actor: 'test' });
  memory.projects.create({ name: 'Garage Door', description: 'ESP32 controller', instructions: 'Offline only.' });
  memory.projects.setMemory('garage', '# Goal\nLocal control');
  memory.decisions.record({ project: 'garage', decision: 'Use ESP32-S3', reason: 'USB host' });
  memory.tasks.create({ title: 'Order relays', project: 'garage', due: '2026-10-01' });
  memory.items.saveNote({ title: 'Bench rig', body: 'Build it first', project: 'garage', tags: ['bench'] });
  const link = memory.items.saveLink({ url: 'https://example.com/spec', title: 'Spec', project: 'garage', ingest: false }).item;
  memory.items.setSource(link.id, { content: 'Archived spec text', metadata: {} });
  memory.files.save({ data: new TextEncoder().encode('pins'), filename: 'pinout.txt', project: 'garage' });
  memory.items.saveNote({ body: 'Loose thought' });

  const out = join(home, 'export');
  const summary = memory.exports.write(out);
  assert.deepEqual({ projects: summary.projects, files: summary.files }, { projects: 1, files: 1 });

  const project = join(out, 'projects', 'garage-door');
  assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /## Instructions\n\nOffline only\.\n\n## Memory\n\n# Goal\nLocal control/);
  assert.match(readFileSync(join(project, 'decisions.md'), 'utf8'), /Use ESP32-S3[\s\S]*USB host/);
  assert.match(readFileSync(join(project, 'tasks.md'), 'utf8'), /- \[ \] Order relays \(due 2026-10-01\)/);
  assert.match(readFileSync(join(project, 'links.md'), 'utf8'), /\[Spec\]\(https:\/\/example\.com\/spec\) · \[archived copy\]\(archive\/\d{4}-\d{2}-\d{2}-spec\.md\)/);
  const [note] = readdirSync(join(project, 'notes'));
  assert.match(readFileSync(join(project, 'notes', note!), 'utf8'), /^---\nid: ".+"\ntype: "note"\ntitle: "Bench rig"[\s\S]*tags: \["bench"\]\n---\n\n# Bench rig\n\nBuild it first/);
  assert.equal(readFileSync(join(project, 'files', 'pinout.txt'), 'utf8'), 'pins');
  assert.ok(readdirSync(join(out, 'projects', 'inbox', 'notes')).length === 1);

  const metadata = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'));
  assert.equal(metadata.format, 'enve-memory-export');
  assert.equal(metadata.items.length, 6);
  assert.throws(() => memory.exports.write(out), /already exists/);
});
