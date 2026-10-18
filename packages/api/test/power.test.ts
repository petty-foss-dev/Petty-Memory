import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { type AiProvider, type ChatResponse } from '@enve-memory/ai';
import { type ActionResult, type EditorActionResult, EnveMemory, type MergeProposal, type ReviewCard, type SavedConversation } from '@enve-memory/core';

async function fixture(t: import('node:test').TestContext) {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const ai: AiProvider = { id: 'ollama', model: 'fixture', listModels: async () => ['fixture'], complete: async () => JSON.stringify({ summary: 'Make a task', operations: [{ kind: 'task', title: 'Build raised beds', body: '', source: 'n1', when: null }] }) };
  const api = createApiServer(memory, { version: 'test', port: 0, aiProvider: () => ai });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const reader = memory.clients.create('reader', ['read']).token;
  const writer = memory.clients.create('writer', ['read', 'write']).token;
  const writeOnly = memory.clients.create('write only', ['write']).token;
  async function call<T>(method: string, path: string, token: string, body?: unknown, key?: string) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T, replayed: response.headers.get('Idempotent-Replayed') };
  }
  return { memory, call, reader, writer, writeOnly };
}

test('saved conversations require explicit writes, can be resumed, and stay out of daily review', async (t) => {
  const { memory, call, reader, writer } = await fixture(t);
  const note = memory.items.saveNote({ title: 'Garden plan', body: 'Plant tomatoes.' });
  const payload = { mode: 'ask', title: 'Garden questions', messages: [{ role: 'user', content: 'What should I plant?' }, { role: 'assistant', content: 'Tomatoes, according to your plan.' }] };
  assert.equal((await call('POST', '/conversations', reader, payload)).status, 403);
  const saved = await call<SavedConversation>('POST', '/conversations', writer, payload, 'save-chat');
  assert.equal(saved.status, 201);
  const resumed = await call<SavedConversation>('GET', `/conversations/${saved.data.id}`, reader);
  assert.deepEqual(resumed.data.messages, payload.messages);
  assert.equal((await call<SavedConversation[]>('GET', '/conversations', reader)).data.length, 1);
  assert.deepEqual((await call<ReviewCard[]>('GET', '/review', reader)).data.map((card) => card.item.id), [note.id]);
  assert.equal((await call('POST', `/review/${note.id}`, reader, { days: 7 })).status, 403);
  assert.equal((await call('POST', `/review/${note.id}`, writer, { days: 7 })).status, 200);
  assert.deepEqual((await call<ReviewCard[]>('GET', '/review', reader)).data, []);
  assert.equal((await call('POST', `/review/${note.id}`, writer, { days: -1 })).status, 400);
  assert.equal((await call('DELETE', `/conversations/${saved.data.id}`, reader)).status, 403);
  assert.equal((await call('DELETE', `/conversations/${saved.data.id}`, writer)).status, 200);
  assert.ok(memory.items.get(saved.data.id).archivedAt);
});

test('action chat is read+write, apply is selective and idempotent, and undo is guarded', async (t) => {
  const { memory, call, reader, writer } = await fixture(t);
  const note = memory.items.saveNote({ title: 'Garden plan', body: 'Build raised beds.' });
  const input = { mode: 'actions', rootId: note.id, messages: [{ role: 'user', content: 'Make a task to build raised beds.' }] };
  assert.equal((await call('POST', '/ai/chat', reader, input)).status, 403);
  const response = await call<ChatResponse>('POST', '/ai/chat', writer, input);
  assert.equal(response.status, 200);
  assert.equal(response.data.kind, 'actions');
  if (response.data.kind !== 'actions') throw new Error('Expected an action proposal');
  assert.equal(memory.tasks.list().length, 0);
  const body = { proposal: response.data.proposal, includeIds: [response.data.proposal.operations[0]!.id] };
  assert.equal((await call('POST', '/ai/actions/apply', reader, body)).status, 403);
  const applied = await call<ActionResult>('POST', '/ai/actions/apply', writer, body, 'apply-actions');
  assert.equal(applied.status, 200);
  assert.equal(memory.tasks.list().length, 1);
  assert.deepEqual((await call<ActionResult>('POST', '/ai/actions/apply', writer, body, 'apply-actions')).data, applied.data);
  const taskId = applied.data.createdIds[0]!;
  memory.tasks.update(taskId, { notes: 'Newer work.' });
  assert.equal((await call('POST', '/ai/actions/undo', writer, { receipt: applied.data.undo })).status, 409);
  assert.equal(memory.items.get(taskId).archivedAt, null);
});

test('connection merge previews show exact text, require write to apply and recover through editor undo', async (t) => {
  const { memory, call, reader, writer } = await fixture(t);
  const target = memory.items.saveNote({ title: 'Seed plan', body: 'Plant tomato seeds in March.' });
  const source = memory.items.saveNote({ title: 'Seed plan', body: 'Plant tomato seeds in March. Water every day.' });
  const insights = await call<{ duplicates: { id: string }[] }>('GET', `/items/${target.id}/insights`, reader);
  assert.equal(insights.status, 200);
  const preview = await call<MergeProposal>('POST', '/insights/merge/preview', reader, { sourceId: source.id, targetId: target.id });
  assert.equal(preview.status, 200);
  assert.match(preview.data.preview.body, /Water every day/);
  assert.equal((await call('POST', '/insights/merge', reader, { proposal: preview.data })).status, 403);
  const merged = await call<EditorActionResult>('POST', '/insights/merge', writer, { proposal: preview.data });
  assert.equal(merged.status, 200);
  assert.ok(memory.items.get(source.id).archivedAt);
  assert.equal((await call('POST', `/editor/actions/${merged.data.actionId}/undo`, writer)).status, 200);
  assert.equal(memory.items.get(source.id).archivedAt, null);
  assert.equal(memory.items.get(target.id).body, target.body);
});

test('Enve import previews never write, imports skip repeats, and OCR requires read+write', async (t) => {
  const { memory, call, reader, writer, writeOnly } = await fixture(t);
  const data = JSON.stringify({ bookTitle: 'Fictional Garden', bookAuthor: 'Ada', annotations: [{ text: 'Save useful ideas.', position: 0.5 }], bookmarks: [] });
  assert.equal((await call('POST', '/imports/enve-highlights/preview', reader, { data })).status, 403);
  const preview = await call<{ entries: unknown[] }>('POST', '/imports/enve-highlights/preview', writer, { data });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.entries.length, 1);
  assert.equal(memory.items.list().length, 0);
  const imported = await call<{ created: number; skipped: number }>('POST', '/imports/enve-highlights', writer, { data });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.created, 1);
  assert.equal((await call<{ skipped: number }>('POST', '/imports/enve-highlights', writer, { data })).data.skipped, 1);
  assert.equal((await call('POST', '/capture/ocr', reader, { attachmentId: 'missing' })).status, 403);
  assert.equal((await call('POST', '/capture/ocr', writeOnly, { attachmentId: 'missing' })).status, 403);
  assert.equal((await call('POST', '/capture/ocr', writer, { attachmentId: 'missing' })).status, 404);
  const other = JSON.stringify({ bookTitle: 'Another Book', annotations: [{ text: 'A different idea.', position: 0.2 }] });
  const first = await call<{ entries: { bookTitle: string }[] }>('POST', '/imports/enve-highlights/preview', writer, { data }, 'preview-only');
  const second = await call<{ entries: { bookTitle: string }[] }>('POST', '/imports/enve-highlights/preview', writer, { data: other }, 'preview-only');
  assert.equal(first.data.entries[0]!.bookTitle, 'Fictional Garden');
  assert.equal(second.data.entries[0]!.bookTitle, 'Another Book', 'preview replies are never retained as idempotency data');
  assert.equal(second.replayed, null);
});

test('an Enve file within 2 MB fits the default API even when JSON wrapping escapes many newlines', async (t) => {
  const { call, writer } = await fixture(t);
  const data = JSON.stringify({ bookTitle: 'A Long Fictional Book', annotations: Array.from({ length: 64 }, (_, index) => ({ text: 'Line\n'.repeat(5000), position: index / 100 })) });
  assert.ok(Buffer.byteLength(data) < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ data })) > 2 * 1024 * 1024);
  const preview = await call<{ entries: unknown[] }>('POST', '/imports/enve-highlights/preview', writer, { data });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.entries.length > 40);
});
