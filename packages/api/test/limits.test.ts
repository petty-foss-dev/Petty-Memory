import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';
import { createApiServer } from '@enve-memory/api';

test('health reveals no private data and request limits reject excess bodies before a write', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const api = createApiServer(memory, { version: 'test', port: 0, maxUploadBytes: 16, maxJsonBytes: 64 });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const token = memory.clients.create('writer', ['read', 'write']).token;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const json = await fetch(`${base}/api/v1/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'x'.repeat(100) }),
  });
  assert.equal(json.status, 413);
  const file = await fetch(`${base}/api/v1/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Filename': 'test.txt' },
    body: 'x'.repeat(17),
  });
  assert.equal(file.status, 413);
  assert.equal(memory.items.list().length, 0);
  assert.throws(() => createApiServer(memory, { version: 'test', maxConcurrentWrites: 0 }), /positive integer/);
});

test('concurrent write admission frees its slot when a partial upload disconnects', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const api = createApiServer(memory, { version: 'test', port: 0, maxConcurrentWrites: 1 });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const token = memory.clients.create('writer', ['write']).token;
  const partial = request(`${base}/api/v1/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 100 },
  });
  partial.on('error', () => {});
  partial.write('{');
  await delay(50);
  const capture = () => fetch(`${base}/api/v1/capture`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'kept' }),
  });
  assert.equal((await capture()).status, 429);
  partial.destroy();
  await delay(50);
  assert.equal((await capture()).status, 201);
  assert.equal(memory.items.list().length, 1);
});

test('revoking a client while its body uploads prevents a late write', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const api = createApiServer(memory, { version: 'test', port: 0 });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const client = memory.clients.create('writer', ['write']);
  const body = JSON.stringify({ note: 'Must not be saved after revocation' });
  let upload: ReturnType<typeof request>;
  const completed = new Promise<number>((resolve, reject) => {
    upload = request(`${base}/api/v1/capture`, {
      method: 'POST', headers: { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => { response.resume(); resolve(response.statusCode!); });
    upload.on('error', reject);
    upload.write(body.slice(0, 1));
  });
  await delay(40);
  memory.clients.revoke(client.client.id);
  upload!.end(body.slice(1));
  assert.equal(await completed, 401);
  assert.equal(memory.items.list().length, 0);
});
