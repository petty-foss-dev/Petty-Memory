import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AiProvider, CompletionRequest } from '@enve-memory/ai';
import { createApiServer } from '@enve-memory/api';
import { EnveMemory, SECRET_LABEL, type SecretEnvelope } from '@enve-memory/core';

const webHome = mkdtempSync(join(tmpdir(), 'petty-memory-web-'));
const webRoot = join(webHome, 'web');
mkdirSync(webRoot);
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Petty web</title>');
writeFileSync(join(webRoot, 'app.js'), 'console.log("petty");');
writeFileSync(join(webRoot, 'notes.txt'), 'not a web asset');
writeFileSync(join(webHome, 'outside.html'), '<p>outside the web root</p>');

const prompts: string[] = [];
const provider: AiProvider = {
  id: 'ollama',
  model: 'fake-editor',
  async complete(request: CompletionRequest) {
    prompts.push(request.prompt);
    return JSON.stringify({
      summary: 'Fix the typo, add adapters and make it a checklist.',
      operations: [
        { op: 'update', ref: 'n2', title: 'Passport' },
        { op: 'create', parent: 'n1', title: 'Plug adapters' },
        { op: 'presentation', ref: 'n1', checklist: true },
      ],
    });
  },
  async listModels() {
    return ['fake-editor'];
  },
};

const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
memory.settings.set('fetchLinks', false);
const api = createApiServer(memory, {
  version: '0.0.0-test', port: 0, aiProvider: () => provider, webRoot, webOrigins: ['https://notes.example'], allowHostVault: true,
});
const base = await api.listen();
after(() => api.close());

const reader = memory.clients.create('reader', ['read']).token;
const writer = memory.clients.create('phone', ['read', 'write']).token;
const vaultClient = memory.clients.create('vault phone', ['read', 'secrets']);
const secrets = vaultClient.token;

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = response.headers.get('content-type')?.startsWith('application/json');
  return { status: response.status, headers: response.headers, data: json && text ? JSON.parse(text) : text };
}

// A browser/iOS client's end-to-end encryption, per the PBKDF2 contract; derived once because it is deliberately slow.
const PASSPHRASE = 'correct horse battery';
const SALT = randomBytes(16);
const clientKey = pbkdf2Sync(PASSPHRASE.normalize('NFKC'), SALT, 600_000, 32, 'sha256');

function seal(id: string, plain: { title: string; body: string }): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clientKey, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 }, salt: SALT.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

function unseal(id: string, envelope: SecretEnvelope): { title: string; body: string } {
  const decipher = createDecipheriv('aes-256-gcm', clientKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(id, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawGet(path: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

test('presentation and checklist routes share one completion authority with task children', async () => {
  const list = memory.outline.createNote({ parentId: null, title: 'Packing' }).item;
  const socks = memory.outline.createNote({ parentId: list.id, title: 'Socks' }).item;
  const adapter = memory.tasks.create({ title: 'Buy adapter' });
  memory.outline.move(adapter.id, { parentId: list.id });

  const patched = await call('PATCH', `/api/v1/items/${list.id}/presentation`, writer, { checklist: true, review: true, attention: 'high' });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.checklist, true);
  assert.equal((await call('PATCH', `/api/v1/items/${list.id}/presentation`, writer, { kind: 'banner' })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/items/${list.id}/presentation`, reader, { review: false })).status, 403);
  const shown = (await call('GET', `/api/v1/items/${list.id}/presentation`, reader)).data;
  assert.deepEqual([shown.kind, shown.attention, shown.review, shown.checked], ['text', 'high', true, false]);
  const flagged = (await call('GET', '/api/v1/items?review=true&attention=high', reader)).data;
  assert.deepEqual(flagged.map((item: { id: string }) => item.id), [list.id]);

  await call('POST', `/api/v1/items/${socks.id}/check`, writer, { checked: true });
  assert.deepEqual((await call('GET', `/api/v1/items/${list.id}/checklist`, reader)).data, { done: 1, total: 2 });
  assert.equal((await call('POST', `/api/v1/items/${socks.id}/check`, writer, {})).status, 400);
  await call('POST', `/api/v1/items/${list.id}/check`, writer, { checked: true });
  const children = (await call('GET', `/api/v1/outline?parent=${list.id}`, reader)).data;
  const task = children.items.find((entry: { item: { id: string } }) => entry.item.id === adapter.id);
  assert.equal(task.item.task.status, 'done');
  assert.deepEqual((await call('GET', `/api/v1/items/${list.id}/checklist`, reader)).data, { done: 2, total: 2 });

  assert.equal((await call('POST', `/api/v1/items/${list.id}/checklist/reset`, writer)).data.updated, 3);
  assert.deepEqual(memory.presentation.progress(list.id), { done: 0, total: 2 });
  assert.equal(memory.tasks.get(adapter.id).task.status, 'open');
});

test('history, references and reversible relations work over REST', async () => {
  const note = memory.items.saveNote({ title: 'Router config', body: 'v1 settings' });
  await call('PATCH', `/api/v1/items/${note.id}`, writer, { body: 'v2 settings' });
  const newest = (await call('GET', `/api/v1/items/${note.id}/versions?limit=1`, reader)).data;
  assert.equal(newest.items.length, 1);
  assert.ok(newest.total >= 2);
  const oldest = (await call('GET', `/api/v1/items/${note.id}/versions?offset=${newest.total - 1}`, reader)).data.items[0];
  const version = (await call('GET', `/api/v1/versions/${oldest.id}`, reader)).data;
  assert.equal(version.snapshot.rootId, note.id);
  assert.equal(version.snapshot.items[0].item.body, 'v1 settings');
  assert.equal((await call('POST', `/api/v1/versions/${oldest.id}/restore`, reader)).status, 403);
  assert.deepEqual((await call('POST', `/api/v1/versions/${oldest.id}/restore`, writer)).data, { restored: 1 });
  assert.equal(memory.items.get(note.id).body, 'v1 settings');
  assert.equal(memory.versions.list(note.id).total, newest.total + 1);

  const spare = memory.items.saveNote({ title: 'Spare router', body: 'In the closet' });
  const linked = await call('POST', `/api/v1/items/${note.id}/references`, writer, { toId: spare.id, label: 'backup|unit' });
  assert.ok(linked.data.body.endsWith(`[[item:${spare.id}|backup unit]]`));
  const outgoing = (await call('GET', `/api/v1/items/${note.id}/references`, reader)).data.outgoing;
  assert.deepEqual(outgoing.map((r: { id: string; title: string }) => [r.id, r.title]), [[spare.id, 'Spare router']]);
  assert.deepEqual((await call('GET', `/api/v1/items/${spare.id}/references`, reader)).data.incoming.map((r: { id: string }) => r.id), [note.id]);

  const related = await call('POST', `/api/v1/items/${note.id}/relations`, writer, { toId: spare.id, kind: 'depends_on' });
  assert.ok(related.data.relations.some((r: { id: string; kind: string }) => r.id === spare.id && r.kind === 'depends_on'));
  assert.equal((await call('DELETE', `/api/v1/items/${note.id}/relations`, reader, { toId: spare.id, kind: 'depends_on' })).status, 403);
  const removed = await call('DELETE', `/api/v1/items/${note.id}/relations`, writer, { toId: spare.id, kind: 'depends_on' });
  assert.equal(removed.data.relations.some((r: { kind: string }) => r.kind === 'depends_on'), false);
  assert.equal((await call('DELETE', `/api/v1/items/${note.id}/relations`, writer, { toId: spare.id, kind: 'depends_on' })).status, 404);
  assert.equal((await call('DELETE', `/api/v1/items/${note.id}/relations`, writer, { toId: spare.id, kind: 'supersedes' })).status, 400);
  assert.equal(memory.items.get(spare.id).id, spare.id, 'removing a connection never deletes an item');
});

test('AI proposals preview, apply atomically, reject stale replays and undo', async () => {
  const trip = memory.outline.createNote({ parentId: null, title: 'Trip' }).item;
  const typo = memory.outline.createNote({ parentId: trip.id, title: 'Pasport' }).item;
  const secretId = uuidv7();
  memory.vault.createSealed({ id: secretId, envelope: seal(secretId, { title: 'Visa PIN', body: '9911' }) });
  memory.outline.move(secretId, { parentId: trip.id });

  assert.equal((await call('POST', '/api/v1/ai/edit', reader, { rootId: trip.id, instruction: 'Tidy' })).status, 403);
  const proposed = await call('POST', '/api/v1/ai/edit', writer, { rootId: trip.id, instruction: 'Fix typos and make this a checklist' });
  assert.equal(proposed.status, 200);
  const proposal = proposed.data;
  assert.equal(prompts.at(-1)!.includes(SECRET_LABEL) || prompts.at(-1)!.includes(secretId), false, 'secret notes stay out of scope');
  assert.deepEqual(proposal.operations.map((op: { op: string }) => op.op), ['update', 'create', 'presentation']);
  assert.equal(proposal.operations[0].before.title, 'Pasport');
  assert.equal(proposal.titles[typo.id], 'Pasport');
  assert.equal(memory.items.get(typo.id).title, 'Pasport', 'proposing applies nothing');

  const applied = (await call('POST', '/api/v1/ai/apply', writer, { proposal })).data;
  assert.equal(applied.applied, 3);
  assert.equal(applied.undo.createdIds.length, 1);
  assert.equal(memory.items.get(typo.id).title, 'Passport');
  assert.equal(memory.presentation.get(trip.id).checklist, true);
  assert.equal(memory.outline.get(applied.undo.createdIds[0]).parentId, trip.id);
  assert.equal((await call('POST', '/api/v1/ai/apply', writer, { proposal })).status, 409, 'a used proposal is stale');

  assert.equal((await call('POST', '/api/v1/ai/undo', writer, { receipt: applied.undo })).status, 200);
  assert.equal(memory.items.get(typo.id).title, 'Pasport');
  assert.equal(memory.presentation.get(trip.id).checklist, false);
  assert.ok(memory.items.get(applied.undo.createdIds[0]).archivedAt);
  assert.equal((await call('POST', '/api/v1/ai/undo', writer, { receipt: applied.undo })).status, 409);
});

test('vault routes need the explicit secrets scope; sealed notes stay opaque while the host vault is locked', async () => {
  for (const token of [reader, writer]) {
    assert.equal((await call('GET', '/api/v1/vault', token)).status, 403);
    assert.equal((await call('POST', '/api/v1/vault/sealed-items', token, {})).status, 403);
  }
  assert.deepEqual((await call('GET', '/api/v1/vault', secrets)).data, { configured: false, unlocked: false });

  const id = uuidv7();
  const plain = { title: 'Bank PIN', body: '4417 under the doormat' };
  const headers = { 'Idempotency-Key': 'sealed-once' };
  const created = await call('POST', '/api/v1/vault/sealed-items', secrets, { id, envelope: seal(id, plain), tags: ['finance'] }, headers);
  assert.equal(created.status, 201);
  assert.deepEqual([created.data.id, created.data.title, created.data.body, created.data.metadata.secret], [id, SECRET_LABEL, '', true]);
  const retry = await call('POST', '/api/v1/vault/sealed-items', secrets, { id, envelope: seal(id, plain) }, headers);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal((await call('POST', '/api/v1/vault/sealed-items', secrets, { id, envelope: seal(id, plain) })).status, 409);
  const weak = { ...seal(uuidv7(), plain), kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 1000 } };
  assert.equal((await call('POST', '/api/v1/vault/sealed-items', secrets, { id: uuidv7(), envelope: weak })).status, 400);
  assert.equal((await call('POST', '/api/v1/vault/sealed-items', secrets, { id: 'not-a-uuid', envelope: seal(id, plain) })).status, 400);

  const listed = (await call('GET', '/api/v1/items?secret=true', reader)).data.find((item: { id: string }) => item.id === id);
  assert.deepEqual(unseal(id, listed.metadata.vault), plain);
  assert.equal(JSON.stringify(listed).includes('doormat'), false);
  assert.equal((await call('GET', '/api/v1/search?q=doormat', reader)).data.length, 0);

  const updated = { title: 'Bank PIN', body: '5528 in the safe' };
  assert.equal((await call('PATCH', `/api/v1/vault/sealed-items/${id}`, secrets, { envelope: seal(id, updated) })).status, 200);
  const stored = memory.items.get(id).metadata.vault!;
  assert.deepEqual(unseal(id, stored), updated);
  const leak = await call('PATCH', `/api/v1/items/${id}`, writer, { body: 'plaintext leak' });
  assert.equal(leak.status, 400);
  assert.deepEqual(memory.items.get(id).metadata.vault, stored);
  assert.equal(memory.items.get(id).body, '');
  assert.deepEqual((await call('GET', '/api/v1/vault', secrets)).data, { configured: false, unlocked: false });

  // The host-decryption path is separate: it joins the existing vault, and reading needs an unlocked host.
  assert.deepEqual((await call('POST', '/api/v1/vault/setup', secrets, { passphrase: PASSPHRASE })).data, { configured: true, unlocked: true });
  await call('POST', '/api/v1/vault/lock', secrets);
  assert.equal((await call('GET', `/api/v1/vault/items/${id}`, secrets)).status, 423);
  assert.equal((await call('POST', '/api/v1/vault/unlock', secrets, { passphrase: 'wrong passphrase' })).status, 400);
  await call('POST', '/api/v1/vault/unlock', secrets, { passphrase: PASSPHRASE });
  assert.deepEqual((await call('GET', `/api/v1/vault/items/${id}`, secrets)).data, { id, ...updated });

  const hostSecret = await call('POST', '/api/v1/vault/items', secrets, { title: 'Alarm code', body: '2468 then star' }, { 'Idempotency-Key': 'host-secret' });
  assert.equal(hostSecret.status, 201);
  const record = memory.clients.recall(vaultClient.client.id, 'POST /api/v1/vault/items host-secret');
  assert.ok(record?.body.includes(SECRET_LABEL));
  assert.equal(/Alarm code|2468/.test(record!.body), false, 'idempotency records hold ciphertext only');
  await call('POST', '/api/v1/vault/lock', secrets);
});

test('public shares are sanitized live projections with one-time tokens, revocation and expiry', async () => {
  const root = memory.outline.createNote({ parentId: null, title: 'Camping list' }).item;
  const tent = memory.outline.createNote({ parentId: root.id, title: 'Tent' }).item;
  const hidden = memory.outline.createNote({ parentId: root.id, title: 'Spare key spot' }).item;
  memory.outline.createNote({ parentId: hidden.id, title: 'Under the blue rock' });
  const diary = memory.items.saveNote({ title: 'Diary', body: 'private thoughts' });
  const secretId = uuidv7();
  memory.vault.createSealed({ id: secretId, envelope: seal(secretId, { title: 'Campsite gate code', body: '1357' }) });
  memory.outline.move(secretId, { parentId: root.id });
  memory.items.update(root.id, { body: `Bring [[item:${tent.id}|old tent label]] and read [[item:${diary.id}|Diary entry 12]]` });

  assert.equal((await call('POST', '/api/v1/shares', reader, { rootId: root.id })).status, 403);
  assert.equal((await call('POST', '/api/v1/shares', writer, { rootId: secretId })).status, 400);
  const headers = { 'Idempotency-Key': 'share-once' };
  const created = await call('POST', '/api/v1/shares', writer, { rootId: root.id, excludedIds: [hidden.id] }, headers);
  assert.equal(created.status, 201);
  const { share, token } = created.data;
  assert.match(token, /^ps_/);
  const retry = await call('POST', '/api/v1/shares', writer, { rootId: root.id, excludedIds: [hidden.id] }, headers);
  assert.equal(retry.status, 409);
  assert.equal(JSON.stringify(retry.data).includes(token), false);
  assert.equal(memory.shares.list().filter((s) => s.rootId === root.id).length, 1);
  assert.equal(JSON.stringify((await call('GET', '/api/v1/shares', writer)).data).includes(token), false);

  const view = await call('GET', `/api/v1/public/${token}`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.items.map((n: { id: string }) => n.id), [root.id, tent.id]);
  assert.equal(view.data.items[0].body, `Bring [[item:${tent.id}|Tent]] and read `);
  const text = JSON.stringify(view.data);
  for (const leaked of ['metadata', 'Spare key spot', 'Under the blue rock', 'Diary', diary.id, secretId, SECRET_LABEL, 'source']) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  memory.items.update(tent.id, { title: 'Two-person tent' });
  assert.equal((await call('GET', `/api/v1/public/${token}`)).data.items[1].title, 'Two-person tent', 'views are live');

  assert.ok((await call('POST', `/api/v1/shares/${share.id}/revoke`, writer)).data.revokedAt);
  const revoked = await call('GET', `/api/v1/public/${token}`);
  const wrong = await call('GET', `/api/v1/public/ps_${'x'.repeat(43)}`);
  assert.deepEqual([revoked.status, wrong.status], [404, 404]);
  assert.equal(revoked.data.error.message, wrong.data.error.message);

  assert.equal((await call('POST', '/api/v1/shares', writer, { rootId: root.id, expiresAt: '2001-01-01T00:00:00Z' })).status, 400);
  const brief = (await call('POST', '/api/v1/shares', writer, { rootId: root.id, expiresAt: new Date(Date.now() + 800).toISOString() })).data;
  assert.equal((await call('GET', `/api/v1/public/${brief.token}`)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await call('GET', `/api/v1/public/${brief.token}`)).status, 404);
});

test('the web root serves the app and share pages without exposing files or the private API', async () => {
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type')!, /text\/html/);
  assert.match(index.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal((await call('GET', '/s/ps_anything')).data, index.data);
  assert.match((await call('GET', '/app.js')).headers.get('content-type')!, /text\/javascript/);
  assert.equal((await call('GET', '/notes.txt')).status, 404);
  assert.equal((await call('GET', '/missing.js')).status, 404);
  for (const path of ['/%2e%2e/outside.html', '/..%2foutside.html', '/s/..%2f..%2foutside.html']) {
    assert.equal(await rawGet(path), 404, path);
  }
  assert.equal((await call('GET', '/api/v1/items')).status, 401);
  assert.equal((await call('GET', '/mcp')).status, 401);

  const allowed = await call('GET', '/api/v1/whoami', reader, undefined, { Origin: 'https://notes.example' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://notes.example');
  for (const origin of ['https://evil.example', 'https://notes.example.evil.example', 'http://notes.example']) {
    assert.equal((await call('GET', '/api/v1/whoami', reader, undefined, { Origin: origin })).status, 403, origin);
  }
});

test('text PATCH with a stale base is a conflict, but an idempotent retry still replays its success', async () => {
  const note = memory.items.saveNote({ title: 'Plan', body: 'draft one' });
  const headers = { 'Idempotency-Key': 'edit-plan-1' };
  const edit = { title: 'Plan A', baseTitle: 'Plan', body: 'draft two', baseBody: 'draft one' };
  assert.equal((await call('PATCH', `/api/v1/items/${note.id}`, writer, edit, headers)).status, 200);
  memory.items.update(note.id, { body: 'edited on desktop' });

  const retry = await call('PATCH', `/api/v1/items/${note.id}`, writer, edit, headers);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.data.body, 'draft two');
  assert.equal(memory.items.get(note.id).body, 'edited on desktop');

  const staleBody = await call('PATCH', `/api/v1/items/${note.id}`, writer, { body: 'draft three', baseBody: 'draft two' });
  assert.equal(staleBody.status, 409);
  assert.equal(staleBody.data.error.code, 'conflict');
  assert.equal((await call('PATCH', `/api/v1/items/${note.id}`, writer, { title: 'Plan B', baseTitle: 'Plan' })).status, 409);
  assert.deepEqual([memory.items.get(note.id).title, memory.items.get(note.id).body], ['Plan A', 'edited on desktop']);
  assert.equal((await call('PATCH', `/api/v1/items/${note.id}`, writer, { body: 'merged', baseBody: 'edited on desktop' })).data.body, 'merged');
});
