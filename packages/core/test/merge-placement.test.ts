import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';

test('duplicate merge ignores archived sibling anchors and undo retains the active outline', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const target = memory.items.saveNote({ title: 'Seed plan', body: 'Plant tomato seeds in March.' });
  const archived = memory.items.saveNote({ title: 'Old seed plan', body: 'Archived material.' });
  memory.items.archive(archived.id);
  const following = memory.items.saveNote({ title: 'Unrelated', body: 'Keep its place.' });
  const source = memory.items.saveNote({ title: 'Seed plan', body: 'Water the seeds.' });
  const action = memory.insights.merge(memory.insights.previewMerge(source.id, target.id));
  assert.equal(memory.items.get(source.id).archivedAt !== null, true);
  assert.equal(memory.items.get(archived.id).archivedAt !== null, true);
  assert.deepEqual(memory.outline.children(null).items.map((entry) => entry.item.id), [target.id, following.id]);
  memory.editor.undo(action.actionId);
  assert.deepEqual(memory.outline.children(null).items.map((entry) => entry.item.id), [target.id, following.id, source.id]);
});

test('merge refuses an archived source parent before offering an operation whose undo could not restore it', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const parent = memory.items.saveNote({ title: 'Archived container', body: 'Container.' });
  const source = memory.outline.createNote({ parentId: parent.id, title: 'Source', body: 'Seed notes.' }).item;
  const target = memory.items.saveNote({ title: 'Target', body: 'More seed notes.' });
  memory.items.archive(parent.id);
  assert.throws(() => memory.insights.previewMerge(source.id, target.id), /source sits under an archived/);
});
