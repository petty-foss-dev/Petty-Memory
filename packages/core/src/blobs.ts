import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from './context.ts';
import { MemoryError } from './errors.ts';
import type { Attachment } from './types.ts';

export interface AttachmentRow {
  id: string;
  item_id: string;
  sha256: string;
  filename: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  sha256: row.sha256,
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
  createdAt: row.created_at,
});

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Content-addressed: attachments/ab/abcdef…, so identical files are stored once. */
export function blobPath(ctx: Context, sha256: string): string {
  if (!ctx.attachmentsDir) throw new MemoryError('invalid', 'Files need an on-disk library.');
  // The hash becomes a path, and synced rows come from other machines: never let it be anything but a hash.
  if (!SHA256_PATTERN.test(sha256)) throw new MemoryError('invalid', 'Malformed attachment hash.');
  return join(ctx.attachmentsDir, sha256.slice(0, 2), sha256);
}

/** Unreferenced blobs wait here for the life of the daily backups, so restoring a recent snapshot finds its files. */
export const TRASH_DIR = '.trash';
export const TRASH_DAYS = 30;

export function writeBlob(ctx: Context, sha256: string, data: Uint8Array): void {
  const path = blobPath(ctx, sha256);
  if (existsSync(path)) return;
  const trashed = join(ctx.attachmentsDir!, TRASH_DIR, sha256);
  if (existsSync(trashed)) {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(trashed, path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

/** Brings a blob back from the trash, if it's still there, when a restore refers to it again. */
export function untrashBlob(ctx: Context, sha256: string): void {
  if (!ctx.attachmentsDir) return;
  const path = blobPath(ctx, sha256);
  const trashed = join(ctx.attachmentsDir, TRASH_DIR, sha256);
  if (existsSync(path) || !existsSync(trashed)) return;
  mkdirSync(dirname(path), { recursive: true });
  renameSync(trashed, path);
}

export function removeBlobIfUnused(ctx: Context, sha256: string): void {
  if (!ctx.attachmentsDir) return;
  if (ctx.get(`SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1`, sha256)) return;
  const path = blobPath(ctx, sha256);
  if (!existsSync(path)) return;
  const trash = join(ctx.attachmentsDir, TRASH_DIR);
  mkdirSync(trash, { recursive: true });
  renameSync(path, join(trash, sha256));
  const now = new Date();
  utimesSync(join(trash, sha256), now, now);
}

/** Whether a kept item version still lists the file, so its bytes must outlive the trash for that version to be restorable. */
export function historyKeeps(db: DatabaseSync): (sha256: string) => boolean {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'item_versions'`).get()) return () => false;
  const statement = db.prepare(
    `SELECT 1 FROM item_versions v, json_each(v.state, '$.attachments') a
     WHERE v.state IS NOT NULL AND instr(v.state, ?) > 0 AND json_extract(a.value, '$.sha256') = ? LIMIT 1`,
  );
  return (sha256) => statement.get(sha256, sha256) !== undefined;
}

/**
 * Brings back trashed blobs a restored database refers to, and empties trash older than TRASH_DAYS, except for bytes
 * item history still refers to: those stay in the trash until a restore brings them back.
 */
export function reconcileBlobs(
  attachmentsDir: string, referenced: Set<string>, now = Date.now(), retained: (sha256: string) => boolean = () => false,
): { restored: number; purged: number } {
  const trash = join(attachmentsDir, TRASH_DIR);
  if (!existsSync(trash)) return { restored: 0, purged: 0 };
  let restored = 0;
  let purged = 0;
  for (const name of readdirSync(trash)) {
    if (!SHA256_PATTERN.test(name)) continue;
    const path = join(trash, name);
    if (referenced.has(name)) {
      const target = join(attachmentsDir, name.slice(0, 2), name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(path, target);
      restored++;
    } else if (now - statSync(path).mtimeMs > TRASH_DAYS * 86_400_000 && !retained(name)) {
      rmSync(path, { force: true });
      purged++;
    }
  }
  return { restored, purged };
}
