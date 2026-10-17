import { existsSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { type AttachmentRow, blobPath, toAttachment, untrashBlob } from './blobs.ts';
import { type Context, PRIORITY_FROM_INT, newId } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { clampLimit } from './items.ts';
import { canHold, pathToRoot } from './placement.ts';
import { isSealedItem } from './vault.ts';
import type { ItemDetail, ItemMetadata, ItemVersion, ItemVersionSummary, MissingFile, TaskStatus, VersionNode } from './types.ts';

/** An item's complete stored state: what sync sends, what history keeps. Secret text is only ever ciphertext here. */
export interface ItemState {
  item: Record<string, SQLInputValue>;
  task: Record<string, SQLInputValue> | null;
  tags: string[];
  attachments: Record<string, SQLInputValue>[];
}

export const ITEM_FIELDS = [
  'id', 'type', 'title', 'body', 'url', 'content', 'metadata', 'project_id', 'source', 'created_at', 'updated_at', 'archived_at',
  'intent', 'pinned_at', 'opened_at', 'remind_at', 'reminded_at', 'parent_id', 'sort_order',
];
export const ATTACHMENT_FIELDS = ['id', 'item_id', 'sha256', 'filename', 'mime_type', 'size', 'created_at'];

export function readItemState(ctx: Context, id: string): ItemState | null {
  const item = ctx.get<Record<string, SQLInputValue>>(`SELECT ${ITEM_FIELDS.join(', ')} FROM items WHERE id = ?`, id);
  if (!item) return null;
  return {
    item: { ...item },
    task: ctx.get<Record<string, SQLInputValue>>(`SELECT status, priority, due_at, completed_at FROM tasks WHERE item_id = ?`, id) ?? null,
    tags: ctx.all<{ name: string }>(
      `SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name`, id,
    ).map((r) => r.name),
    attachments: ctx.all<Record<string, SQLInputValue>>(
      `SELECT id, sha256, filename, mime_type, size, created_at FROM attachments WHERE item_id = ?`, id,
    ),
  };
}

export function upsert(ctx: Context, table: string, fields: string[], row: Record<string, SQLInputValue>): void {
  const updates = fields.filter((f) => f !== 'id').map((f) => `${f} = excluded.${f}`).join(', ');
  ctx.run(
    `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')}) ON CONFLICT (id) DO UPDATE SET ${updates}`,
    ...fields.map((f) => row[f] ?? null),
  );
}

/** Replaces an item's tags and task with the given state's. */
export function writeTagsAndTask(ctx: Context, id: string, state: ItemState): void {
  if (state.task) {
    ctx.run(
      `INSERT INTO tasks (item_id, status, priority, due_at, completed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET status = excluded.status, priority = excluded.priority, due_at = excluded.due_at, completed_at = excluded.completed_at`,
      id, state.task.status!, state.task.priority!, state.task.due_at ?? null, state.task.completed_at ?? null,
    );
  } else {
    ctx.run(`DELETE FROM tasks WHERE item_id = ?`, id);
  }
  ctx.run(`DELETE FROM item_tags WHERE item_id = ?`, id);
  const now = ctx.now();
  for (const name of state.tags) {
    ctx.run(`INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING`, newId(), name, now);
    ctx.run(`INSERT INTO item_tags (item_id, tag_id, created_at) SELECT ?, id, ? FROM tags WHERE name = ?`, id, now, name);
  }
}

/** Called once per transaction with the items it changed; a state identical to the last kept one isn't kept twice. */
export function captureVersions(ctx: Context, changed: Map<string, { op: string; actor: string }>): void {
  const affected = new Map(changed);
  for (const [id, { actor }] of changed) {
    const pending = [id];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const parents = [
        ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, current)?.parent_id,
        ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM item_versions WHERE item_id = ? ORDER BY seq DESC LIMIT 1`, current)?.parent_id,
      ];
      for (const parent of parents) {
        if (!parent || seen.has(parent)) continue;
        if (!affected.has(parent)) affected.set(parent, { op: 'subtree', actor });
        pending.push(parent);
      }
    }
  }
  const start = ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM item_versions`)!.seq;
  for (const [id, { op, actor }] of affected) {
    const state = readItemState(ctx, id);
    const json = state ? JSON.stringify(state) : null;
    const last = ctx.get<{ state: string | null }>(`SELECT state FROM item_versions WHERE item_id = ? ORDER BY seq DESC LIMIT 1`, id);
    if (json === null ? !last || last.state === null : op !== 'subtree' && last?.state === json) continue;
    ctx.run(
      `INSERT INTO item_versions (id, item_id, parent_id, at, actor, op, state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(), id, (state?.item.parent_id as string | null) ?? null, ctx.now(), actor, state ? op : 'delete', json,
    );
  }
  // Every snapshot sees the complete transaction, including descendants written after its root.
  const end = ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM item_versions`)!.seq;
  ctx.run(`UPDATE item_versions SET snapshot_seq = ? WHERE seq > ?`, end, start);
}

/** Keeps a state that lost to a newer one as history, then the current state again so the newest version stays the live one. */
export function keepConflictVersion(ctx: Context, state: ItemState, actor: string): void {
  const id = state.item.id as string;
  const current = readItemState(ctx, id);
  const start = ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM item_versions`)!.seq;
  const insert = `INSERT INTO item_versions (id, item_id, parent_id, at, actor, op, state) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  ctx.run(insert, newId(), id, (state.item.parent_id as string | null) ?? null, ctx.now(), actor, 'conflict', JSON.stringify(state));
  ctx.run(
    insert, newId(), id, (current?.item.parent_id as string | null) ?? null, ctx.now(), 'sync', current ? 'sync' : 'delete',
    current ? JSON.stringify(current) : null,
  );
  const end = ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM item_versions`)!.seq;
  ctx.run(`UPDATE item_versions SET snapshot_seq = ? WHERE seq > ?`, end, start);
}

const isSecretState = (state: ItemState) => (JSON.parse(state.item.metadata as string) as ItemMetadata).secret === true;

interface VersionRow {
  seq: number;
  snapshot_seq: number;
  id: string;
  item_id: string;
  at: string;
  actor: string;
  op: string;
}

const toSummary = (row: VersionRow): ItemVersionSummary => ({ id: row.id, itemId: row.item_id, at: row.at, actor: row.actor, op: row.op });

// Rebuild historical subtrees from each descendant's latest state at the transaction boundary.
export class VersionService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Newest first. Works for deleted items too. */
  list(itemId: string, { offset = 0, limit }: { offset?: number; limit?: number } = {}): { items: ItemVersionSummary[]; total: number } {
    if (!Number.isInteger(offset) || offset < 0) throw invalid('Offset must be a non-negative integer.');
    const { total } = this.ctx.get<{ total: number }>(`SELECT count(*) AS total FROM item_versions WHERE item_id = ?`, itemId)!;
    if (total === 0 && !this.ctx.get(`SELECT 1 FROM items WHERE id = ?`, itemId)) throw notFound(`No item or history with id "${itemId}".`);
    const rows = this.ctx.all<VersionRow>(
      `SELECT seq, snapshot_seq, id, item_id, at, actor, op FROM item_versions WHERE item_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
      itemId, clampLimit(limit), offset,
    );
    return { items: rows.map(toSummary), total };
  }

  get(versionId: string): ItemVersion {
    const row = this.row(versionId);
    return {
      ...toSummary(row),
      snapshot: { rootId: row.item_id, items: this.subtree(row).map(({ state }) => this.toNode(state)) },
    };
  }

  // Preserve later additions and decisions; report historical files whose bytes are unavailable.
  restore(versionId: string): { restored: number; missingFiles?: MissingFile[] } {
    return this.restoreVersion(versionId, false);
  }

  /** Only ciphertext-only secret states, into rows that are secret now or gone; ordinary nodes are left alone. */
  restoreSecret(versionId: string): { restored: number; missingFiles?: MissingFile[] } {
    return this.restoreVersion(versionId, true);
  }

  private restoreVersion(versionId: string, secret: boolean): { restored: number; missingFiles?: MissingFile[] } {
    const row = this.row(versionId);
    const nodes = this.subtree(row);
    if (nodes.length === 0) throw invalid('That version records a deletion. Restore an earlier version of the item instead.');
    const restorable = ({ state }: { state: ItemState }) => {
      const current = this.ctx.get<{ metadata: string }>(`SELECT metadata FROM items WHERE id = ?`, state.item.id as string);
      const currentSecret = current ? (JSON.parse(current.metadata) as ItemMetadata).secret === true : null;
      return secret
        ? isSealedItem(state.item) && currentSecret !== false
        : !isSecretState(state) && currentSecret !== true;
    };
    if (!restorable(nodes[0]!)) {
      throw invalid(secret
        ? 'That version isn’t a sealed secret note, or the item is no longer secret. Restore it from ordinary history instead.'
        : 'This is a secret note. Restore its history through the vault, so it stays encrypted.');
    }
    return this.ctx.tx(() => {
      let restored = 0;
      const missingFiles: MissingFile[] = [];
      for (const node of nodes) {
        if (!restorable(node)) continue;
        for (const attachment of node.state.attachments) {
          const owner = this.ctx.get<{ item_id: string }>(`SELECT item_id FROM attachments WHERE id = ?`, attachment.id!);
          if (owner && owner.item_id !== node.state.item.id) {
            throw new MemoryError('conflict', 'A file in this version now belongs to another item. Keep that item’s file, or remove its attachment before restoring this version.');
          }
        }
      }
      for (const [i, node] of nodes.entries()) {
        if (i > 0 && !restorable(node)) continue;
        const { state } = node;
        if (!this.restoreState(state, i === 0, row.id)) continue;
        restored++;
        if (!this.ctx.attachmentsDir) continue;
        for (const attachment of state.attachments) {
          if (existsSync(blobPath(this.ctx, attachment.sha256 as string))) continue;
          missingFiles.push({
            itemId: state.item.id as string, attachmentId: attachment.id as string,
            sha256: attachment.sha256 as string, filename: attachment.filename as string,
          });
        }
      }
      return { restored, ...(missingFiles.length > 0 && { missingFiles }) };
    });
  }

  private row(versionId: string): VersionRow {
    const row = this.ctx.get<VersionRow>(`SELECT seq, snapshot_seq, id, item_id, at, actor, op FROM item_versions WHERE id = ?`, versionId);
    if (!row) throw notFound(`No version with id "${versionId}".`);
    return row;
  }

  /** The root's state at that version, then its descendants' latest states at that point, top down. */
  private subtree(version: VersionRow): { state: ItemState }[] {
    const root = this.ctx.get<{ state: string | null }>(`SELECT state FROM item_versions WHERE seq = ?`, version.seq)!.state;
    if (root === null) return [];
    const nodes = [{ state: JSON.parse(root) as ItemState }];
    const seen = new Set([version.item_id]);
    for (let i = 0; i < nodes.length; i++) {
      const children = this.ctx.all<{ item_id: string; state: string }>(
        `SELECT v.item_id, v.state FROM item_versions v
         WHERE v.parent_id = ? AND v.seq <= ? AND v.state IS NOT NULL
           AND v.seq = (SELECT max(w.seq) FROM item_versions w WHERE w.item_id = v.item_id AND w.seq <= ?)
         ORDER BY json_extract(v.state, '$.item.sort_order'), v.item_id`,
        nodes[i]!.state.item.id as string, version.snapshot_seq, version.snapshot_seq,
      );
      for (const child of children) {
        if (seen.has(child.item_id)) continue;
        seen.add(child.item_id);
        nodes.push({ state: JSON.parse(child.state) as ItemState });
      }
    }
    return nodes;
  }

  private toNode(state: ItemState): VersionNode {
    const row = state.item;
    const projectId = row.project_id as string | null;
    const projectName = projectId ? this.ctx.get<{ name: string }>(`SELECT name FROM projects WHERE id = ?`, projectId)?.name : null;
    const item: ItemDetail = {
      id: row.id as string,
      type: row.type as ItemDetail['type'],
      title: row.title as string,
      body: row.body as string,
      url: row.url as string | null,
      project: projectId ? { id: projectId, name: projectName ?? 'Deleted project' } : null,
      source: row.source as string,
      metadata: JSON.parse(row.metadata as string) as ItemMetadata,
      intent: row.intent as ItemDetail['intent'],
      tags: state.tags,
      pinnedAt: row.pinned_at as string | null,
      openedAt: row.opened_at as string | null,
      remindAt: row.remind_at as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      archivedAt: row.archived_at as string | null,
      content: row.content as string,
      attachments: state.attachments.map((a) => toAttachment({ ...a, item_id: row.id } as unknown as AttachmentRow)),
      task: state.task ? {
        status: state.task.status as TaskStatus,
        priority: PRIORITY_FROM_INT[state.task.priority as number]!,
        dueAt: state.task.due_at as string | null,
        completedAt: state.task.completed_at as string | null,
      } : null,
      relations: [],
    };
    return { item, parentId: row.parent_id as string | null, position: row.sort_order as number };
  }

  private restoreState(state: ItemState, isRoot: boolean, versionId: string): boolean {
    const id = state.item.id as string;
    const current = this.ctx.get<{ type: string; parent_id: string | null }>(`SELECT type, parent_id FROM items WHERE id = ?`, id);
    if (current?.type === 'decision') return false;
    const item: Record<string, SQLInputValue> = { ...state.item, updated_at: this.ctx.now() };
    if (item.project_id && !this.ctx.get(`SELECT 1 FROM projects WHERE id = ?`, item.project_id)) item.project_id = null;
    const parentId = item.parent_id as string | null;
    const parent = parentId
      ? this.ctx.get<{ type: string; secret: number | null }>(`SELECT type, json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, parentId)
      : undefined;
    const parentUsable = parent && canHold(parent, isSecretState(state)) && !pathToRoot(this.ctx, parentId!).includes(id);
    // A restored root whose old parent is gone or unusable stays where it is now, rather than jumping elsewhere.
    if (parentId && !parentUsable) item.parent_id = isRoot ? (current?.parent_id ?? null) : null;
    upsert(this.ctx, 'items', ITEM_FIELDS, item);
    writeTagsAndTask(this.ctx, id, state);
    for (const attachment of state.attachments) {
      upsert(this.ctx, 'attachments', ATTACHMENT_FIELDS, { ...attachment, item_id: id });
      untrashBlob(this.ctx, attachment.sha256 as string);
    }
    this.ctx.record('item', id, 'restore', item.project_id as string | null, { versionId });
    return true;
  }
}
