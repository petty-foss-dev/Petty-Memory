import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { EnveMemory, type EditorActionResult, type LibraryPage } from '@enve-memory/core';
import { RemoteSyncClient, createApiServer } from '@enve-memory/api';

async function fixture(t: TestContext) {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  const api = createApiServer(memory, { port: 0, version: 'test' });
  const base = await api.listen();
  const reader = memory.clients.create('reader', ['read']);
  const writer = memory.clients.create('writer', ['read', 'write']);
  t.after(async () => { await api.close(); memory.close(); });
  const call = (path: string, token = reader.token, init: RequestInit = {}) => fetch(`${base}/api/v1${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  return { memory, api, base, reader, writer, call };
}

async function until(check: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Live sync did not converge before the deadline.');
    await delay(30);
  }
}

test('read-only library feed and capability negotiation retain their scope boundary', async (t) => {
  const { memory, call } = await fixture(t);
  const capture = memory.clients.create('capture', ['capture']).token;
  const note = memory.items.saveNote({ title: 'Unopened branch', body: 'Available offline' });
  const caps = await (await call('/capabilities')).json() as { api: number; features: string[] };
  assert.equal(caps.api, 1);
  assert.ok(caps.features.includes('library-feed') && caps.features.includes('editor-actions'));
  const response = await call('/library?limit=1');
  assert.equal(response.status, 200);
  const page = await response.json() as LibraryPage;
  assert.equal(page.deviceId, memory.deviceId);
  assert.equal(page.items[0]!.item.id, note.id);
  assert.equal(page.items[0]!.item.body, 'Available offline');
  for (const path of ['/library', '/changes', '/capabilities']) {
    assert.equal((await call(path, capture)).status, 403);
  }
  for (const path of ['/library?cursor=-1', '/library?cursor=1.2', '/changes?since=NaN', '/changes?wait=25001']) {
    assert.equal((await call(path)).status, 400, path);
  }
});

test('live waits wake on external writes, time out, and stop when a token is revoked', async (t) => {
  const { memory, reader, call } = await fixture(t);
  let revision = memory.feed.revision;
  const pending = call(`/changes?since=${revision}&wait=5000`);
  await delay(40);
  memory.items.saveNote({ body: 'Written by another local process' });
  const changed = await (await pending).json() as { revision: number };
  assert.ok(changed.revision > revision);
  revision = changed.revision;
  const started = Date.now();
  const timed = await (await call(`/changes?since=${revision}&wait=70`)).json() as { revision: number };
  assert.equal(timed.revision, revision);
  assert.ok(Date.now() - started >= 50);
  const revoked = call(`/changes?since=${revision}&wait=5000`);
  await delay(40);
  memory.clients.revoke(reader.client.id);
  assert.equal((await revoked).status, 401);
});

test('live waits are bounded per client and disconnects free their capacity', async (t) => {
  const { memory, call } = await fixture(t);
  const revision = memory.feed.revision;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = Array.from({ length: 3 }, () => call(`/changes?since=${revision}&wait=300`, undefined, { signal: controller.signal }));
  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 429]);
  await Promise.all(responses.map((r) => r.text()));
  const disconnected = call(`/changes?since=${revision}&wait=25000`, undefined, { signal: controller.signal });
  await delay(40);
  controller.abort();
  await assert.rejects(disconnected, { name: 'AbortError' });
  await delay(40);
  assert.equal((await call(`/changes?since=${revision}&wait=1`)).status, 200);
});

test('journalled API edits reuse stable ids, undo and redo, and reject stale or unauthorized changes', async (t) => {
  const { memory, writer, call } = await fixture(t);
  const id = '019d0000-0000-7000-8000-000000000001';
  const actionId = '019d0000-0000-7000-8000-000000000002';
  const commands = [{ op: 'create', id, parentId: null, title: 'Packing', body: 'Socks and a hat' }];
  const apply = (body: unknown, token = writer.token) => call('/editor/actions', token, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await apply({ commands }, undefined)).status, 201);
  // Use a separate id so the read-only denial can be checked without touching the successful action.
  const denied = await call('/editor/actions', undefined, { method: 'POST', body: JSON.stringify({ commands: [{ ...commands[0], id: actionId }] }) });
  assert.equal(denied.status, 403);
  const split = await apply({ id: actionId, commands: [{ op: 'split', id, field: 'body', offset: 5, baseText: 'Socks and a hat' }] });
  assert.equal(split.status, 201);
  const action = await split.json() as EditorActionResult;
  assert.equal(action.actionId, actionId);
  assert.equal(action.createdIds.length, 1);
  const replay = await (await apply({ id: actionId, commands: [{ op: 'split', id, field: 'body', offset: 5, baseText: 'Socks and a hat' }] })).json();
  assert.deepEqual(replay, action);
  assert.equal((await call(`/editor/actions/${actionId}/undo`, writer.token, { method: 'POST' })).status, 200);
  assert.equal(memory.items.get(id).body, 'Socks and a hat');
  assert.ok(memory.items.get(action.createdIds[0]!).archivedAt);
  assert.equal((await call(`/editor/actions/${actionId}/redo`, writer.token, { method: 'POST' })).status, 200);
  assert.equal(memory.items.get(action.createdIds[0]!).archivedAt, null);
  memory.items.update(id, { body: 'A newer independent edit' });
  assert.equal((await call(`/editor/actions/${actionId}/undo`, writer.token, { method: 'POST' })).status, 409);
  assert.equal(memory.items.get(id).body, 'A newer independent edit');
});

test('two watched replicas push local edits and receive remote edits without a timer interval', { timeout: 20000 }, async (t) => {
  const { memory, base } = await fixture(t);
  const peers = [0, 1].map(() => EnveMemory.open({ inMemory: true, actor: 'test' }));
  const token = memory.clients.create('replicas', ['sync']).token;
  const controller = new AbortController();
  const errors: string[] = [];
  const watches = peers.map((peer) => new RemoteSyncClient(peer, { url: base, token }).watch({
    signal: controller.signal, onError: (error) => errors.push(error.stack ?? error.message),
  }));
  t.after(async () => { controller.abort(); await Promise.all(watches); peers.forEach((peer) => peer.close()); });
  const note = peers[0]!.items.saveNote({ body: 'A live shared note' });
  try {
    await until(() => peers[1]!.items.list().some((item) => item.id === note.id));
  } catch (error) {
    assert.fail(`${String(error)}; transport errors: ${JSON.stringify(errors)}; revisions: ${[memory, ...peers].map((peer) => peer.feed.revision).join(',')}`);
  }
  assert.equal(peers[1]!.items.get(note.id).body, 'A live shared note');
  peers[1]!.items.update(note.id, { body: 'Edited on the second device', baseBody: 'A live shared note' });
  await until(() => peers[0]!.items.get(note.id).body === 'Edited on the second device');
  assert.equal(memory.items.get(note.id).body, 'Edited on the second device');
  assert.deepEqual(errors, []);
});

test('a watcher stops on revoked credentials instead of retrying a permission failure', { timeout: 5000 }, async (t) => {
  const { memory, base } = await fixture(t);
  const peer = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => peer.close());
  const client = memory.clients.create('revoked replica', ['sync']);
  memory.clients.revoke(client.client.id);
  const controller = new AbortController();
  const errors: string[] = [];
  const watching = new RemoteSyncClient(peer, { url: `${base}/api/v1`, token: client.token }).watch({ signal: controller.signal, onError: (error) => errors.push(error.message) });
  t.after(() => controller.abort());
  await watching;
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /rejected the token/);
});

test('HTTP never exposes an unlocked host vault unless local host access was explicitly enabled', async (t) => {
  const { memory, call } = await fixture(t);
  memory.vault.setup('synthetic host passphrase');
  const secret = memory.vault.create({ title: 'Private host title', body: 'Host plaintext must stay local' });
  const client = memory.clients.create('sealed client', ['read', 'secrets']);
  for (const [method, path, body] of [
    ['GET', `/vault/items/${secret.id}`, undefined],
    ['PATCH', `/vault/items/${secret.id}`, { title: 'Replaced', body: 'Replaced' }],
    ['POST', '/vault/unlock', { passphrase: 'synthetic host passphrase' }],
  ] as const) {
    const result = await call(path, client.token, { method, ...(body && { body: JSON.stringify(body) }) });
    assert.equal(result.status, 403);
    assert.equal((await result.text()).includes('Host plaintext must stay local'), false);
  }
  const ordinary = await (await call(`/items/${secret.id}`, client.token)).text();
  assert.equal(ordinary.includes('Host plaintext must stay local'), false);
  assert.equal(memory.vault.read(secret.id).body, 'Host plaintext must stay local');
});
