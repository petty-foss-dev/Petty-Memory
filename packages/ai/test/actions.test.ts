import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AiProvider, chat, parseChatRequest } from '@enve-memory/ai';
import { EnveMemory } from '@enve-memory/core';

function provider(reply: unknown, inspect?: (prompt: string) => void): AiProvider {
  return { id: 'ollama', model: 'test-fixture', listModels: async () => ['test-fixture'], complete: async (request) => { inspect?.(request.prompt); return JSON.stringify(reply); } };
}

test('AI actions prepare reviewed task/tag/reminder/brief operations without writing, then support selective apply', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Meeting', body: 'Build the raised beds and buy seeds.' });
  const ai = provider({ summary: 'Follow up on the meeting.', operations: [
    { kind: 'task', title: 'Build raised beds', body: 'Use untreated timber', source: 'n1', when: null },
    { kind: 'tag', ref: 'n1', tags: ['gardening'] },
    { kind: 'reminder', ref: 'n1', when: '2026-12-20T12:00:00Z' },
    { kind: 'note', title: 'Garden brief', body: 'Raised beds and seeds.', sources: ['n1'] },
  ] }, (prompt) => { assert.match(prompt, /<items>/); assert.match(prompt, /Build the raised beds/); });
  const result = await chat(memory, ai, { mode: 'actions', rootId: source.id, messages: [{ role: 'user', content: 'Create the follow-up tasks, tag this gardening, remind me December 20 at noon UTC and draft a brief.' }] });
  assert.equal(result.kind, 'actions');
  if (result.kind !== 'actions') throw new Error('Expected actions');
  assert.equal(result.proposal.operations.length, 4);
  assert.equal(memory.tasks.list().length, 0);
  const applied = memory.actions.apply(result.proposal, [result.proposal.operations[0]!.id]);
  assert.equal(memory.tasks.get(applied.createdIds[0]!).title, 'Build raised beds');
  assert.deepEqual(memory.items.get(source.id).tags, []);
});

test('action chat validates its explicit scope and refuses model-invented source refs', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const source = memory.items.saveNote({ title: 'Garden work', body: 'Build a planter.' });
  const messages = [{ role: 'user' as const, content: 'Add a task.' }];
  assert.throws(() => parseChatRequest({ mode: 'actions', messages }), /branch or a topic/);
  assert.throws(() => parseChatRequest({ mode: 'actions', messages, rootId: source.id, query: 'garden' }), /branch or a topic/);
  assert.equal(parseChatRequest({ mode: 'actions', messages, query: 'garden', project: 'home' }).project, 'home');
  await assert.rejects(chat(memory, provider({ summary: 'Unsafe', operations: [{ kind: 'tag', ref: 'n999', tags: ['bad'] }] }), { mode: 'actions', rootId: source.id, messages }), /outside/);
  assert.deepEqual(memory.items.get(source.id).tags, []);
});

test('action source payload stays bounded with many heavily escaped notes and empty model summaries', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  for (let index = 0; index < 150; index++) memory.items.saveNote({ title: `Garden ${index}`, body: '\\"\n'.repeat(3000) });
  const response = await chat(memory, provider({ summary: ' ', operations: [] }, (prompt) => {
    const source = prompt.split('<items>\n')[1]!.split('\n</items>')[0]!;
    assert.ok(source.length <= 40_200, `Escaped source context grew to ${source.length}`);
    assert.equal(JSON.parse(source).length, 150);
  }), { mode: 'actions', query: 'garden', messages: [{ role: 'user', content: 'What actions would help?' }] });
  assert.equal(response.kind, 'actions');
  if (response.kind === 'actions') assert.equal(response.proposal.summary, 'Proposed actions');
});
