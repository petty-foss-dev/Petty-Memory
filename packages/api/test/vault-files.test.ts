import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { EnveMemory, MAX_SEALED_FILE_BYTES, type SecretEnvelope } from '@enve-memory/core';

const fixture = JSON.parse(readFileSync(new URL('../../core/test/fixtures/vault-closeout-v1.json', import.meta.url), 'utf8'));

test('encrypted file routes work with a locked host, enforce scope, and restore retained ciphertext', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-vault-api-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  const api = createApiServer(memory, { port: 0, version: 'test' });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); rmSync(home, { recursive: true, force: true }); });
  const writer = memory.clients.create('ordinary', ['read', 'write']).token;
  const secret = memory.clients.create('vault', ['read', 'secrets']).token;
  const call = async (method: string, path: string, token = secret, body?: unknown) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const note = fixture.note;
  assert.equal((await call('POST', '/vault/sealed-items', secret, { id: note.id, envelope: note.envelope })).status, 201);
  const path = `/vault/items/${note.id}/attachments/${fixture.file.attachmentId}`;
  assert.equal((await call('PUT', path, writer, fixture.file.envelope)).status, 403);
  const attached = await call('PUT', path, secret, fixture.file.envelope);
  assert.equal(attached.status, 201, JSON.stringify(attached.data));
  assert.equal((await call('GET', path, writer)).status, 403);
  assert.deepEqual((await call('GET', path)).data, fixture.file.envelope);
  assert.equal(memory.vault.state().unlocked, false);
  const version = memory.versions.list(note.id).items[0]!;
  assert.equal((await call('DELETE', path)).status, 200);
  assert.equal((await call('GET', path)).status, 404);
  assert.equal((await call('POST', `/versions/${version.id}/restore`, writer)).status, 400);
  assert.equal((await call('POST', `/vault/versions/${version.id}/restore`, writer)).status, 403);
  assert.equal((await call('POST', `/vault/versions/${version.id}/restore`)).status, 200);
  assert.deepEqual((await call('GET', path)).data, fixture.file.envelope);
  memory.vault.setup(fixture.passphrase);
  assert.equal((await call('GET', `/vault/items/${note.id}`)).status, 403, 'HTTP never borrows the host unlocked key');
  assert.deepEqual(Buffer.from(memory.vault.readFile(note.id, fixture.file.attachmentId).data), Buffer.from(fixture.file.dataBase64, 'base64'));
  assert.ok(!JSON.stringify((await call('GET', `/items/${note.id}`, writer)).data).includes(fixture.file.filename));
  assert.equal((await call('GET', `/items/${note.id}/file`, writer)).status, 403);
});

test('a maximum-size client-encrypted file crosses HTTP intact and excessive wire bodies are refused', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-vault-limit-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  const api = createApiServer(memory, { port: 0, version: 'test' });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); rmSync(home, { recursive: true, force: true }); });
  const token = memory.clients.create('vault', ['secrets']).token;
  memory.vault.createSealed({ id: fixture.note.id, envelope: fixture.note.envelope });
  const meta = Buffer.from(JSON.stringify({ filename: 'boundary.bin', mimeType: 'application/octet-stream' }));
  const frame = Buffer.alloc(9 + meta.length + MAX_SEALED_FILE_BYTES, 0x5a);
  frame.write('PMVF1', 0, 'ascii');
  frame.writeUInt32BE(meta.length, 5);
  meta.copy(frame, 9);
  const key = pbkdf2Sync(fixture.passphrase.normalize('NFKC'), Buffer.from(fixture.note.envelope.salt, 'base64'), 600_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(fixture.file.aad));
  const encrypted = Buffer.concat([cipher.update(frame), cipher.final()]);
  key.fill(0);
  frame.fill(0);
  const envelope: SecretEnvelope = {
    ...fixture.file.envelope, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
  };
  const path = `${base}/api/v1/vault/items/${fixture.note.id}/attachments/${fixture.file.attachmentId}`;
  const response = await fetch(path, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
  });
  assert.equal(response.status, 201, await response.clone().text());
  await response.body?.cancel();
  memory.vault.setup(fixture.passphrase);
  const file = memory.vault.readFile(fixture.note.id, fixture.file.attachmentId);
  assert.equal(file.data.byteLength, MAX_SEALED_FILE_BYTES);
  assert.ok(file.data.every((byte) => byte === 0x5a));
  const rejected = await new Promise<number>((resolve, reject) => {
    const req = request(path, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 40 * 1024 * 1024 },
    }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rejected, 413);
});
