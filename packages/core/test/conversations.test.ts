import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, type ItemState, MAX_LIMIT, MemoryError, type SaveConversationInput } from '@enve-memory/core';

const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const fails = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!pattern || pattern.test(error.message));
const exchange = (question = 'Which opener do I have?', answer = 'A Chamberlain B970 [1].') => [
  { role: 'user' as const, content: question },
  { role: 'assistant' as const, content: answer },
];
const changes = (memory: EnveMemory) => memory.activity.recent({}, MAX_LIMIT).length;

test('a saved conversation is an ordinary note with a readable transcript, listed newest first and reopened exactly', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T12:00:00.000Z') });
  const memory = open();
  const garage = memory.projects.create({ name: 'Garage' });
  memory.rules.create({ name: 'File every capture', conditions: { types: ['note'] }, actions: { tags: ['captured'] } });
  const before = changes(memory);
  assert.deepEqual(memory.chats.list(), []);
  assert.equal(changes(memory), before, 'listing only reads');

  const saved = memory.chats.save({ title: '  Opener  ', mode: 'ask', project: 'garage', messages: exchange() });
  assert.equal(saved.title, 'Opener');
  assert.equal(saved.mode, 'ask');
  assert.equal(saved.project, garage.id);
  assert.equal('rootId' in saved, false);
  assert.deepEqual(saved.messages, exchange());

  const note = memory.items.get(saved.id);
  assert.equal(note.type, 'note');
  assert.equal(note.body, '**You:** Which opener do I have?\n\n**Assistant:** A Chamberlain B970 [1].');
  assert.deepEqual(note.tags, [], 'capture rules never run on a saved transcript');
  assert.deepEqual(memory.search.query('Chamberlain').map((hit) => hit.id), [saved.id], 'the transcript is searchable like any note');

  t.mock.timers.setTime(Date.parse('2026-10-17T12:01:00.000Z'));
  const asked = memory.chats.save({ mode: 'organize', query: 'gardening', messages: [{ role: 'user', content: '  Organize   my\ngardening notes please  ' }] });
  assert.equal(asked.title, 'Organize my gardening notes please', 'an untitled conversation is named by its first message');
  assert.equal(asked.query, 'gardening');
  assert.deepEqual(memory.chats.list().map((chat) => chat.id), [asked.id, saved.id]);
  assert.deepEqual(memory.chats.get(saved.id), saved);
});

test('saving with an id replaces only that conversation, keeps its filing and unrelated metadata, and archiving is reversible', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const saved = memory.chats.save({ mode: 'ask', project: 'garage', messages: exchange() });
  memory.presentation.update(saved.id, { attention: 'high' });
  memory.items.pin(saved.id, true);

  const longer = [...exchange(), { role: 'user' as const, content: 'What battery does it take?' }];
  const updated = memory.chats.save({ id: saved.id, title: 'Opener battery', mode: 'ask', messages: longer });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.title, 'Opener battery');
  assert.deepEqual(updated.messages, longer, 'a conversation may end with the user’s turn');
  assert.equal(updated.project, saved.project, 'an omitted project keeps the filing');
  const item = memory.items.get(saved.id);
  assert.equal(item.metadata.presentation?.attention, 'high');
  assert.notEqual(item.pinnedAt, null);
  assert.match(item.body, /\*\*You:\*\* What battery does it take\?$/);

  const unfiled = memory.chats.save({ id: saved.id, mode: 'ask', project: null, messages: longer });
  assert.equal('project' in unfiled, false);
  assert.equal(unfiled.title, 'Opener battery', 'an omitted title keeps the current one');

  const archived = memory.chats.archive(saved.id);
  assert.notEqual(archived.archivedAt, null);
  assert.deepEqual(memory.chats.list(), []);
  assert.throws(() => memory.chats.get(saved.id), fails('not_found'));
  assert.throws(() => memory.chats.save({ id: saved.id, mode: 'ask', messages: exchange() }), fails('not_found'));
  memory.items.unarchive(saved.id);
  assert.equal(memory.chats.get(saved.id).title, 'Opener battery');
});

test('an id must name a saved conversation, never an arbitrary note, view, template or secret', () => {
  const memory = open();
  const note = memory.items.saveNote({ title: 'Plain', body: 'Ordinary text' });
  const view = memory.views.create({ name: 'Garage notes', query: 'garage' });
  const source = memory.outline.createNote({ parentId: null, title: 'Checklist' }).item.id;
  const template = memory.templates.create(source, 'Checklist template');
  memory.vault.setup('correct horse battery staple');
  const secret = memory.vault.create({ title: 'Code', body: '4471' });
  const missing = memory.chats.save({ mode: 'ask', messages: exchange() }).id.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  for (const id of [note.id, view.id, template.id, secret.id, missing, '']) {
    assert.throws(() => memory.chats.save({ id, mode: 'ask', messages: exchange() }), (error: unknown) => error instanceof MemoryError);
    assert.throws(() => memory.chats.get(id), (error: unknown) => error instanceof MemoryError);
    assert.throws(() => memory.chats.archive(id), (error: unknown) => error instanceof MemoryError);
  }
  assert.equal(memory.items.get(note.id).body, 'Ordinary text', 'the note was left alone');

  const saved = memory.chats.save({ mode: 'ask', messages: exchange() });
  memory.outline.move(saved.id, { parentId: template.id });
  assert.throws(() => memory.chats.get(saved.id), fails('not_found'), 'a conversation filed inside a template is a template member');
  assert.equal(memory.chats.list().some((chat) => chat.id === saved.id), false);
});

test('messages, modes, titles and context are validated at the boundary', () => {
  const memory = open();
  const root = memory.outline.createNote({ parentId: null, title: 'Branch' }).item.id;
  const save = (input: Partial<SaveConversationInput> & Record<string, unknown>) =>
    () => memory.chats.save({ mode: 'ask', messages: exchange(), ...input } as SaveConversationInput);

  assert.throws(save({ messages: [] }), fails('invalid', /at least one message/));
  assert.throws(save({ messages: [{ role: 'assistant', content: 'Hello' }] }), fails('invalid', /Message 1 must have the role "user"/));
  assert.throws(save({ messages: [...exchange(), { role: 'assistant', content: 'Again' }] }), fails('invalid', /Message 3 must have the role "user"/));
  assert.throws(save({ messages: [{ role: 'user', content: '   ' }] }), fails('invalid', /Message 1 is empty/));
  assert.throws(save({ messages: [{ role: 'user', content: 7 }] as never }), fails('invalid', /Message 1 must be text/));
  assert.throws(save({ messages: [{ role: 'user', content: 'Hi', sources: [] }] as never }), fails('invalid', /Unknown message 1 field "sources"/));
  const many = Array.from({ length: 101 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `turn ${i}` }));
  assert.throws(save({ messages: many }), fails('invalid', /at most 100 messages/));
  assert.equal(memory.chats.save({ mode: 'ask', messages: many.slice(0, 100) }).messages.length, 100);
  const big = 'x'.repeat(100_000);
  assert.throws(save({ messages: [...exchange(big, big), { role: 'user', content: 'one more' }] }), fails('invalid', /at most 200000 characters/));
  assert.equal(memory.chats.save({ mode: 'ask', messages: exchange(big, big) }).messages[1]!.content.length, 100_000);

  assert.throws(save({ title: 'x'.repeat(201) }), fails('invalid', /longer than 200/));
  assert.throws(save({ mode: 'chat' as never }), fails('invalid', /Unknown conversation mode "chat"/));
  assert.throws(save({ createdAt: '2026-10-17T00:00:00.000Z' }), fails('invalid', /Unknown conversation field "createdAt"/));
  assert.throws(save({ mode: 'edit' }), fails('invalid', /edit conversation needs the rootId/));
  assert.throws(save({ mode: 'actions' }), fails('invalid', /exactly one of rootId or query/));
  assert.throws(save({ mode: 'actions', rootId: root, query: 'garden' }), fails('invalid', /exactly one of rootId or query/));
  assert.throws(save({ rootId: 'not-an-id' }), fails('invalid', /rootId must be a lowercase UUIDv7/));
  assert.throws(save({ project: 'nowhere' }), fails('not_found'));
  assert.throws(save({ query: 'q'.repeat(501) }), fails('invalid', /longer than 500/));

  const edit = memory.chats.save({ mode: 'edit', rootId: root, messages: exchange('Tidy this branch', 'Proposed: sort it.') });
  assert.equal(edit.rootId, root);
  assert.equal(memory.chats.save({ mode: 'actions', query: '  garden  ', messages: exchange() }).query, 'garden');
  assert.equal(memory.chats.save({ mode: 'actions', rootId: root, query: '  ', messages: exchange() }).rootId, root, 'a blank query is no query');

  memory.vault.setup('correct horse battery staple');
  const secret = memory.vault.create({ title: 'Code', body: '4471' });
  assert.throws(save({ rootId: secret.id }), fails('invalid', /secret note/));
  memory.items.delete(root);
  assert.deepEqual(memory.chats.get(edit.id).rootId, root, 'a saved context survives its root being deleted');
});

test('saved conversations stay out of review, connections and merges', () => {
  const memory = open();
  const subject = memory.outline.createNote({ parentId: null, title: 'Chamberlain opener', body: 'Garage door opener wiring' }).item.id;
  const chat = memory.chats.save({ mode: 'ask', messages: exchange('Tell me about the Chamberlain opener', 'The Chamberlain opener needs garage door wiring.') });
  assert.equal(memory.review.queue({ limit: 100 }).some((card) => card.item.id === chat.id), false);
  assert.throws(() => memory.review.schedule(chat.id, 1), fails('invalid'));
  const insights = memory.insights.forItem(subject);
  for (const list of [insights.mentions, insights.related, insights.duplicates]) assert.equal(list.some((s) => s.id === chat.id), false);
  assert.equal(insights.total, 0);
  assert.throws(() => memory.insights.forItem(chat.id), fails('invalid'));
  assert.throws(() => memory.insights.previewMerge(chat.id, subject), fails('invalid'));
});

test('saved conversations survive reopening, sync and export', () => {
  const home = mkdtempSync(join(tmpdir(), 'petty-conversations-'));
  const first = EnveMemory.open({ home, actor: 'test' });
  const project = first.projects.create({ name: 'Garage' });
  const saved = first.chats.save({ title: 'Opener', mode: 'actions', query: 'opener', project: project.id, messages: exchange() });
  first.close();

  const reopened = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(reopened.chats.get(saved.id), saved);
  const peer = open();
  peer.sync.applyChanges(reopened.sync.exportChanges().records);
  assert.deepEqual(peer.chats.get(saved.id), saved);
  assert.deepEqual(peer.chats.list().map((chat) => chat.id), [saved.id]);

  const out = join(mkdtempSync(join(tmpdir(), 'petty-conversations-export-')), 'export');
  reopened.exports.write(out);
  const exported = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8')) as { items: { id: string; body: string; metadata: Record<string, unknown> }[] };
  const item = exported.items.find((entry) => entry.id === saved.id)!;
  assert.deepEqual(item.metadata.conversation, { version: 1, mode: 'actions', rootId: null, query: 'opener', messages: exchange() });
  assert.match(item.body, /^\*\*You:\*\* Which opener do I have\?/);
  reopened.close();
});

test('a conversation damaged by another device is left out of the list but refused clearly on its own', () => {
  const a = open();
  const b = open();
  const good = a.chats.save({ mode: 'ask', messages: exchange() });
  const bad = a.chats.save({ mode: 'ask', messages: exchange('Second question', 'Second answer') });
  const records = a.sync.exportChanges().records.map((record) => {
    if (record.entity !== 'item' || record.id !== bad.id || record.state === null) return record;
    const state = record.state as ItemState;
    const metadata = JSON.parse(state.item.metadata as string) as { conversation: { messages: unknown[] } };
    metadata.conversation.messages = [{ role: 'assistant', content: 'out of order' }];
    return { ...record, state: { ...state, item: { ...state.item, metadata: JSON.stringify(metadata) } } };
  });
  b.sync.applyChanges(records);
  assert.deepEqual(b.chats.list().map((chat) => chat.id), [good.id]);
  assert.throws(() => b.chats.get(bad.id), fails('invalid', /Message 1 must have the role "user"/));
});
