import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type AttachmentRow, blobPath, removeBlobIfUnused, toAttachment, writeBlob } from './blobs.ts';
import { type Context, type ItemRow, clientId, newId } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type ItemService, isSecret } from './items.ts';
import { mimeFor } from './mime.ts';
import type { VersionService } from './versions.ts';
import type { Attachment, ItemDetail, ItemMetadata, MissingFile, SecretEnvelope, VaultRecoveryKit, VaultState } from './types.ts';

const SALT = 'vault.salt';
const CHECK = 'vault.check';
const CHECK_TEXT = 'petty-memory vault key check';
// Same cost as sync encryption: ~64 MB and a fraction of a second, once per unlock.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
/** What ordinary views, search, exports and shares see instead of a secret note's title. */
export const SECRET_LABEL = 'Secret note';
/** The only name and type an encrypted attachment's row may show; the real ones are inside the ciphertext. */
export const SEALED_FILE_NAME = 'Encrypted attachment.pmv';
export const SEALED_FILE_MIME = 'application/vnd.petty-memory.vault+json';
export const MAX_SEALED_FILE_BYTES = 20 * 1024 * 1024;

const KDF = { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p } as const;
const CLIENT_KDF = { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 } as const;

const FRAME_MAGIC = Buffer.from('PMVF1', 'ascii');
const FRAME_HEADER = FRAME_MAGIC.length + 4;
const MAX_FILE_META_BYTES = 4096;
const MAX_NOTE_DATA_CHARS = 3_000_000;
const MAX_FILE_DATA_CHARS = Math.ceil((FRAME_HEADER + MAX_FILE_META_BYTES + MAX_SEALED_FILE_BYTES) / 3) * 4;
const MAX_KIT_DATA_CHARS = 65_536;
const RECOVERY_KIND = 'petty-memory-vault-recovery';
const RECOVERY_AAD = 'petty-memory:recovery:v1';
const RECOVERY_CODE = /^pmr1_([A-Za-z0-9_-]{43})$/;
const fileAad = (itemId: string, attachmentId: string) => `petty-memory:file:v1:${itemId}:${attachmentId}`;

/** Envelope parameters come from other devices: accept only the cost this build uses rather than an attacker's choice. */
function derive(passphrase: string, salt: Buffer, kdf: SecretEnvelope['kdf'] = KDF): Buffer {
  validateKdf(kdf);
  if (kdf.name === 'pbkdf2') return pbkdf2Sync(passphrase.normalize('NFKC'), salt, kdf.iterations, 32, 'sha256');
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}

type Sealed = Pick<SecretEnvelope, 'iv' | 'tag' | 'data'>;

function encrypt(key: Buffer, plain: string | Uint8Array, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain) : plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}

function seal(key: Buffer, salt: string, plain: string | Uint8Array, aad: string, kdf: SecretEnvelope['kdf']): SecretEnvelope {
  return { v: 1, kdf: canonicalKdf(kdf), salt, ...encrypt(key, plain, aad) };
}

const open = (key: Buffer, envelope: SecretEnvelope, aad: string): string => decrypt(key, envelope, aad).toString('utf8');

// Ordinary item fields remain generic; only the encrypted envelope may enter persistent content paths.
export class VaultService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly versions: VersionService;
  private key: Buffer | null = null;
  private passphrase: string | null = null;
  private keys = new Map<string, Buffer>();
  private generation = 0;

  constructor(ctx: Context, items: ItemService, versions: VersionService) {
    this.ctx = ctx;
    this.items = items;
    this.versions = versions;
  }

  state(): VaultState {
    return { configured: this.setting(SALT) !== null, unlocked: this.key !== null };
  }

  get sessionRevision(): number { return this.generation; }

  // Verify synced envelopes before joining an existing vault with this device's passphrase.
  setup(passphrase: string): VaultState {
    if (this.state().configured) throw new MemoryError('conflict', 'The vault is already set up. Unlock it with its passphrase.');
    if (typeof passphrase !== 'string' || passphrase.length < 8) throw invalid('Use a passphrase of at least 8 characters.');
    const existing = this.anyEnvelope();
    const salt = existing ? Buffer.from(existing.envelope.salt, 'base64') : randomBytes(16);
    const kdf = existing?.envelope.kdf ?? CLIENT_KDF;
    const key = derive(passphrase, salt, kdf);
    if (existing) {
      try {
        open(key, existing.envelope, existing.id);
      } catch {
        throw invalid('Secret notes from another device were sealed with a different passphrase. Enter that passphrase.');
      }
    }
    const check = seal(key, salt.toString('base64'), CHECK_TEXT, CHECK, kdf);
    this.ctx.tx(() => {
      this.write(SALT, salt.toString('base64'));
      this.write(CHECK, JSON.stringify(check));
    });
    this.key = key;
    this.passphrase = passphrase;
    this.generation++;
    return this.state();
  }

  unlock(passphrase: string): VaultState {
    const salt = this.setting(SALT);
    if (salt === null) throw invalid('Set up the vault first.');
    if (typeof passphrase !== 'string') throw invalid('Enter the vault passphrase.');
    const check = JSON.parse(this.setting(CHECK)!) as SecretEnvelope;
    const key = derive(passphrase, Buffer.from(salt, 'base64'), check.kdf);
    try {
      if (open(key, check, CHECK) !== CHECK_TEXT) throw new Error();
    } catch {
      throw invalid('That passphrase doesn’t unlock the vault.');
    }
    this.lock();
    this.key = key;
    this.passphrase = passphrase;
    return this.state();
  }

  lock(): VaultState {
    this.generation++;
    this.key?.fill(0);
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.key = null;
    this.passphrase = null;
    return this.state();
  }

  create({ title, body, project, tags, parentId }: { title: string; body: string; project?: string; tags?: string[]; parentId?: string | null }): ItemDetail {
    const key = this.unlocked();
    if (typeof title !== 'string' || typeof body !== 'string') throw invalid('A secret note needs a title and body as text.');
    if (!title.trim() && !body.trim()) throw invalid('A secret note needs a title or some text.');
    const id = newId();
    const vault = seal(key, this.setting(SALT)!, JSON.stringify({ title: title.trim(), body: body.trim() }), id, this.checkKdf());
    return this.items.get(this.items.insert({
      id, type: 'note', title: SECRET_LABEL, metadata: { secret: true, vault }, project, tags, parentId: parentRef(parentId),
    }));
  }

  read(id: string): { id: string; title: string; body: string } {
    this.unlocked();
    const row = this.secretRow(id);
    const envelope = (JSON.parse(row.metadata) as ItemMetadata).vault!;
    try {
      const { title, body } = JSON.parse(open(this.keyFor(envelope), envelope, row.id)) as { title: unknown; body: unknown };
      if (typeof title !== 'string' || typeof body !== 'string') throw new Error();
      return { id: row.id, title, body };
    } catch {
      throw invalid('This secret note can’t be opened with the current passphrase, or it was damaged.');
    }
  }

  update(id: string, { title, body }: { title: string; body: string }): ItemDetail {
    this.unlocked();
    const row = this.secretRow(id);
    if (typeof title !== 'string' || typeof body !== 'string') throw invalid('A secret note needs a title and body as text.');
    if (!title.trim() && !body.trim()) throw invalid('A secret note needs a title or some text.');
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    const envelope = metadata.vault!;
    const vault = seal(this.keyFor(envelope), envelope.salt, JSON.stringify({ title: title.trim(), body: body.trim() }), row.id, envelope.kdf);
    this.items.write(row, { metadata: JSON.stringify({ ...metadata, vault }) }, 'update', { vault });
    return this.items.get(row.id);
  }

  createSealed(input: { id: string; envelope: unknown; project?: string; tags?: string[]; parentId?: string | null }): ItemDetail {
    const id = clientId(input.id, 'A sealed note’s id (generated before encryption)');
    if (this.ctx.get(`SELECT 1 FROM items WHERE id = ?`, id)) throw new MemoryError('conflict', 'An item with that id already exists.');
    const vault = validateEnvelope(input.envelope);
    return this.items.get(this.items.insert({
      id, type: 'note', title: SECRET_LABEL, project: input.project, tags: input.tags, parentId: parentRef(input.parentId),
      metadata: { secret: true, vault },
    }));
  }

  updateSealed(id: string, input: { envelope: unknown }): ItemDetail {
    const row = this.secretRow(id);
    const vault = validateEnvelope(input.envelope);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    this.items.write(row, { metadata: JSON.stringify({ ...metadata, vault }) }, 'update', { vault });
    return this.items.get(row.id);
  }

  /** Stores a file a client encrypted itself; the host never needs the key. A retry with the same envelope is a no-op. */
  attachSealed(itemId: string, attachmentId: string, envelope: unknown): Attachment {
    const row = this.secretRow(itemId);
    const id = clientId(attachmentId, 'Attachment id');
    const sealed = validateEnvelope(envelope, MAX_FILE_DATA_CHARS);
    if (Buffer.from(sealed.data, 'base64').length < FRAME_HEADER) throw invalid('Invalid envelope data.');
    return this.storeSealed(row, id, sealed);
  }

  sealedAttachment(itemId: string, attachmentId: string): SecretEnvelope {
    const row = this.secretRow(itemId);
    const attachment = this.ctx.get<AttachmentRow>(`SELECT * FROM attachments WHERE id = ? AND item_id = ?`, attachmentId, row.id);
    if (!attachment) throw notFound(`This secret note has no attachment "${attachmentId}".`);
    if (attachment.filename !== SEALED_FILE_NAME || attachment.mime_type !== SEALED_FILE_MIME) throw invalid('That attachment isn’t an encrypted file.');
    const path = blobPath(this.ctx, attachment.sha256);
    if (!existsSync(path)) throw notFound('This encrypted file hasn’t arrived on this device yet. Sync with a device that has it.');
    try {
      return validateEnvelope(JSON.parse(readFileSync(path, 'utf8')), MAX_FILE_DATA_CHARS);
    } catch {
      throw invalid('This encrypted file is damaged.');
    }
  }

  attachFile(itemId: string, input: { id?: string; data: Uint8Array; filename: string; mimeType?: string }): Attachment {
    const key = this.unlocked();
    const row = this.secretRow(itemId);
    const id = input.id === undefined ? newId() : clientId(input.id, 'Attachment id');
    const filename = safeFilename(input.filename);
    if (!(input.data instanceof Uint8Array)) throw invalid('File contents must be bytes.');
    if (input.data.byteLength === 0) throw invalid(`"${filename}" is empty.`);
    if (input.data.byteLength > MAX_SEALED_FILE_BYTES) throw invalid('Encrypted attachments can be at most 20 MiB.');
    const mimeType = safeMime(input.mimeType?.split(';')[0]?.trim() || mimeFor(filename));
    const frame = encodeFrame(filename, mimeType, input.data);
    const envelope = seal(key, this.setting(SALT)!, frame, fileAad(row.id, id), this.checkKdf());
    frame.fill(0);
    return this.storeSealed(row, id, envelope);
  }

  readFile(itemId: string, attachmentId: string): { filename: string; mimeType: string; data: Uint8Array } {
    this.unlocked();
    const envelope = this.sealedAttachment(itemId, attachmentId);
    let frame: Buffer;
    try {
      frame = decrypt(this.keyFor(envelope), envelope, fileAad(this.items.row(itemId).id, attachmentId));
    } catch {
      throw invalid('This encrypted file can’t be opened with the current passphrase, or it was damaged.');
    }
    try {
      return decodeFrame(frame);
    } finally {
      frame.fill(0);
    }
  }

  /** Recoverable: the item's history keeps the row, and the bytes stay in the trash while history refers to them. */
  removeFile(itemId: string, attachmentId: string): { removed: boolean } {
    const row = this.secretRow(itemId);
    const attachment = this.ctx.get<{ sha256: string }>(`SELECT sha256 FROM attachments WHERE id = ? AND item_id = ?`, attachmentId, row.id);
    if (!attachment) return { removed: false };
    this.ctx.tx(() => {
      this.ctx.run(`DELETE FROM attachments WHERE id = ?`, attachmentId);
      this.items.write(row, {}, 'detach', { id: attachmentId, sha256: attachment.sha256 });
    });
    if (!this.ctx.db.isTransaction) removeBlobIfUnused(this.ctx, attachment.sha256);
    return { removed: true };
  }

  /** Restores a secret note's history: only ciphertext snapshots, never a plaintext state into a secret row. */
  restoreVersion(versionId: string): { restored: number; missingFiles?: MissingFile[] } {
    return this.versions.restoreSecret(versionId);
  }

  /** A random code that wraps the passphrase. Neither is stored; the caller shows the code once and offers the kit as a file. */
  recoveryKit(): { kit: VaultRecoveryKit; code: string } {
    this.unlocked();
    const key = randomBytes(32);
    const plain = Buffer.from(JSON.stringify({ passphrase: this.passphrase!.normalize('NFKC') }));
    try {
      const kit: VaultRecoveryKit = { v: 1, kind: RECOVERY_KIND, ...encrypt(key, plain, RECOVERY_AAD) };
      return { kit, code: `pmr1_${key.toString('base64url')}` };
    } finally {
      plain.fill(0);
      key.fill(0);
    }
  }

  /** Opens a kit with its code, then unlocks (or joins) the vault exactly as the recovered passphrase would. */
  recover(kit: unknown, code: string): VaultState {
    const sealed = validateKit(kit);
    const match = typeof code === 'string' ? RECOVERY_CODE.exec(code.trim()) : null;
    const key = match ? Buffer.from(match[1]!, 'base64url') : null;
    if (!key || key.length !== 32 || key.toString('base64url') !== match![1]) {
      throw invalid('A recovery code is "pmr1_" followed by 43 letters, digits, "-" or "_". Check that it was copied completely.');
    }
    let passphrase: unknown;
    try {
      passphrase = (JSON.parse(decrypt(key, sealed, RECOVERY_AAD).toString('utf8')) as { passphrase?: unknown }).passphrase;
    } catch {
      throw invalid('That recovery code doesn’t open this recovery kit. Use the code that was saved with this kit.');
    } finally {
      key.fill(0);
    }
    if (typeof passphrase !== 'string' || passphrase === '') throw invalid('This recovery kit is damaged.');
    return this.state().configured ? this.unlock(passphrase) : this.setup(passphrase);
  }

  private storeSealed(row: ItemRow, id: string, envelope: SecretEnvelope): Attachment {
    const bytes = Buffer.from(JSON.stringify(envelope));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = this.ctx.get<AttachmentRow>(`SELECT * FROM attachments WHERE id = ?`, id);
    // A removed attachment's id stays bound to its file while history can restore it.
    const retained = existing ? undefined : this.ctx.get(
      `SELECT 1 FROM item_versions v, json_each(v.state, '$.attachments') a
       WHERE v.state IS NOT NULL AND instr(v.state, ?) > 0 AND json_extract(a.value, '$.id') = ?
         AND (v.item_id != ? OR json_extract(a.value, '$.sha256') != ?) LIMIT 1`,
      id, id, row.id, sha256,
    );
    if (retained || (existing && (existing.item_id !== row.id || existing.sha256 !== sha256))) {
      throw new MemoryError('conflict', 'That attachment id already holds a different file. Upload it under a new id.');
    }
    writeBlob(this.ctx, sha256, bytes);
    if (existing) return toAttachment(existing);
    const attachment = { id, sha256, filename: SEALED_FILE_NAME, mimeType: SEALED_FILE_MIME, size: bytes.length, createdAt: this.ctx.now() };
    this.ctx.tx(() => {
      this.ctx.run(
        `INSERT INTO attachments (id, item_id, sha256, filename, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, row.id, sha256, SEALED_FILE_NAME, SEALED_FILE_MIME, attachment.size, attachment.createdAt,
      );
      this.items.write(row, {}, 'attach', attachment);
    });
    return attachment;
  }

  private keyFor(envelope: SecretEnvelope): Buffer {
    const cacheId = JSON.stringify([envelope.salt, envelope.kdf]);
    let key = this.keys.get(cacheId);
    if (!key) {
      key = derive(this.passphrase!, Buffer.from(envelope.salt, 'base64'), envelope.kdf);
      this.keys.set(cacheId, key);
    }
    return key;
  }

  private unlocked(): Buffer {
    if (!this.key) throw new MemoryError('locked', this.state().configured ? 'Unlock the vault first.' : 'Set up the vault first.');
    return this.key;
  }

  private checkKdf(): SecretEnvelope['kdf'] {
    return (JSON.parse(this.setting(CHECK)!) as SecretEnvelope).kdf;
  }

  private secretRow(id: string) {
    const row = this.items.row(id);
    if (!isSecret(row)) throw invalid('That item isn’t a secret note.');
    return row;
  }

  private anyEnvelope(): { id: string; envelope: SecretEnvelope } | null {
    const row = this.ctx.get<{ id: string; vault: string }>(
      `SELECT id, json_extract(metadata, '$.vault') AS vault FROM items WHERE json_extract(metadata, '$.secret') = 1 AND json_extract(metadata, '$.vault') IS NOT NULL LIMIT 1`,
    );
    return row ? { id: row.id, envelope: JSON.parse(row.vault) as SecretEnvelope } : null;
  }

  private setting(key: string): string | null {
    return this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.ctx.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }
}

/** A secret note's stored item fields: the generic label, nothing else readable, and a supported envelope. */
export function isSealedItem(item: Record<string, unknown>): boolean {
  if (item.type !== 'note' || item.title !== SECRET_LABEL || item.body !== '' || (item.content ?? '') !== '' || (item.url ?? null) !== null) return false;
  try {
    const metadata = JSON.parse(item.metadata as string) as unknown;
    if (!isObject(metadata) || metadata.secret !== true) return false;
    validateEnvelope(metadata.vault);
    return true;
  } catch {
    return false;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parentRef(parentId: unknown): string | null {
  if (parentId === undefined || parentId === null) return null;
  if (typeof parentId !== 'string' || parentId === '') throw invalid('parentId must be an item id or null.');
  return parentId;
}

function validateKdf(kdf: SecretEnvelope['kdf']): void {
  if (kdf?.name === 'pbkdf2' && kdf.hash === 'sha256' && kdf.iterations === CLIENT_KDF.iterations) return;
  if (kdf?.name === 'scrypt' && kdf.N === KDF.N && kdf.r === KDF.r && kdf.p === KDF.p) return;
  throw invalid('This secret note uses unsupported key settings.');
}

const canonicalKdf = (kdf: SecretEnvelope['kdf']): SecretEnvelope['kdf'] =>
  kdf.name === 'pbkdf2' ? { name: 'pbkdf2', hash: 'sha256', iterations: kdf.iterations } : { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p };

/** Canonical base64 of an exact (or, without `size`, non-empty and bounded) length. */
function base64Field(value: unknown, label: string, size: number | undefined, maxChars: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > maxChars) throw invalid(`Invalid ${label}.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined ? bytes.length !== size : bytes.length === 0)) throw invalid(`Invalid ${label}.`);
  return value;
}

export function validateEnvelope(input: unknown, maxData = MAX_NOTE_DATA_CHARS): SecretEnvelope {
  if (!isObject(input)) throw invalid('A sealed note needs an encrypted envelope.');
  if (input.v !== 1) throw invalid('Unsupported secret envelope version.');
  const kdf = input.kdf as SecretEnvelope['kdf'];
  validateKdf(kdf);
  return {
    v: 1, kdf: canonicalKdf(kdf),
    salt: base64Field(input.salt, 'envelope salt', 16, 64),
    iv: base64Field(input.iv, 'envelope iv', 12, 64),
    tag: base64Field(input.tag, 'envelope tag', 16, 64),
    data: base64Field(input.data, 'envelope data', undefined, maxData),
  };
}

function validateKit(input: unknown): Sealed {
  if (!isObject(input)) throw invalid('Choose a Petty Memory recovery kit file.');
  if (input.kind !== RECOVERY_KIND || input.v !== 1) throw invalid('That isn’t a Petty Memory vault recovery kit, or it comes from a newer version.');
  return {
    iv: base64Field(input.iv, 'recovery kit iv', 12, 64),
    tag: base64Field(input.tag, 'recovery kit tag', 16, 64),
    data: base64Field(input.data, 'recovery kit data', undefined, MAX_KIT_DATA_CHARS),
  };
}

function safeFilename(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255 || value === '.' || value === '..'
    || /[/\\\u0000-\u001f\u007f]/.test(value)) {
    throw invalid('Use a plain file name of at most 255 characters, without folders.');
  }
  return value;
}

function safeMime(value: unknown): string {
  const mime = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)) throw invalid('Use a plain MIME type such as "application/pdf".');
  return mime;
}

/** `PMVF1`, a big-endian u32 metadata length, `{"filename","mimeType"}` as UTF-8 JSON, then the file's bytes. */
function encodeFrame(filename: string, mimeType: string, data: Uint8Array): Buffer {
  const meta = Buffer.from(JSON.stringify({ filename, mimeType }));
  if (meta.length > MAX_FILE_META_BYTES) throw invalid('That file name is too long to encrypt.');
  const header = Buffer.alloc(FRAME_HEADER);
  FRAME_MAGIC.copy(header);
  header.writeUInt32BE(meta.length, FRAME_MAGIC.length);
  return Buffer.concat([header, meta, data]);
}

function decodeFrame(frame: Buffer): { filename: string; mimeType: string; data: Uint8Array } {
  const damaged = () => invalid('This encrypted file is damaged, or was made by a newer version.');
  if (frame.length < FRAME_HEADER || !frame.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)) throw damaged();
  const length = frame.readUInt32BE(FRAME_MAGIC.length);
  if (length > MAX_FILE_META_BYTES || FRAME_HEADER + length > frame.length) throw damaged();
  if (frame.length - FRAME_HEADER - length > MAX_SEALED_FILE_BYTES) throw damaged();
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(FRAME_HEADER, FRAME_HEADER + length)));
  } catch {
    throw damaged();
  }
  if (!isObject(meta)) throw damaged();
  return { filename: safeFilename(meta.filename), mimeType: safeMime(meta.mimeType), data: new Uint8Array(frame.subarray(FRAME_HEADER + length)) };
}
