import type { SQLInputValue } from 'node:sqlite';
import type { Context } from './context.ts';
import { invalid, notFound } from './errors.ts';

/** Beyond this, float64 stops holding every integer and neighbouring keys start to collide. */
export const MAX_SORT_KEY = 2 ** 53;

export const isSortKey = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SORT_KEY;

/** The key of an item with no recorded placement: its creation time, exactly as the outline migration computed it. */
export function defaultSortKey(ctx: Context, createdAt: SQLInputValue): number {
  return ctx.get<{ key: number }>(`SELECT coalesce(round((julianday(?) - 2440587.5) * 86400000.0), 0) AS key`, createdAt)!.key;
}

const siblings = (parentId: string | null): { where: string; params: SQLInputValue[] } =>
  parentId === null ? { where: 'parent_id IS NULL', params: [] } : { where: 'parent_id = ?', params: [parentId] };

/** The item, its parent, its grandparent… Stops at a repeat, so a loop from a bad sync can't hang it. */
export function pathToRoot(ctx: Context, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let current: string | null = id; current !== null && !seen.has(current);) {
    seen.add(current);
    path.push(current);
    current = ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, current)?.parent_id ?? null;
  }
  return path;
}

export const isSecretItem = (ctx: Context, id: string): boolean =>
  ctx.get<{ secret: number | null }>(`SELECT json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, id)?.secret === 1;

/** A secret parent holds only secret notes; decisions hold nothing. Ordinary parents may hold secrets. */
export const canHold = (parent: { type: string; secret: number | null }, secretChild: boolean): boolean =>
  parent.type !== 'decision' && (!parent.secret || secretChild);

/** Every item below `id`, parents before their children, each sibling list in order. */
export function descendants(ctx: Context, id: string): string[] {
  const found: string[] = [];
  const seen = new Set([id]);
  for (let queue = [id]; queue.length;) {
    const next: string[] = [];
    for (const parent of queue) {
      for (const { id: child } of ctx.all<{ id: string }>(`SELECT id FROM items WHERE parent_id = ? ORDER BY sort_order, id`, parent)) {
        if (seen.has(child)) continue;
        seen.add(child);
        found.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return found;
}

/**
 * `parentId` can hold `childId` (or a new item, secret if `secretChild`): it exists, is active, isn't a decision, holds
 * only secrets if it's secret, and isn't the child or below it.
 */
export function assertParent(ctx: Context, parentId: string, childId?: string, secretChild?: boolean): void {
  const parent = ctx.get<{ type: string; archived_at: string | null; secret: number | null }>(
    `SELECT type, archived_at, json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, parentId,
  );
  if (!parent) throw notFound(`No item with id "${parentId}" to nest under.`);
  if (parent.type === 'decision') throw invalid('Decisions are append-only and can’t hold other items. Choose a note or another item as the parent.');
  if (parent.secret && !(secretChild ?? (childId !== undefined && isSecretItem(ctx, childId)))) {
    throw invalid('A secret note can hold only other secret notes. Choose an ordinary parent, or create a secret note here.');
  }
  if (parent.archived_at !== null) throw invalid('That parent is archived. Unarchive it first, or choose an active parent.');
  if (childId !== undefined && pathToRoot(ctx, parentId).includes(childId)) {
    throw invalid('An item can’t be nested under itself or one of its own descendants.');
  }
}

// Rebalance crowded keys locally; stamp sync repairs after their cause to converge across peers.
export function slots(
  ctx: Context, parentId: string | null, beforeId: string | null, count: number, exclude: string[], after?: string,
): number[] {
  const { where, params } = siblings(parentId);
  const scope = `${where} AND id NOT IN (SELECT value FROM json_each(?))`;
  const scoped = [...params, JSON.stringify(exclude)];
  if (beforeId === null) {
    const last = ctx.get<{ key: number | null }>(`SELECT max(sort_order) AS key FROM items WHERE ${scope}`, ...scoped)!.key;
    const base = Math.max(last === null ? -MAX_SORT_KEY : last + 1, Date.now());
    if (base + count - 1 <= MAX_SORT_KEY && (last === null || base > last)) return Array.from({ length: count }, (_, i) => base + i);
    return respace(ctx, parentId, null, count, scope, scoped, after);
  }
  const before = ctx.get<{ sort_order: number }>(`SELECT sort_order FROM items WHERE id = ?`, beforeId)!.sort_order;
  const previous = ctx.get<{ key: number }>(
    `SELECT sort_order AS key FROM items WHERE ${scope} AND (sort_order, id) < (?, ?) ORDER BY sort_order DESC, id DESC LIMIT 1`,
    ...scoped, before, beforeId,
  )?.key;
  return spread(previous ?? Math.max(before - count - 1, -MAX_SORT_KEY), before, count)
    ?? respace(ctx, parentId, beforeId, count, scope, scoped, after);
}

/** Moves an item and records it; `projectId` is only for the change log, the item's project never changes. */
export function place(ctx: Context, id: string, projectId: string | null, parentId: string | null, sortOrder: number, after?: string): void {
  ctx.run(`UPDATE items SET parent_id = ?, sort_order = ? WHERE id = ?`, parentId, sortOrder, id);
  if (after === undefined) ctx.record('item', id, 'move', projectId, { parentId, sortOrder });
  else ctx.recordAfter(after, 'item', id, 'move', projectId, { parentId, sortOrder });
}

/** Before an item is deleted, its children take its place under its own parent, so deleting never takes content with it. */
export function adoptChildren(ctx: Context, id: string, after?: string): void {
  const children = ctx.all<{ id: string; project_id: string | null }>(
    `SELECT id, project_id FROM items WHERE parent_id = ? ORDER BY sort_order, id`, id,
  );
  if (children.length === 0) return;
  const parentId = ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, id)!.parent_id;
  const keys = slots(ctx, parentId, id, children.length, children.map((c) => c.id), after);
  children.forEach((child, i) => place(ctx, child.id, child.project_id, parentId, keys[i]!, after));
}

function spread(lo: number, hi: number, count: number): number[] | null {
  const keys = Array.from({ length: count }, (_, i) => lo + ((hi - lo) * (i + 1)) / (count + 1));
  return keys.every((key, i) => key > (i === 0 ? lo : keys[i - 1]!) && key < hi) ? keys : null;
}

/** `beforeId` null respaces for an append. If even the whole list has no room in range, it's renumbered from 1024 up. */
function respace(
  ctx: Context, parentId: string | null, beforeId: string | null, count: number, scope: string, scoped: SQLInputValue[], after?: string,
): number[] {
  const list = ctx.all<{ id: string; sort_order: number; project_id: string | null }>(
    `SELECT id, sort_order, project_id FROM items WHERE ${scope} ORDER BY sort_order, id`, ...scoped,
  );
  const at = beforeId === null ? list.length : list.findIndex((s) => s.id === beforeId);
  for (let reach = 1; ; reach *= 2) {
    const start = Math.max(0, at - reach);
    const end = Math.min(list.length, at + reach);
    const whole = start === 0 && end === list.length;
    const n = end - start + count;
    const margin = (n + 1) * 1024;
    const lo = start > 0 ? list[start - 1]!.sort_order : Math.max(list[start]!.sort_order - margin, -MAX_SORT_KEY);
    const hi = end < list.length ? list[end]!.sort_order : Math.min(list[end - 1]!.sort_order + margin, MAX_SORT_KEY);
    const keys = spread(lo, hi, n) ?? (whole ? Array.from({ length: n }, (_, i) => (i + 1) * 1024) : null);
    if (!keys) continue;
    const offset = at - start;
    list.slice(start, end).forEach((sibling, i) => {
      const key = keys[i < offset ? i : i + count]!;
      if (key !== sibling.sort_order) place(ctx, sibling.id, sibling.project_id, parentId, key, after);
    });
    return keys.slice(offset, offset + count);
  }
}
