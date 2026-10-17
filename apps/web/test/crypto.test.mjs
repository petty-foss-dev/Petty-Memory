// Runs the browser's vault crypto (public/crypto.js) under Node's Web Crypto and checks it against core's own implementation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';

globalThis.document = Object.assign(new EventTarget(), { hidden: false });
globalThis.window = new EventTarget();
const web = await import('../public/crypto.js');

const PASSPHRASE = 'correct horse battery staple (test only)';
const home = mkdtempSync(join(tmpdir(), 'petty-web-crypto-'));
const memory = EnveMemory.open({ home, actor: 'test' });
after(() => {
  memory.close();
  rmSync(home, { recursive: true, force: true });
});

const bytes = (text) => new TextEncoder().encode(text);
const secrets = () => memory.items.list({ secret: true }, 200).map((item) => memory.items.get(item.id));

test('the file frame round-trips and refuses damaged or unsafe frames', () => {
  const frame = web.encodeFrame('notes.txt', 'Text/Plain; charset=utf-8', bytes('hello'));
  assert.deepEqual([...frame.subarray(0, 5)], [...bytes('PMVF1')]);
  const decoded = web.decodeFrame(frame);
  assert.equal(decoded.filename, 'notes.txt');
  assert.equal(decoded.mimeType, 'text/plain');
  assert.equal(new TextDecoder().decode(decoded.data), 'hello');
  assert.throws(() => web.decodeFrame(frame.subarray(0, 8)), /damaged/);
  const wrongMagic = frame.slice();
  wrongMagic[0] = 0;
  assert.throws(() => web.decodeFrame(wrongMagic), /damaged/);
  const tooLong = frame.slice();
  new DataView(tooLong.buffer).setUint32(5, 4097);
  assert.throws(() => web.decodeFrame(tooLong), /damaged/);
  assert.throws(() => web.encodeFrame('../escape.txt', 'text/plain', bytes('x')), /plain file name/);
  assert.throws(() => web.encodeFrame('empty.txt', 'text/plain', new Uint8Array()), /empty/);
  assert.throws(() => web.encodeFrame('big.bin', 'application/octet-stream', new Uint8Array(web.MAX_FILE_BYTES + 1)), /20 MiB/);
});

test('a note sealed in the browser opens in core, which joins the vault with the same passphrase', async () => {
  await web.unlockVault(PASSPHRASE, []);
  const id = web.uuidv7();
  const envelope = await web.sealNote(id, 'Browser title', 'Browser body');
  memory.vault.createSealed({ id, envelope });
  memory.vault.setup(PASSPHRASE);
  assert.deepEqual(memory.vault.read(id), { id, title: 'Browser title', body: 'Browser body' });
  const item = memory.items.get(id);
  assert.equal(item.title, 'Secret note');
  assert.ok(!JSON.stringify(item).includes('Browser title'));
});

test('files sealed in the browser open in core, and core-sealed files open in the browser', async () => {
  const [note] = secrets();
  const attachmentId = web.uuidv7();
  const envelope = await web.sealFile(note.id, attachmentId, { filename: 'plan.pdf', mimeType: 'application/pdf', data: bytes('%PDF-synthetic') });
  const row = memory.vault.attachSealed(note.id, attachmentId, envelope);
  assert.equal(row.filename, 'Encrypted attachment.pmv');
  assert.equal(row.mimeType, 'application/vnd.petty-memory.vault+json');
  assert.deepEqual(memory.vault.attachSealed(note.id, attachmentId, envelope).id, attachmentId, 'retrying the same upload is a no-op');
  const opened = memory.vault.readFile(note.id, attachmentId);
  assert.equal(opened.filename, 'plan.pdf');
  assert.equal(opened.mimeType, 'application/pdf');
  assert.equal(new TextDecoder().decode(opened.data), '%PDF-synthetic');

  const fromCore = memory.vault.attachFile(note.id, { data: bytes('core bytes'), filename: 'core.txt' });
  const sealed = memory.vault.sealedAttachment(note.id, fromCore.id);
  const file = await web.openFile(note.id, fromCore.id, sealed);
  assert.equal(file.filename, 'core.txt');
  assert.equal(new TextDecoder().decode(file.data), 'core bytes');
  await assert.rejects(web.openFile(note.id, attachmentId, sealed), /can’t be opened/, 'the AAD binds the attachment id');
  await assert.rejects(web.openFile(web.uuidv7(), fromCore.id, sealed), /can’t be opened/, 'the AAD binds the item id');
});

test('a core recovery kit unlocks the browser, and a wrong code changes nothing', async () => {
  const { kit, code } = memory.vault.recoveryKit();
  assert.match(code, /^pmr1_[A-Za-z0-9_-]{43}$/);
  web.lockVault();
  const wrong = `pmr1_${'A'.repeat(43)}`;
  await assert.rejects(web.unlockWithRecovery(kit, wrong, secrets()), /doesn’t open this recovery kit/);
  assert.equal(web.vaultUnlocked(), false);
  await assert.rejects(web.unlockWithRecovery(kit, 'pmr1_short', secrets()), /43 letters/);
  await assert.rejects(web.unlockWithRecovery({ ...kit, kind: 'other' }, code, secrets()), /recovery kit/);
  await web.unlockWithRecovery(kit, code, secrets());
  assert.equal(web.vaultUnlocked(), true);
});

test('a browser recovery kit recovers the vault in core', async () => {
  const { kit, code } = await web.createRecoveryKit();
  assert.deepEqual(Object.keys(kit).sort(), ['data', 'iv', 'kind', 'tag', 'v']);
  memory.vault.lock();
  assert.throws(() => memory.vault.recover(kit, code.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))));
  assert.equal(memory.vault.state().unlocked, false);
  assert.equal(memory.vault.recover(kit, code).unlocked, true);
});

test('locking during an encryption discards its result', async () => {
  const [note] = secrets();
  const pending = web.sealFile(note.id, web.uuidv7(), { filename: 'race.txt', mimeType: 'text/plain', data: bytes('race') });
  web.lockVault();
  await assert.rejects(pending, /locked/);
  await web.unlockVault(PASSPHRASE, secrets());
  const kit = web.createRecoveryKit();
  web.lockVault();
  await assert.rejects(kit, /locked/);
});

const fixture = JSON.parse(readFileSync(new URL('../../../packages/core/test/fixtures/vault-closeout-v1.json', import.meta.url), 'utf8'));
const fixtureItems = [{ id: fixture.note.id, metadata: { vault: fixture.note.envelope } }];

test('the fixed Node-generated fixture opens in the browser: note, file frame and NFKC passphrase', async () => {
  web.lockVault();
  await web.unlockVault(fixture.passphrase, fixtureItems);
  assert.deepEqual(await web.openNote(fixture.note.id, fixture.note.envelope), { id: fixture.note.id, ...fixture.note.plaintext });
  const file = await web.openFile(fixture.file.itemId, fixture.file.attachmentId, fixture.file.envelope);
  assert.equal(file.filename, fixture.file.filename);
  assert.equal(file.mimeType, fixture.file.mimeType);
  assert.equal(Buffer.from(file.data).toString('base64'), fixture.file.dataBase64);
  assert.equal(createHash('sha256').update(file.data).digest('hex'), fixture.file.dataSha256);
  const frame = web.encodeFrame(fixture.file.filename, fixture.file.mimeType, file.data);
  assert.equal(new DataView(frame.buffer).getUint32(5), fixture.file.metadataLength);
  assert.equal(createHash('sha256').update(JSON.stringify(fixture.file.envelope)).digest('hex'), fixture.file.storedBlobSha256);
  await assert.rejects(web.openFile(fixture.file.itemId, fixture.note.id, fixture.file.envelope), /can’t be opened/);
});

test('the fixture recovery kit and code unlock the browser with the fixture passphrase', async () => {
  web.lockVault();
  await web.unlockWithRecovery(fixture.recovery.kit, fixture.recovery.code, fixtureItems);
  assert.equal(web.vaultUnlocked(), true);
  assert.equal((await web.openNote(fixture.note.id, fixture.note.envelope)).title, fixture.note.plaintext.title);
  web.lockVault();
  await assert.rejects(web.unlockWithRecovery({ ...fixture.recovery.kit, tag: fixture.note.envelope.tag }, fixture.recovery.code, fixtureItems));
  assert.equal(web.vaultUnlocked(), false);
});

test('locking during recovery prevents a late completion from unlocking the browser again', async () => {
  const pending = web.unlockWithRecovery(fixture.recovery.kit, fixture.recovery.code, fixtureItems);
  web.lockVault();
  await assert.rejects(pending, /locked/);
  assert.equal(web.vaultUnlocked(), false);
});
