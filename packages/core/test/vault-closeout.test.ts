import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EnveMemory, MAX_LIMIT, MemoryError, SEALED_FILE_MIME, SEALED_FILE_NAME, SECRET_LABEL, type ItemState, type SecretEnvelope,
  type SyncRecord,
} from '@enve-memory/core';

interface Fixture {
  passphrase: string;
  note: { id: string; envelope: SecretEnvelope; plaintext: { title: string; body: string } };
  file: {
    itemId: string; attachmentId: string; aad: string; envelope: SecretEnvelope; storedBlobSha256: string; storedBlobSize: number;
    filename: string; mimeType: string; metadataLength: number; dataBase64: string; dataSha256: string;
  };
  recovery: { aad: string; kit: Record<string, unknown>; code: string };
}

/** Fixed bytes generated once from the written contract; the iPhone and browser clients open the same file. */
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/vault-closeout-v1.json', import.meta.url), 'utf8')) as Fixture;

// Fictional values only.
const PASSPHRASE = 'tangerine harbour lantern';
const FILE_MARKER = 'ledger-marker-zq';
const NAME_MARKER = 'Payroll ledger zq-marker.csv';

const temp = (label: string) => mkdtempSync(join(tmpdir(), `petty-vault-closeout-${label}-`));
const onDisk = (label = 'library') => EnveMemory.open({ home: temp(label), actor: 'test' });
const inMemory = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const fileAad = (itemId: string, attachmentId: string) => `petty-memory:file:v1:${itemId}:${attachmentId}`;
const everything = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? everything(join(dir, e.name)) : [readFileSync(join(dir, e.name)).toString('latin1')]));

const keys = new Map<string, Buffer>();
/** What a browser or iPhone does: PBKDF2-SHA256 over the NFKC passphrase. Cached, as clients cache in RAM. */
function clientKey(passphrase: string, salt: Buffer): Buffer {
  const id = `${passphrase}:${salt.toString('base64')}`;
  if (!keys.has(id)) keys.set(id, pbkdf2Sync(passphrase.normalize('NFKC'), salt, 600_000, 32, 'sha256'));
  return keys.get(id)!;
}

function clientSeal(key: Buffer, salt: Buffer, plain: Buffer, aad: string): SecretEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 }, salt: salt.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

function clientOpen(key: Buffer, sealed: { iv: string; tag: string; data: string }, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

function frame(meta: object, data: Buffer, magic = 'PMVF1'): Buffer {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.alloc(9);
  header.write(magic, 0, 'ascii');
  header.writeUInt32BE(json.length, 5);
  return Buffer.concat([header, json, data]);
}

const sealNote = (salt: Buffer, id: string, plain: { title: string; body: string }) =>
  clientSeal(clientKey(PASSPHRASE, salt), salt, Buffer.from(JSON.stringify(plain)), id);
const sealFile = (salt: Buffer, itemId: string, attachmentId: string, data: Buffer, meta: object = { filename: 'scan.pdf', mimeType: 'application/pdf' }) =>
  clientSeal(clientKey(PASSPHRASE, salt), salt, frame(meta, data), fileAad(itemId, attachmentId));

/** A well-formed envelope nobody can open; enough for boundary checks that never decrypt. */
const opaqueEnvelope = (): SecretEnvelope => ({
  v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 }, salt: randomBytes(16).toString('base64'),
  iv: randomBytes(12).toString('base64'), tag: randomBytes(16).toString('base64'), data: randomBytes(40).toString('base64'),
});

const stamp = (device: string, ms = 0) => `${new Date(Date.now() + ms).toISOString()}-000000-${device}`;
const itemRecord = (memory: EnveMemory, id: string) =>
  memory.sync.exportChanges().records.find((r): r is SyncRecord & { state: ItemState } => r.entity === 'item' && r.id === id)!;

test('the fixed fixture opens through core and matches the written frame and kit layout', () => {
  const f = FIXTURE;
  const salt = Buffer.from(f.file.envelope.salt, 'base64');
  const plain = clientOpen(clientKey(f.passphrase, salt), f.file.envelope, f.file.aad);
  assert.equal(plain.subarray(0, 5).toString('ascii'), 'PMVF1');
  assert.equal(plain.readUInt32BE(5), f.file.metadataLength);
  assert.deepEqual(JSON.parse(plain.subarray(9, 9 + f.file.metadataLength).toString('utf8')), { filename: f.file.filename, mimeType: f.file.mimeType });
  assert.equal(plain.subarray(9 + f.file.metadataLength).toString('base64'), f.file.dataBase64);
  assert.equal(f.file.aad, fileAad(f.file.itemId, f.file.attachmentId));

  const memory = onDisk('fixture');
  try {
    memory.vault.createSealed({ id: f.note.id, envelope: f.note.envelope });
    const attachment = memory.vault.attachSealed(f.file.itemId, f.file.attachmentId, f.file.envelope);
    assert.deepEqual(
      [attachment.id, attachment.filename, attachment.mimeType, attachment.sha256, attachment.size],
      [f.file.attachmentId, SEALED_FILE_NAME, SEALED_FILE_MIME, f.file.storedBlobSha256, f.file.storedBlobSize],
      'the stored blob is exactly the UTF-8 JSON of the envelope',
    );
    assert.deepEqual(memory.vault.sealedAttachment(f.file.itemId, f.file.attachmentId), f.file.envelope);
    assert.deepEqual(memory.vault.state(), { configured: false, unlocked: false }, 'sealed writes need no host key');

    assert.deepEqual(memory.vault.setup(f.passphrase), { configured: true, unlocked: true });
    assert.deepEqual(memory.vault.read(f.note.id), { id: f.note.id, ...f.note.plaintext });
    const opened = memory.vault.readFile(f.file.itemId, f.file.attachmentId);
    assert.deepEqual([opened.filename, opened.mimeType], [f.file.filename, f.file.mimeType]);
    assert.equal(createHash('sha256').update(opened.data).digest('hex'), f.file.dataSha256);

    memory.vault.lock();
    assert.deepEqual(memory.vault.recover(f.recovery.kit, f.recovery.code), { configured: true, unlocked: true });
    const fresh = inMemory();
    fresh.sync.applyChanges(memory.sync.exportChanges().records);
    assert.deepEqual(fresh.vault.recover(f.recovery.kit, f.recovery.code), { configured: true, unlocked: true }, 'a kit joins a library that only has the notes');
    assert.equal(fresh.vault.read(f.note.id).body, f.note.plaintext.body);
  } finally {
    memory.close();
  }
});

test('host-encrypted attachments round-trip binary bytes and keep names, types and bytes out of ordinary paths', () => {
  const home = temp('host-files');
  const memory = EnveMemory.open({ home, actor: 'test' });
  memory.vault.setup(PASSPHRASE);
  const secret = memory.vault.create({ title: 'Payroll', body: 'fictional' });
  const data = Buffer.concat([randomBytes(4096), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from(FILE_MARKER)]);
  const attachment = memory.vault.attachFile(secret.id, { data, filename: NAME_MARKER, mimeType: 'Text/CSV; charset=utf-8' });
  assert.deepEqual([attachment.filename, attachment.mimeType], [SEALED_FILE_NAME, SEALED_FILE_MIME]);
  assert.deepEqual(memory.items.get(secret.id).attachments.map((a) => a.id), [attachment.id]);
  const opened = memory.vault.readFile(secret.id, attachment.id);
  assert.deepEqual([opened.filename, opened.mimeType, Buffer.from(opened.data).equals(data)], [NAME_MARKER, 'text/csv', true]);

  // The wire layout, checked independently of core.
  const envelope = memory.vault.sealedAttachment(secret.id, attachment.id);
  const plain = clientOpen(clientKey(PASSPHRASE, Buffer.from(envelope.salt, 'base64')), envelope, fileAad(secret.id, attachment.id));
  assert.equal(plain.subarray(0, 5).toString('ascii'), 'PMVF1');
  assert.deepEqual(JSON.parse(plain.subarray(9, 9 + plain.readUInt32BE(5)).toString()), { filename: NAME_MARKER, mimeType: 'text/csv' });

  // Bound to its item and attachment id: the same ciphertext elsewhere doesn't open.
  const moved = uuidv7();
  memory.vault.attachSealed(secret.id, moved, envelope);
  assert.throws(() => memory.vault.readFile(secret.id, moved), failsWith('invalid', /can’t be opened/));
  const other = memory.vault.create({ title: 'Other', body: 'x' });
  memory.vault.attachSealed(other.id, uuidv7(), envelope);
  assert.throws(() => memory.vault.readFile(other.id, memory.items.get(other.id).attachments[0]!.id), failsWith('invalid'));

  const ordinary = memory.items.saveNote({ body: 'plain' });
  assert.throws(() => memory.vault.attachSealed(ordinary.id, uuidv7(), envelope), failsWith('invalid', /isn’t a secret note/));
  assert.throws(() => memory.vault.attachSealed(secret.id, 'not-an-id', envelope), failsWith('invalid'));
  assert.throws(() => memory.vault.attachFile(secret.id, { data, filename: '../escape.csv' }), failsWith('invalid'));
  assert.throws(() => memory.vault.attachFile(secret.id, { data: new Uint8Array(0), filename: 'empty.bin' }), failsWith('invalid'));
  assert.throws(() => memory.vault.attachFile(secret.id, { data: new Uint8Array(20 * 1024 * 1024 + 1), filename: 'big.bin' }), failsWith('invalid', /20 MiB/));
  assert.throws(() => memory.vault.attachFile(secret.id, { data, filename: 'x.bin', mimeType: 'text/html<script>' }), failsWith('invalid'));

  memory.vault.lock();
  assert.throws(() => memory.vault.readFile(secret.id, attachment.id), failsWith('locked'));
  assert.throws(() => memory.vault.attachFile(secret.id, { data, filename: 'late.bin' }), failsWith('locked'));
  assert.deepEqual(memory.vault.sealedAttachment(secret.id, attachment.id), envelope, 'the opaque route works while locked');

  const leaks = (label: string, text: string) =>
    assert.deepEqual([NAME_MARKER, FILE_MARKER, 'text/csv', PASSPHRASE].filter((p) => text.includes(p)), [], label);
  leaks('activity', JSON.stringify(memory.activity.recent({}, MAX_LIMIT)));
  leaks('history', JSON.stringify(memory.versions.list(secret.id).items.map((v) => memory.versions.get(v.id))));
  leaks('sync records', JSON.stringify(memory.sync.exportChanges()));
  leaks('feed', JSON.stringify(memory.feed.page()));
  const exported = join(temp('host-files-export'), 'out');
  memory.exports.write(exported);
  leaks('export', everything(exported).join('\n'));
  memory.close();
  leaks('library folder', everything(home).join('\n'));
});

test('sealed uploads are idempotent, conflicting ids are refused, and removal is recoverable with its bytes', () => {
  const memory = onDisk('sealed-files');
  try {
    memory.vault.setup(PASSPHRASE);
    memory.vault.lock();
    const salt = randomBytes(16);
    const id = uuidv7();
    memory.vault.createSealed({ id, envelope: sealNote(salt, id, { title: 'Scans', body: 'fictional' }) });
    const attachmentId = uuidv7();
    const bytes = randomBytes(2048);
    const envelope = sealFile(salt, id, attachmentId, bytes);
    const first = memory.vault.attachSealed(id, attachmentId, envelope);
    assert.deepEqual(memory.vault.attachSealed(id, attachmentId, structuredClone(envelope)), first, 'a retried upload returns the stored row');
    assert.equal(memory.items.get(id).attachments.length, 1);
    assert.throws(() => memory.vault.attachSealed(id, attachmentId, sealFile(salt, id, attachmentId, bytes)), failsWith('conflict'));
    const sibling = uuidv7();
    memory.vault.createSealed({ id: sibling, envelope: sealNote(salt, sibling, { title: 'Other', body: 'x' }) });
    assert.throws(() => memory.vault.attachSealed(sibling, attachmentId, envelope), failsWith('conflict'));
    assert.throws(() => memory.vault.attachSealed(id, uuidv7(), { ...envelope, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 50_000_000 } }), failsWith('invalid'));
    assert.throws(() => memory.vault.attachSealed(id, uuidv7(), { ...envelope, iv: randomBytes(16).toString('base64') }), failsWith('invalid'));
    assert.throws(() => memory.vault.attachSealed(id, uuidv7(), { ...envelope, data: 'A'.repeat(28_000_000) }), failsWith('invalid'));

    const live = join(memory.paths!.attachments, first.sha256.slice(0, 2), first.sha256);
    assert.deepEqual(memory.vault.removeFile(id, attachmentId), { removed: true });
    assert.deepEqual(memory.vault.removeFile(id, attachmentId), { removed: false });
    assert.deepEqual(memory.items.get(id).attachments, []);
    assert.equal(existsSync(live), false);
    assert.equal(existsSync(join(memory.paths!.attachments, '.trash', first.sha256)), true, 'bytes wait in the trash for history');

    const versions = memory.versions.list(id).items.map((v) => memory.versions.get(v.id));
    const before = versions.find((v) => v.snapshot.items[0]!.item.attachments.length === 1)!;
    assert.throws(() => memory.versions.restore(before.id), failsWith('invalid', /through the vault/));
    assert.deepEqual(memory.vault.restoreVersion(before.id), { restored: 1 });
    assert.deepEqual(memory.items.get(id).attachments.map((a) => a.id), [attachmentId]);
    assert.equal(existsSync(live), true);
    memory.vault.unlock(PASSPHRASE);
    assert.equal(Buffer.from(memory.vault.readFile(id, attachmentId).data).equals(bytes), true);

    const badMagic = uuidv7();
    memory.vault.attachSealed(id, badMagic, clientSeal(clientKey(PASSPHRASE, salt), salt, frame({ filename: 'a', mimeType: 'a/b' }, bytes, 'XXXX1'), fileAad(id, badMagic)));
    assert.throws(() => memory.vault.readFile(id, badMagic), failsWith('invalid', /damaged/));
    const badName = uuidv7();
    memory.vault.attachSealed(id, badName, sealFile(salt, id, badName, bytes, { filename: '../../escape', mimeType: 'text/plain' }));
    assert.throws(() => memory.vault.readFile(id, badName), failsWith('invalid'));
  } finally {
    memory.close();
  }
});

test('ordinary restores never roll back secret envelopes, and vault restores never write plaintext into a secret row', () => {
  const memory = inMemory();
  memory.vault.setup(PASSPHRASE);
  const parent = memory.outline.createNote({ parentId: null, title: 'Trip' }).item.id;
  const secret = memory.vault.create({ title: 'Passport', body: 'fictional one', parentId: parent });
  const parentVersion = memory.versions.list(parent).items[0]!.id;
  const secretVersion = memory.versions.list(secret.id).items[0]!.id;
  memory.vault.update(secret.id, { title: 'Passport', body: 'fictional two' });
  memory.items.update(parent, { title: 'Trip 2026' });

  assert.deepEqual(memory.versions.restore(parentVersion), { restored: 1 }, 'the secret child is left as it is');
  assert.equal(memory.items.get(parent).title, 'Trip');
  assert.equal(memory.vault.read(secret.id).body, 'fictional two');
  assert.throws(() => memory.versions.restore(secretVersion), failsWith('invalid', /through the vault/));
  assert.throws(() => memory.vault.restoreVersion(parentVersion), failsWith('invalid'));
  assert.deepEqual(memory.vault.restoreVersion(secretVersion), { restored: 1 });
  assert.equal(memory.vault.read(secret.id).body, 'fictional one');

  // An ordinary note that another device turned secret: its plaintext history can't be restored into it either way.
  const plain = memory.items.saveNote({ title: 'Was ordinary', body: 'readable text' });
  const plainVersion = memory.versions.list(plain.id).items[0]!.id;
  const record = itemRecord(memory, plain.id);
  const device = uuidv7();
  const state = structuredClone(record.state);
  Object.assign(state.item, { title: SECRET_LABEL, body: '', metadata: JSON.stringify({ secret: true, vault: opaqueEnvelope() }) });
  assert.equal(memory.sync.applyChanges([{ ...record, device, hlc: stamp(device, 1000), base: record.hlc, state }]).imported, 1);
  assert.throws(() => memory.versions.restore(plainVersion), failsWith('invalid'));
  assert.throws(() => memory.vault.restoreVersion(plainVersion), failsWith('invalid'));
  assert.equal(memory.items.get(plain.id).body, '');
});

test('secret notes hold only secret notes through create, move, sync and pending parents', () => {
  const memory = inMemory();
  memory.vault.setup(PASSPHRASE);
  const top = memory.vault.create({ title: 'Accounts', body: 'x' });
  const child = memory.vault.create({ title: 'Bank', body: 'x', parentId: top.id });
  const salt = randomBytes(16);
  const sealedId = uuidv7();
  memory.vault.createSealed({ id: sealedId, envelope: sealNote(salt, sealedId, { title: 'Card', body: 'x' }), parentId: child.id });
  assert.deepEqual(memory.outline.children(top.id).items.map((e) => e.item.id), [child.id]);
  assert.deepEqual(memory.outline.children(child.id).items.map((e) => e.item.id), [sealedId]);

  assert.throws(() => memory.outline.createNote({ parentId: top.id, title: 'Plain child' }), failsWith('invalid', /only other secret notes/));
  const ordinary = memory.items.saveNote({ body: 'Plain' }).id;
  assert.throws(() => memory.outline.move(ordinary, { parentId: top.id }), failsWith('invalid', /only other secret notes/));
  const task = memory.tasks.create({ title: 'Renew card' }).id;
  assert.throws(() => memory.outline.move(task, { parentId: child.id }), failsWith('invalid', /only other secret notes/));
  assert.throws(() => memory.vault.create({ title: 'x', body: 'y', parentId: uuidv7() }), failsWith('not_found'));
  const loose = memory.vault.create({ title: 'Loose', body: 'x' });
  memory.outline.move(loose.id, { parentId: child.id, beforeId: sealedId });
  assert.deepEqual(memory.outline.children(child.id).items.map((e) => e.item.id), [loose.id, sealedId]);
  assert.throws(() => memory.outline.move(top.id, { parentId: child.id }), failsWith('invalid', /under itself/));
  memory.outline.move(top.id, { parentId: ordinary });
  assert.equal(memory.outline.get(top.id).parentId, ordinary, 'an ordinary parent may hold a secret branch');

  // Children whose records arrive before their secret parent still nest once it lands.
  const records = memory.sync.exportChanges().records;
  const peer = inMemory();
  peer.sync.applyChanges(records.filter((r) => r.id !== child.id));
  assert.equal(peer.outline.get(sealedId).parentId, null);
  peer.sync.applyChanges(records.filter((r) => r.id === child.id));
  assert.deepEqual(peer.outline.children(child.id).items.map((e) => e.item.id), [loose.id, sealedId]);
  assert.equal(peer.outline.get(top.id).parentId, ordinary);

  // An ordinary record claiming a secret parent lands at the top level instead.
  const device = uuidv7();
  const record = itemRecord(memory, ordinary);
  const claim = { ...record, device, hlc: stamp(device, 1000), base: record.hlc, state: structuredClone(record.state) };
  claim.state.item.parent_id = child.id;
  assert.equal(peer.sync.applyChanges([claim]).imported, 1);
  assert.equal(peer.outline.get(ordinary).parentId, null);

  // A secret note can't turn back into readable text through sync.
  const unseal = { ...itemRecord(memory, child.id), device, hlc: stamp(device, 2000) };
  unseal.state = structuredClone(unseal.state);
  unseal.state.item.metadata = '{}';
  assert.equal(peer.sync.applyChanges([unseal]).rejected, 1);
});

test('an item that arrives secret hands its ordinary children to its nearest ordinary ancestor', () => {
  const memory = inMemory();
  const outer = memory.outline.createNote({ parentId: null, title: 'Outer' }).item.id;
  const parent = memory.outline.createNote({ parentId: outer, title: 'Becomes secret' }).item.id;
  const first = memory.outline.createNote({ parentId: parent, title: 'First' }).item.id;
  const second = memory.outline.createNote({ parentId: parent, title: 'Second' }).item.id;
  const salt = randomBytes(16);
  const secretChild = uuidv7();
  memory.vault.createSealed({ id: secretChild, envelope: sealNote(salt, secretChild, { title: 's', body: 'x' }), parentId: parent });
  const record = itemRecord(memory, parent);
  const device = uuidv7();
  const state = structuredClone(record.state);
  Object.assign(state.item, { title: SECRET_LABEL, body: '', metadata: JSON.stringify({ secret: true, vault: opaqueEnvelope() }) });
  assert.equal(memory.sync.applyChanges([{ ...record, device, hlc: stamp(device, 1000), base: record.hlc, state }]).imported, 1);
  assert.deepEqual(memory.outline.children(outer).items.map((e) => e.item.id), [first, second, parent]);
  assert.deepEqual(memory.outline.children(parent).items.map((e) => e.item.id), [secretChild]);
});

test('the sync boundary refuses malformed metadata, tasks, envelopes and states without blocking later records', () => {
  const a = inMemory();
  a.projects.create({ name: 'Garage' });
  const note = a.items.saveNote({ body: 'Ordinary', project: 'garage' });
  const task = a.tasks.create({ title: 'Order relays' });
  const other = a.items.saveNote({ body: 'Other' });
  a.items.relate(note.id, other.id, 'related_to');
  const salt = randomBytes(16);
  const secretId = uuidv7();
  a.vault.createSealed({ id: secretId, envelope: sealNote(salt, secretId, { title: 't', body: 'b' }) });
  const records = a.sync.exportChanges().records;
  const device = uuidv7();
  let tick = 0;
  const variant = (sourceId: string, patch: (state: ItemState) => void): SyncRecord => {
    const source = records.find((r) => r.id === sourceId)! as SyncRecord & { state: ItemState };
    const id = uuidv7();
    const state = structuredClone(source.state);
    state.item.id = id;
    patch(state);
    return { ...source, id, device, base: null, hlc: stamp(device, -10_000 + tick++), state };
  };
  const meta = (value: unknown) => (state: ItemState) => { state.item.metadata = typeof value === 'string' ? value : JSON.stringify(value); };
  const project = records.find((r) => r.entity === 'project')!;
  const relation = records.find((r) => r.entity === 'relation')!;
  const bad: SyncRecord[] = [
    ...['null', '[]', '7', '"text"', 'not json'].map((m) => variant(note.id, meta(m))),
    variant(note.id, meta({ secret: 1 })),
    variant(note.id, meta({ vault: opaqueEnvelope() })),
    variant(note.id, meta({ presentation: 'heading' })),
    variant(note.id, meta({ presentation: { kind: 'banner' } })),
    variant(note.id, meta({ ai: [] })),
    variant(secretId, (s) => { s.item.title = 'Visible secret title'; }),
    variant(secretId, meta({ secret: true, vault: { ...opaqueEnvelope(), kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 900_000_000 } } })),
    variant(secretId, meta({ secret: true, vault: { ...opaqueEnvelope(), kdf: { name: 'scrypt', N: 2 ** 30, r: 8, p: 1 } } })),
    variant(secretId, meta({ secret: true, vault: { ...opaqueEnvelope(), v: 2 } })),
    variant(secretId, (s) => { s.attachments = [{ id: uuidv7(), sha256: 'a'.repeat(64), filename: NAME_MARKER, mime_type: 'text/csv', size: 1, created_at: s.item.created_at! }]; }),
    variant(note.id, (s) => { s.task = { status: 'open', priority: 2, due_at: null, completed_at: null }; }),
    variant(task.id, (s) => { s.task = null; }),
    variant(task.id, (s) => { s.task = { ...s.task!, status: 'later' }; }),
    variant(task.id, (s) => { s.task = { ...s.task!, priority: 9 }; }),
    variant(task.id, (s) => { s.task = { ...s.task!, status: 'open', completed_at: new Date().toISOString() }; }),
    variant(note.id, (s) => { s.item.intent = 'steal'; }),
    variant(note.id, (s) => { s.item.archived_at = 5; }),
    { ...project, id: 'p-bad', device, hlc: stamp(device, -500), state: { ...(project.state as object), id: 'p-bad', status: 'gone' } },
    { ...project, id: 'p-bad2', device, hlc: stamp(device, -499), state: { ...(project.state as object), id: 'p-bad2', slug: 'garage-2', memory: null } },
    { ...relation, id: 'r-bad', device, hlc: stamp(device, -498), state: { ...(relation.state as object), id: 'r-bad', to_id: note.id, from_id: note.id } },
  ];
  const good = variant(note.id, () => undefined);

  const b = inMemory();
  b.sync.applyChanges(records);
  const result = b.sync.applyChanges([...bad, 42, good]);
  assert.deepEqual([result.imported, result.rejected, result.rejectedRecords], [1, bad.length + 1, undefined], 'an unnamed record omits the list');
  assert.equal(b.items.get(good.id).body, 'Ordinary');
  const named = b.sync.applyChanges(bad);
  assert.deepEqual(named.rejectedRecords, bad.map((r) => ({ entity: r.entity, id: r.id, hlc: r.hlc })));
  assert.doesNotThrow(() => [b.feed.page(), b.items.list({}, MAX_LIMIT), b.outline.children(null), b.projects.list()]);
});

test('far-future clock stamps are deferred rather than applied, and folder sync reads their segment again', (t) => {
  const a = inMemory();
  const b = inMemory();
  const note = a.items.saveNote({ body: 'Now' });
  const record = itemRecord(a, note.id);
  const ahead = { ...record, hlc: stamp(a.deviceId, 3_600_000) };
  const result = b.sync.applyChanges([ahead]);
  assert.deepEqual(result, { imported: 0, conflicts: 0, rejected: 1, deferred: 1, rejectedRecords: [{ entity: 'item', id: note.id, hlc: ahead.hlc }] });
  assert.throws(() => b.items.get(note.id), failsWith('not_found'));
  assert.deepEqual(b.sync.applyChanges([record]), { imported: 1, conflicts: 0, rejected: 0 });

  const folder = temp('folder');
  const x = onDisk('device-x');
  const y = onDisk('device-y');
  try {
    x.items.saveNote({ body: 'Before' });
    x.sync.run(folder);
    y.sync.run(folder);
    const futureNote = x.items.saveNote({ body: 'From the future' });
    const presentNote = x.items.saveNote({ body: 'From the present' });
    const future = { ...itemRecord(x, futureNote.id), hlc: stamp(x.deviceId, 3_600_000) };
    const present = itemRecord(x, presentNote.id);
    const dir = join(folder, 'devices', x.deviceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '000000099999.ndjson'), `${[future, present].map((r) => JSON.stringify(r)).join('\n')}\n`);

    const first = y.sync.run(folder);
    assert.deepEqual([first.deferred, first.rejected], [1, 1]);
    assert.equal(y.items.get(presentNote.id).body, 'From the present');
    assert.throws(() => y.items.get(futureNote.id), failsWith('not_found'));
    assert.equal(y.sync.run(folder).deferred, 1, 'the segment is read again rather than skipped');

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 3_600_000 });
    const later = y.sync.run(folder);
    assert.equal(later.deferred, undefined);
    assert.equal(y.items.get(futureNote.id).body, 'From the future');
    assert.equal(y.sync.run(folder).deferred, undefined);
  } finally {
    x.close();
    y.close();
  }
});

test('file bytes move only after sync commits, and a file moved between items in one batch stays live', () => {
  const a = onDisk('blob-a');
  const b = onDisk('blob-b');
  try {
    const data = randomBytes(512);
    const { item } = a.files.save({ data, filename: 'scan.bin' });
    const sha = item.attachments[0]!.sha256;
    b.sync.applyChanges(a.sync.exportChanges().records);
    b.sync.writeBlob(sha, data);
    const device = uuidv7();
    const source = itemRecord(a, item.id);
    const emptied = { ...source, device, base: source.hlc, hlc: stamp(device, 1000), state: { ...structuredClone(source.state), attachments: [] } };
    const holderId = uuidv7();
    const holderState = structuredClone(source.state);
    holderState.item.id = holderId;
    holderState.attachments = [{ ...holderState.attachments[0]!, id: uuidv7() }];
    const holder = { ...source, id: holderId, device, base: null, hlc: stamp(device, 2000), state: holderState };
    assert.equal(b.sync.applyChanges([emptied, holder]).imported, 2);
    assert.equal(b.sync.blobStatus(sha), 'stored', 'the bytes were never parked in the trash while a row still needed them');

    const released = { ...holder, base: holder.hlc, hlc: stamp(device, 3000), state: { ...structuredClone(holderState), attachments: [] } };
    assert.equal(b.sync.applyChanges([released]).imported, 1);
    assert.equal(b.sync.blobStatus(sha), 'unreferenced');
    assert.equal(existsSync(join(b.paths!.attachments, '.trash', sha)), true);
    assert.equal(b.sync.readBlob(sha).equals(data), true, 'history still owns the bytes, so peers can fetch them');
  } finally {
    a.close();
    b.close();
  }
});

test('bytes retained by item history reach a device that restores an older version', () => {
  const a = onDisk('history-a');
  const b = onDisk('history-b');
  try {
    a.vault.setup(PASSPHRASE);
    const secret = a.vault.create({ title: 'Deeds', body: 'fictional' });
    const data = randomBytes(1024);
    const attachment = a.vault.attachFile(secret.id, { data, filename: 'deed.pdf' });
    b.sync.applyChanges(a.sync.exportChanges().records);
    const cursor = a.sync.exportChanges().nextCursor;
    a.vault.removeFile(secret.id, attachment.id);
    b.sync.applyChanges(a.sync.exportChanges(cursor).records);
    assert.deepEqual(b.items.get(secret.id).attachments, []);

    const versions = b.versions.list(secret.id).items.map((v) => b.versions.get(v.id));
    const before = versions.find((v) => v.snapshot.items[0]!.item.attachments.length === 1)!;
    assert.deepEqual(b.vault.restoreVersion(before.id).missingFiles, [
      { itemId: secret.id, attachmentId: attachment.id, sha256: attachment.sha256, filename: SEALED_FILE_NAME },
    ]);
    assert.equal(b.sync.blobStatus(attachment.sha256), 'missing');
    b.sync.writeBlob(attachment.sha256, a.sync.readBlob(attachment.sha256));
    b.vault.setup(PASSPHRASE);
    assert.equal(Buffer.from(b.vault.readFile(secret.id, attachment.id).data).equals(data), true);

    assert.throws(() => a.sync.readBlob('f'.repeat(64)), failsWith('not_found'));
    const stray = createHash('sha256').update('stray').digest('hex');
    writeFileSync(join(a.paths!.attachments, '.trash', stray), 'stray');
    assert.throws(() => a.sync.readBlob(stray), failsWith('not_found'), 'a hash guess isn’t library membership');
  } finally {
    a.close();
    b.close();
  }
});

test('a recovery kit and its code unlock or join a vault, and failures change nothing', () => {
  const home = temp('recovery');
  const memory = EnveMemory.open({ home, actor: 'test' });
  assert.throws(() => memory.vault.recoveryKit(), failsWith('locked'));
  memory.vault.setup(PASSPHRASE);
  const secret = memory.vault.create({ title: 'Will', body: 'fictional' });
  memory.vault.lock();
  assert.throws(() => memory.vault.recoveryKit(), failsWith('locked'));
  memory.vault.unlock(PASSPHRASE);
  const { kit, code } = memory.vault.recoveryKit();
  assert.deepEqual(Object.keys(kit), ['v', 'kind', 'iv', 'tag', 'data']);
  assert.deepEqual([kit.v, kit.kind, Buffer.from(kit.iv, 'base64').length, Buffer.from(kit.tag, 'base64').length], [1, 'petty-memory-vault-recovery', 12, 16]);
  assert.match(code, /^pmr1_[A-Za-z0-9_-]{43}$/);
  const opened = clientOpen(Buffer.from(code.slice(5), 'base64url'), kit, 'petty-memory:recovery:v1');
  assert.deepEqual(JSON.parse(opened.toString('utf8')), { passphrase: PASSPHRASE.normalize('NFKC') });
  assert.notEqual(memory.vault.recoveryKit().code, code, 'every kit gets a fresh code');

  memory.vault.lock();
  const otherCode = `pmr1_${randomBytes(32).toString('base64url')}`;
  assert.throws(() => memory.vault.recover(kit, otherCode), failsWith('invalid', /doesn’t open this recovery kit/));
  assert.throws(() => memory.vault.recover(kit, code.slice(0, -1)), failsWith('invalid', /pmr1_/));
  assert.throws(() => memory.vault.recover(kit, `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`), failsWith('invalid'));
  assert.throws(() => memory.vault.recover({ ...kit, kind: 'something-else' }, code), failsWith('invalid'));
  assert.throws(() => memory.vault.recover({ ...kit, data: randomBytes(48).toString('base64') }, code), failsWith('invalid'));
  assert.throws(() => memory.vault.recover(null, code), failsWith('invalid'));
  assert.deepEqual(memory.vault.state(), { configured: true, unlocked: false });

  const foreign = inMemory();
  foreign.vault.setup('a different fictional phrase');
  const foreignKit = foreign.vault.recoveryKit();
  assert.throws(() => memory.vault.recover(foreignKit.kit, foreignKit.code), failsWith('invalid'));
  assert.deepEqual(memory.vault.state(), { configured: true, unlocked: false }, 'a kit for another vault leaves this one locked');

  assert.deepEqual(memory.vault.recover(kit, code), { configured: true, unlocked: true });
  assert.equal(memory.vault.read(secret.id).body, 'fictional');
  const joined = inMemory();
  joined.sync.applyChanges(memory.sync.exportChanges().records);
  assert.deepEqual(joined.vault.recover(kit, code), { configured: true, unlocked: true });
  memory.close();
  const stored = everything(home).join('\n');
  for (const value of [code, code.slice(5), kit.data, PASSPHRASE]) assert.equal(stored.includes(value), false, 'nothing about the kit is persisted');
});

test('sync peer state keeps refused push pages only when there are some', () => {
  const memory = inMemory();
  const base = { deviceId: 'server', pushedCursor: 4, pulledCursor: 2, uploads: [], downloads: [] };
  memory.sync.setPeerState('http://peer', { ...base, pendingPushes: [3, 3, 1] });
  assert.deepEqual(memory.sync.peerState('http://peer')!.pendingPushes, [3, 1]);
  memory.sync.setPeerState('http://peer', { ...base, pendingPushes: [] });
  assert.equal('pendingPushes' in memory.sync.peerState('http://peer')!, false);
  assert.throws(() => memory.sync.setPeerState('http://peer', { ...base, pendingPushes: [-1] }), failsWith('invalid'));
  assert.throws(() => memory.sync.setPeerState('http://peer', { ...base, pendingPushes: [1.5] }), failsWith('invalid'));
});
