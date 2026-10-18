import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';

test('AI action review applies only selected operations, keeps source text, journals writes and undoes atomically', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  memory.projects.create({ name: 'Garden' });
  const source = memory.items.saveNote({ title: 'Garden meeting', body: 'Build raised beds. Buy seeds.', project: 'garden', tags: ['meeting'] });
  memory.items.setReminder(source.id, '2026-12-20T12:00:00.000Z');
  const scope = memory.actions.scope({ rootId: source.id });
  const proposal = memory.actions.prepare(scope, { summary: 'Proposed follow-up', operations: [
    { kind: 'tag', itemId: source.id, tags: ['gardening'] },
    { kind: 'task', title: 'Build raised beds', body: 'Use untreated timber.', sourceId: source.id, dueAt: null },
    { kind: 'reminder', itemId: source.id, remindAt: '2026-12-25T12:00:00.000Z' },
    { kind: 'note', title: 'Garden brief', body: 'Raised beds and seeds.', sourceIds: [source.id] },
  ] });
  assert.deepEqual(memory.items.get(source.id).tags, ['meeting']);
  assert.equal(memory.tasks.list().length, 0, 'preparing never writes');
  const selection = proposal.operations.slice(0, 2).map((op) => op.id);
  const result = memory.actions.apply(proposal, selection);
  assert.equal(result.createdIds.length, 1);
  assert.deepEqual(result.updatedIds, [source.id]);
  assert.equal(memory.items.get(source.id).body, source.body);
  assert.equal(memory.items.get(source.id).remindAt, '2026-12-20T12:00:00.000Z', 'unselected reminder is untouched');
  assert.deepEqual(memory.items.get(source.id).tags, ['gardening', 'meeting']);
  const task = memory.tasks.get(result.createdIds[0]!);
  assert.equal(task.project?.name, 'Garden');
  assert.match(task.body, new RegExp(source.id));
  assert.ok(memory.activity.recent({}, 100).some((change) => change.op === 'ai_actions'));
  assert.equal(memory.actions.undo(result.undo).restored, 2);
  assert.deepEqual(memory.items.get(source.id).tags, ['meeting']);
  assert.deepEqual(memory.items.get(source.id).relations, [], 'undo also removes the new provenance connections');
  assert.ok(memory.items.get(task.id).archivedAt, 'new task remains recoverable');
  assert.deepEqual(memory.actions.undo(result.undo), { restored: 2 }, 'undo retries are idempotent');
  assert.throws(() => memory.actions.apply(proposal, selection), /undone/);
});

test('undoing a tag action does not redeliver a reminder that fired meanwhile', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Seed order', body: 'Order seeds.' });
  memory.items.setReminder(source.id, '2020-01-01T12:00:00Z');
  const proposal = memory.actions.prepare(memory.actions.scope({ rootId: source.id }), {
    summary: 'Add gardening', operations: [{ kind: 'tag', itemId: source.id, tags: ['gardening'] }],
  });
  const applied = memory.actions.apply(proposal);
  memory.items.markReminded(source.id);
  memory.actions.undo(applied.undo);
  assert.equal(memory.items.dueReminders().some((item) => item.id === source.id), false);
});

test('action retries retain the original undo guard, and newer edits and children block undo', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Meeting', body: 'Prepare a plan.' });
  const proposal = memory.actions.prepare(memory.actions.scope({ rootId: source.id }), {
    summary: 'Draft a brief', operations: [{ kind: 'note', title: 'Project brief', body: 'The first draft.', sourceIds: [source.id] }],
  });
  const result = memory.actions.apply(proposal);
  memory.items.markOpened(source.id);
  assert.deepEqual(memory.actions.apply(proposal), result);
  memory.outline.createNote({ parentId: result.createdIds[0]!, title: 'A later addition' });
  assert.deepEqual(memory.actions.apply(proposal).undo, result.undo, 'retry does not refresh the hash');
  assert.throws(() => memory.actions.undo(result.undo), (error) => error instanceof MemoryError && error.code === 'conflict');
  assert.equal(memory.items.get(result.createdIds[0]!).archivedAt, null);
});

test('a proposal refuses changed scope, unknown operations, out-of-scope targets and forged receipts', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Source', body: 'Keep this.' });
  const other = memory.items.saveNote({ title: 'Other', body: 'Outside scope.' });
  const scope = memory.actions.scope({ rootId: source.id });
  assert.throws(() => memory.actions.prepare(scope, { summary: 'Bad', operations: [{ kind: 'tag', itemId: other.id, tags: ['x'] }] }), /outside/);
  assert.throws(() => memory.actions.prepare(scope, { summary: 'Bad', operations: [{ kind: 'delete', itemId: source.id }] }), /only propose/);
  const proposal = memory.actions.prepare(scope, { summary: 'Tag', operations: [{ kind: 'tag', itemId: source.id, tags: ['useful'] }] });
  memory.items.update(source.id, { body: 'New work.' });
  assert.throws(() => memory.actions.apply(proposal), /changed/);
  assert.deepEqual(memory.items.get(source.id).tags, []);
  const fresh = memory.actions.prepare(memory.actions.scope({ rootId: source.id }), { summary: 'Tag', operations: [{ kind: 'tag', itemId: source.id, tags: ['useful'] }] });
  const result = memory.actions.apply(fresh);
  assert.throws(() => memory.actions.undo({ ...result.undo, afterHash: '0'.repeat(64) }), /does not belong/);
});

test('topic scopes cover the complete keyword set and never expose secrets or workflow definitions', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const note = memory.items.saveNote({ title: 'Garden budget', body: 'Seed costs.' });
  memory.items.saveNote({ title: 'House budget', body: 'Electricity.' });
  memory.views.create({ name: 'Garden budget', query: 'garden budget' });
  memory.vault.setup('correct horse battery staple');
  memory.vault.create({ title: 'Garden budget', body: 'Private bank details.' });
  assert.deepEqual(memory.actions.scope({ query: 'garden budget' }).items.map((item) => item.id), [note.id]);
  const root = memory.outline.createNote({ parentId: null, title: 'A branch' }).item;
  memory.vault.create({ title: 'Private', body: 'Private marker', parentId: root.id });
  assert.throws(() => memory.actions.scope({ rootId: root.id }), /secret/);
  for (let index = 0; index < 151; index++) memory.items.saveNote({ title: `Beekeeping ${index}`, body: 'Hive log.' });
  assert.throws(() => memory.actions.scope({ query: 'beekeeping' }), /151 items/);
});

test('action creation does not invoke capture rules and an invalid creation rolls back the entire selection', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Meeting', body: 'Draft a research plan.' });
  memory.rules.create({ name: 'Capture label', conditions: { types: ['note', 'task'] }, actions: { tags: ['captured'] } });
  const proposal = memory.actions.prepare(memory.actions.scope({ rootId: source.id }), {
    summary: 'Create a plan', operations: [
      { kind: 'tag', itemId: source.id, tags: ['reviewed'] },
      { kind: 'note', title: 'Research plan', body: 'Collect evidence.', sourceIds: [source.id] },
    ],
  });
  const occupied = memory.items.saveNote({ title: 'Occupied id', body: 'Keep this.' });
  const invalid = { ...proposal, operations: proposal.operations.map((op, i) => i === 1 ? { ...op, id: occupied.id } : op) };
  assert.throws(() => memory.actions.apply(invalid), /already exists/);
  assert.deepEqual(memory.items.get(source.id).tags, []);
  const result = memory.actions.apply(proposal);
  assert.deepEqual(memory.items.get(result.createdIds[0]!).tags, [], 'reviewed creations skip capture automations');
  assert.equal(memory.items.pendingEnrichment('2000-01-01T00:00:00.000Z').includes(result.createdIds[0]!), false, 'background enrichment cannot change an accepted brief behind its undo guard');
});

test('branch actions without explicit sources inherit the selected branch project', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const project = memory.projects.create({ name: 'Garden' });
  const source = memory.items.saveNote({ title: 'Plan', body: 'Garden plans.', project: project.id });
  const proposal = memory.actions.prepare(memory.actions.scope({ rootId: source.id }), {
    summary: 'Follow-ups', operations: [
      { kind: 'task', title: 'Buy seeds', body: '', sourceId: null, dueAt: null },
      { kind: 'note', title: 'Brief', body: 'A brief.', sourceIds: [] },
    ],
  });
  const result = memory.actions.apply(proposal);
  assert.ok(result.createdIds.every((id) => memory.items.get(id).project?.id === project.id));
});
