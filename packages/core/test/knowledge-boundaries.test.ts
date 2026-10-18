import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, pathsFor, restoreBackup } from '@enve-memory/core';

test('workflow definitions and their children stay outside knowledge source scopes', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const note = memory.items.saveNote({ title: 'Compost log', body: 'Turn the compost weekly.' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Compost workflow', instruction: 'Suggest compost tasks.', scope: { rootId: note.id } });
  const child = memory.outline.createNote({ parentId: recipe.id, title: 'Compost configuration', body: 'This belongs to the definition.' }).item;
  assert.deepEqual(memory.actions.scope({ query: 'compost' }).items.map((item) => item.id), [note.id]);
  assert.deepEqual(memory.review.queue().map((card) => card.item.id), [note.id]);
  assert.throws(() => memory.review.schedule(child.id, 7));
  assert.throws(() => memory.insights.forItem(child.id));
  assert.throws(() => memory.edits.scope(recipe.id));
  assert.throws(() => memory.edits.scope(child.id));
  const view = memory.views.create({ name: 'Compost', query: 'compost' });
  assert.deepEqual(memory.views.results(view.id).items.map((item) => item.id), [note.id]);
  assert.deepEqual(memory.items.pendingEnrichment('2000-01-01T00:00:00Z').filter((id) => id === recipe.id || id === child.id), []);
});

test('a changed watched file with the bytes of an unrelated file becomes its own snapshot and leaves that file alone', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-watch-identity-'));
  const documents = mkdtempSync(join(tmpdir(), 'petty-watch-files-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); rmSync(documents, { recursive: true, force: true }); });
  const existing = memory.files.save({ filename: 'elsewhere.txt', data: Buffer.from('The revised field notes with a later plan.') }).item;
  writeFileSync(join(documents, 'field.txt'), 'The first field notes.');
  const watch = memory.sources.create({ name: 'Field notes', kind: 'folder' });
  memory.sources.approveFolder(watch.id, documents);
  const first = memory.sources.checkFolder(watch.id);
  const original = memory.sources.apply(watch.id, first.candidates.map((entry) => entry.id)).applied[0]!.itemId;
  writeFileSync(join(documents, 'field.txt'), 'The revised field notes with a later plan.');
  const changed = memory.sources.checkFolder(watch.id);
  assert.equal(changed.candidates.length, 1);
  const applied = memory.sources.apply(watch.id, changed.candidates.map((entry) => entry.id)).applied[0]!;
  assert.notEqual(applied.itemId, existing.id);
  assert.equal(applied.previousId, original);
  const snapshot = memory.items.get(applied.itemId);
  assert.equal(snapshot.attachments[0]!.sha256, existing.attachments[0]!.sha256);
  assert.equal((snapshot.metadata.watchedFrom as { key: string }).key, 'field.txt');
  assert.deepEqual(snapshot.relations.map((relation) => [relation.kind, relation.direction, relation.id]), [['supersedes', 'outgoing', original]]);
  const untouched = memory.items.get(existing.id);
  assert.equal(untouched.updatedAt, existing.updatedAt);
  assert.equal(untouched.metadata.watchedFrom, undefined);
  assert.deepEqual(untouched.relations, []);
  const again = memory.sources.checkFolder(watch.id);
  assert.equal(again.candidates.length, 0);
  assert.equal(again.check?.unchanged, 1);
  assert.equal(memory.items.get(original).archivedAt, null);
});

test('restoring a backup keeps watch definitions but requires fresh local folder approval', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-watch-restore-'));
  const documents = mkdtempSync(join(tmpdir(), 'petty-watch-original-folder-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(documents, { recursive: true, force: true }); });
  const memory = EnveMemory.open({ home, actor: 'test' });
  writeFileSync(join(documents, 'field.txt'), 'Preserved source.');
  const watch = memory.sources.create({ name: 'Local documents', kind: 'folder', enabled: true });
  memory.sources.approveFolder(watch.id, documents);
  memory.sources.checkFolder(watch.id);
  const snapshot = memory.backups.create('manual');
  memory.close();
  restoreBackup(pathsFor(home), snapshot.path);
  const restored = EnveMemory.open({ home, actor: 'test' });
  try {
    assert.deepEqual(restored.sources.get(watch.id).folder, { approved: false, available: false });
    assert.equal(restored.sources.queue(watch.id).candidates.length, 0);
    assert.equal(restored.sources.get(watch.id).enabled, true);
    assert.deepEqual(restored.sources.due(0), []);
  } finally { restored.close(); }
});
