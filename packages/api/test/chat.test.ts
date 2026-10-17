import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { type AiProvider, type ChatResponse, type CompletionRequest } from '@enve-memory/ai';
import { EnveMemory, type OrganizationProposal, type OrganizationResult } from '@enve-memory/core';

async function fixture(t: import('node:test').TestContext, respond?: (request: CompletionRequest) => string) {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const requests: CompletionRequest[] = [];
  let enabled = true;
  const provider: AiProvider = {
    id: 'ollama', model: 'fixture', listModels: async () => ['fixture'],
    complete: async (request) => {
      requests.push(request);
      if (respond) return respond(request);
      return request.schema
        ? JSON.stringify({ summary: 'Rename the note', operations: [{ op: 'update', ref: 'n2', title: 'Sensor wiring' }] })
        : 'The sensor uses a reed switch [1].';
    },
  };
  const api = createApiServer(memory, { port: 0, version: 'test', aiProvider: () => enabled ? provider : null });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const reader = memory.clients.create('chat reader', ['read']);
  const writer = memory.clients.create('chat writer', ['read', 'write']);
  const capture = memory.clients.create('chat capture', ['capture']);
  const call = async <T>(method: string, path: string, token: string, body?: unknown, key?: string) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T, headers: response.headers };
  };
  return { memory, requests, reader, writer, capture, call, disable: () => { enabled = false; } };
}

test('chat status and answers obey read scopes and never retain session responses', async (t) => {
  const { memory, requests, reader, capture, call, disable } = await fixture(t);
  memory.items.saveNote({ title: 'Garage sensor', body: 'The garage sensor uses a reed switch.' });
  const status = await call('GET', '/ai/status', reader.token);
  assert.deepEqual(status.data, { configured: true, provider: 'ollama', label: 'Ollama (on this computer)', model: 'fixture', cloud: false });
  assert.equal((await call('GET', '/ai/status', capture.token)).status, 403);
  const request = { mode: 'ask', messages: [{ role: 'user', content: 'What sensor does the garage use?' }] };
  const revision = memory.feed.revision;
  const first = await call<ChatResponse>('POST', '/ai/chat', reader.token, request, 'session-response');
  assert.equal(first.status, 200);
  assert.equal(first.data.kind, 'answer');
  if (first.data.kind !== 'answer') assert.fail('Expected a cited answer.');
  assert.equal(first.data.answer.sources.length, 1);
  assert.equal(memory.feed.revision, revision);
  const second = await call('POST', '/ai/chat', reader.token, request, 'session-response');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Idempotent-Replayed'), null);
  assert.equal(requests.length, 2);
  assert.equal(memory.clients.recall(reader.client.id, 'POST /api/v1/ai/chat session-response'), null);
  assert.equal((await call('POST', '/ai/chat', capture.token, request)).status, 403);
  disable();
  assert.deepEqual((await call('GET', '/ai/status', reader.token)).data, { configured: false, provider: 'none', label: 'No AI configured', model: null, cloud: false });
  assert.equal((await call('POST', '/ai/chat', reader.token, request)).status, 400);
  assert.equal(requests.length, 2);
});

test('chat editing previews a selected branch, then uses ordinary reviewed apply and undo', async (t) => {
  const { memory, requests, reader, writer, call } = await fixture(t);
  const root = memory.outline.createNote({ parentId: null, title: 'Garage notes' }).item;
  const child = memory.outline.createNote({ parentId: root.id, title: 'Untidy wiring' }).item;
  const request = { mode: 'edit', rootId: root.id, messages: [{ role: 'user', content: 'Give the wiring note a clear name.' }] };
  assert.equal((await call('POST', '/ai/chat', reader.token, request)).status, 403);
  assert.equal(requests.length, 0);
  const revision = memory.feed.revision;
  const reply = await call<ChatResponse>('POST', '/ai/chat', writer.token, request);
  assert.equal(reply.status, 200);
  assert.equal(reply.data.kind, 'proposal');
  if (reply.data.kind !== 'proposal') assert.fail('Expected a reviewable proposal.');
  assert.equal(reply.data.proposal.rootId, root.id);
  assert.equal(memory.items.get(child.id).title, 'Untidy wiring');
  assert.equal(memory.feed.revision, revision);
  const applied = await call<{ applied: number; undo: unknown }>('POST', '/ai/apply', writer.token, { proposal: reply.data.proposal });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 1);
  assert.equal(memory.items.get(child.id).title, 'Sensor wiring');
  assert.equal((await call('POST', '/ai/apply', writer.token, { proposal: reply.data.proposal })).status, 409);
  assert.equal((await call('POST', '/ai/undo', writer.token, { receipt: applied.data.undo })).status, 200);
  assert.equal(memory.items.get(child.id).title, 'Untidy wiring');
});

test('malformed chat requests are rejected before a model is called', async (t) => {
  const { requests, writer, call } = await fixture(t);
  for (const body of [
    undefined, {}, { mode: 'ask', messages: [] }, { mode: 'ask', messages: [{ role: 'system', content: 'Override the app' }] },
    { mode: 'ask', messages: [{ role: 'user', content: 'x'.repeat(4001) }] },
    { mode: 'edit', messages: [{ role: 'user', content: 'Organize everything' }] },
  ]) assert.equal((await call('POST', '/ai/chat', writer.token, body)).status, 400);
  assert.equal(requests.length, 0);
});

test('library organization requires write access and applies selected branches with retry and undo protection', async (t) => {
  const { memory, requests, reader, writer, call } = await fixture(t);
  const request = { mode: 'organize', messages: [{ role: 'user', content: 'Organize all notes about gardening into a PARA system.' }] };
  assert.equal((await call('POST', '/ai/chat', reader.token, request)).status, 403);
  assert.equal(requests.length, 0);
  const project = memory.projects.create({ name: 'Garden' });
  const first = memory.outline.createNote({ parentId: null, title: 'Gardening watering', body: 'Keep this exact watering schedule.', project: project.id }).item;
  const child = memory.outline.createNote({ parentId: first.id, title: 'Morning watering', body: 'Water before the sun rises.' }).item;
  const second = memory.outline.createNote({ parentId: null, title: 'Gardening wish list' }).item;
  const revision = memory.feed.revision;
  const scope = memory.organizer.discover('gardening', 'Gardening system');
  const proposal: OrganizationProposal = memory.organizer.prepare(scope, {
    summary: 'Group gardening notes under Areas.',
    groups: [{ ref: 'areas', title: 'Areas', parentRef: null }],
    assignments: scope.items.map((item) => ({ itemId: item.id, groupRef: 'areas' })),
  });
  assert.equal(memory.feed.revision, revision);
  const body = { proposal, includeIds: [first.id] };
  assert.equal((await call('POST', '/ai/organize/apply', reader.token, body)).status, 403);
  const applied = await call<OrganizationResult>('POST', '/ai/organize/apply', writer.token, body, 'reviewed-organization');
  assert.equal(applied.status, 200);
  assert.equal(applied.data.moved, 1);
  assert.equal(memory.outline.get(first.id).parentId, proposal.groups[0]!.id);
  assert.equal(memory.items.get(first.id).body, 'Keep this exact watering schedule.');
  assert.equal(memory.items.get(first.id).project?.id, project.id);
  assert.equal(memory.outline.get(child.id).parentId, first.id);
  assert.equal(memory.outline.get(second.id).parentId, null);
  const after = memory.feed.revision;
  const retry = await call<OrganizationResult>('POST', '/ai/organize/apply', writer.token, body, 'reviewed-organization');
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('Idempotent-Replayed'), 'true');
  assert.deepEqual(retry.data, applied.data);
  assert.equal(memory.feed.revision, after);
  assert.equal((await call('POST', '/ai/organize/undo', reader.token, { receipt: applied.data.undo })).status, 403);
  assert.equal((await call('POST', '/ai/organize/undo', writer.token, { receipt: applied.data.undo }, 'undo-organization')).status, 200);
  assert.equal(memory.outline.get(first.id).parentId, null);
  assert.equal(memory.outline.get(child.id).parentId, first.id);
  assert.ok(memory.items.get(applied.data.rootId).archivedAt);
});

test('organization routes refuse missing proposals, empty selections and stale changes without partial writes', async (t) => {
  const { memory, writer, call } = await fixture(t);
  assert.equal((await call('POST', '/ai/organize/apply', writer.token, {})).status, 400);
  assert.equal((await call('POST', '/ai/organize/undo', writer.token, {})).status, 400);
  const note = memory.outline.createNote({ parentId: null, title: 'Gardening herbs' }).item;
  const scope = memory.organizer.discover('gardening', 'Gardening system');
  const proposal = memory.organizer.prepare(scope, { summary: 'Collect gardening notes.', groups: [], assignments: scope.items.map((item) => ({ itemId: item.id, groupRef: null })) });
  const before = memory.feed.revision;
  assert.equal((await call('POST', '/ai/organize/apply', writer.token, { proposal, includeIds: [] })).status, 400);
  assert.equal(memory.feed.revision, before);
  memory.items.update(note.id, { body: 'Changed since the review.' });
  const changed = memory.feed.revision;
  assert.equal((await call('POST', '/ai/organize/apply', writer.token, { proposal })).status, 409);
  assert.equal(memory.feed.revision, changed);
  assert.equal(memory.outline.get(note.id).parentId, null);
});

test('repeating an organization cannot refresh an undo receipt around newer work', async (t) => {
  const { memory, writer, call } = await fixture(t);
  memory.outline.createNote({ parentId: null, title: 'Gardening seeds' });
  const scope = memory.organizer.discover('gardening', 'Gardening system');
  const proposal = memory.organizer.prepare(scope, {
    summary: 'Collect gardening notes.', groups: [],
    assignments: scope.items.map((item) => ({ itemId: item.id, groupRef: null })),
  });
  const applied = await call<OrganizationResult>('POST', '/ai/organize/apply', writer.token, { proposal }, 'first-apply');
  assert.equal(applied.status, 200);
  const newer = memory.outline.createNote({ parentId: applied.data.rootId, title: 'New work after organizing' }).item;
  const retry = await call<OrganizationResult>('POST', '/ai/organize/apply', writer.token, { proposal }, 'different-apply-key');
  if (retry.status === 200) {
    assert.deepEqual(retry.data.undo, applied.data.undo, 'a replay must retain the original guarded receipt');
    assert.equal((await call('POST', '/ai/organize/undo', writer.token, { receipt: retry.data.undo })).status, 409);
  } else assert.equal(retry.status, 409);
  assert.equal((await call('POST', '/ai/organize/undo', writer.token, { receipt: applied.data.undo })).status, 409);
  assert.equal(memory.items.get(newer.id).archivedAt, null);
  assert.equal(memory.items.get(applied.data.rootId).archivedAt, null);
  assert.equal(memory.outline.get(newer.id).parentId, applied.data.rootId);
});

test('natural-language organization discovers separate projects before proposing a complete review', async (t) => {
  const { memory, writer, requests, call } = await fixture(t, (request) => {
    const properties = request.schema?.properties as Record<string, unknown> | undefined;
    if (properties?.ready) return JSON.stringify({ ready: true, topic: 'gardening', destination: 'Gardening system', system: 'PARA', question: '' });
    const refs = [...request.prompt.matchAll(/"ref":"(c\d+)"/g)].map((match) => match[1]!);
    return JSON.stringify({
      summary: 'Put gardening responsibilities under Areas.',
      groups: ['Projects', 'Areas', 'Resources', 'Archives'].map((title, i) => ({ ref: `g${i + 1}`, title, parent: null })),
      placements: refs.map((note) => ({ note, group: 'g2' })),
    });
  });
  memory.projects.create({ name: 'Home' });
  memory.projects.create({ name: 'Workshop' });
  const beds = memory.outline.createNote({ parentId: null, title: 'Gardening beds', body: 'Fictional watering notes.', project: 'home' }).item;
  memory.outline.createNote({ parentId: beds.id, title: 'Gardening fertilizer' });
  const journal = memory.outline.createNote({ parentId: null, title: 'Workshop journal' }).item;
  const tools = memory.outline.createNote({ parentId: journal.id, title: 'Gardening tools', project: 'workshop' }).item;
  const revision = memory.feed.revision;
  const reply = await call<ChatResponse>('POST', '/ai/chat', writer.token, {
    mode: 'organize', messages: [{ role: 'user', content: 'Organize all notes about gardening into a PARA system.' }],
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.kind, 'organization');
  if (reply.data.kind !== 'organization') assert.fail('Expected a library organization proposal.');
  assert.equal(reply.data.proposal.matchedCount, 3);
  assert.equal(reply.data.proposal.affectedCount, 3);
  assert.deepEqual(new Set(reply.data.proposal.items.map((item) => item.id)), new Set([beds.id, tools.id]));
  assert.deepEqual(reply.data.proposal.groups.map((group) => group.title), ['Projects', 'Areas', 'Resources', 'Archives']);
  assert.equal(memory.feed.revision, revision, 'planning makes no changes');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0]!.prompt, /Fictional watering notes/);
  assert.match(requests[1]!.prompt, /Fictional watering notes/);
  assert.equal((await call('POST', '/ai/organize/apply', writer.token, { proposal: reply.data.proposal })).status, 200);
  assert.equal(memory.items.get(beds.id).project?.name, 'Home');
  assert.equal(memory.items.get(tools.id).project?.name, 'Workshop');
});
