import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';
import { createApiServer } from '@enve-memory/api';

const memory = EnveMemory.open({ inMemory: true, actor: 'fixture' });
const api = createApiServer(memory, { version: 'test', port: 0 });
const base = await api.listen();
after(async () => { await api.close(); memory.close(); });
const reader = memory.clients.create('reader', ['read']).token;
const writerClient = memory.clients.create('writer', ['read', 'write']);
const writer = writerClient.token;
const writeOnly = memory.clients.create('write-only', ['write']).token;
const capture = memory.clients.create('capture', ['capture']).token;
const data = 'id,title,created,summary,notes,transcript\napi-meeting,Garden meeting,2026-10-20,Order cedar.,Keep receipts.,"[0:23] Alex\nOrder cedar."';

async function call(method: string, path: string, token: string, body?: unknown, key?: string) {
  const response = await fetch(`${base}/api/v1${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any };
}

test('meeting previews require read and write, save nothing and are never replay cached', async () => {
  for (const token of [reader, writeOnly, capture]) {
    assert.equal((await call('POST', '/imports/biscotti/preview', token, { data })).status, 403);
  }
  const preview = await call('POST', '/imports/biscotti/preview', writer, { data }, 'meeting-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.entries[0].title, 'Garden meeting');
  assert.equal(memory.items.list({ importedKind: 'biscotti' }).length, 0);
  assert.equal(memory.clients.recall(writerClient.client.id, 'POST /api/v1/imports/biscotti/preview meeting-preview'), null);
  const changed = await call('POST', '/imports/biscotti/preview', writer, { data: data.replace('Order cedar.', 'Buy seeds.') }, 'meeting-preview');
  assert.notEqual(changed.data.fingerprint, preview.data.fingerprint);
});

test('selected meeting imports retain provenance and date, replay safely and appear in the reader library', async () => {
  const preview = await call('POST', '/imports/biscotti/preview', writer, { data });
  const request = { data, source: 'csv', fingerprint: preview.data.fingerprint, includeIds: ['api-meeting'] };
  for (const token of [reader, writeOnly, capture]) assert.equal((await call('POST', '/imports/biscotti', token, request)).status, 403);
  const saved = await call('POST', '/imports/biscotti', writer, request, 'meeting-apply');
  assert.equal(saved.status, 201);
  assert.equal(saved.data.created, 1);
  const replay = await call('POST', '/imports/biscotti', writer, request, 'meeting-apply');
  assert.deepEqual(replay.data, saved.data);
  assert.equal((await call('POST', '/imports/biscotti', writer, request)).data.skipped, 1);
  const listed = await call('GET', '/meetings/biscotti?limit=1', reader);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items[0].date, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(listed.data.items[0].speakers, ['Alex']);
  const item = memory.items.get(saved.data.items[0].id);
  assert.equal(item.source, 'api:writer');
  assert.match(item.body, /\[0:23\] Alex/);
  assert.deepEqual(item.metadata.importedFrom, { kind: 'biscotti', path: 'api-meeting' });
});

test('bad selections, stale previews and invalid sources cannot create notes', async () => {
  const unique = data.replace('api-meeting', 'api-second');
  const preview = await call('POST', '/imports/biscotti/preview', writer, { data: unique });
  const request = { data: unique, source: 'csv', fingerprint: preview.data.fingerprint, includeIds: ['api-second'] };
  assert.equal((await call('POST', '/imports/biscotti', writer, { ...request, includeIds: ['unknown'] })).status, 400);
  assert.equal((await call('POST', '/imports/biscotti', writer, { ...request, data: unique.replace('Keep receipts.', 'Different notes.') })).status, 409);
  assert.equal((await call('POST', '/imports/biscotti/preview', writer, { data, source: 'arbitrary-server' })).status, 400);
  assert.equal(memory.items.findImported('biscotti', 'api-second'), null);
  assert.equal((await call('GET', '/meetings/biscotti?limit=0', reader)).status, 400);
  assert.equal((await call('POST', '/biscotti/query', writer, { url: 'http://127.0.0.1:8516/mcp' })).status, 404);
});

test('an explicit JSON body limit still takes precedence over the meeting envelope allowance', async () => {
  const limited = createApiServer(memory, { version: 'test', port: 0, maxJsonBytes: 128 });
  const url = await limited.listen();
  try {
    const response = await fetch(`${url}/api/v1/imports/biscotti/preview`, { method: 'POST', headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    assert.equal(response.status, 413);
  } finally { await limited.close(); }
});
