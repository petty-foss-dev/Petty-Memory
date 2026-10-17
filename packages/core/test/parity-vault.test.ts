import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MAX_LIMIT, MemoryError, SECRET_LABEL, type SecretEnvelope } from '@enve-memory/core';

const temp = (label: string) => mkdtempSync(join(tmpdir(), `enve-memory-parity-${label}-`));
const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const note = (memory: EnveMemory, title: string, parentId: string | null = null, body?: string) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const everything = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? everything(join(dir, e.name)) : [readFileSync(join(dir, e.name), 'utf8')]));

// Fictional values only.
const PASSPHRASE = 'tangerine harbour lantern';
const SECRET_TITLE = 'Locker combination zq';
const SECRET_BODY = 'fictional code 31-07-52 zq';
const SECRET_BODY_2 = 'fictional code 88-14-09 zq';

/** What a browser or iPhone client does: PBKDF2 over the NFKC passphrase, AES-256-GCM bound to the item id. */
function clientSeal(passphrase: string, salt: Buffer, id: string, plain: { title: string; body: string }): SecretEnvelope {
  const key = pbkdf2Sync(passphrase.normalize('NFKC'), salt, 600_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 }, salt: salt.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

test('the vault locks, refuses a wrong passphrase, and keeps plaintext out of every ordinary path', () => {
  const home = temp('vault');
  const memory = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(memory.vault.state(), { configured: false, unlocked: false });
  assert.throws(() => memory.vault.create({ title: SECRET_TITLE, body: SECRET_BODY }), failsWith('locked'));
  assert.throws(() => memory.vault.setup('short'), failsWith('invalid'));
  assert.deepEqual(memory.vault.setup(PASSPHRASE), { configured: true, unlocked: true });
  assert.throws(() => memory.vault.setup(PASSPHRASE), failsWith('conflict'));

  const secret = memory.vault.create({ title: SECRET_TITLE, body: SECRET_BODY, tags: ['gym'] });
  assert.equal(secret.title, SECRET_LABEL);
  assert.equal(secret.body, '');
  assert.equal(secret.metadata.secret, true);
  const envelope = secret.metadata.vault!;
  assert.deepEqual(envelope.kdf, { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 });
  assert.deepEqual(['salt', 'iv', 'tag'].map((f) => Buffer.from(envelope[f as 'salt'], 'base64').length), [16, 12, 16]);
  assert.deepEqual(memory.vault.read(secret.id), { id: secret.id, title: SECRET_TITLE, body: SECRET_BODY });
  memory.vault.update(secret.id, { title: SECRET_TITLE, body: SECRET_BODY_2 });

  memory.vault.lock();
  assert.throws(() => memory.vault.read(secret.id), failsWith('locked'));
  assert.throws(() => memory.vault.unlock('tangerine harbour lantern!'), failsWith('invalid'));
  assert.equal(memory.vault.state().unlocked, false);
  memory.vault.unlock(PASSPHRASE);
  assert.equal(memory.vault.read(secret.id).body, SECRET_BODY_2);

  assert.throws(() => memory.items.update(secret.id, { body: 'plain text' }), failsWith('invalid'));
  assert.throws(() => memory.outline.createNote({ parentId: secret.id, title: 'child' }), failsWith('invalid'));
  assert.throws(() => memory.edits.scope(secret.id), failsWith('invalid'));
  assert.throws(() => memory.shares.create(secret.id), failsWith('invalid'));
  assert.deepEqual(memory.items.list({ secret: true }).map((i) => [i.id, i.title, i.body]), [[secret.id, SECRET_LABEL, '']]);

  const plaintexts = [SECRET_TITLE, SECRET_BODY, SECRET_BODY_2, PASSPHRASE];
  const leaks = (label: string, text: string) => assert.deepEqual(plaintexts.filter((p) => text.includes(p)), [], label);
  assert.deepEqual(memory.search.query('zq'), []);
  assert.deepEqual(memory.search.query('combination'), []);
  leaks('change log', JSON.stringify(memory.activity.recent({}, MAX_LIMIT)));
  leaks('history', JSON.stringify(memory.versions.list(secret.id).items.map((v) => memory.versions.get(v.id))));
  leaks('sync records', JSON.stringify(memory.sync.exportChanges()));
  const exported = join(temp('vault-export'), 'out');
  memory.exports.write(exported);
  leaks('export', everything(exported).join('\n'));
  memory.close();
  for (const file of ['memory.sqlite', 'memory.sqlite-wal']) {
    const path = join(home, file);
    if (existsSync(path)) leaks(file, readFileSync(path).toString('latin1'));
  }
});

test('client-sealed PBKDF2 notes are stored opaquely while locked and open anywhere with the NFKC-equivalent passphrase', () => {
  const composed = 'Café ﬁeld notes 2026';
  const decomposed = 'Café field notes 2026';
  assert.equal(composed.normalize('NFKC'), decomposed.normalize('NFKC'));
  assert.notEqual(composed, decomposed);

  const host = open();
  host.vault.setup(decomposed);
  host.vault.lock();
  const salt = randomBytes(16);
  const id = uuidv7();
  const first = clientSeal(composed, salt, id, { title: 'Bike lock', body: 'fictional 4-4-1-7' });
  const sealed = host.vault.createSealed({ id, envelope: first, tags: ['bike'] });
  assert.deepEqual([sealed.id, sealed.title, sealed.body, sealed.metadata.secret], [id, SECRET_LABEL, '', true]);
  assert.deepEqual(sealed.metadata.vault, first);
  host.vault.updateSealed(id, { envelope: clientSeal(composed, salt, id, { title: 'Bike lock', body: 'fictional 9-0-2-6' }) });
  assert.deepEqual(host.vault.state(), { configured: true, unlocked: false }, 'opaque writes neither need nor change the host key');

  host.vault.unlock(decomposed);
  assert.deepEqual(host.vault.read(id), { id, title: 'Bike lock', body: 'fictional 9-0-2-6' });

  // Bound to its id: the same ciphertext stored under another id is refused on reading.
  const other = uuidv7();
  host.vault.createSealed({ id: other, envelope: first });
  assert.throws(() => host.vault.read(other), failsWith('invalid', /can’t be opened/));

  const peer = open();
  peer.sync.applyChanges(host.sync.exportChanges().records);
  peer.vault.setup(composed);
  assert.equal(peer.vault.read(id).body, 'fictional 9-0-2-6', 'the envelope carries everything another device needs');

  const fresh = open();
  fresh.sync.applyChanges(host.sync.exportChanges().records);
  assert.throws(() => fresh.vault.setup('wrong but long enough'), failsWith('invalid', /different passphrase/));

  const bad = (patch: object) => ({ ...first, ...patch });
  assert.throws(() => host.vault.createSealed({ id: uuidv7(), envelope: bad({ kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 1000 } }) }), failsWith('invalid'));
  assert.throws(() => host.vault.createSealed({ id: uuidv7(), envelope: bad({ iv: randomBytes(8).toString('base64') }) }), failsWith('invalid'));
  assert.throws(() => host.vault.createSealed({ id: uuidv7(), envelope: bad({ v: 2 }) }), failsWith('invalid'));
  assert.throws(() => host.vault.createSealed({ id: 'not-a-uuid', envelope: first }), failsWith('invalid'));
  assert.throws(() => host.vault.createSealed({ id, envelope: first }), failsWith('conflict'));
  assert.throws(() => host.vault.updateSealed(note(host, 'Plain'), { envelope: first }), failsWith('invalid'));
});

test('a public link shows a live, sanitized subtree and nothing private', () => {
  const memory = open();
  const outside = note(memory, 'Outside private zq');
  const root = note(memory, 'Trip');
  const packing = note(memory, 'Packing', root);
  const { id: socks } = memory.tasks.create({ title: 'Buy socks' });
  memory.outline.move(socks, { parentId: packing });
  memory.tasks.complete(socks);
  const hidden = note(memory, 'Hidden branch', root);
  note(memory, 'Inner hidden plan zq', hidden);
  const secret = uuidv7();
  memory.vault.createSealed({ id: secret, envelope: clientSeal(PASSPHRASE, randomBytes(16), secret, { title: 't', body: 'b' }) });
  memory.outline.move(secret, { parentId: root });
  memory.items.archive(note(memory, 'Archived idea zq', root));
  memory.items.update(root, { title: `Trip [[item:${hidden}|Surprise party zq]]` });
  memory.items.update(packing, {
    body: `See [[item:${hidden}|Surprise party zq]], [[item:${outside}|Outside private zq]] and [[item:${socks}|stale label]].`,
  });

  const { share, token } = memory.shares.create(root, { excludedIds: [hidden] });
  assert.match(token, /^ps_/);
  assert.equal(JSON.stringify(memory.shares.list()).includes(token), false, 'only a hash of the token is kept');
  assert.deepEqual(share.excludedIds, [hidden]);

  const tree = memory.shares.view(token);
  assert.deepEqual(tree.items.map((n) => [n.id, n.parentId]), [[root, null], [packing, root], [socks, packing]]);
  const text = JSON.stringify(tree);
  for (const hiddenText of ['zq', hidden, outside, secret, SECRET_LABEL]) assert.equal(text.includes(hiddenText), false, hiddenText);
  assert.equal(tree.items[1]!.body.includes(`[[item:${socks}|Buy socks]]`), true, 'inside references show current titles');
  const socksNode = tree.items[2]!;
  assert.deepEqual([socksNode.type, socksNode.presentation.checked], ['task', true]);
  assert.deepEqual(Object.keys(socksNode).sort(), ['body', 'id', 'parentId', 'presentation', 'title', 'type']);

  memory.items.update(packing, { title: 'Packing list' });
  assert.equal(memory.shares.view(token).items[1]!.title, 'Packing list');

  assert.throws(() => memory.shares.view('ps_not-a-real-token'), failsWith('not_found'));
  assert.equal(memory.shares.revoke(share.id).revokedAt !== null, true);
  assert.throws(() => memory.shares.view(token), failsWith('not_found'));
});

test('public links expire', (t) => {
  const memory = open();
  const root = note(memory, 'Recipe');
  assert.throws(() => memory.shares.create(root, { expiresAt: new Date(Date.now() - 1000).toISOString() }), failsWith('invalid'));
  const { token } = memory.shares.create(root, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(memory.shares.view(token).title, 'Recipe');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  assert.throws(() => memory.shares.view(token), failsWith('not_found'));
});
