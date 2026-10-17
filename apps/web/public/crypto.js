const KDF = Object.freeze({ name: 'pbkdf2', hash: 'sha256', iterations: 600000 });
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_META_BYTES = 4096;
const FRAME_MAGIC = utf8.encode('PMVF1');
const FRAME_HEADER = FRAME_MAGIC.length + 4;
const RECOVERY_KIND = 'petty-memory-vault-recovery';
const RECOVERY_AAD = 'petty-memory:recovery:v1';
const RECOVERY_CODE = /^pmr1_([A-Za-z0-9_-]{43})$/;
const MAX_KIT_DATA_CHARS = 65536;
const fileAad = (itemId, attachmentId) => `petty-memory:file:v1:${itemId}:${attachmentId}`;
let passphrase = null;
let salt = null;
let epoch = 0;
const keys = new Map();

export function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) { bytes[i] = Number(time & 255n); time >>= 8n; }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function subtle() {
  if (!crypto.subtle) throw new Error('Secret notes need HTTPS or localhost so this browser can encrypt them on your device.');
  return crypto.subtle;
}

const base64 = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(text);
};
const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const base64url = (data) => base64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = (text) => bytes(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));

/** Canonical base64 of an exact length (or, without `size`, non-empty), as core validates it. */
function base64Field(value, label, size, maxChars = 64) {
  const fail = () => new Error(`This recovery kit is damaged (${label}).`);
  if (typeof value !== 'string' || value.length > maxChars || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail();
  let decoded;
  try { decoded = bytes(value); } catch { throw fail(); }
  if (base64(decoded) !== value || (size !== undefined ? decoded.length !== size : decoded.length === 0)) throw fail();
  return decoded;
}

function supported(envelope) {
  const k = envelope?.kdf;
  if (envelope?.v !== 1 || k?.name !== KDF.name || k.hash !== KDF.hash || k.iterations !== KDF.iterations) {
    throw new Error('This note uses an older encryption format. Open it in the desktop app; this browser will never send your passphrase to the host.');
  }
  if (bytes(envelope.salt).length !== 16 || bytes(envelope.iv).length !== 12 || bytes(envelope.tag).length !== 16) throw new Error('The encrypted note is damaged.');
}

async function aesSeal(key, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, plain));
  return { iv: base64(iv), tag: base64(sealed.subarray(-16)), data: base64(sealed.subarray(0, -16)) };
}

async function aesOpen(key, sealed, aad) {
  const cipher = bytes(sealed.data);
  const combined = new Uint8Array(cipher.length + 16);
  combined.set(cipher);
  combined.set(bytes(sealed.tag), cipher.length);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: utf8.encode(aad), tagLength: 128 }, key, combined));
}

async function derive(password, encodedSalt) {
  const material = await subtle().importKey('raw', utf8.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: bytes(encodedSalt), iterations: KDF.iterations, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function vaultUnlocked() { return passphrase !== null; }

export function lockVault() {
  epoch++;
  passphrase = null;
  salt = null;
  keys.clear();
  document.dispatchEvent(new Event('petty:vault-locked'));
}

export async function unlockVault(password, items) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const started = epoch;
  const note = items.find((item) => item.metadata?.vault?.kdf?.name === 'pbkdf2');
  if (!note && items.length) supported(items[0].metadata.vault);
  const selectedSalt = note?.metadata.vault.salt ?? base64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await derive(password, selectedSalt);
  if (note) {
    try { await decrypt(key, note.id, note.metadata.vault); }
    catch { throw new Error('That passphrase does not unlock these notes.'); }
  }
  if (started !== epoch || document.hidden) throw new Error('The vault was locked. Unlock it again.');
  passphrase = password;
  salt = selectedSalt;
  keys.clear();
  keys.set(selectedSalt, key);
}

async function keyFor(encodedSalt) {
  if (passphrase === null) throw new Error('Unlock the vault on this device first.');
  const started = epoch;
  let key = keys.get(encodedSalt);
  if (!key) key = await derive(passphrase, encodedSalt);
  if (started !== epoch || passphrase === null) throw new Error('The vault was locked.');
  keys.set(encodedSalt, key);
  return key;
}

async function decrypt(key, id, envelope) {
  supported(envelope);
  const cipher = bytes(envelope.data);
  const tag = bytes(envelope.tag);
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher); combined.set(tag, cipher.length);
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: utf8.encode(id), tagLength: 128 }, key, combined);
  const value = JSON.parse(new TextDecoder().decode(plain));
  if (typeof value.title !== 'string' || typeof value.body !== 'string') throw new Error('The decrypted note is invalid.');
  return { id, title: value.title, body: value.body };
}

export async function openNote(id, envelope) {
  supported(envelope);
  const started = epoch;
  const note = await decrypt(await keyFor(envelope.salt), id, envelope);
  if (started !== epoch || !vaultUnlocked()) throw new Error('The vault was locked.');
  return note;
}

export async function sealNote(id, title, body) {
  if (!title.trim() && !body.trim()) throw new Error('A secret note needs a title or some text.');
  const started = epoch;
  const encodedSalt = salt;
  const key = await keyFor(encodedSalt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(id), tagLength: 128 }, key,
    utf8.encode(JSON.stringify({ title: title.trim(), body: body.trim() }))));
  if (started !== epoch || !vaultUnlocked()) throw new Error('The vault was locked.');
  return { v: 1, kdf: { ...KDF }, salt: encodedSalt, iv: base64(iv), tag: base64(sealed.subarray(-16)), data: base64(sealed.subarray(0, -16)) };
}

document.addEventListener('visibilitychange', () => { if (document.hidden) lockVault(); });
window.addEventListener('pagehide', lockVault);

/** The same checks core applies, so a file that opens here also opens on the desktop and phone. */
function safeFilename(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255 || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Use a plain file name of at most 255 characters, without folders.');
  }
  return value;
}

function safeMime(value) {
  const mime = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime) ? mime : 'application/octet-stream';
}

/** `PMVF1`, a big-endian u32 metadata length, `{"filename","mimeType"}` as UTF-8 JSON, then the file's bytes. */
export function encodeFrame(filename, mimeType, data) {
  const meta = utf8.encode(JSON.stringify({ filename: safeFilename(filename), mimeType: safeMime(mimeType) }));
  if (meta.length > MAX_FILE_META_BYTES) throw new Error('That file name is too long to encrypt.');
  if (data.byteLength === 0) throw new Error(`“${filename}” is empty.`);
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`“${filename}” is larger than 20 MiB, the limit for encrypted files.`);
  const frame = new Uint8Array(FRAME_HEADER + meta.length + data.byteLength);
  frame.set(FRAME_MAGIC);
  new DataView(frame.buffer).setUint32(FRAME_MAGIC.length, meta.length);
  frame.set(meta, FRAME_HEADER);
  frame.set(data, FRAME_HEADER + meta.length);
  return frame;
}

export function decodeFrame(frame) {
  const damaged = () => new Error('This encrypted file is damaged, or was made by a newer version.');
  if (frame.length < FRAME_HEADER || FRAME_MAGIC.some((byte, i) => frame[i] !== byte)) throw damaged();
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(FRAME_MAGIC.length);
  if (length > MAX_FILE_META_BYTES || FRAME_HEADER + length > frame.length || frame.length - FRAME_HEADER - length > MAX_FILE_BYTES) throw damaged();
  let meta;
  try { meta = JSON.parse(strictUtf8.decode(frame.subarray(FRAME_HEADER, FRAME_HEADER + length))); } catch { throw damaged(); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw damaged();
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : '';
  if (safeMime(mimeType) !== mimeType) throw damaged();
  return { filename: safeFilename(meta.filename), mimeType, data: frame.slice(FRAME_HEADER + length) };
}

/** Encrypts a file for `itemId` under a client-chosen attachment id; the result is the request body for PUT …/attachments/:id. */
export async function sealFile(itemId, attachmentId, { filename, mimeType, data }) {
  const started = epoch;
  const encodedSalt = salt;
  const key = await keyFor(encodedSalt);
  const frame = encodeFrame(filename, mimeType, data);
  try {
    const sealed = await aesSeal(key, frame, fileAad(itemId, attachmentId));
    if (started !== epoch || !vaultUnlocked()) throw new Error('The vault was locked.');
    return { v: 1, kdf: { ...KDF }, salt: encodedSalt, ...sealed };
  } finally {
    frame.fill(0);
  }
}

/** Decrypts an attachment envelope back to its name, type and bytes. The caller offers the bytes as a download only. */
export async function openFile(itemId, attachmentId, envelope) {
  supported(envelope);
  const started = epoch;
  const key = await keyFor(envelope.salt);
  let frame;
  try {
    frame = await aesOpen(key, envelope, fileAad(itemId, attachmentId));
  } catch {
    throw new Error('This encrypted file can’t be opened with the current passphrase, or it was damaged.');
  }
  try {
    if (started !== epoch || !vaultUnlocked()) throw new Error('The vault was locked.');
    return decodeFrame(frame);
  } finally {
    frame.fill(0);
  }
}

/**
 * A recovery kit for the passphrase this tab unlocked with, plus the code that opens it. The code is the AES key; neither
 * is kept here, and the passphrase never leaves this module.
 */
export async function createRecoveryKit() {
  if (passphrase === null) throw new Error('Unlock the vault on this device first.');
  const started = epoch;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const plain = utf8.encode(JSON.stringify({ passphrase: passphrase.normalize('NFKC') }));
  try {
    const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const sealed = await aesSeal(key, plain, RECOVERY_AAD);
    if (started !== epoch || !vaultUnlocked()) throw new Error('The vault was locked before the kit was made. Unlock it and try again.');
    return { kit: { v: 1, kind: RECOVERY_KIND, ...sealed }, code: `pmr1_${base64url(raw)}` };
  } finally {
    raw.fill(0);
    plain.fill(0);
  }
}

/** Opens a kit with its code, then unlocks with the recovered passphrase exactly as typing it would. */
export async function unlockWithRecovery(kit, code, items) {
  const started = epoch;
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) throw new Error('Choose a Petty Memory recovery kit file.');
  if (kit.kind !== RECOVERY_KIND || kit.v !== 1) throw new Error('That isn’t a Petty Memory vault recovery kit, or it comes from a newer version.');
  base64Field(kit.iv, 'iv', 12);
  base64Field(kit.tag, 'tag', 16);
  base64Field(kit.data, 'data', undefined, MAX_KIT_DATA_CHARS);
  const match = typeof code === 'string' ? RECOVERY_CODE.exec(code.trim()) : null;
  const raw = match ? fromBase64url(match[1]) : null;
  if (!raw || raw.length !== 32 || base64url(raw) !== match[1]) {
    throw new Error('A recovery code is "pmr1_" followed by 43 letters, digits, "-" or "_". Check that it was copied completely.');
  }
  let recovered;
  try {
    const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await aesOpen(key, kit, RECOVERY_AAD);
    try { recovered = JSON.parse(strictUtf8.decode(plain)).passphrase; }
    finally { plain.fill(0); }
  } catch {
    throw new Error('That recovery code doesn’t open this recovery kit. Use the code that was saved with this kit.');
  } finally {
    raw.fill(0);
  }
  if (typeof recovered !== 'string' || recovered === '') throw new Error('This recovery kit is damaged.');
  if (started !== epoch || document.hidden) throw new Error('The vault was locked. Unlock it again.');
  await unlockVault(recovered, items);
}
