import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { invalid } from './errors.ts';
import type { Change, Intent, Item, ItemMetadata, ItemType, TaskFields, TaskPriority, TaskStatus } from './types.ts';

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, then random bits. Node 24 (Electron's runtime) lacks crypto.randomUUIDv7. */
export function newId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An id a client generated ahead of time. */
export function clientId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V7.test(value)) throw invalid(`${label} must be a lowercase UUIDv7.`);
  return value;
}

type Captured = Map<string, { op: string; actor: string }>;

export class Context {
  readonly db: DatabaseSync;
  readonly deviceId: string;
  actor: string;
  private readonly statements = new Map<string, StatementSync>();

  /** Null for in-memory libraries, which can't hold files. */
  readonly attachmentsDir: string | null;
  private clock: { at: string; counter: number };

  constructor(db: DatabaseSync, actor: string, attachmentsDir: string | null) {
    this.db = db;
    this.actor = actor;
    this.attachmentsDir = attachmentsDir;
    this.deviceId = this.loadDeviceId();
    const ceiling = new Date(Date.now() + MAX_CLOCK_LEAD_MS).toISOString();
    const latest = this.get<{ hlc: string | null }>(`SELECT max(hlc) AS hlc FROM changes WHERE substr(hlc, 1, 24) <= ?`, ceiling)?.hlc;
    this.clock = latest ? parseHlc(latest) : { at: '', counter: 0 };
  }

  /** Next hybrid logical clock stamp: never behind any stamp seen before, even if the wall clock is. */
  tick(): string {
    const now = this.now();
    if (now > this.clock.at) this.clock = { at: now, counter: 0 };
    else if (this.clock.counter < MAX_COUNTER) this.clock = { at: this.clock.at, counter: this.clock.counter + 1 };
    else this.clock = { at: new Date(Date.parse(this.clock.at) + 1).toISOString(), counter: 0 };
    return formatHlc(this.clock, this.deviceId);
  }

  /**
   * Advances the clock past a stamp from another device. A stamp far in the future (a peer with a badly wrong clock)
   * is not followed, or it would drag every device's clock along with it.
   */
  observe(hlc: string): void {
    const seen = parseHlc(hlc);
    if (Date.parse(seen.at) - Date.now() > MAX_CLOCK_LEAD_MS) return;
    if (seen.at > this.clock.at || (seen.at === this.clock.at && seen.counter > this.clock.counter)) this.clock = seen;
  }

  now(): string {
    return new Date().toISOString();
  }

  stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.stmt(sql).run(...params);
  }

  /** Set by EnveMemory: snapshots the items and projects changed in a transaction, once, just before it commits. */
  captureVersions: ((items: Captured, projects: Captured) => void) | null = null;
  private changed: Captured = new Map();
  private changedProjects: Captured = new Map();

  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    try {
      return transaction(this.db, () => {
        const result = fn();
        this.flushVersions();
        return result;
      });
    } finally {
      this.changed.clear();
      this.changedProjects.clear();
    }
  }

  private flushVersions(): void {
    if (this.changed.size === 0 && this.changedProjects.size === 0) return;
    const { changed, changedProjects } = this;
    this.changed = new Map();
    this.changedProjects = new Map();
    this.captureVersions?.(changed, changedProjects);
  }

  /** `origin` is set only when applying another device's change during sync. */
  record(
    entity: Change['entity'], entityId: string, op: string, projectId: string | null, data: object | null = null,
    origin?: { deviceId: string; actor: string; hlc: string },
  ): void {
    const hlc = origin?.hlc ?? this.tick();
    this.log(entity, entityId, op, projectId, data, origin?.deviceId ?? this.deviceId, origin?.actor ?? this.actor, hlc, origin ? hlc : null);
  }

  /**
   * A repair sync makes by itself, stamped just after `cause` and the entity's current version rather than now, so an
   * edit any device made after the cause still wins over the repair when it arrives.
   */
  recordAfter(cause: string, entity: Change['entity'], entityId: string, op: string, projectId: string | null, data: object): void {
    const current = this.get<{ hlc: string }>(`SELECT hlc FROM sync_versions WHERE entity = ? AND entity_id = ?`, entity, entityId)?.hlc;
    const { at, counter } = parseHlc(current && current > cause ? current : cause);
    const next = counter < MAX_COUNTER ? { at, counter: counter + 1 } : { at: new Date(Date.parse(at) + 1).toISOString(), counter: 0 };
    this.log(entity, entityId, op, projectId, data, this.deviceId, this.actor, formatHlc(next, this.deviceId), null);
  }

  private log(
    entity: Change['entity'], entityId: string, op: string, projectId: string | null, data: object | null,
    deviceId: string, actor: string, hlc: string, synced: string | null,
  ): void {
    this.run(
      `INSERT INTO changes (id, device_id, actor, entity, entity_id, op, project_id, data, at, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), deviceId, actor, entity, entityId, op, projectId, data === null ? null : JSON.stringify(data), this.now(), hlc,
    );
    this.run(
      `INSERT INTO sync_versions (entity, entity_id, hlc, synced) VALUES (?, ?, ?, ?)
       ON CONFLICT (entity, entity_id) DO UPDATE SET hlc = excluded.hlc, synced = coalesce(excluded.synced, sync_versions.synced)`,
      entity, entityId, hlc, synced,
    );
    if (entity === 'item' && !UNVERSIONED_OPS.has(op) && !this.changed.has(entityId)) this.changed.set(entityId, { op, actor });
    if (entity === 'project' && (!this.changedProjects.has(entityId) || MEMORY_OPS.has(op))) this.changedProjects.set(entityId, { op, actor });
    if (!this.db.isTransaction) this.flushVersions();
  }

  private loadDeviceId(): string {
    const row = this.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'device_id'`);
    if (row) return row.value;
    const id = newId();
    this.run(`INSERT INTO settings (key, value) VALUES ('device_id', ?)`, id);
    return id;
  }
}

// Bookkeeping, not edits: opening an item or delivering its reminder isn't worth a version.
const UNVERSIONED_OPS = new Set(['open', 'reminded']);
const MEMORY_OPS = new Set(['set_memory', 'sync']);

const MAX_COUNTER = 999_999;
export const MAX_CLOCK_LEAD_MS = 5 * 60_000;

/** ISO time, a 6-digit counter and the device: fixed width up to the device, so plain string order is clock order. */
export const HLC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-(\d{6})-([\w-]{1,64})$/;

export function formatHlc({ at, counter }: { at: string; counter: number }, deviceId: string): string {
  return `${at}-${String(counter).padStart(6, '0')}-${deviceId}`;
}

export function parseHlc(hlc: string): { at: string; counter: number } {
  const match = HLC_PATTERN.exec(hlc);
  if (!match) throw invalid(`Malformed clock stamp "${hlc.slice(0, 80)}".`);
  return { at: match[1]!, counter: Number(match[2]) };
}

export const ITEM_COLUMNS = `
  i.id, i.type, i.title, i.body, i.url, i.project_id, p.name AS project_name,
  i.source, i.metadata, i.intent, i.pinned_at, i.opened_at, i.remind_at, i.created_at, i.updated_at, i.archived_at,
  t.status AS task_status, t.priority AS task_priority, t.due_at AS task_due_at, t.completed_at AS task_completed_at`;

export const ITEM_JOINS = `
  LEFT JOIN projects p ON p.id = i.project_id
  LEFT JOIN tasks t ON t.item_id = i.id`;

export const ITEM_FROM = `items i ${ITEM_JOINS}`;

export interface ItemRow {
  id: string;
  type: ItemType;
  title: string;
  body: string;
  url: string | null;
  project_id: string | null;
  project_name: string | null;
  source: string;
  metadata: string;
  intent: Intent | null;
  pinned_at: string | null;
  opened_at: string | null;
  remind_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  task_status: TaskStatus | null;
  task_priority: number | null;
  task_due_at: string | null;
  task_completed_at: string | null;
}

export const PRIORITY_FROM_INT: Record<number, TaskPriority> = { 1: 'high', 2: 'normal', 3: 'low' };
export const PRIORITY_TO_INT: Record<TaskPriority, number> = { high: 1, normal: 2, low: 3 };

export function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    url: row.url,
    project: row.project_id ? { id: row.project_id, name: row.project_name! } : null,
    source: row.source,
    metadata: JSON.parse(row.metadata) as ItemMetadata,
    intent: row.intent,
    tags: [],
    pinnedAt: row.pinned_at,
    openedAt: row.opened_at,
    remindAt: row.remind_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function toSummaryItem(row: ItemRow): Item {
  const item = toItem(row);
  delete item.metadata.pdfPages;
  return item;
}

export function toTaskFields(row: ItemRow): TaskFields | null {
  if (row.task_status === null) return null;
  return {
    status: row.task_status,
    priority: PRIORITY_FROM_INT[row.task_priority!]!,
    dueAt: row.task_due_at,
    completedAt: row.task_completed_at,
  };
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(`Unknown ${label} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw invalid(`${label} is required.`);
  return trimmed;
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeTag(value: string): string {
  const tag = slugify(value.replace(/^#+/, ''));
  if (!tag) throw invalid(`"${value}" is not a usable tag.`);
  if (tag.length > 64) throw invalid(`Tag "${tag}" is longer than 64 characters.`);
  return tag;
}

export function normalizeDue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return trimmed;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw invalid(`Due date "${value}" must be YYYY-MM-DD or an ISO 8601 timestamp.`);
  return new Date(parsed).toISOString();
}
