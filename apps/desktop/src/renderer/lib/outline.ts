import type { EditorCommand, Item, OutlineEntry, OutlineMoveInput } from '@enve-memory/core';
import type { PastedLine } from './presentation.ts';

/** `needs`: the answer depends on rows not loaded yet, so load more and plan again. */
export type Plan = { move: OutlineMoveInput } | { needs: true } | null;

/** The loaded prefix of one parent's children (`parentId` null is the top level). */
export interface Siblings {
  parentId: string | null;
  entries: OutlineEntry[];
  total: number;
}

export const organizable = (entry: OutlineEntry) => entry.item.type !== 'decision' && entry.item.archivedAt === null;

export const canHoldChildren = (entry: OutlineEntry, child?: Item) => organizable(entry)
  && (entry.item.metadata.secret !== true || child?.metadata.secret === true);

// Children of an archived parent are listed at the top level but aren't siblings there, so they can't anchor a move.
const anchors = (list: Siblings, entry: OutlineEntry) => entry.parentId === list.parentId && entry.item.archivedAt === null;

type Next = { id: string | null } | { needs: true };

function nextAnchor(list: Siblings, index: number): { id: string; index: number } | { id: null } | { needs: true } {
  for (let i = index + 1; i < list.entries.length; i++) {
    if (anchors(list, list.entries[i]!)) return { id: list.entries[i]!.item.id, index: i };
  }
  return list.entries.length >= list.total ? { id: null } : { needs: true };
}

export function firstAnchor(list: Siblings): string | null {
  return list.entries.find((entry) => anchors(list, entry))?.item.id ?? null;
}

export function insertBelow(list: Siblings, index: number): Next {
  const next = nextAnchor(list, index);
  return 'needs' in next ? next : { id: next.id };
}

export function planMoveUp(list: Siblings, index: number): Plan {
  for (let i = index - 1; i >= 0; i--) {
    if (anchors(list, list.entries[i]!)) return { move: { parentId: list.parentId, beforeId: list.entries[i]!.item.id } };
  }
  return null;
}

export function planMoveDown(list: Siblings, index: number): Plan {
  const next = nextAnchor(list, index);
  if ('needs' in next) return next;
  if (next.id === null) return null;
  const after = nextAnchor(list, next.index);
  return 'needs' in after ? after : { move: { parentId: list.parentId, beforeId: after.id } };
}

export function planIndent(list: Siblings, index: number): Plan {
  for (let i = index - 1; i >= 0; i--) {
    const entry = list.entries[i]!;
    if (canHoldChildren(entry, list.entries[index]?.item)) return { move: { parentId: entry.item.id, beforeId: null } };
  }
  return null;
}

/** Lands right after its parent, which sits at `parentIndex` in `grandparent`. */
export function planOutdent(grandparent: Siblings, parentIndex: number): Plan {
  const next = nextAnchor(grandparent, parentIndex);
  return 'needs' in next ? next : { move: { parentId: grandparent.parentId, beforeId: next.id } };
}

/** Rows to expand to show an item. Without archived items its path restarts below the last archived ancestor. */
export function displayPath(ancestors: Pick<Item, 'id' | 'archivedAt'>[], includeArchived: boolean): string[] {
  if (includeArchived) return ancestors.map((a) => a.id);
  let start = 0;
  ancestors.forEach((a, i) => {
    if (a.archivedAt !== null) start = i + 1;
  });
  return ancestors.slice(start).map((a) => a.id);
}

const mergeable = (entry: OutlineEntry) => entry.item.type === 'note' && entry.item.archivedAt === null && entry.item.metadata.secret !== true;

/** The note a row merges into: its exact previous sibling, when both are active ordinary notes. */
export function mergeTarget(list: Siblings, index: number): string | null {
  const entry = list.entries[index];
  const previous = list.entries[index - 1];
  if (!entry || !previous || !mergeable(entry) || !mergeable(previous) || !anchors(list, previous) || !anchors(list, entry)) return null;
  return previous.item.id;
}

/** Enter in a title: split it at the caret, or (with nothing on one side) open a new note above or below instead of saving an empty one. */
export function enterAction(title: string, caret: number): 'split' | 'above' | 'below' {
  if (!title.slice(caret).trim()) return 'below';
  if (!title.slice(0, caret).trim()) return 'above';
  return 'split';
}

export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = Date.now();
  bytes[0] = Math.floor(time / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(time / 2 ** 32) & 0xff;
  bytes[2] = (time >>> 24) & 0xff;
  bytes[3] = (time >>> 16) & 0xff;
  bytes[4] = (time >>> 8) & 0xff;
  bytes[5] = time & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One journalled batch for pasted lines: notes nested by indentation (deeper lines go inside the line above, starting from
 * `seed`), their styles, and checklists for pasted [ ] / [x] boxes. Top-level lines land before `beforeId`.
 */
export function pasteCommands(
  at: { parentId: string | null; beforeId: string | null; project?: string },
  lines: PastedLine[],
  seed: string[] = [],
): { commands: EditorCommand[]; ids: string[] } {
  const creates: EditorCommand[] = [];
  const styles: EditorCommand[] = [];
  const checks: EditorCommand[] = [];
  const checklists = new Set<string>();
  const stack = [...seed];
  const ids: string[] = [];
  for (const line of lines) {
    const parentId = line.depth === 0 ? at.parentId : stack[line.depth - 1] ?? stack.at(-1) ?? at.parentId;
    const id = uuidv7();
    ids.push(id);
    creates.push({ op: 'create', id, parentId, beforeId: parentId === at.parentId ? at.beforeId : null, title: line.title, project: at.project });
    if (line.kind) styles.push({ op: 'presentation', id, patch: { kind: line.kind } });
    if (line.checked !== undefined && parentId) checklists.add(parentId);
    if (line.checked) checks.push({ op: 'check', id, checked: true });
    stack.length = line.depth;
    stack[line.depth] = id;
  }
  for (const id of checklists) styles.push({ op: 'presentation', id, patch: { checklist: true } });
  return { commands: [...creates, ...styles, ...checks], ids };
}
