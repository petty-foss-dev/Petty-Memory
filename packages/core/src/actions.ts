import { createHash } from 'node:crypto';
import { type Context, clientId, newId, normalizeTag } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import type { ItemService } from './items.ts';
import { descendants } from './placement.ts';
import type { ProjectService } from './projects.ts';
import { toFtsQuery } from './search.ts';
import type { TaskService } from './tasks.ts';
import type { Item, ItemDetail } from './types.ts';
import { readItemState } from './versions.ts';

export interface ActionScopeInput { rootId?: string; query?: string; project?: string }
export interface ActionScope {
  rootId: string | null;
  query: string | null;
  project: string | null;
  baseHash: string;
  items: ItemDetail[];
}
export type ActionOperation =
  | { id: string; kind: 'task'; title: string; body: string; sourceId: string | null; dueAt: string | null }
  | { id: string; kind: 'tag'; itemId: string; tags: string[] }
  | { id: string; kind: 'reminder'; itemId: string; remindAt: string | null }
  | { id: string; kind: 'note'; title: string; body: string; sourceIds: string[] };
export interface ActionProposal {
  id: string;
  rootId: string | null;
  query: string | null;
  project: string | null;
  baseHash: string;
  summary: string;
  operations: ActionOperation[];
  createdAt: string;
  titles?: Record<string, string>;
}
export interface ActionReceipt { actionId: string; afterHash: string }
export interface ActionResult { actionId: string; createdIds: string[]; updatedIds: string[]; undo: ActionReceipt }
interface Prior { id: string; tags: string[]; remindAt: string | null; remindedAt: string | null; tagged: boolean; reminder: boolean }
interface RecordedAction {
  hash: string;
  result: ActionResult;
  before: Prior[];
  watchIds: string[];
}

const MAX_ITEMS = 150;
const MAX_OPERATIONS = 50;
const DEFINITIONS = `WITH RECURSIVE definitions(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL
  UNION SELECT i.id FROM items i JOIN definitions d ON i.parent_id = d.id
)`;
const ORDINARY = `i.archived_at IS NULL AND i.type != 'decision'
  AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
  AND json_extract(i.metadata, '$.savedView') IS NULL
  AND json_extract(i.metadata, '$.conversation') IS NULL
  AND i.id NOT IN (SELECT id FROM definitions)`;

export class ActionService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly tasks: TaskService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, tasks: TaskService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.tasks = tasks;
    this.projects = projects;
  }

  scope(input: ActionScopeInput): ActionScope {
    if (!object(input)) throw invalid('Choose a branch or a topic for the action.');
    const rootId = optional(input.rootId, 'The branch', 100);
    const query = optional(input.query, 'The topic', 500);
    if (!!rootId === !!query) throw invalid('Choose either one branch or one keyword topic for the action.');
    if (rootId && input.project) throw invalid('A branch already determines its project; choose a project only for a topic.');
    const project = input.project ? this.projects.resolve(text(input.project, 'The project', 200)).id : null;
    let ids: string[];
    let watched: string[];
    if (rootId) {
      this.items.row(rootId);
      watched = [rootId, ...descendants(this.ctx, rootId)];
      if (watched.length > 500) throw invalid('That branch has more than 500 items. Choose a smaller branch.');
      const unsafe = watched.some((id) => this.items.get(id).metadata.secret === true);
      if (unsafe) throw invalid('That branch contains a secret note. Choose an ordinary branch without secrets.');
      ids = this.ctx.all<{ id: string }>(
        `${DEFINITIONS} SELECT i.id FROM items i WHERE ${ORDINARY} AND i.id IN (SELECT value FROM json_each(?)) ORDER BY i.seq`,
        JSON.stringify(watched),
      ).map((row) => row.id);
      if (!ids.includes(rootId)) throw invalid('Choose an active ordinary branch; decisions and workflow definitions cannot be action scopes.');
    } else {
      const match = toFtsQuery(query!)?.replaceAll(' OR ', ' AND ');
      if (!match) throw invalid('Name the topic with at least one word or number.');
      ids = this.ctx.all<{ id: string }>(
        `${DEFINITIONS} SELECT i.id FROM items i WHERE ${ORDINARY}
         AND i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
         ${project ? 'AND i.project_id = ?' : ''} ORDER BY i.seq`,
        match, ...(project ? [project] : []),
      ).map((row) => row.id);
      watched = ids;
    }
    if (!ids.length) throw invalid('No ordinary items match this scope. Choose another branch or a more useful topic.');
    if (ids.length > MAX_ITEMS) throw invalid(`${ids.length} items match; choose a narrower topic or a branch with at most ${MAX_ITEMS} active items.`);
    return {
      rootId, query, project,
      baseHash: digest({ rootId, query, project, ids, states: this.states(watched) }),
      items: ids.map((id) => this.items.get(id)),
    };
  }

  prepare(scope: ActionScope, plan: { summary: string; operations: unknown[] }): ActionProposal {
    const live = this.scope(scopeInput(scope));
    if (scope.baseHash !== live.baseHash) throw stale();
    if (!object(plan)) throw invalid('The action plan must contain a summary and operations.');
    const operations = parseOperations(plan.operations, true);
    validateTargets(operations, new Set(live.items.map((item) => item.id)));
    return {
      id: newId(), rootId: live.rootId, query: live.query, project: live.project, baseHash: live.baseHash,
      summary: text(plan.summary, 'The summary', 1000), operations, createdAt: this.ctx.now(),
      titles: Object.fromEntries(live.items.map((item) => [item.id, item.title || item.body.split('\n')[0]!.slice(0, 100) || `Untitled ${item.type}`])),
    };
  }

  apply(raw: ActionProposal, includeIds?: string[]): ActionResult {
    const proposal = parseProposal(raw);
    const selected = selection(proposal.operations, includeIds);
    const hash = digest({ proposal, selected: selected.map((op) => op.id) });
    return this.ctx.tx(() => {
      const previous = this.applied(proposal.id);
      if (previous) {
        if (previous.hash !== hash) throw new MemoryError('conflict', 'This action was already applied with a different selection. Ask for a new proposal.');
        if (this.undone(proposal.id)) throw new MemoryError('conflict', 'This action was undone. Ask for a new proposal.');
        return previous.result;
      }
      const scope = this.scope(scopeInput(proposal));
      if (scope.baseHash !== proposal.baseHash) throw stale();
      validateTargets(proposal.operations, new Set(scope.items.map((item) => item.id)));
      const byId = new Map(scope.items.map((item) => [item.id, item]));
      const updatedIds = [...new Set(selected.flatMap((op) => op.kind === 'tag' || op.kind === 'reminder' ? [op.itemId] : []))];
      const before = updatedIds.map((id): Prior => {
        const row = this.items.row(id);
        const remindedAt = this.ctx.get<{ reminded_at: string | null }>(`SELECT reminded_at FROM items WHERE id = ?`, id)!.reminded_at;
        return {
          id, tags: this.items.get(id).tags, remindAt: row.remind_at, remindedAt,
          tagged: selected.some((op) => op.kind === 'tag' && op.itemId === id),
          reminder: selected.some((op) => op.kind === 'reminder' && op.itemId === id),
        };
      });
      const createdIds: string[] = [];
      for (const op of selected) {
        if (op.kind === 'tag') this.items.tag(op.itemId, { add: op.tags });
        else if (op.kind === 'reminder') this.items.setReminder(op.itemId, op.remindAt);
        else {
          const sources = op.kind === 'task' ? (op.sourceId ? [op.sourceId] : []) : op.sourceIds;
          const projects = new Set(sources.map((id) => byId.get(id)!.project?.id ?? null));
          const project = scope.project ?? (projects.size === 1 ? [...projects][0] : sources.length === 0 && scope.rootId ? byId.get(scope.rootId)!.project?.id : null);
          const body = withSources(op.body, sources, byId);
          if (op.kind === 'task') {
            this.tasks.create({ id: op.id, title: op.title, notes: body, project: project ?? undefined, due: op.dueAt ?? undefined }, { automations: false });
          } else {
            this.items.insert({
              id: op.id, type: 'note', title: op.title, body, project: project ?? undefined,
              metadata: { aiAction: { version: 1, actionId: proposal.id } },
            }, { automations: false });
          }
          for (const id of sources) this.items.relate(op.id, id, 'derived_from');
          createdIds.push(op.id);
        }
      }
      const watchIds = [...new Set([...scope.items.map((item) => item.id), ...createdIds])];
      const result: ActionResult = {
        actionId: proposal.id, createdIds, updatedIds,
        undo: { actionId: proposal.id, afterHash: digest(this.states(watchIds)) },
      };
      const record: RecordedAction = { hash, result, before, watchIds };
      const anchor = scope.items[0]!;
      this.ctx.record('item', anchor.id, 'ai_actions', anchor.project?.id ?? null, { aiAction: record });
      return result;
    });
  }

  undo(receipt: ActionReceipt): { restored: number } {
    if (!object(receipt)) throw invalid('Choose a recorded AI action to undo.');
    const actionId = clientId(receipt.actionId, 'Action id');
    const afterHash = text(receipt.afterHash, 'The undo hash', 64);
    return this.ctx.tx(() => {
      const record = this.applied(actionId);
      if (!record) throw notFound('That AI action was not applied on this library.');
      if (record.result.undo.afterHash !== afterHash) throw invalid('That receipt does not belong to this action.');
      if (this.undone(actionId)) return { restored: record.before.length + record.result.createdIds.length };
      if (digest(this.states(record.watchIds)) !== afterHash) {
        throw new MemoryError('conflict', 'These items changed after the AI action. Open History to recover individual changes without replacing newer work.');
      }
      for (const prior of record.before) {
        const current = this.items.get(prior.id);
        if (prior.tagged) this.items.tag(prior.id, { add: prior.tags.filter((tag) => !current.tags.includes(tag)), remove: current.tags.filter((tag) => !prior.tags.includes(tag)) });
        if (prior.reminder) {
          const row = this.items.row(prior.id);
          this.items.write(row, { remind_at: prior.remindAt, reminded_at: prior.remindedAt }, 'remind', { remind_at: prior.remindAt }, false);
        }
      }
      for (const id of record.result.createdIds) {
        for (const relation of this.items.get(id).relations) {
          if (relation.direction === 'outgoing' && relation.kind === 'derived_from') this.items.unrelate(id, relation.id, 'derived_from');
        }
        this.items.archive(id);
      }
      const anchor = this.items.row(record.watchIds[0]!);
      this.ctx.record('item', anchor.id, 'ai_actions_undo', anchor.project_id, { aiActionUndo: actionId });
      return { restored: record.before.length + record.result.createdIds.length };
    });
  }

  private states(ids: string[]) {
    const all = [...new Set(ids.flatMap((id) => [id, ...descendants(this.ctx, id)]))].sort();
    return all.map((id) => {
      const state = readItemState(this.ctx, id);
      const relations = this.ctx.all<{ from_id: string; to_id: string; kind: string }>(
        `SELECT from_id, to_id, kind FROM relations WHERE from_id = ? OR to_id = ? ORDER BY from_id, to_id, kind`, id, id,
      );
      return { state: state && { ...state, item: { ...state.item, opened_at: null, reminded_at: null } }, relations };
    });
  }

  private applied(id: string): RecordedAction | null {
    const row = this.ctx.get<{ data: string }>(
      `SELECT data FROM changes WHERE op = 'ai_actions' AND json_extract(data, '$.aiAction.result.actionId') = ? ORDER BY seq LIMIT 1`, id,
    );
    return row ? (JSON.parse(row.data) as { aiAction: RecordedAction }).aiAction : null;
  }

  private undone(id: string): boolean {
    return !!this.ctx.get(`SELECT 1 FROM changes WHERE op = 'ai_actions_undo' AND json_extract(data, '$.aiActionUndo') = ? LIMIT 1`, id);
  }
}

function scopeInput(value: { rootId: string | null; query: string | null; project: string | null }): ActionScopeInput {
  return { ...(value.rootId ? { rootId: value.rootId } : { query: value.query! }), ...(value.project ? { project: value.project } : {}) };
}

function parseProposal(value: unknown): ActionProposal {
  if (!object(value)) throw invalid('Choose a reviewed AI action proposal.');
  return {
    id: clientId(value.id, 'Proposal id'),
    rootId: optional(value.rootId, 'The branch', 100), query: optional(value.query, 'The topic', 500), project: optional(value.project, 'The project', 200),
    baseHash: text(value.baseHash, 'The scope hash', 64), summary: text(value.summary, 'The summary', 1000),
    operations: parseOperations(value.operations, false), createdAt: iso(value.createdAt, 'The proposal time')!,
  };
}

function parseOperations(raw: unknown, assignIds: boolean): ActionOperation[] {
  if (!Array.isArray(raw) || raw.length > MAX_OPERATIONS) throw invalid(`An action needs at most ${MAX_OPERATIONS} proposed operations.`);
  const seen = new Set<string>();
  return raw.map((op: unknown): ActionOperation => {
    if (!object(op)) throw invalid('Each proposed action must be an object.');
    const id = assignIds ? newId() : clientId(op.id, 'Operation id');
    if (seen.has(id)) throw invalid('Each operation needs its own id.');
    seen.add(id);
    if (op.kind === 'task') return { id, kind: 'task', title: text(op.title, 'The task title', 200), body: body(op.body), sourceId: optional(op.sourceId, 'The source', 100), dueAt: iso(op.dueAt, 'The due date') };
    if (op.kind === 'note') {
      if (!Array.isArray(op.sourceIds) || op.sourceIds.length > MAX_ITEMS) throw invalid('A brief needs a bounded list of source ids.');
      const sourceIds = [...new Set(op.sourceIds.map((id) => text(id, 'The source', 100)))];
      return { id, kind: 'note', title: text(op.title, 'The note title', 200), body: body(op.body), sourceIds };
    }
    if (op.kind === 'tag') {
      if (!Array.isArray(op.tags) || !op.tags.length || op.tags.length > 8) throw invalid('Choose between one and eight tags per item.');
      return { id, kind: 'tag', itemId: text(op.itemId, 'The item', 100), tags: [...new Set(op.tags.map((tag) => normalizeTag(text(tag, 'The tag', 100))))] };
    }
    if (op.kind === 'reminder') return { id, kind: 'reminder', itemId: text(op.itemId, 'The item', 100), remindAt: iso(op.remindAt, 'The reminder') };
    throw invalid('AI actions can only propose tasks, tags, reminders or notes.');
  });
}

function validateTargets(operations: ActionOperation[], ids: Set<string>) {
  for (const op of operations) {
    const targets = op.kind === 'tag' || op.kind === 'reminder' ? [op.itemId] : op.kind === 'task' ? (op.sourceId ? [op.sourceId] : []) : op.sourceIds;
    if (targets.some((id) => !ids.has(id))) throw invalid('A proposed action refers to an item outside the reviewed scope.');
    if (ids.has(op.id)) throw invalid('A new action cannot reuse an existing source id.');
  }
}

function selection(operations: ActionOperation[], ids?: string[]): ActionOperation[] {
  if (ids === undefined) {
    if (!operations.length) throw invalid('There are no proposed actions to apply.');
    return operations;
  }
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !operations.some((op) => op.id === id))) {
    throw invalid('Select one or more operations from this proposal.');
  }
  return operations.filter((op) => ids.includes(op.id));
}

function withSources(value: string, ids: string[], items: Map<string, Item>): string {
  if (!ids.length) return value;
  const refs = ids.map((id) => `[[item:${id}|${(items.get(id)!.title || 'Source').replace(/[\[\]|]/g, ' ').trim()}]]`);
  return [value, `Sources: ${refs.join(', ')}`].filter(Boolean).join('\n\n');
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stale = () => new MemoryError('conflict', 'These items changed while the proposal was being reviewed. Ask for a fresh proposal.');
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${label} needs between 1 and ${max} characters.`);
  return value.trim();
}
const optional = (value: unknown, label: string, max: number): string | null => value === undefined || value === null ? null : text(value, label, max);
function body(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 20_000) throw invalid('Proposed note text can contain at most 20,000 characters.');
  return value.trim();
}
function iso(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const input = text(value, label, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(input) || !Number.isFinite(Date.parse(input))) throw invalid(`${label} must be an ISO date and time.`);
  return new Date(input).toISOString();
}
