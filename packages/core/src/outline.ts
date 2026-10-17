import type { SQLInputValue } from 'node:sqlite';
import { type Context, ITEM_COLUMNS, clientId, ITEM_FROM, type ItemRow, toItem, toTaskFields } from './context.ts';
import { invalid, notFound } from './errors.ts';
import { type ItemService, clampLimit } from './items.ts';
import { assertParent, pathToRoot, place, slots } from './placement.ts';
import type { Item, OutlineEntry, OutlinePage } from './types.ts';

export interface OutlineListOptions {
  offset?: number;
  limit?: number;
  /** Shows the stored tree, archived items included, instead of the active view. */
  includeArchived?: boolean;
}

export interface OutlineMoveInput {
  parentId: string | null;
  /** A current sibling under `parentId` to land right before; absent or null appends. */
  beforeId?: string | null;
}

export interface OutlineNoteInput {
  /** A lowercase UUIDv7 the client chose, so queued edits can refer to the note before it exists here. */
  id?: string;
  parentId: string | null;
  title?: string;
  body?: string;
  project?: string;
  tags?: string[];
}

const isRef = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value !== '');

type EntryRow = ItemRow & { parent_id: string | null; sort_order: number; child_count: number };

const childCount = (includeArchived: boolean) =>
  `(SELECT count(*) FROM items c WHERE c.parent_id = i.id${includeArchived ? '' : ' AND c.archived_at IS NULL'}) AS child_count`;

// Active children of archived parents appear at root so archiving never strands content.
export class OutlineService {
  private readonly ctx: Context;
  private readonly items: ItemService;

  constructor(ctx: Context, items: ItemService) {
    this.ctx = ctx;
    this.items = items;
  }

  children(parentId: string | null, options: OutlineListOptions = {}): OutlinePage {
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw invalid('Offset must be a non-negative integer.');
    const limit = clampLimit(options.limit);
    const includeArchived = options.includeArchived ?? false;
    let where: string;
    const params: SQLInputValue[] = [];
    if (parentId === null) {
      where = includeArchived
        ? 'i.parent_id IS NULL'
        : 'i.archived_at IS NULL AND (i.parent_id IS NULL OR i.parent_id IN (SELECT id FROM items WHERE archived_at IS NOT NULL))';
    } else {
      const parent = this.items.row(parentId);
      if (!includeArchived && parent.archived_at !== null) return { items: [], total: 0 };
      where = includeArchived ? 'i.parent_id = ?' : 'i.parent_id = ? AND i.archived_at IS NULL';
      params.push(parent.id);
    }
    const { total } = this.ctx.get<{ total: number }>(`SELECT count(*) AS total FROM items i WHERE ${where}`, ...params)!;
    const rows = this.ctx.all<EntryRow>(
      `SELECT ${ITEM_COLUMNS}, i.parent_id, i.sort_order, ${childCount(includeArchived)} FROM ${ITEM_FROM}
       WHERE ${where} ORDER BY i.sort_order, i.id LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    return { items: this.entries(rows), total };
  }

  /** An archived item is described in the stored tree; an active one in the active view. */
  get(id: string): OutlineEntry {
    const { archived_at } = this.items.row(id);
    const row = this.ctx.get<EntryRow>(
      `SELECT ${ITEM_COLUMNS}, i.parent_id, i.sort_order, ${childCount(archived_at !== null)} FROM ${ITEM_FROM} WHERE i.id = ?`, id,
    )!;
    return this.entries([row])[0]!;
  }

  /** From the top level down to the direct parent, archived ancestors included. */
  ancestors(id: string): Item[] {
    const path = pathToRoot(this.ctx, this.items.row(id).id).slice(1).reverse();
    if (path.length === 0) return [];
    const rows = this.ctx.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id IN (SELECT value FROM json_each(?))`, JSON.stringify(path),
    );
    const byId = new Map(this.items.withTags(rows.map(toItem)).map((item) => [item.id, item]));
    return path.map((ancestor) => byId.get(ancestor)!);
  }

  move(id: string, { parentId, beforeId = null }: OutlineMoveInput): OutlineEntry {
    const row = this.items.row(id);
    if (row.type === 'decision') throw invalid('Decisions are append-only and stay where they were recorded.');
    if (!isRef(parentId) || !isRef(beforeId)) throw invalid('parentId and beforeId must be item ids or null.');
    this.ctx.tx(() => {
      if (parentId !== null) assertParent(this.ctx, parentId, row.id);
      if (beforeId !== null) {
        const before = this.ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, beforeId);
        if (!before) throw notFound(`No item with id "${beforeId}" to place it before.`);
        if (beforeId === row.id || before.parent_id !== parentId) {
          throw invalid(`"${beforeId}" isn't a sibling at the destination. Use an item that shares the new parent, or leave beforeId out to append.`);
        }
      }
      const current = this.ctx.get<{ parent_id: string | null; sort_order: number }>(`SELECT parent_id, sort_order FROM items WHERE id = ?`, row.id)!;
      if (current.parent_id === parentId && this.nextSibling(row.id, current.parent_id, current.sort_order) === beforeId) return;
      const [key] = slots(this.ctx, parentId, beforeId, 1, [row.id]);
      place(this.ctx, row.id, row.project_id, parentId, key!);
      this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, row.id);
    });
    return this.get(row.id);
  }

  /** Creates the note already nested, in one transaction, at the end of `parentId`'s children. */
  createNote({ id, parentId, title, body, project, tags }: OutlineNoteInput): OutlineEntry {
    if (!title?.trim() && !body?.trim()) throw invalid('A note needs a title or some text.');
    return this.get(this.items.insert({
      type: 'note', title, body, project, tags, parentId, ...(id !== undefined && { id: clientId(id, 'Note id') }),
    }));
  }

  private nextSibling(id: string, parentId: string | null, sortOrder: number): string | null {
    return this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE parent_id IS ? AND (sort_order, id) > (?, ?) ORDER BY sort_order, id LIMIT 1`,
      parentId, sortOrder, id,
    )?.id ?? null;
  }

  private entries(rows: EntryRow[]): OutlineEntry[] {
    const items = this.items.withTags(rows.map(toItem));
    return rows.map((row, i) => ({ item: { ...items[i]!, task: toTaskFields(row) }, parentId: row.parent_id, position: row.sort_order, childCount: row.child_count }));
  }
}
