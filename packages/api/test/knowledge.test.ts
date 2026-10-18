import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { type AiProvider, type ChatResponse, type FreshnessProposal } from '@enve-memory/ai';
import { EnveMemory, type Collection, type CollectionRowsPage, type Recipe, type TranscriptPreview } from '@enve-memory/core';
import { ingestItem } from '@enve-memory/ingestion';
import { knowledgeAudio, knowledgePdf } from '../../../scripts/knowledge-fixtures.ts';

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'petty-knowledge-api-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  const requests: string[] = [];
  const ai: AiProvider = { id: 'ollama', model: 'fixture', listModels: async () => ['fixture'], complete: async ({ prompt, schema }) => {
    requests.push(prompt);
    if (schema && 'suggestions' in (schema.properties as object)) return JSON.stringify({ suggestions: [] });
    return JSON.stringify({ summary: 'Add the requested task.', operations: [{ kind: 'task', title: 'Order cedar boards', body: '', source: 'n1', when: null }] });
  } };
  const api = createApiServer(memory, { version: 'fixture', port: 0, aiProvider: () => ai });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); rmSync(home, { recursive: true, force: true }); });
  const reader = memory.clients.create('Reader', ['read']).token;
  const writer = memory.clients.create('Writer', ['read', 'write']).token;
  const writeOnly = memory.clients.create('Write only', ['write']).token;
  const call = async <T = unknown>(method: string, path: string, body?: unknown, token = writer, key?: string) => {
    const response = await fetch(`${base}/api/v1/knowledge${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() as T };
  };
  return { memory, api, call, reader, writer, writeOnly, requests };
}

test('knowledge routes require read access, definitions require writes, and field edits preserve typed values', async (t) => {
  const { memory, call, reader, writeOnly } = await fixture(t);
  const note = memory.items.saveNote({ title: 'Garden beds', body: 'Build raised beds.' });
  assert.equal((await call('GET', '/collections', undefined, writeOnly)).status, 403);
  assert.equal((await call('POST', '/collections', { name: 'Beds' }, reader)).status, 403);
  const created = await call<Collection>('POST', '/collections', { name: 'Beds', scope: { query: 'beds' }, fields: [{ name: 'Cost', type: 'number' }, { name: 'Status', type: 'select', options: [{ name: 'Planned' }, { name: 'Done' }] }], layout: 'kanban', groupBy: 'status' });
  assert.equal(created.status, 200);
  assert.equal((await call('POST', `/collections/${created.value.id}/values`, { itemId: note.id, values: { cost: 80, status: 'Planned' } }, writeOnly)).status, 403);
  assert.equal((await call('POST', `/collections/${created.value.id}/values`, { itemId: note.id, values: { cost: 80, status: 'Planned' } })).status, 200);
  assert.equal((await call('POST', `/collections/${created.value.id}/values`, { itemId: note.id, values: { cost: 'eighty' } })).status, 400);
  const rows = await call<CollectionRowsPage>('GET', `/collections/${created.value.id}/rows`, undefined, reader);
  assert.equal(rows.value.rows.length, 1);
  assert.equal(rows.value.rows[0]!.values[created.value.fields[0]!.id], 80);
  assert.equal(rows.value.groups?.find((group) => group.name === 'Planned')?.count, 1);
});

test('workflow runs always produce a fresh uncached proposal, and only selected apply changes content', async (t) => {
  const { memory, call, reader, writer, requests } = await fixture(t);
  const note = memory.items.saveNote({ title: 'Garden beds', body: 'Order cedar boards.' });
  const saved = await call<Recipe>('POST', '/recipes', { name: 'Weekly beds', instruction: 'Create a task for the open job.', scope: { rootId: note.id } });
  assert.equal((await call('POST', `/recipes/${saved.value.id}/run`, {}, reader)).status, 403);
  const first = await call<ChatResponse>('POST', `/recipes/${saved.value.id}/run`, {}, writer, 'same-preview');
  const second = await call<ChatResponse>('POST', `/recipes/${saved.value.id}/run`, {}, writer, 'same-preview');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(memory.tasks.list().length, 0);
  assert.equal(first.value.kind, 'actions');
  if (first.value.kind !== 'actions' || second.value.kind !== 'actions') throw new Error('Expected reviewed actions.');
  assert.notEqual(first.value.proposal.id, second.value.proposal.id);
  const priorProposal = first.value.proposal;
  memory.items.update(note.id, { body: 'Order oak boards instead.' });
  assert.throws(() => memory.actions.apply(priorProposal), /changed/);
});

test('caption preview does not write or replay private text; explicit save is repeat-safe and locators retain the original', async (t) => {
  const { memory, call } = await fixture(t);
  const audio = memory.files.save({ data: knowledgeAudio(), filename: 'standup.wav' }).item;
  const before = memory.activity.recent({}, 1)[0]!.id;
  const data = 'WEBVTT\n\n00:00.000 --> 00:04.000\nOrder cedar boards.\n';
  const preview = await call<TranscriptPreview>('POST', '/research/transcripts/preview', { audioId: audio.id, data }, undefined, 'private-preview');
  assert.equal(preview.status, 200);
  assert.equal(memory.activity.recent({}, 1)[0]!.id, before);
  const saved = await call<{ item: { id: string }; created: boolean }>('POST', '/research/transcripts', { audioId: audio.id, segments: preview.value.segments, format: preview.value.format, engine: preview.value.engine, fingerprint: preview.value.fingerprint });
  assert.equal(saved.status, 200);
  const locator = await call<{ audioId: string; start: number; sha256: string }>('GET', `/research/audio-locator/${saved.value.item.id}?segment=0`);
  assert.equal(locator.value.audioId, audio.id);
  assert.equal(locator.value.start, 0);
  assert.equal(locator.value.sha256, audio.attachments[0]!.sha256);
  const bad = await call('POST', '/research/transcribe', { audioId: audio.id });
  assert.equal(bad.status, 400);
});

test('PDF annotations retain the selected page, quote and source hash, and reject stale or fabricated material', async (t) => {
  const { memory, call, reader } = await fixture(t);
  const file = memory.files.save({ data: knowledgePdf(), filename: 'field-guide.pdf' }).item;
  await ingestItem(memory, file.id);
  const source = await call<{ sha256: string; pageCount: number }>('GET', `/research/pdf/${file.id}`, undefined, reader);
  assert.equal(source.value.pageCount, 2);
  const payload = { sourceId: file.id, page: 2, quote: 'Aurora rocket burns methane', sha256: source.value.sha256, note: 'Fuel choice.' };
  const saved = await call<{ item: { id: string } }>('POST', '/research/annotations', payload);
  assert.equal(saved.status, 200);
  assert.equal((await call('POST', '/research/annotations', { ...payload, page: 1 })).status, 400);
  assert.equal((await call('POST', '/research/annotations', { ...payload, sha256: '0'.repeat(64) })).status, 409);
  assert.equal((await call('POST', '/research/annotations', payload, reader)).status, 403);
  const annotation = await call<{ page: number; quote: string }>('GET', `/research/annotations/${saved.value.item.id}`);
  assert.equal(annotation.value.page, 2);
  assert.equal(annotation.value.quote, 'Aurora rocket burns methane');
  assert.equal(memory.items.get(file.id).body, '');
});

test('research files inside definitions and templates do not crowd out ordinary sources', async (t) => {
  const { memory, call } = await fixture(t);
  const ordinary = memory.files.save({ data: knowledgeAudio(1), filename: 'ordinary.wav' }).item;
  const note = memory.items.saveNote({ title: 'Scope', body: 'Ordinary research.' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Workflow', instruction: 'Find follow-ups.', scope: { rootId: note.id } });
  const template = memory.items.saveNote({ title: 'Template', body: 'Template content.' });
  memory.items.setSource(template.id, { metadata: { template: true } });
  for (const parent of [recipe.id, template.id]) {
    const nested = memory.files.save({ data: knowledgeAudio(parent === recipe.id ? 2 : 3), filename: 'configuration.wav' }).item;
    memory.outline.move(nested.id, { parentId: parent });
  }
  const result = await call<{ items: { id: string }[] }>('GET', '/research/sources');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.items.map((item) => item.id), [ordinary.id]);
});

test('remote watch requests cannot supply host folders, and freshness analysis never changes notes', async (t) => {
  const { memory, call } = await fixture(t);
  assert.equal((await call('POST', '/sources', { name: 'Private', kind: 'folder', path: '/tmp' })).status, 400);
  const folder = await call<{ id: string; folder: { approved: boolean } }>('POST', '/sources', { name: 'Chosen documents', kind: 'folder' });
  assert.equal(folder.value.folder.approved, false);
  assert.equal((await call('POST', `/sources/${folder.value.id}/check`, { path: '/tmp' })).status, 400);
  memory.items.saveNote({ title: 'Garden supplier old', body: 'The supplier delivers on Tuesday.' });
  memory.items.saveNote({ title: 'Garden supplier new', body: 'The supplier delivers on Friday.' });
  const before = memory.activity.recent({}, 1)[0]!.id;
  const analysis = await call<FreshnessProposal>('POST', '/freshness/analyze', { query: 'Garden supplier' });
  assert.equal(analysis.status, 200);
  assert.equal(analysis.value.state, 'no_evidence');
  assert.equal(memory.activity.recent({}, 1)[0]!.id, before);
});
