import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RemoteSyncClient, createApiServer } from '@enve-memory/api';
import { EnveMemory, openDatabase, pathsFor } from '@enve-memory/core';

const laptopHome = mkdtempSync(join(tmpdir(), 'petty-memory-laptop-'));
const server = EnveMemory.open({ home: mkdtempSync(join(tmpdir(), 'petty-memory-server-')), actor: 'test' });
server.settings.set('fetchLinks', false);
let laptop = EnveMemory.open({ home: laptopHome, actor: 'test' });
const api = createApiServer(server, { version: '0.0.0-test', port: 0 });
const base = await api.listen();
const peer = `${base}/api/v1`;
after(async () => {
  await api.close();
  laptop.close();
  server.close();
});

const syncToken = server.clients.create('laptop sync', ['sync']).token;
const writer = server.clients.create('phone', ['read', 'write']).token;
const run = () => new RemoteSyncClient(laptop, { url: base, token: syncToken }).run();
let wiringId = '';
const has = (memory: EnveMemory, words: string) => memory.search.query(words).length > 0;

test('sync routes need the explicit sync scope, so ordinary tokens cannot push tombstones', async () => {
  const kept = server.items.saveNote({ body: 'server keeps this note' });
  const record = server.sync.exportChanges(0).records.find((r) => r.id === kept.id)!;
  const tombstone = { ...record, state: null, device: 'another-device' };
  const hash = 'a'.repeat(64);
  const send = (method: string, path: string, token: string | undefined, body?: RequestInit['body']) => fetch(`${peer}${path}`, {
    method, body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  });
  for (const token of [writer, undefined]) {
    const expected = token ? 403 : 401;
    assert.equal((await send('GET', '/sync', token)).status, expected);
    assert.equal((await send('POST', '/sync', token, JSON.stringify({ records: [tombstone] }))).status, expected);
    assert.equal((await send('GET', `/sync/blobs/${hash}`, token)).status, expected);
    assert.equal((await send('PUT', `/sync/blobs/${hash}`, token, new Uint8Array([1]))).status, expected);
  }
  assert.equal(server.items.get(kept.id).body, 'server keeps this note');
  assert.equal((await send('GET', '/sync?cursor=0&limit=5', syncToken)).status, 200);
  assert.equal((await send('GET', '/sync?cursor=-1', syncToken)).status, 400);
  assert.equal((await send('GET', `/sync/blobs/${hash}`, syncToken)).status, 404);
  assert.equal((await send('PUT', `/sync/blobs/${hash}`, syncToken, new Uint8Array([1]))).status, 404);
  await assert.rejects(new RemoteSyncClient(laptop, { url: base, token: writer }).run(), /lacks the sync scope/);
  assert.equal(laptop.sync.peerState(peer), null);
});

test('two libraries exchange notes, hierarchy and files, then edit after pull without false conflicts', async () => {
  const root = laptop.outline.createNote({ parentId: null, title: 'Workshop' }).item;
  const bench = laptop.outline.createNote({ parentId: root.id, title: 'Bench', body: 'needs clamps' }).item;
  const wiring = laptop.files.save({ data: Buffer.from('wiring diagram v1'), filename: 'wiring.txt' }).item;
  laptop.outline.move(wiring.id, { parentId: root.id });
  wiringId = wiring.id;

  const first = await run();
  assert.ok(first.pushed >= 3);
  assert.deepEqual([first.conflicts, first.rejected], [0, 0]);
  assert.equal(server.outline.get(bench.id).parentId, root.id);
  assert.equal(server.outline.get(wiring.id).parentId, root.id);
  assert.equal(readFileSync(server.files.primary(wiring.id).path, 'utf8'), 'wiring diagram v1');
  assert.ok(has(laptop, 'server keeps this note'), 'the server relays its own changes');

  server.items.update(bench.id, { body: 'needs clamps and a vise' });
  const pulled = await run();
  assert.ok(pulled.pulled >= 1);
  assert.equal(pulled.conflicts, 0);
  assert.equal(laptop.items.get(bench.id).body, 'needs clamps and a vise');

  laptop.items.update(bench.id, { body: 'clamps bought', baseBody: 'needs clamps and a vise' });
  const pushed = await run();
  assert.ok(pushed.pushed >= 1);
  assert.equal(pushed.conflicts, 0);
  assert.equal(server.items.get(bench.id).body, 'clamps bought');
  assert.equal(server.versions.list(bench.id).items.some((v) => v.op === 'conflict'), false);
});

test('a restarted client resumes from persisted cursors and its files survive', async () => {
  laptop.close();
  laptop = EnveMemory.open({ home: laptopHome, actor: 'test' });
  const state = laptop.sync.peerState(peer)!;
  assert.ok(state.pushedCursor > 0 && state.pulledCursor > 0);
  assert.deepEqual([state.uploads, state.downloads], [[], []]);
  assert.deepEqual(await run(), { pushed: 0, pulled: 0, conflicts: 0, rejected: 0 });
  assert.deepEqual(await run(), { pushed: 0, pulled: 0, conflicts: 0, rejected: 0 }, 'repeated runs do not echo');
  const sha = laptop.files.primary(wiringId).attachment.sha256;
  assert.deepEqual([laptop.sync.blobStatus(sha), server.sync.blobStatus(sha)], ['stored', 'stored']);
});

test('a genuine concurrent edit is reported and both texts are kept on both sides', async () => {
  const note = laptop.items.saveNote({ title: 'Shelf', body: 'shared shelf plan' });
  await run();
  server.items.update(note.id, { body: 'server says zephyr' });
  laptop.items.update(note.id, { body: 'laptop says quokka' });
  const result = await run();
  assert.ok(result.conflicts >= 1);
  assert.equal(result.rejected, 0);
  await run();
  for (const memory of [server, laptop]) {
    assert.ok(has(memory, 'zephyr') && has(memory, 'quokka'));
  }
  assert.equal(server.items.get(note.id).body, laptop.items.get(note.id).body);
});

test('a file whose bytes are not on the server yet stays pending and arrives on a later run', async () => {
  const manual = server.files.save({ data: Buffer.from('opener manual pages'), filename: 'manual.txt' }).item;
  const { path, attachment } = server.files.primary(manual.id);
  const bytes = readFileSync(path);
  rmSync(path);
  assert.ok((await run()).pulled >= 1);
  assert.equal(laptop.sync.blobStatus(attachment.sha256), 'missing');
  assert.ok(laptop.sync.peerState(peer)!.downloads.includes(attachment.sha256));

  writeFileSync(path, bytes);
  await run();
  assert.equal(laptop.sync.blobStatus(attachment.sha256), 'stored');
  assert.equal(laptop.sync.peerState(peer)!.downloads.includes(attachment.sha256), false);
  assert.equal(readFileSync(laptop.files.primary(manual.id).path, 'utf8'), 'opener manual pages');
});

test('refused push pages stay pending while other local changes and incoming updates continue', async () => {
  laptop.projects.create({ name: 'Shop rules' });
  const decision = laptop.decisions.record({ project: 'shop-rules', decision: 'No power tools after 9pm' });
  await run();
  assert.equal(server.items.get(decision.id).type, 'decision');

  laptop.items.delete(decision.id);
  const before = laptop.sync.peerState(peer)!.pushedCursor;
  assert.equal((await run()).rejected, 1);
  assert.ok(laptop.sync.peerState(peer)!.pendingPushes?.includes(before));
  const local = laptop.items.saveNote({ body: 'Independent local work must still arrive' });
  const incoming = server.items.saveNote({ body: 'Other device work must still arrive' });
  assert.ok((await run()).rejected >= 1);
  assert.ok(laptop.sync.peerState(peer)!.pendingPushes?.includes(before));
  assert.equal(server.items.get(local.id).body, local.body);
  assert.equal(laptop.items.get(incoming.id).body, incoming.body);
  assert.equal(server.items.get(decision.id).type, 'decision', 'decisions stay append-only on the server');
});

test('a server request quota splits sync pushes by UTF-8 bytes without dropping records', async (t) => {
  const remote = EnveMemory.open({ inMemory: true, actor: 'test' });
  const local = EnveMemory.open({ inMemory: true, actor: 'test' });
  const quota = 4096;
  const bounded = createApiServer(remote, { version: 'test', port: 0, maxSyncBytes: quota });
  const url = await bounded.listen();
  t.after(async () => { await bounded.close(); local.close(); remote.close(); });
  const sizes: number[] = [];
  bounded.server.on('request', (request) => {
    if (request.method === 'POST' && request.url === '/api/v1/sync') sizes.push(Number(request.headers['content-length']));
  });
  const token = remote.clients.create('bounded replica', ['sync']).token;
  const notes = Array.from({ length: 8 }, (_, i) => local.items.saveNote({ title: `Note ${i}`, body: '旅'.repeat(400) }));
  const result = await new RemoteSyncClient(local, { url, token }).run();
  assert.equal(result.rejected, 0);
  assert.equal(result.pushed, notes.length);
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every((size) => size <= quota));
  for (const note of notes) assert.equal(remote.items.get(note.id).body, note.body);
});

test('deferred pulls remain retryable without blocking later valid server changes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-deferred-server-'));
  let remote = EnveMemory.open({ home, actor: 'test' });
  const held = remote.items.saveNote({ body: 'A legacy clock mistake' });
  const clock = `2099-01-01T00:00:00.000Z-000000-${remote.deviceId}`;
  remote.close();
  const db = openDatabase(pathsFor(home).database);
  db.prepare(`UPDATE changes SET hlc = ? WHERE entity_id = ?`).run(clock, held.id);
  db.prepare(`UPDATE sync_versions SET hlc = ? WHERE entity_id = ?`).run(clock, held.id);
  db.close();
  remote = EnveMemory.open({ home, actor: 'test' });
  const normal = remote.items.saveNote({ body: 'Valid later server work' });
  const local = EnveMemory.open({ inMemory: true, actor: 'test' });
  const bounded = createApiServer(remote, { version: 'test', port: 0 });
  const url = await bounded.listen();
  t.after(async () => { await bounded.close(); local.close(); remote.close(); rmSync(home, { recursive: true, force: true }); });
  const token = remote.clients.create('clock replica', ['sync']).token;
  const sync = new RemoteSyncClient(local, { url, token });
  assert.ok((await sync.run()).rejected > 0);
  assert.equal(local.items.get(normal.id).body, normal.body);
  assert.throws(() => local.items.get(held.id), /No item/);
  assert.deepEqual(local.sync.peerState(`${url}/api/v1`)!.pendingPulls, [0]);
  local.items.update(normal.id, { body: 'Edited after a partial pull', baseBody: normal.body });
  const partial = await sync.run();
  assert.ok(partial.rejected > 0);
  assert.equal(partial.conflicts, 0);
  assert.equal(remote.items.get(normal.id).body, 'Edited after a partial pull');
  assert.equal(remote.versions.list(normal.id).items.some((version) => version.op === 'conflict'), false);
  remote.items.update(held.id, { body: 'Clock corrected note' });
  assert.equal((await sync.run()).rejected, 0);
  assert.equal(local.items.get(held.id).body, 'Clock corrected note');
  assert.equal(local.sync.peerState(`${url}/api/v1`)!.pendingPulls, undefined);
});
