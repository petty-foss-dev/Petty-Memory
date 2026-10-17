import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { historyKeeps, reconcileBlobs } from './blobs.ts';
import { type Context, newId } from './context.ts';
import { transaction } from './db.ts';
import { MemoryError, invalid } from './errors.ts';
import { MIGRATIONS } from './migrations.ts';
import type { MemoryPaths } from './paths.ts';

export const BACKUP_KINDS = ['hourly', 'daily', 'monthly', 'manual', 'pre-restore', 'pre-migration'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface Backup {
  file: string;
  path: string;
  kind: BackupKind;
  createdAt: string;
  size: number;
}

const SCHEDULE: { kind: BackupKind; everyMs: number; keep: number }[] = [
  { kind: 'hourly', everyMs: 3_600_000, keep: 24 },
  { kind: 'daily', everyMs: 86_400_000, keep: 30 },
  { kind: 'monthly', everyMs: 30 * 86_400_000, keep: 12 },
];
const KEEP_OTHER = 10;

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
const FILE_PATTERN = /^(hourly|daily|monthly|manual|pre-restore|pre-migration)(?:-v\d+)?-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;

function parseStamp(value: string): string {
  const [date, time] = value.split('T') as [string, string];
  const [h, m, s, ms] = time.replace('Z', '').split('-');
  return `${date}T${h}:${m}:${s}.${ms}Z`;
}

export function listBackups(dir: string): Backup[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => ({ file, match: FILE_PATTERN.exec(file) }))
    .filter((f): f is { file: string; match: RegExpExecArray } => f.match !== null)
    .map(({ file, match }) => ({
      file,
      path: join(dir, file),
      kind: match[1] as BackupKind,
      createdAt: parseStamp(match[2]!),
      size: statSync(join(dir, file)).size,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Snapshots use VACUUM INTO: a consistent, compacted copy taken while the library stays open. */
export class BackupService {
  private readonly ctx: Context;
  private readonly paths: MemoryPaths | null;

  constructor(ctx: Context, paths: MemoryPaths | null) {
    this.ctx = ctx;
    this.paths = paths;
  }

  list(): Backup[] {
    return this.paths ? listBackups(this.paths.backups) : [];
  }

  create(kind: BackupKind = 'manual', now = new Date()): Backup {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const file = `${kind}-${stamp(now)}.sqlite`;
    this.ctx.db.prepare('VACUUM INTO ?').run(join(dir, file));
    return this.list().find((b) => b.file === file)!;
  }

  /** Takes whichever scheduled snapshots are due and prunes old ones. Cheap to call every few minutes. */
  runSchedule(now = new Date()): Backup[] {
    const existing = this.list();
    const created: Backup[] = [];
    for (const { kind, everyMs } of SCHEDULE) {
      const latest = existing.find((b) => b.kind === kind);
      if (!latest || now.getTime() - Date.parse(latest.createdAt) >= everyMs) created.push(this.create(kind, now));
    }
    this.prune();
    if (this.paths) reconcileBlobs(this.paths.attachments, this.referencedBlobs(), now.getTime(), historyKeeps(this.ctx.db));
    return created;
  }

  prune(): void {
    const all = this.list();
    for (const kind of new Set(all.map((b) => b.kind))) {
      const keep = SCHEDULE.find((s) => s.kind === kind)?.keep ?? KEEP_OTHER;
      for (const old of all.filter((b) => b.kind === kind).slice(keep)) rmSync(old.path, { force: true });
    }
  }

  private referencedBlobs(): Set<string> {
    return new Set(this.ctx.all<{ sha256: string }>(`SELECT DISTINCT sha256 FROM attachments`).map((r) => r.sha256));
  }

  private dir(): string {
    if (!this.paths) throw invalid('In-memory libraries have no backups.');
    return this.paths.backups;
  }
}

/** Checks a snapshot is a sound Petty Memory library this build can open. */
export function verifyBackup(path: string): { schemaVersion: number } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw invalid(`${path} is not a readable SQLite file.`);
  }
  try {
    let integrity: { integrity_check: string };
    try {
      integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    } catch {
      throw invalid(`${path} is not a readable SQLite file.`);
    }
    if (integrity.integrity_check !== 'ok') throw invalid(`${path} failed its integrity check: ${integrity.integrity_check}`);
    const schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (schemaVersion > MIGRATIONS.length) {
      throw new MemoryError('schema', `${path} was written by a newer Petty Memory (schema ${schemaVersion}).`);
    }
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'items'`).get()) throw invalid(`${path} is not a Petty Memory library.`);
    return { schemaVersion };
  } finally {
    db.close();
  }
}

/**
 * Replaces the library with a snapshot. The current library is snapshotted first, so a restore can itself be undone.
 * Every process using the library must be closed: the desktop app, `serve`, and MCP servers.
 */
export function restoreBackup(paths: MemoryPaths, snapshot: string, now = new Date()): { saved: string } {
  verifyBackup(snapshot);
  mkdirSync(paths.backups, { recursive: true });
  const saved = join(paths.backups, `pre-restore-${stamp(now)}.sqlite`);
  if (existsSync(paths.database)) {
    const current = new DatabaseSync(paths.database);
    try {
      current.prepare('VACUUM INTO ?').run(saved);
    } finally {
      current.close();
    }
  }
  for (const suffix of ['-wal', '-shm']) rmSync(paths.database + suffix, { force: true });
  copyFileSync(snapshot, paths.database);
  const restored = new DatabaseSync(paths.database);
  try {
    // A new writer identity makes peers detect a rewind even after new edits reuse old change numbers.
    transaction(restored, () => {
      restored.prepare(`INSERT INTO settings (key, value) VALUES ('device_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(newId());
      restored.prepare(`DELETE FROM settings WHERE key LIKE 'sync.peer.%' OR key = 'sync.exported_seq'`).run();
      if (restored.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sync_cursors'`).get()) restored.exec(`DELETE FROM sync_cursors`);
    });
    const referenced = new Set((restored.prepare('SELECT DISTINCT sha256 FROM attachments').all() as { sha256: string }[]).map((r) => r.sha256));
    reconcileBlobs(paths.attachments, referenced, now.getTime(), historyKeeps(restored));
  } finally {
    restored.close();
  }
  return { saved };
}
