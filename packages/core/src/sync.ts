import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { SHA256_PATTERN, TRASH_DIR, blobPath, historyKeeps, removeBlobIfUnused, untrashBlob, writeBlob } from './blobs.ts';
import { type Context, HLC_PATTERN, MAX_CLOCK_LEAD_MS, normalizeTag, slugify } from './context.ts';
import { MemoryError, invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import { adoptChildren, canHold, defaultSortKey, isSecretItem, isSortKey, pathToRoot, place, slots } from './placement.ts';
import { DEFAULT_PRESENTATION, validPresentationPatch } from './presentation.ts';
import type { SettingsService } from './settings.ts';
import {
  type Change, INTENTS, ITEM_TYPES, PROJECT_STATUSES, RELATION_KINDS, type SyncPeerState, TASK_STATUSES,
} from './types.ts';
import { SEALED_FILE_MIME, SEALED_FILE_NAME, isSealedItem } from './vault.ts';
import {
  ATTACHMENT_FIELDS, ITEM_FIELDS, type ItemState, keepConflictVersion, readItemState, upsert, writeTagsAndTask,
} from './versions.ts';

type Entity = Change['entity'];

/** One line of a segment file: an entity's full state (null = deleted) at a clock stamp. */
export interface SyncRecord {
  entity: Entity;
  id: string;
  hlc: string;
  /** The version the writing device had last exchanged before editing; lets the reader spot concurrent edits. */
  base: string | null;
  device: string;
  actor: string;
  state: ItemState | Record<string, SQLInputValue> | null;
}

export interface SyncPage {
  records: SyncRecord[];
  nextCursor: number;
  hasMore: boolean;
  deviceId: string;
  /** The cursor was past this library's history (it was restored from a backup), so the page starts over from the beginning. */
  reset: boolean;
}

export interface SyncResult {
  exported: number;
  imported: number;
  conflicts: number;
  /** Records from other devices that were malformed or failed to apply, and were skipped. */
  rejected: number;
  devices: number;
  /** How many rejected records were stamped too far ahead to apply yet; their segments are read again. Absent when none. */
  deferred?: number;
}

export type SyncRecordRef = Pick<SyncRecord, 'entity' | 'id' | 'hlc'>;

/**
 * What applying a batch did. `deferred` counts the rejected records held back because their stamps are more than five
 * minutes ahead; retrying them later can succeed. `rejectedRecords` names every rejected record, and is absent when
 * none were rejected or one of them was too malformed to name.
 */
export interface SyncApplied {
  imported: number;
  conflicts: number;
  rejected: number;
  deferred?: number;
  rejectedRecords?: SyncRecordRef[];
}

const PROJECT_FIELDS = ['id', 'name', 'slug', 'description', 'instructions', 'memory', 'status', 'created_at', 'updated_at'];
const APPLY_ORDER: Record<Entity, number> = { project: 0, item: 1, relation: 2 };
const EXPORTED_SEQ = 'sync.exported_seq';
// Changes per network page: whole entity states can be large, so a page stays well under the API's 2 MB body cap.
const NETWORK_PAGE = 500;
const SEGMENT = /^\d{12}\.ndjson$/;
const DEVICE_ID = /^[\w-]{1,64}$/;
const KEY_SETTING = 'sync.key';
const MARKER = 'sync.json';
const VERIFIER = 'enve-memory sync key check';
// scrypt cost: ~64 MB and a fraction of a second, once per device.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

interface Marker {
  version: 1;
  encryption: { kdf: 'scrypt'; salt: string; verifier: string } | null;
}

/** AES-256-GCM: 12-byte IV, 16-byte tag, then ciphertext. */
class Sealer {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    this.key = key;
  }

  /** `name` is bound in as associated data, so sealed files can't be swapped between names undetected. */
  seal(plain: Buffer, name: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer, name: string): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
  }
}

const deriveKey = (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);

/**
 * Folder sync between devices (iCloud Drive, Dropbox, Syncthing, a network share). Each device appends
 * segments to its own subfolder, so cloud providers never see two writers on one file. Entities converge
 * by newest clock stamp; when two devices edited the same note or project memory between syncs, the
 * losing text is kept as a "conflicting edit" note instead of disappearing.
 */
export class SyncService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly settings: SettingsService;
  private sealer: Sealer | null = null;
  /** Items given a parent during the current import, checked for loops once everything has landed. */
  private placed = new Set<string>();
  /** Files whose rows an import added or removed; their bytes move only after the transaction commits. */
  private touchedBlobs = new Set<string>();

  constructor(ctx: Context, items: ItemService, settings: SettingsService) {
    this.ctx = ctx;
    this.items = items;
    this.settings = settings;
  }

  /**
   * Encrypts everything this library puts in the folder. The first device to set a passphrase on an empty folder
   * creates its key; every other device must enter the same passphrase. An existing unencrypted folder can't be
   * converted in place: start a new, empty one.
   */
  setPassphrase(passphrase: string, folder = this.settings.get('syncFolder')): void {
    if (!folder) throw invalid('Choose a sync folder first.');
    if (passphrase.length < 8) throw invalid('Use a passphrase of at least 8 characters.');
    const marker = readMarker(folder);
    if (marker && !marker.encryption) {
      throw invalid('This folder already holds unencrypted sync data. Choose a new, empty folder for encrypted sync.');
    }
    let key: Buffer;
    if (marker?.encryption) {
      key = deriveKey(passphrase, Buffer.from(marker.encryption.salt, 'base64'));
      try {
        if (new Sealer(key).open(Buffer.from(marker.encryption.verifier, 'base64'), MARKER).toString() !== VERIFIER) throw new Error();
      } catch {
        throw invalid('That passphrase does not match the one this sync folder was set up with.');
      }
    } else {
      mkdirSync(folder, { recursive: true });
      const salt = randomBytes(16);
      key = deriveKey(passphrase, salt);
      const verifier = new Sealer(key).seal(Buffer.from(VERIFIER), MARKER).toString('base64');
      writeMarker(folder, { version: 1, encryption: { kdf: 'scrypt', salt: salt.toString('base64'), verifier } });
    }
    this.ctx.run(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      KEY_SETTING, key.toString('hex'),
    );
  }

  get encrypted(): boolean {
    return this.ctx.get(`SELECT 1 FROM settings WHERE key = ?`, KEY_SETTING) !== undefined;
  }

  /** Forgets the key (e.g. when stopping sync); the folder's data is untouched. */
  forgetKey(): void {
    this.ctx.run(`DELETE FROM settings WHERE key = ?`, KEY_SETTING);
  }

  private sealerFor(folder: string): Sealer | null {
    const marker = readMarker(folder);
    const hex = this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, KEY_SETTING)?.value;
    if (!marker) {
      if (hex) throw invalid('The sync folder is missing its setup file. Set the passphrase again to reinitialize it.');
      mkdirSync(folder, { recursive: true });
      writeMarker(folder, { version: 1, encryption: null });
      return null;
    }
    if (marker.encryption && !hex) throw new MemoryError('locked', 'This sync folder is encrypted. Enter its passphrase to sync with it.');
    if (!marker.encryption && hex) throw invalid('This sync folder is not encrypted, but this library expects encryption. Choose the right folder or stop syncing.');
    return hex ? new Sealer(Buffer.from(hex, 'hex')) : null;
  }

  run(folder = this.settings.get('syncFolder')): SyncResult {
    if (!folder) throw invalid('Choose a sync folder first.');
    if (!this.ctx.attachmentsDir) throw invalid('In-memory libraries cannot sync.');
    this.sealer = this.sealerFor(folder);
    const dir = join(folder, 'devices', this.ctx.deviceId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(folder, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'device.json'), JSON.stringify({ deviceId: this.ctx.deviceId, name: hostname(), lastSync: this.ctx.now() }));
    let exported = this.export(folder);
    const { imported, conflicts, rejected, deferred, devices } = this.import(folder);
    // Conflict notes made while importing go out now rather than on the next run.
    exported += this.export(folder);
    this.fetchMissingBlobs(folder);
    return { exported, imported, conflicts, rejected, devices, ...(deferred > 0 && { deferred }) };
  }

  private export(folder: string): number {
    const cursor = Number(this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, EXPORTED_SEQ)?.value ?? 0);
    const changed = this.ctx.all<{ entity: Entity; entity_id: string; seq: number; actor: string }>(
      `SELECT entity, entity_id, max(seq) AS seq, actor FROM changes
       WHERE seq > ? AND device_id = ? GROUP BY entity, entity_id ORDER BY max(seq)`,
      cursor, this.ctx.deviceId,
    );
    if (changed.length === 0) return 0;
    const records: SyncRecord[] = changed.map((c) => {
      const version = this.ctx.get<{ hlc: string; synced: string | null }>(
        `SELECT hlc, synced FROM sync_versions WHERE entity = ? AND entity_id = ?`, c.entity, c.entity_id,
      )!;
      const state = this.read(c.entity, c.entity_id);
      if (c.entity === 'item' && state) this.exportBlobs(folder, state as ItemState);
      return { entity: c.entity, id: c.entity_id, hlc: version.hlc, base: version.synced, device: this.ctx.deviceId, actor: c.actor, state };
    });
    const lastSeq = Math.max(...changed.map((c) => c.seq));
    const dir = join(folder, 'devices', this.ctx.deviceId);
    // Names must only ever grow: after a backup restore the change sequence restarts lower, and peers only read
    // names past their cursor, so continue from the highest segment already in the folder.
    const highest = Math.max(0, ...readdirSync(dir).filter((f) => SEGMENT.test(f)).map((f) => Number(f.slice(0, 12))));
    const name = `${String(Math.max(lastSeq, highest + 1)).padStart(12, '0')}.ndjson`;
    // Write then rename, so a reader never sees half a segment from this device.
    writeFileSync(join(dir, `.${name}.tmp`), this.pack(Buffer.from(`${records.map((r) => JSON.stringify(r)).join('\n')}\n`), `${this.ctx.deviceId}/${name}`));
    renameSync(join(dir, `.${name}.tmp`), join(dir, name));
    this.ctx.tx(() => {
      for (const r of records) {
        this.ctx.run(`UPDATE sync_versions SET synced = hlc WHERE entity = ? AND entity_id = ?`, r.entity, r.id);
      }
      this.ctx.run(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        EXPORTED_SEQ, String(lastSeq),
      );
    });
    return records.length;
  }

  /**
   * Reads every pending segment from every device, then applies them in one global order (projects, items, relations;
   * then clock order), so an item never lands before its project just because its device folder was read first.
   * Each record applies under its own savepoint: a malformed or failing record is skipped, never a blocker.
   */
  private import(folder: string): { imported: number; conflicts: number; rejected: number; deferred: number; devices: number } {
    const devicesDir = join(folder, 'devices');
    const others = readdirSync(devicesDir).filter((d) => d !== this.ctx.deviceId && DEVICE_ID.test(d) && existsSync(join(devicesDir, d, 'device.json')));
    const records: SyncRecord[] = [];
    const segmentOf = new Map<SyncRecord, string>();
    const read = new Map<string, string[]>();
    let rejected = 0;
    for (const device of others) {
      const cursor = this.ctx.get<{ segment: string }>(`SELECT segment FROM sync_cursors WHERE device_id = ?`, device)?.segment ?? '';
      const segments = readdirSync(join(devicesDir, device)).filter((f) => SEGMENT.test(f) && f > cursor).sort();
      for (const segment of segments) {
        let lines: unknown[];
        try {
          lines = this.unpack(readFileSync(join(devicesDir, device, segment)), `${device}/${segment}`)
            .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
        } catch {
          // A cloud folder can deliver a file before it's complete; try again next run.
          break;
        }
        for (const line of lines) {
          if (isRecord(line) && line.device === device) {
            records.push(line);
            segmentOf.set(line, segment);
          } else {
            rejected++;
          }
        }
        read.set(device, [...(read.get(device) ?? []), segment]);
      }
    }
    try {
      const result = this.ctx.tx(() => {
        const applied = this.applyAll(records);
        for (const [device, segments] of read) {
          // Stop short of a segment holding a deferred record; re-reading the rest of it later is idempotent.
          const held = applied.deferred.filter((r) => r.device === device).map((r) => segmentOf.get(r)!).sort()[0];
          const done = held === undefined ? segments.at(-1) : segments.filter((s) => s < held).at(-1);
          if (done === undefined) continue;
          this.ctx.run(
            `INSERT INTO sync_cursors (device_id, segment) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET segment = excluded.segment`,
            device, done,
          );
        }
        return applied;
      });
      const { imported, conflicts, deferred } = result;
      return { imported, conflicts, rejected: rejected + result.rejected.length + deferred.length, deferred: deferred.length, devices: others.length };
    } finally {
      this.settleBlobs();
    }
  }

  /**
   * Network sync: every change this library holds after `cursor` (its own and those it applied from other devices), as
   * the same records folder sync writes. `cursor` is this library's change sequence. A server answering a pull uses the
   * default `base: 'cursor'`; a client pushing its changes uses `base: 'synced'`, the version it last exchanged.
   */
  exportChanges(cursor = 0, limit?: number, { base = 'cursor' }: { base?: 'cursor' | 'synced' } = {}): SyncPage {
    if (!Number.isInteger(cursor) || cursor < 0) throw invalid('Cursor must be a non-negative integer.');
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw invalid('Limit must be a positive integer.');
    if (base !== 'cursor' && base !== 'synced') throw invalid('Base must be "cursor" or "synced".');
    const reset = cursor > this.ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM changes`)!.seq;
    if (reset) cursor = 0;
    const page = this.ctx.all<{ seq: number }>(
      `SELECT seq FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`, cursor, Math.min(limit ?? NETWORK_PAGE, NETWORK_PAGE),
    );
    if (page.length === 0) return { records: [], nextCursor: cursor, hasMore: false, deviceId: this.ctx.deviceId, reset };
    const end = page.at(-1)!.seq;
    const changed = this.ctx.all<{ entity: Entity; entity_id: string; seq: number }>(
      `SELECT entity, entity_id, max(seq) AS seq FROM changes WHERE seq > ? AND seq <= ? GROUP BY entity, entity_id ORDER BY max(seq)`,
      cursor, end,
    );
    const records = changed.map((c): SyncRecord => {
      const last = this.ctx.get<{ device_id: string; actor: string }>(`SELECT device_id, actor FROM changes WHERE seq = ?`, c.seq)!;
      const version = this.ctx.get<{ hlc: string; synced: string | null }>(
        `SELECT hlc, synced FROM sync_versions WHERE entity = ? AND entity_id = ?`, c.entity, c.entity_id,
      )!;
      // What a peer that had read up to `cursor` holds for this entity, so it can tell an update from a concurrent edit.
      const prior = base === 'synced' ? version.synced : this.ctx.get<{ hlc: string }>(
        `SELECT hlc FROM changes WHERE entity = ? AND entity_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`, c.entity, c.entity_id, cursor,
      )?.hlc ?? null;
      return {
        entity: c.entity, id: c.entity_id, hlc: version.hlc, base: prior, device: last.device_id, actor: last.actor,
        state: this.read(c.entity, c.entity_id),
      };
    });
    const hasMore = this.ctx.get(`SELECT 1 FROM changes WHERE seq > ? LIMIT 1`, end) !== undefined;
    return { records, nextCursor: end, hasMore, deviceId: this.ctx.deviceId, reset };
  }

  /** After a peer accepted pushed records: those still at the pushed version become this library's exchanged version. */
  markSynced(records: Pick<SyncRecord, 'entity' | 'id' | 'hlc'>[]): void {
    this.ctx.tx(() => {
      for (const r of records) {
        this.ctx.run(`UPDATE sync_versions SET synced = hlc WHERE entity = ? AND entity_id = ? AND hlc = ?`, r.entity, r.id, r.hlc);
      }
    });
  }

  /**
   * Applies records from another library with the same validation and rules as folder sync. `pulled` marks records a
   * client fetched from a server that already holds everything this library exchanged with it: a local version that
   * was exchanged and not edited since is then the server's to reconcile, not a concurrent edit here.
   */
  applyChanges(records: unknown[], { pulled = false }: { pulled?: boolean } = {}): SyncApplied {
    if (!Array.isArray(records)) throw invalid('Records must be an array.');
    const malformed = new Set(records.filter((r) => !isRecord(r)));
    const valid = records.filter((r): r is SyncRecord => !malformed.has(r) && (r as SyncRecord).device !== this.ctx.deviceId);
    try {
      const { imported, conflicts, rejected, deferred } = this.ctx.tx(() => this.applyAll(valid, pulled));
      const refused = [...[...malformed].map(recordRef), ...[...rejected, ...deferred].map(recordRef)];
      return {
        imported, conflicts, rejected: refused.length,
        ...(deferred.length > 0 && { deferred: deferred.length }),
        ...(refused.length > 0 && refused.every((r) => r !== null) && { rejectedRecords: refused as SyncRecordRef[] }),
      };
    } finally {
      this.settleBlobs();
    }
  }

  /** A network sync client's bookkeeping for one server, keyed by the server's normalized address. */
  peerState(url: string): SyncPeerState | null {
    const row = this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, peerKey(url));
    return row ? (JSON.parse(row.value) as SyncPeerState) : null;
  }

  /** Null forgets the server. */
  setPeerState(url: string, state: SyncPeerState | null): void {
    if (state === null) {
      this.ctx.run(`DELETE FROM settings WHERE key = ?`, peerKey(url));
      return;
    }
    const cursor = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    const hashes = (list: unknown) => Array.isArray(list) && list.every((h) => isString(h) && SHA256_PATTERN.test(h));
    if (!cursor(state.pushedCursor) || !cursor(state.pulledCursor) || !hashes(state.uploads) || !hashes(state.downloads)
      || !(state.deviceId === null || isString(state.deviceId))
      || !(state.pendingPushes === undefined || (Array.isArray(state.pendingPushes) && state.pendingPushes.every(cursor)))
      || !(state.pendingPulls === undefined || (Array.isArray(state.pendingPulls) && state.pendingPulls.every(cursor)))) {
      throw invalid('Malformed sync peer state.');
    }
    const { deviceId, pushedCursor, pulledCursor, uploads, downloads, pendingPushes = [], pendingPulls = [] } = state;
    this.ctx.run(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      peerKey(url), JSON.stringify({
        deviceId, pushedCursor, pulledCursor, uploads: [...new Set(uploads)], downloads: [...new Set(downloads)],
        ...(pendingPushes.length > 0 && { pendingPushes: [...new Set(pendingPushes)] }),
        ...(pendingPulls.length > 0 && { pendingPulls: [...new Set(pendingPulls)] }),
      }),
    );
  }

  /** Whether this library has an attachment's bytes, is still waiting for them, or no longer refers to them at all. */
  blobStatus(sha256: string): 'stored' | 'missing' | 'unreferenced' {
    if (!SHA256_PATTERN.test(sha256)) throw invalid('Malformed attachment hash.');
    if (!this.ctx.get(`SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1`, sha256)) return 'unreferenced';
    return existsSync(blobPath(this.ctx, sha256)) ? 'stored' : 'missing';
  }

  /**
   * Attachment bytes for network sync: those of a live attachment or one item history still lists, which may wait in
   * the trash, so a peer restoring an older version can fetch them. Any other hash is unknown here.
   */
  readBlob(sha256: string): Buffer {
    const path = blobPath(this.ctx, sha256);
    if (this.ctx.get(`SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1`, sha256) || historyKeeps(this.ctx.db)(sha256)) {
      for (const candidate of [path, join(this.ctx.attachmentsDir!, TRASH_DIR, sha256)]) {
        if (existsSync(candidate)) return readFileSync(candidate);
      }
    }
    throw new MemoryError('not_found', 'This library has no file with that hash.');
  }

  /** Accepts bytes only for an attachment this library already lists, and only if they hash to its name. */
  writeBlob(sha256: string, bytes: Uint8Array): void {
    if (!SHA256_PATTERN.test(sha256)) throw invalid('Malformed attachment hash.');
    if (!this.ctx.get(`SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1`, sha256)) {
      throw new MemoryError('not_found', 'No attachment here refers to that file; sync its item first.');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw invalid('The file does not match its hash.');
    writeBlob(this.ctx, sha256, bytes);
  }

  /**
   * One global order (projects, items, relations; then clock order); each record under its own savepoint. Records
   * stamped too far ahead are returned unapplied rather than letting them outrank every later edit.
   */
  private applyAll(records: SyncRecord[], pulled = false): { imported: number; conflicts: number; rejected: SyncRecord[]; deferred: SyncRecord[] } {
    const ordered = [...records].sort((a, b) => APPLY_ORDER[a.entity] - APPLY_ORDER[b.entity] || (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    let imported = 0;
    let conflicts = 0;
    const rejected: SyncRecord[] = [];
    const deferred: SyncRecord[] = [];
    const horizon = Date.now() + MAX_CLOCK_LEAD_MS;
    this.placed = new Set();
    for (const record of ordered) {
      if (Date.parse(record.hlc.slice(0, 24)) > horizon) {
        deferred.push(record);
        continue;
      }
      this.ctx.db.exec('SAVEPOINT sync_record');
      try {
        const outcome = this.apply(record, pulled);
        this.ctx.db.exec('RELEASE sync_record');
        if (outcome !== 'skipped') imported++;
        if (outcome === 'conflict') conflicts++;
      } catch {
        this.ctx.db.exec('ROLLBACK TO sync_record');
        this.ctx.db.exec('RELEASE sync_record');
        rejected.push(record);
      }
    }
    this.resolvePending();
    this.breakCycles();
    return { imported, conflicts, rejected, deferred };
  }

  /** After the import's transaction: a removed file's bytes go to the trash, a re-added one's come back from it. */
  private settleBlobs(): void {
    const hashes = [...this.touchedBlobs];
    this.touchedBlobs.clear();
    if (this.ctx.db.isTransaction || !this.ctx.attachmentsDir) return;
    for (const sha256 of hashes) {
      if (this.ctx.get(`SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1`, sha256)) untrashBlob(this.ctx, sha256);
      else removeBlobIfUnused(this.ctx, sha256);
    }
  }

  /** Links references whose targets have since arrived. */
  private resolvePending(): void {
    for (const pending of this.ctx.all<{ kind: string; key: string; payload: string }>(`SELECT * FROM sync_pending`)) {
      const payload = JSON.parse(pending.payload) as Record<string, string>;
      if (pending.kind === 'item_project') {
        const item = this.ctx.get<{ project_id: string | null }>(`SELECT project_id FROM items WHERE id = ?`, pending.key);
        const current = this.ctx.get<{ hlc: string }>(`SELECT hlc FROM sync_versions WHERE entity = 'item' AND entity_id = ?`, pending.key)?.hlc;
        if (!item || current !== payload.hlc || item.project_id !== null) {
          this.ctx.run(`DELETE FROM sync_pending WHERE kind = ? AND key = ?`, pending.kind, pending.key);
        } else if (this.ctx.get(`SELECT 1 FROM projects WHERE id = ?`, payload.projectId!)) {
          this.ctx.run(`UPDATE items SET project_id = ? WHERE id = ?`, payload.projectId!, pending.key);
          this.ctx.run(`DELETE FROM sync_pending WHERE kind = ? AND key = ?`, pending.kind, pending.key);
        }
      } else if (pending.kind === 'item_parent') {
        const parent = this.ctx.get<{ type: string; secret: number | null }>(
          `SELECT type, json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, payload.parentId!,
        );
        const waiting = this.ctx.get(`SELECT 1 FROM items WHERE id = ? AND parent_id IS NULL`, pending.key) !== undefined;
        if (waiting && parent && canHold(parent, isSecretItem(this.ctx, pending.key))) {
          this.ctx.run(`UPDATE items SET parent_id = ? WHERE id = ?`, payload.parentId!, pending.key);
          this.placed.add(pending.key);
        }
        // A parent that was deleted will never arrive; the child stays at the top level.
        if (!waiting || parent || this.deleted(payload.parentId!)) {
          this.ctx.run(`DELETE FROM sync_pending WHERE kind = ? AND key = ?`, pending.kind, pending.key);
        }
      } else if (pending.kind === 'relation' && this.bothItemsExist(payload.from_id!, payload.to_id!)) {
        this.insertRelation(payload);
        this.ctx.run(`DELETE FROM sync_pending WHERE kind = ? AND key = ?`, pending.kind, pending.key);
      }
    }
  }

  /** Known here once and gone now: deleted, here or on another device. */
  private deleted(itemId: string): boolean {
    return this.ctx.get(`SELECT 1 FROM sync_versions WHERE entity = 'item' AND entity_id = ?`, itemId) !== undefined
      && this.ctx.get(`SELECT 1 FROM items WHERE id = ?`, itemId) === undefined;
  }

  /**
   * Moves that were each valid on their own device can form a loop together (A under B here, B under A there). Every
   * device breaks it the same way: the member with the newest version moves to the top level, as a later local move
   * that would close a loop is refused.
   */
  private breakCycles(): void {
    for (const id of this.placed) {
      for (let loop = this.loopAbove(id); loop; loop = this.loopAbove(id)) {
        const newest = loop
          .map((member) => ({
            member,
            hlc: this.ctx.get<{ hlc: string }>(`SELECT hlc FROM sync_versions WHERE entity = 'item' AND entity_id = ?`, member)?.hlc ?? '',
          }))
          .reduce((a, b) => (b.hlc > a.hlc || (b.hlc === a.hlc && b.member > a.member) ? b : a));
        const row = this.ctx.get<{ project_id: string | null; sort_order: number }>(`SELECT project_id, sort_order FROM items WHERE id = ?`, newest.member)!;
        this.asSync(() => place(this.ctx, newest.member, row.project_id, null, row.sort_order, newest.hlc || undefined));
      }
    }
  }

  /** The loop an item's ancestors run into, or null when they reach the top level. */
  private loopAbove(id: string): string[] | null {
    const path = pathToRoot(this.ctx, id);
    const next = this.ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, path.at(-1)!)?.parent_id;
    return next ? path.slice(path.indexOf(next)) : null;
  }

  /** Repairs sync makes by itself (adopting orphans, breaking loops) are attributed to `sync`. */
  private asSync(fn: () => void): void {
    const actor = this.ctx.actor;
    this.ctx.actor = 'sync';
    try {
      fn();
    } finally {
      this.ctx.actor = actor;
    }
  }

  private defer(kind: string, key: string, payload: object): void {
    this.ctx.run(
      `INSERT INTO sync_pending (kind, key, payload) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload`,
      kind, key, JSON.stringify(payload),
    );
  }

  private apply(record: SyncRecord, pulled: boolean): 'applied' | 'conflict' | 'skipped' {
    this.ctx.observe(record.hlc);
    const local = this.ctx.get<{ hlc: string; synced: string | null }>(
      `SELECT hlc, synced FROM sync_versions WHERE entity = ? AND entity_id = ?`, record.entity, record.id,
    );
    if (local && local.hlc >= record.hlc) return local.hlc !== record.hlc && this.keepLosingItem(record) ? 'conflict' : 'skipped';
    if (record.entity === 'item') {
      this.guardDecision(record);
      this.guardSecret(record);
    }
    // The writer hadn't seen our latest version: both sides changed it since they last agreed.
    const concurrent = local !== undefined && record.base !== local.hlc && !(pulled && local.synced === local.hlc);
    const preserved = concurrent ? this.preserveLosingText(record) : false;

    const origin = { deviceId: record.device, actor: record.actor, hlc: record.hlc };
    if (record.entity === 'item') this.applyItem(record.id, record.state as ItemState | null, record.hlc);
    else if (record.entity === 'project') this.applyProject(record.state as Record<string, SQLInputValue> | null);
    else this.applyRelation(record.id, record.state as Record<string, SQLInputValue> | null);
    const projectId = record.entity === 'item' ? ((record.state as ItemState | null)?.item.project_id as string | null) ?? null
      : record.entity === 'project' ? record.id : null;
    this.ctx.record(record.entity, record.id, record.state ? 'sync' : 'delete', projectId, null, origin);
    return preserved ? 'conflict' : 'applied';
  }

  /** Decisions are append-only everywhere: another device may add one, never rewrite or delete one this library holds. */
  private guardDecision(record: SyncRecord): void {
    const mine = this.ctx.get<{ type: string; title: string; body: string; project_id: string | null; content: string }>(
      `SELECT type, title, body, project_id, content FROM items WHERE id = ?`, record.id,
    );
    if (mine?.type !== 'decision') return;
    const waiting = this.ctx.get<{ payload: string }>(`SELECT payload FROM sync_pending WHERE kind = 'item_project' AND key = ?`, record.id);
    const projectId = mine.project_id ?? (waiting ? (JSON.parse(waiting.payload) as { projectId: string }).projectId : null);
    const theirs = (record.state as ItemState | null)?.item;
    if (!theirs || theirs.type !== 'decision' || theirs.title !== mine.title || theirs.body !== mine.body
      || (theirs.project_id ?? null) !== projectId || theirs.content !== mine.content) {
      throw invalid('Decisions cannot be changed or deleted by sync. Record a new decision that supersedes it instead.');
    }
  }

  /** A secret note never turns back into readable text by sync; its ciphertext would be replaced by plaintext. */
  private guardSecret(record: SyncRecord): void {
    const state = record.state as ItemState | null;
    if (state && isSecretItem(this.ctx, record.id) && vaultData(state.item.metadata) === null) {
      throw invalid('A secret note can’t stop being secret through sync.');
    }
  }

  // A skipped older edit must stay recoverable, including ciphertext bound to its original id.
  private keepLosingItem(record: SyncRecord): boolean {
    if (record.entity !== 'item' || !record.state) return false;
    const state = record.state as ItemState;
    if (state.item.type === 'decision') return false;
    const data = vaultData(state.item.metadata);
    if (this.ctx.get(`SELECT 1 FROM items WHERE id = ?`, record.id) && isSecretItem(this.ctx, record.id) !== (data !== null)) return false;
    const known = data ? this.ctx.get(
      `SELECT 1 FROM item_versions WHERE item_id = ? AND json_extract(json_extract(state, '$.item.metadata'), '$.vault.data') = ? LIMIT 1`,
      record.id, data,
    ) ?? this.ctx.get(`SELECT 1 FROM items WHERE id = ? AND json_extract(metadata, '$.vault.data') = ?`, record.id, data)
      : this.ctx.get(
        `SELECT 1 FROM item_versions WHERE item_id = ? AND json_extract(state, '$.item.title') = ? AND json_extract(state, '$.item.body') = ? LIMIT 1`,
        record.id, state.item.title ?? '', state.item.body ?? '',
      ) ?? this.ctx.get(`SELECT 1 FROM items WHERE id = ? AND title = ? AND body = ?`, record.id, state.item.title ?? '', state.item.body ?? '');
    if (known) return false;
    keepConflictVersion(this.ctx, state, record.actor);
    return true;
  }

  /** Keeps our side of a concurrent edit to a note body or a project memory as its own note. */
  private preserveLosingText(record: SyncRecord): boolean {
    if (record.entity === 'item') {
      const mine = this.ctx.get<{ title: string; body: string; project_id: string | null; type: string; metadata: string }>(
        `SELECT title, body, project_id, type, metadata FROM items WHERE id = ?`, record.id,
      );
      const theirs = (record.state as ItemState | null)?.item;
      // A secret's text is ciphertext bound to its id; our side stays recoverable from the item's own history.
      const sealed = mine ? vaultData(mine.metadata) : null;
      if (sealed) return sealed !== vaultData(theirs?.metadata);
      if (!mine || !mine.body || mine.body === theirs?.body) return false;
      const copy = this.items.insert({
        type: 'note',
        title: `Conflicting edit of ${mine.title || 'an untitled note'}`,
        body: mine.body,
        project: mine.project_id ?? undefined,
      });
      if (theirs) this.items.link(copy, record.id, 'related_to', mine.project_id);
      return true;
    }
    if (record.entity === 'project') {
      const mine = this.ctx.get<{ name: string; memory: string }>(`SELECT name, memory FROM projects WHERE id = ?`, record.id);
      const theirs = record.state as Record<string, SQLInputValue> | null;
      if (!mine || !mine.memory || mine.memory === theirs?.memory) return false;
      this.items.insert({ type: 'note', title: `Conflicting edit of the ${mine.name} memory`, body: mine.memory, project: record.id });
      return true;
    }
    return false;
  }

  private read(entity: Entity, id: string): SyncRecord['state'] {
    if (entity === 'project') {
      return this.ctx.get<Record<string, SQLInputValue>>(`SELECT ${PROJECT_FIELDS.join(', ')} FROM projects WHERE id = ?`, id) ?? null;
    }
    if (entity === 'relation') {
      return this.ctx.get<Record<string, SQLInputValue>>(`SELECT id, from_id, to_id, kind, created_at FROM relations WHERE id = ?`, id) ?? null;
    }
    const state = readItemState(this.ctx, id);
    // A parent still on its way here is part of the item's state; editing it meanwhile mustn't unnest it everywhere.
    const waiting = this.ctx.get<{ payload: string }>(`SELECT payload FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, id);
    if (state && waiting) state.item.parent_id = (JSON.parse(waiting.payload) as { parentId: string }).parentId;
    return state;
  }

  private applyItem(id: string, state: ItemState | null, hlc: string): void {
    if (!state) {
      for (const { sha256 } of this.ctx.all<{ sha256: string }>(`SELECT sha256 FROM attachments WHERE item_id = ?`, id)) this.touchedBlobs.add(sha256);
      // Children nested here since the deleting device last synced would otherwise point at nothing.
      this.asSync(() => adoptChildren(this.ctx, id, hlc));
      this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, id);
      this.ctx.run(`DELETE FROM items WHERE id = ?`, id);
      return;
    }
    const item = { ...state.item };
    if (item.project_id && !this.ctx.get(`SELECT 1 FROM projects WHERE id = ?`, item.project_id)) {
      this.defer('item_project', id, { projectId: item.project_id, hlc });
      item.project_id = null;
    }
    if (!('sort_order' in item)) {
      // From a build that predates nesting: keep the placement this device knows, or file it by creation time.
      const local = this.ctx.get<{ parent_id: string | null; sort_order: number }>(`SELECT parent_id, sort_order FROM items WHERE id = ?`, id);
      item.parent_id = local?.parent_id ?? null;
      item.sort_order = local?.sort_order ?? defaultSortKey(this.ctx, item.created_at ?? null);
    } else {
      this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, id);
      item.parent_id = this.parentFor(id, item.type as string, item.parent_id as string | null, vaultData(item.metadata) !== null);
    }
    if (item.parent_id !== null) this.placed.add(id);
    upsert(this.ctx, 'items', ITEM_FIELDS, item);
    if (vaultData(item.metadata) !== null) this.releaseOrdinaryChildren(id, hlc);
    writeTagsAndTask(this.ctx, id, state);
    const keep = new Set(state.attachments.map((a) => a.id as string));
    for (const old of this.ctx.all<{ id: string; sha256: string }>(`SELECT id, sha256 FROM attachments WHERE item_id = ?`, id)) {
      if (keep.has(old.id)) continue;
      this.ctx.run(`DELETE FROM attachments WHERE id = ?`, old.id);
      this.touchedBlobs.add(old.sha256);
    }
    for (const attachment of state.attachments) {
      upsert(this.ctx, 'attachments', ATTACHMENT_FIELDS, { ...attachment, item_id: id });
      this.touchedBlobs.add(attachment.sha256 as string);
    }
  }

  /**
   * A secret holds only secrets, so ordinary children of an item that arrived secret take its place under its nearest
   * ordinary ancestor, stamped after the cause as when a parent is deleted.
   */
  private releaseOrdinaryChildren(id: string, hlc: string): void {
    const children = this.ctx.all<{ id: string; project_id: string | null }>(
      `SELECT id, project_id FROM items WHERE parent_id = ? AND coalesce(json_extract(metadata, '$.secret'), 0) = 0 ORDER BY sort_order, id`, id,
    );
    if (children.length === 0) return;
    const path = pathToRoot(this.ctx, id);
    const at = path.findIndex((ancestor, i) => i > 0 && !isSecretItem(this.ctx, ancestor));
    const parentId = at === -1 ? null : path[at]!;
    const anchor = at === -1 ? path.at(-1)! : path[at - 1]!;
    this.asSync(() => {
      const keys = slots(this.ctx, parentId, anchor, children.length, children.map((c) => c.id), hlc);
      children.forEach((child, i) => place(this.ctx, child.id, child.project_id, parentId, keys[i]!, hlc));
    });
  }

  /** The parent a synced item can have here: none for decisions, under a decision, ordinary under a secret, or yet if it hasn't arrived. */
  private parentFor(id: string, type: string, parentId: string | null, secret: boolean): string | null {
    if (parentId === null || type === 'decision') return null;
    const parent = this.ctx.get<{ type: string; secret: number | null }>(
      `SELECT type, json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, parentId,
    );
    if (parent) return canHold(parent, secret) ? parentId : null;
    if (!this.deleted(parentId)) this.defer('item_parent', id, { parentId });
    return null;
  }

  private applyProject(state: Record<string, SQLInputValue> | null): void {
    if (!state) return;
    const project = { ...state };
    // Two devices can each create "Garage" before they first sync; keep both rather than merging blindly.
    const clash = this.ctx.get<{ id: string }>(`SELECT id FROM projects WHERE slug = ? AND id != ?`, project.slug!, project.id!);
    if (clash) {
      let n = 2;
      while (this.ctx.get(`SELECT 1 FROM projects WHERE slug = ? AND id != ?`, `${project.slug}-${n}`, project.id!)) n++;
      project.slug = `${project.slug}-${n}`;
      project.name = `${project.name} (${n})`;
    }
    upsert(this.ctx, 'projects', PROJECT_FIELDS, project);
  }

  /** A null state is a removed connection. Supersedes links belong to the decision log and are never removed. */
  private applyRelation(id: string, state: Record<string, SQLInputValue> | null): void {
    if (!state) {
      this.ctx.run(`DELETE FROM relations WHERE id = ? AND kind != 'supersedes'`, id);
      this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'relation' AND key = ?`, id);
      return;
    }
    if (this.bothItemsExist(state.from_id as string, state.to_id as string)) this.insertRelation(state);
    else this.defer('relation', state.id as string, state);
  }

  private bothItemsExist(from: string, to: string): boolean {
    return (this.ctx.get<{ n: number }>(`SELECT count(*) AS n FROM items WHERE id IN (?, ?)`, from, to)!).n === 2;
  }

  private insertRelation(state: Record<string, SQLInputValue>): void {
    this.ctx.run(
      `INSERT INTO relations (id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      state.id!, state.from_id!, state.to_id!, state.kind!, state.created_at!,
    );
  }

  private pack(plain: Buffer, name: string): Buffer {
    return this.sealer ? this.sealer.seal(plain, name) : plain;
  }

  private unpack(stored: Buffer, name: string): Buffer {
    return this.sealer ? this.sealer.open(stored, name) : stored;
  }

  private exportBlobs(folder: string, state: ItemState): void {
    for (const attachment of state.attachments) {
      const target = join(folder, 'blobs', attachment.sha256 as string);
      const source = blobPath(this.ctx, attachment.sha256 as string);
      if (!existsSync(target) && existsSync(source)) {
        writeFileSync(`${target}.tmp`, this.pack(readFileSync(source), `blobs/${attachment.sha256 as string}`));
        renameSync(`${target}.tmp`, target);
      }
    }
  }

  /** Attachment rows can arrive before their bytes do; fill them in whenever the folder has them. */
  private fetchMissingBlobs(folder: string): void {
    for (const { sha256 } of this.ctx.all<{ sha256: string }>(`SELECT DISTINCT sha256 FROM attachments`)) {
      const local = blobPath(this.ctx, sha256);
      const remote = join(folder, 'blobs', sha256);
      if (existsSync(local) || !existsSync(remote)) continue;
      let bytes: Buffer;
      try {
        bytes = this.unpack(readFileSync(remote), `blobs/${sha256}`);
      } catch {
        continue;
      }
      // A partly downloaded or tampered file must not become the attachment; try again next run.
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) continue;
      mkdirSync(join(local, '..'), { recursive: true });
      writeFileSync(`${local}.tmp`, bytes);
      renameSync(`${local}.tmp`, local);
    }
  }
}

function readMarker(folder: string): Marker | null {
  const path = join(folder, MARKER);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Marker) : null;
}

function writeMarker(folder: string, marker: Marker): void {
  writeFileSync(join(folder, `.${MARKER}.tmp`), JSON.stringify(marker, null, 2));
  renameSync(join(folder, `.${MARKER}.tmp`), join(folder, MARKER));
}

/** A refused record's identity, or null when it's too malformed to name. */
function recordRef(value: unknown): SyncRecordRef | null {
  if (!isObject(value)) return null;
  const { entity, id, hlc } = value;
  return (entity === 'item' || entity === 'project' || entity === 'relation') && isId(id) && isString(hlc) && HLC_PATTERN.test(hlc)
    ? { entity, id, hlc } : null;
}

const peerKey = (url: string) => `sync.peer.${createHash('sha256').update(url).digest('hex')}`;

/** The ciphertext in a secret item's metadata, or null for anything else. */
function vaultData(metadata: SQLInputValue | undefined): string | null {
  if (typeof metadata !== 'string') return null;
  try {
    const parsed = JSON.parse(metadata) as { secret?: unknown; vault?: { data?: unknown } } | null;
    return parsed?.secret === true && typeof parsed.vault?.data === 'string' ? parsed.vault.data : null;
  } catch {
    return null;
  }
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown) => value === undefined || value === null || isString(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => isString(value) && DEVICE_ID.test(value);
const includes = (list: readonly unknown[], value: unknown) => list.includes(value);
const ITEM_TIMES = ['archived_at', 'pinned_at', 'opened_at', 'remind_at', 'reminded_at'];
// Core writes every time with toISOString(); clients decode these as dates, so one bad value would break a whole page.
const isTimestamp = (value: unknown) => isString(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isDay = (value: unknown) => isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const METADATA_OBJECTS = ['presentation', 'ingest', 'ai', 'organized', 'importedFrom'];

// Peer records must preserve storage, secret and client decoding invariants.
function isRecord(value: unknown): value is SyncRecord {
  if (!isObject(value)) return false;
  const r = value;
  if (r.entity !== 'item' && r.entity !== 'project' && r.entity !== 'relation') return false;
  if (!isId(r.id) || !isId(r.device) || !isString(r.actor)) return false;
  if (!isString(r.hlc) || !HLC_PATTERN.test(r.hlc) || Number.isNaN(Date.parse(r.hlc.slice(0, 24)))) return false;
  if (r.base !== null && !(isString(r.base) && HLC_PATTERN.test(r.base))) return false;
  if (r.state === null) return true;
  if (!isObject(r.state)) return false;
  const state = r.state;
  if (r.entity === 'project') {
    return state.id === r.id && isString(state.name) && state.name.trim() !== '' && isString(state.slug) && state.slug !== ''
      && slugify(state.slug) === state.slug && [state.description, state.instructions, state.memory].every(isString)
      && includes(PROJECT_STATUSES, state.status) && isTimestamp(state.created_at) && isTimestamp(state.updated_at);
  }
  if (r.entity === 'relation') {
    return state.id === r.id && isId(state.from_id) && isId(state.to_id) && state.from_id !== state.to_id
      && includes(RELATION_KINDS, state.kind) && isTimestamp(state.created_at);
  }
  const item = state.item;
  if (!isObject(item) || item.id !== r.id || !includes(ITEM_TYPES, item.type)) return false;
  if (![item.title, item.body, item.metadata, item.source].every(isString) || !isTimestamp(item.created_at) || !isTimestamp(item.updated_at)) return false;
  if (!isOptionalString(item.content) || !isOptionalString(item.url) || !ITEM_TIMES.every((f) => item[f] == null || isTimestamp(item[f]))) return false;
  if (item.intent != null && !includes(INTENTS, item.intent)) return false;
  if (item.project_id != null && !isId(item.project_id)) return false;
  // Records from builds before nesting carry neither field; anything else must be a finite key and a real other item.
  if (('parent_id' in item || 'sort_order' in item)
    && !(isSortKey(item.sort_order) && (item.parent_id === null || (isId(item.parent_id) && item.parent_id !== r.id)))) return false;
  const secret = secretShape(item);
  if (secret === null) return false;
  if (!Array.isArray(state.tags) || !state.tags.every((t) => isString(t) && safeTag(t) === t)) return false;
  const task = state.task ?? null;
  if ((task !== null) !== (item.type === 'task') || (task !== null && !isTask(task))) return false;
  return Array.isArray(state.attachments) && state.attachments.every((a) => isObject(a)
    && isId(a.id) && isString(a.sha256) && SHA256_PATTERN.test(a.sha256)
    && isString(a.filename) && a.filename !== '' && basename(a.filename) === a.filename && a.filename !== '..' && !a.filename.includes('\\')
    && isString(a.mime_type) && Number.isSafeInteger(a.size) && (a.size as number) >= 0 && isTimestamp(a.created_at)
    && (!secret || (a.filename === SEALED_FILE_NAME && a.mime_type === SEALED_FILE_MIME)));
}

/** Whether an item's metadata is a well-formed secret (true), a well-formed ordinary item (false), or neither (null). */
function secretShape(item: Record<string, unknown>): boolean | null {
  let metadata: unknown;
  try {
    metadata = JSON.parse(item.metadata as string);
  } catch {
    return null;
  }
  if (!isObject(metadata)) return null;
  if (METADATA_OBJECTS.some((key) => metadata[key] != null && !isObject(metadata[key]))) return null;
  if (isObject(metadata.presentation)) {
    try {
      validPresentationPatch(Object.fromEntries(Object.entries(metadata.presentation).filter(([key]) => key in DEFAULT_PRESENTATION)));
    } catch {
      return null;
    }
  }
  if (metadata.secret === true) return isSealedItem(item) ? true : null;
  return (metadata.secret === undefined || metadata.secret === false) && metadata.vault === undefined ? false : null;
}

function isTask(task: unknown): boolean {
  if (!isObject(task) || !includes(TASK_STATUSES, task.status) || !includes([1, 2, 3], task.priority)) return false;
  if (!(task.due_at == null || isDay(task.due_at) || isTimestamp(task.due_at))) return false;
  if (!(task.completed_at == null || isTimestamp(task.completed_at))) return false;
  return task.status === 'done' || task.completed_at == null;
}

function safeTag(tag: string): string | null {
  try {
    return normalizeTag(tag);
  } catch {
    return null;
  }
}
