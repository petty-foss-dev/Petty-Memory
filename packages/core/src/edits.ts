import { createHash } from 'node:crypto';
import type { Context } from './context.ts';
import { MemoryError, invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import type { OutlineService } from './outline.ts';
import type { VersionService } from './versions.ts';
import { DEFAULT_PRESENTATION, type PresentationService, validPresentationPatch } from './presentation.ts';
import type { EditOperation, EditPreview, EditProposal, ItemMetadata, ItemPresentation, ItemType, MissingFile } from './types.ts';

/** One editable item as a proposal sees it. */
export interface EditScopeNode {
  id: string;
  parentId: string | null;
  position: number;
  type: ItemType;
  title: string;
  body: string;
  presentation: ItemPresentation;
}

/** The selected item and the ordinary items below it. Decisions, secrets and archived items are never in scope. */
export interface EditScope {
  rootId: string;
  baseHash: string;
  nodes: EditScopeNode[];
}

const MAX_TEXT = 20_000;
const MAX_CREATES = 50;
const TEMP_ID = /^new:[1-9]\d{0,2}$/;

export interface EditUndoReceipt {
  rootId: string;
  versionId: string;
  afterVersionId: string;
  baseHash: string;
  createdIds: string[];
}

// Bind reviewed operations to their original subtree state before applying them atomically.
export class EditService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly outline: OutlineService;
  private readonly presentation: PresentationService;
  private readonly versions: VersionService;

  constructor(ctx: Context, items: ItemService, outline: OutlineService, presentation: PresentationService, versions: VersionService) {
    this.ctx = ctx;
    this.items = items;
    this.outline = outline;
    this.presentation = presentation;
    this.versions = versions;
  }

  scope(rootId: string): EditScope {
    const root = this.items.row(rootId);
    if (!editable(root)) throw invalid('Choose an active, ordinary item to edit: decisions, secret notes and archived items can’t be edited this way.');
    const nodes: EditScopeNode[] = [];
    const pending = [root.id];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]!;
      const row = this.ctx.get<{ id: string; parent_id: string | null; sort_order: number; type: ItemType; title: string; body: string; metadata: string; archived_at: string | null }>(
        `SELECT id, parent_id, sort_order, type, title, body, metadata, archived_at FROM items WHERE id = ?`, id,
      )!;
      if (!editable(row)) continue;
      nodes.push({
        id: row.id, parentId: row.id === root.id ? null : row.parent_id, position: row.sort_order, type: row.type,
        title: row.title, body: row.body, presentation: this.presentation.get(row.id),
      });
      pending.push(...this.ctx.all<{ id: string }>(`SELECT id FROM items WHERE parent_id = ? ORDER BY sort_order, id`, id).map((child) => child.id));
    }
    const baseHash = createHash('sha256').update(JSON.stringify(nodes.map((n) => [n.id, n.parentId, n.position, n.type, n.title, n.body, n.presentation]))).digest('hex');
    return { rootId: root.id, baseHash, nodes };
  }

  // Before-state comes from the library, never from untrusted proposal fields.
  prepare(rootId: string, baseHash: string, summary: string, operations: unknown[]): EditProposal {
    const scope = this.scope(rootId);
    if (scope.baseHash !== baseHash) throw stale();
    const plan = newPlan(scope);
    const prepared = operations.flatMap((raw) => {
      try {
        return [this.check(scope, plan, raw)];
      } catch {
        return [];
      }
    });
    return {
      rootId: scope.rootId, baseHash, summary: summary.trim().slice(0, 2000), createdAt: this.ctx.now(), operations: prepared,
      titles: {
        ...Object.fromEntries(scope.nodes.map((node) => [node.id, node.title || 'Untitled'])),
        ...Object.fromEntries(prepared.flatMap((o) => (o.op === 'create' && o.tempId ? [[o.tempId, o.title || 'Untitled']] : []))),
      },
    };
  }

  /**
   * Applies every operation or none, and only if nothing in scope has changed since the proposal was made. A selected
   * subset is checked again as a whole, so an operation can't refer to a new note the selection left out.
   */
  apply(proposal: EditProposal): { applied: number; undo?: EditUndoReceipt } {
    if (!proposal || typeof proposal !== 'object' || typeof proposal.rootId !== 'string' || typeof proposal.baseHash !== 'string'
      || !Array.isArray(proposal.operations)) {
      throw invalid('That isn’t an edit proposal.');
    }
    const previous = this.versions.list(proposal.rootId, { limit: 1 }).items[0];
    const createdIds: string[] = [];
    const result = this.ctx.tx(() => {
      const scope = this.scope(proposal.rootId);
      if (scope.baseHash !== proposal.baseHash) throw stale();
      const plan = newPlan(scope);
      const operations = proposal.operations.map((raw) => this.check(scope, plan, raw));
      const created = new Map<string, string>();
      const real = (id: string) => created.get(id) ?? id;
      for (const operation of operations) {
        if (operation.op === 'update') {
          this.items.update(operation.id, { title: operation.title, body: operation.body });
        } else if (operation.op === 'create') {
          const id = this.outline.createNote({ parentId: real(operation.parentId), title: operation.title, body: operation.body }).item.id;
          if (operation.beforeId) this.outline.move(id, { parentId: real(operation.parentId), beforeId: real(operation.beforeId) });
          if (operation.tempId) created.set(operation.tempId, id);
          createdIds.push(id);
        } else if (operation.op === 'move') {
          this.outline.move(operation.id, { parentId: real(operation.parentId), beforeId: operation.beforeId && real(operation.beforeId) });
        } else {
          this.presentation.update(real(operation.id), operation.patch);
        }
      }
      return { applied: operations.length };
    });
    const after = this.versions.list(proposal.rootId, { limit: 1 }).items[0];
    return {
      ...result,
      ...(previous && after && { undo: {
        rootId: proposal.rootId, versionId: previous.id, afterVersionId: after.id,
        baseHash: this.scope(proposal.rootId).baseHash, createdIds,
      } }),
    };
  }

  undo(receipt: EditUndoReceipt): { restored: number; missingFiles?: MissingFile[] } {
    if (!receipt || typeof receipt.rootId !== 'string' || typeof receipt.versionId !== 'string'
      || typeof receipt.afterVersionId !== 'string' || typeof receipt.baseHash !== 'string'
      || !Array.isArray(receipt.createdIds) || receipt.createdIds.some((id) => typeof id !== 'string')) throw invalid('Invalid edit undo receipt.');
    return this.ctx.tx(() => {
      const scope = this.scope(receipt.rootId);
      if (scope.baseHash !== receipt.baseHash || this.versions.list(receipt.rootId, { limit: 1 }).items[0]?.id !== receipt.afterVersionId) {
        throw new MemoryError('conflict', 'This list changed again. Open History to choose a version to restore.');
      }
      const before = this.versions.get(receipt.versionId);
      if (before.snapshot.rootId !== receipt.rootId) throw invalid('The undo snapshot belongs to another item.');
      const existed = new Set(before.snapshot.items.map((node) => node.item.id));
      const current = new Set(scope.nodes.map((node) => node.id));
      for (const id of receipt.createdIds) {
        if (existed.has(id) || !current.has(id) || id === receipt.rootId) throw invalid('Undo can only archive items created by this edit.');
      }
      for (const id of receipt.createdIds) this.items.archive(id);
      return this.versions.restore(receipt.versionId);
    });
  }

  /** Roots with automatic organizing on whose subtree changed since the organizer last left it. */
  organizeCandidates(limit = 5): string[] {
    return this.ctx
      .all<{ id: string; organized: string | null }>(
        `SELECT id, json_extract(metadata, '$.organized.hash') AS organized FROM items
         WHERE json_extract(metadata, '$.presentation.autoOrganize') = 1 AND archived_at IS NULL ORDER BY seq`,
      )
      .filter((row) => {
        try {
          return this.scope(row.id).baseHash !== row.organized;
        } catch {
          return false;
        }
      })
      .slice(0, limit)
      .map((row) => row.id);
  }

  /** Remembers the subtree as the organizer left it, so its own changes don't trigger another pass. */
  markOrganized(rootId: string): void {
    const row = this.items.row(rootId);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    const organized = { hash: this.scope(row.id).baseHash, at: this.ctx.now() };
    this.items.write(row, { metadata: JSON.stringify({ ...metadata, organized }) }, 'organized', { organized }, false);
  }

  /**
   * Validates one untrusted operation against the scope and the operations accepted before it, and returns it with
   * trusted before-state. `plan` tracks where earlier operations put things, so parents, siblings and cycles are
   * checked as they will be when the operations run in order.
   */
  private check(scope: EditScope, plan: Plan, raw: unknown): EditOperation {
    if (!raw || typeof raw !== 'object') throw invalid('An operation must be an object.');
    const op = raw as Record<string, unknown>;
    const byId = new Map(scope.nodes.map((n) => [n.id, n]));
    const node = (value: unknown, label: string) => {
      const found = typeof value === 'string' ? byId.get(value) : undefined;
      if (!found) throw invalid(`${label} must be an item inside the selected subtree.`);
      return found;
    };
    // An item in scope, or a note an earlier operation in this proposal creates.
    const target = (value: unknown, label: string): string => {
      if (typeof value === 'string' && plan.created.has(value)) return value;
      if (typeof value === 'string' && TEMP_ID.test(value)) throw invalid(`${label} "${value}" isn’t created earlier in this proposal.`);
      return node(value, label).id;
    };
    const sibling = (value: unknown, parentId: string, movingId?: string): string | null => {
      if (value === undefined || value === null) return null;
      const id = target(value, 'beforeId');
      if (id === movingId || plan.parents.get(id) !== parentId) throw invalid('beforeId must be another item under the same parent.');
      return id;
    };
    const text = (value: unknown, label: string) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length > MAX_TEXT) throw invalid(`${label} must be text under ${MAX_TEXT} characters.`);
      return value;
    };
    const before = (n: EditScopeNode): EditPreview => ({ title: n.title, body: n.body, parentId: n.parentId });
    switch (op.op) {
      case 'update': {
        const item = node(op.id, 'id');
        const title = text(op.title, 'title');
        const body = text(op.body, 'body');
        if (title === undefined && body === undefined) throw invalid('An update needs a title or body.');
        return { op: 'update', id: item.id, ...(title !== undefined && { title }), ...(body !== undefined && { body }), before: before(item) };
      }
      case 'create': {
        const parentId = target(op.parentId, 'parentId');
        const beforeId = sibling(op.beforeId, parentId);
        const title = text(op.title, 'title') ?? '';
        const body = text(op.body, 'body') ?? '';
        if (!title.trim() && !body.trim()) throw invalid('A new note needs a title or body.');
        if (plan.creates >= MAX_CREATES) throw invalid(`A proposal can create at most ${MAX_CREATES} notes.`);
        const tempId = op.tempId;
        if (tempId !== undefined && (typeof tempId !== 'string' || !TEMP_ID.test(tempId) || plan.created.has(tempId))) {
          throw invalid('tempId must be a new "new:<n>" reference.');
        }
        plan.creates++;
        if (tempId !== undefined) {
          plan.created.add(tempId);
          plan.parents.set(tempId, parentId);
        }
        return { op: 'create', parentId, ...(beforeId !== null && { beforeId }), title, body, ...(tempId !== undefined && { tempId }) };
      }
      case 'move': {
        const item = node(op.id, 'id');
        if (item.id === scope.rootId) throw invalid('The selected item itself stays where it is.');
        const parentId = target(op.parentId, 'parentId');
        for (let at: string | null | undefined = parentId; at; at = plan.parents.get(at)) {
          if (at === item.id) throw invalid('An item can’t be moved under itself or one of its own descendants.');
        }
        const beforeId = sibling(op.beforeId, parentId, item.id);
        plan.parents.set(item.id, parentId);
        return { op: 'move', id: item.id, parentId, beforeId, before: before(item) };
      }
      case 'presentation': {
        const id = target(op.id, 'id');
        const patch = validPresentationPatch(op.patch);
        return { op: 'presentation', id, patch, before: byId.get(id)?.presentation ?? DEFAULT_PRESENTATION };
      }
      default:
        throw invalid('Operations can only update, create, move or change presentation.');
    }
  }
}

/** Where each item in scope, or created by the proposal so far, will sit once the accepted operations have run. */
interface Plan {
  parents: Map<string, string | null>;
  created: Set<string>;
  creates: number;
}

const newPlan = (scope: EditScope): Plan => ({
  parents: new Map(scope.nodes.map((node) => [node.id, node.parentId])),
  created: new Set(),
  creates: 0,
});

function editable(row: { type: string; metadata: string; archived_at: string | null }): boolean {
  return row.type !== 'decision' && row.archived_at === null && (JSON.parse(row.metadata) as ItemMetadata).secret !== true;
}

const stale = () => new MemoryError('conflict', 'These items changed since the proposal was made. Ask for a new proposal.');
