import { createHash } from 'node:crypto';
import { type Context, clientId, newId } from './context.ts';
import type { EditorService } from './editor.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { descendants, pathToRoot } from './placement.ts';
import { toFtsQuery } from './search.ts';
import type { EditorActionResult, EditorCommand } from './types.ts';
import { readItemState } from './versions.ts';

/** A note that would move, carrying everything nested under it. `body` is an excerpt for review. */
export interface OrganizationCandidate {
  id: string;
  title: string;
  body: string;
  parentId: string | null;
  position: number;
  descendantCount: number;
  match?: 'keyword' | 'semantic' | 'both';
}

export interface OrganizationScope {
  query: string;
  baseHash: string;
  matchedCount: number;
  affectedCount: number;
  destination: { id: string | null; title: string };
  items: OrganizationCandidate[];
  additionalIds?: string[];
}

/** Group refs are the planner's own names; a null `parentRef` or `groupRef` means directly in the destination. */
export interface OrganizationPlan {
  summary: string;
  groups: { ref: string; title: string; parentRef: string | null }[];
  assignments: { itemId: string; groupRef: string | null }[];
}

export interface OrganizationProposal {
  id: string;
  query: string;
  baseHash: string;
  summary: string;
  matchedCount: number;
  affectedCount: number;
  destination: { id: string; title: string; create: boolean };
  items: OrganizationCandidate[];
  groups: { id: string; title: string; parentId: string }[];
  assignments: { itemId: string; parentId: string }[];
  createdAt: string;
  additionalIds?: string[];
}

export interface OrganizationReceipt {
  actionId: string;
  rootId: string;
  afterHash: string;
}

export interface OrganizationResult {
  rootId: string;
  moved: number;
  actionId: string;
  undo: OrganizationReceipt;
}

const MAX_MATCHES = 150;
const MAX_AFFECTED = 500;
const MAX_GROUPS = 40;
const MAX_QUERY = 500;
const MAX_TITLE = 200;
const MAX_REF = 40;
const MAX_SUMMARY = 1000;
const EXCERPT = 500;

// Saved views and everything inside a template branch are definitions, not library notes.
const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;
const ORDINARY_NOTE = `i.type = 'note' AND i.archived_at IS NULL AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
  AND json_extract(i.metadata, '$.savedView') IS NULL AND json_extract(i.metadata, '$.conversation') IS NULL AND coalesce(json_extract(i.metadata, '$.knowledgeDefinition'), 0) = 0
  AND i.id NOT IN (SELECT id FROM template_members)`;

interface CandidateRow {
  id: string;
  title: string;
  body: string;
  parent_id: string | null;
  sort_order: number;
}

// Read-only proposals bind a complete match set to one journalled editor action.
export class OrganizerService {
  private readonly ctx: Context;
  private readonly editor: EditorService;

  constructor(ctx: Context, editor: EditorService) {
    this.ctx = ctx;
    this.editor = editor;
  }

  discover(query: string, destinationTitle: string, additionalIds?: string[]): OrganizationScope {
    const topic = bounded(query, 'The topic', MAX_QUERY);
    const match = toFtsQuery(topic)?.replaceAll(' OR ', ' AND ');
    if (!match) throw invalid('Name the topic with at least one word or number, for example “gardening”.');
    const title = bounded(destinationTitle, 'The destination name', MAX_TITLE);
    const destination = this.destination(title);
    const keyword = this.ctx
      .all<{ id: string }>(
        `${TEMPLATE_MEMBERS} SELECT i.id FROM items i
         WHERE i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?) AND ${ORDINARY_NOTE} ORDER BY i.seq`,
        match,
      )
      .map((row) => row.id)
      .filter((id) => id !== destination?.id);
    const proposed = relatedIds(additionalIds);
    const additional = proposed.length ? this.ctx.all<{ id: string }>(
      `${TEMPLATE_MEMBERS} SELECT i.id FROM items i WHERE ${ORDINARY_NOTE} AND i.id IN (SELECT value FROM json_each(?)) ORDER BY i.seq`,
      JSON.stringify(proposed),
    ).map((row) => row.id).filter((id) => id !== destination?.id && !keyword.includes(id)) : [];
    const matched = [...keyword, ...additional];
    if (matched.length > MAX_MATCHES) {
      throw invalid(`${matched.length} notes match “${topic}”, more than the ${MAX_MATCHES} that can be organized at once. Use a narrower topic or more specific words.`);
    }
    // A match nested under another match travels with it, so the branch keeps its shape.
    const matchedSet = new Set(matched);
    const roots = matched.filter((id) => !pathToRoot(this.ctx, id).slice(1).some((ancestor) => matchedSet.has(ancestor)));
    const branches = roots.map((id) => ({ id, below: descendants(this.ctx, id) }));
    const rows = new Map(this.ctx
      .all<CandidateRow>(`SELECT id, title, body, parent_id, sort_order FROM items WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(roots))
      .map((row) => [row.id, row]));
    let affectedCount = 0;
    const items = branches.map(({ id, below }): OrganizationCandidate => {
      const row = rows.get(id)!;
      const { secret, count } = this.ctx.get<{ secret: number; count: number }>(
        `SELECT coalesce(sum(coalesce(json_extract(metadata, '$.secret'), 0) = 1), 0) AS secret,
                count(*) AS count
         FROM items WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(below),
      )!;
      if (secret) {
        throw invalid(`“${row.title || excerpt(row.body, 60)}” holds a secret note, which organizing never reads or moves. Move the secret note out of it first, or use a narrower topic.`);
      }
      affectedCount += 1 + count;
      return {
        id, title: row.title, body: excerpt(row.body, EXCERPT), parentId: row.parent_id, position: row.sort_order, descendantCount: count,
        match: keyword.includes(id) ? 'keyword' : 'semantic',
      };
    });
    if (affectedCount > MAX_AFFECTED) {
      throw invalid(`Organizing “${topic}” would move ${affectedCount} items, counting what is nested under the matching notes; at most ${MAX_AFFECTED} can move at once. Use a narrower topic.`);
    }
    const baseHash = digest({
      match,
      destination: title.toLowerCase(),
      destinationTree: destination ? this.states(destination.id) : null,
      matched: [...matched].sort(),
      branches: roots.map((id) => this.states(id)),
    });
    return {
      query: topic, baseHash, matchedCount: matched.length, affectedCount,
      destination: destination ?? { id: null, title }, items,
      ...(additional.length ? { additionalIds: additional } : {}),
    };
  }

  /** Read-only: checks the plan against the live library and gives every new note its id now, so review shows the exact result. */
  prepare(scope: OrganizationScope, plan: OrganizationPlan): OrganizationProposal {
    if (!isObject(scope) || typeof scope.query !== 'string' || typeof scope.baseHash !== 'string'
      || !isObject(scope.destination) || typeof scope.destination.title !== 'string') {
      throw invalid('That isn’t an organization scope. Search the library again.');
    }
    const live = this.discover(scope.query, scope.destination.title, scope.additionalIds);
    if (live.baseHash !== scope.baseHash) throw stale();
    if (live.items.length === 0) throw invalid(`No notes match “${live.query}”, so there is nothing to organize.`);
    const { summary, groups, assignments } = validPlan(plan, live.items);
    const destination = { id: live.destination.id ?? newId(), title: live.destination.title, create: live.destination.id === null };
    const ids = new Map(groups.map((group) => [group.ref, newId()]));
    const parent = (ref: string | null) => (ref === null ? destination.id : ids.get(ref)!);
    return {
      id: newId(),
      query: live.query,
      baseHash: live.baseHash,
      summary,
      matchedCount: live.matchedCount,
      affectedCount: live.affectedCount,
      destination,
      items: live.items,
      groups: groups.map((group) => ({ id: ids.get(group.ref)!, title: group.title, parentId: parent(group.parentRef) })),
      assignments: assignments.map((assignment) => ({ itemId: assignment.itemId, parentId: parent(assignment.groupRef) })),
      createdAt: this.ctx.now(),
      ...(live.additionalIds?.length ? { additionalIds: live.additionalIds } : {}),
    };
  }

  // Retrying the same selection returns its original receipt without refreshing the undo guard.
  apply(proposal: OrganizationProposal, includeIds?: string[]): OrganizationResult {
    const checked = validProposal(proposal);
    const all = checked.assignments.map((assignment) => assignment.itemId);
    const selected = includeIds === undefined ? new Set(all) : validSelection(includeIds, all);
    const commands = organizeCommands(checked, selected);
    return this.ctx.tx(() => {
      const previous = this.ctx.get<{ undone_at: string | null }>(`SELECT undone_at FROM editor_actions WHERE id = ?`, checked.id);
      if (previous && previous.undone_at !== null) {
        throw new MemoryError('conflict', 'This organization was undone. Ask for a new proposal to organize these notes again.');
      }
      if (!previous) {
        const live = this.discover(checked.query, checked.destination.title, checked.additionalIds);
        const ids = (list: string[]) => JSON.stringify([...list].sort());
        const liveIds = ids(live.items.map((item) => item.id));
        if (live.baseHash !== checked.baseHash || live.destination.id !== (checked.destination.create ? null : checked.destination.id)
          || liveIds !== ids(all) || liveIds !== ids(checked.items.map((item) => item.id))) {
          throw stale();
        }
      }
      const recorded = previous ? this.applied(checked.id) : null;
      if (previous && !recorded) throw new MemoryError('conflict', 'That action id belongs to another edit. Ask for a new proposal.');
      const { actionId } = this.editor.apply(commands, { id: checked.id, automations: false });
      if (recorded) return recorded;
      const undo = { actionId, rootId: checked.destination.id, afterHash: this.treeHash(checked.destination.id) };
      const result = { rootId: checked.destination.id, moved: selected.size, actionId, undo };
      const projectId = this.ctx.get<{ project_id: string | null }>(`SELECT project_id FROM items WHERE id = ?`, result.rootId)!.project_id;
      // Keep the original receipt on retries; a newer hash would let undo displace later additions.
      this.ctx.record('item', result.rootId, 'subtree', projectId, { organization: result });
      return result;
    });
  }

  /** Refuses once anything in the organized tree changed, so newer notes or edits are never displaced. */
  undo(receipt: OrganizationReceipt): EditorActionResult {
    if (!isObject(receipt) || typeof receipt.actionId !== 'string' || typeof receipt.rootId !== 'string' || typeof receipt.afterHash !== 'string') {
      throw invalid('That isn’t an organization undo receipt.');
    }
    return this.ctx.tx(() => {
      const action = this.ctx.get<{ undone_at: string | null }>(`SELECT undone_at FROM editor_actions WHERE id = ?`, receipt.actionId);
      if (!action) throw notFound(`No organization with id "${receipt.actionId}" on this library.`);
      const original = this.applied(receipt.actionId)?.undo;
      if (!original || original.rootId !== receipt.rootId || original.afterHash !== receipt.afterHash) throw invalid('That receipt does not belong to this organization.');
      if (action.undone_at === null && this.treeHash(receipt.rootId) !== receipt.afterHash) {
        throw new MemoryError('conflict', 'These notes changed after they were organized, so undoing now could displace newer work. Open History to restore an earlier version, or move notes by hand.');
      }
      return this.editor.undo(receipt.actionId);
    });
  }

  private destination(title: string): { id: string; title: string } | null {
    const wanted = title.toLowerCase();
    const found = this.ctx
      .all<{ id: string; title: string }>(`${TEMPLATE_MEMBERS} SELECT i.id, i.title FROM items i WHERE i.parent_id IS NULL AND ${ORDINARY_NOTE}`)
      .filter((row) => row.title.trim().toLowerCase() === wanted);
    if (found.length > 1) throw invalid(`${found.length} top-level notes are called “${title}”. Rename one, or name a different destination.`);
    return found[0] ? { id: found[0].id, title: found[0].title } : null;
  }

  private states(rootId: string) {
    return [rootId, ...descendants(this.ctx, rootId)].map((id) => {
      const state = readItemState(this.ctx, id);
      return state && { ...state, item: { ...state.item, opened_at: null, reminded_at: null } };
    });
  }

  private applied(actionId: string): OrganizationResult | null {
    const row = this.ctx.get<{ data: string }>(
      `SELECT data FROM changes WHERE json_extract(data, '$.organization.actionId') = ? ORDER BY seq LIMIT 1`, actionId,
    );
    return row ? (JSON.parse(row.data) as { organization: OrganizationResult }).organization : null;
  }

  private treeHash(rootId: string): string {
    return digest(this.states(rootId));
  }
}

function validPlan(plan: unknown, candidates: OrganizationCandidate[]): OrganizationPlan {
  if (!isObject(plan) || !Array.isArray(plan.groups) || !Array.isArray(plan.assignments)) throw invalid('An organization plan needs groups and assignments.');
  const summary = typeof plan.summary === 'string' ? plan.summary.trim().slice(0, MAX_SUMMARY) : '';
  if (plan.groups.length > MAX_GROUPS) throw invalid(`A plan can create at most ${MAX_GROUPS} groups.`);
  const byRef = new Map<string, OrganizationPlan['groups'][number]>();
  for (const raw of plan.groups as unknown[]) {
    if (!isObject(raw) || typeof raw.ref !== 'string' || !raw.ref.trim() || raw.ref.length > MAX_REF) throw invalid(`Each group needs a ref of 1 to ${MAX_REF} characters.`);
    if (byRef.has(raw.ref)) throw invalid(`Two groups share the ref "${raw.ref}".`);
    if (raw.parentRef !== null && typeof raw.parentRef !== 'string') throw invalid(`Group "${raw.ref}" needs a parentRef or null.`);
    byRef.set(raw.ref, { ref: raw.ref, title: bounded(raw.title, `Group "${raw.ref}"`, MAX_TITLE), parentRef: raw.parentRef });
  }
  // Parents before children, otherwise in plan order.
  const ordered: OrganizationPlan['groups'] = [];
  const placed = new Set<string>();
  for (const group of byRef.values()) {
    const chain: OrganizationPlan['groups'] = [];
    for (let current: typeof group | undefined = group; current && !placed.has(current.ref); current = current.parentRef === null ? undefined : byRef.get(current.parentRef)) {
      if (current.parentRef !== null && !byRef.has(current.parentRef)) throw invalid(`Group "${current.ref}" sits under "${current.parentRef}", which isn’t in the plan.`);
      if (chain.includes(current)) throw invalid(`Group "${current.ref}" is nested under itself.`);
      chain.push(current);
    }
    for (const link of chain.reverse()) {
      placed.add(link.ref);
      ordered.push(link);
    }
  }
  const remaining = new Set(candidates.map((item) => item.id));
  const assignments = (plan.assignments as unknown[]).map((raw): OrganizationPlan['assignments'][number] => {
    if (!isObject(raw) || typeof raw.itemId !== 'string') throw invalid('Each assignment needs an itemId.');
    if (!remaining.delete(raw.itemId)) {
      throw invalid(candidates.some((item) => item.id === raw.itemId)
        ? `Note "${raw.itemId}" is placed twice; place each note once.`
        : `"${raw.itemId}" isn’t one of the notes found for this topic.`);
    }
    if (raw.groupRef !== null && (typeof raw.groupRef !== 'string' || !byRef.has(raw.groupRef))) throw invalid(`Note "${raw.itemId}" is placed in a group that isn’t in the plan.`);
    return { itemId: raw.itemId, groupRef: raw.groupRef };
  });
  if (remaining.size) throw invalid(`The plan leaves out ${remaining.size} of the notes found; place every note, directly in the destination if nothing fits.`);
  return { summary, groups: ordered, assignments };
}

/** Shape only; apply then binds it to the live library through the base hash and candidate ids. */
function validProposal(raw: unknown): OrganizationProposal {
  const bad = () => invalid('That isn’t an organization proposal. Ask for a new one.');
  if (!isObject(raw) || typeof raw.query !== 'string' || typeof raw.baseHash !== 'string' || !isObject(raw.destination)
    || !Array.isArray(raw.groups) || !Array.isArray(raw.assignments) || !Array.isArray(raw.items)) throw bad();
  const { destination } = raw;
  if (typeof destination.create !== 'boolean') throw bad();
  const id = clientId(raw.id, 'Proposal id');
  const rootId = clientId(destination.id, 'Destination id');
  if (raw.groups.length > MAX_GROUPS) throw invalid(`A proposal can create at most ${MAX_GROUPS} groups.`);
  const parents = new Set([rootId]);
  const groups = (raw.groups as unknown[]).map((group) => {
    if (!isObject(group) || typeof group.parentId !== 'string') throw bad();
    const groupId = clientId(group.id, 'Group id');
    if (parents.has(groupId)) throw invalid('Each new group needs its own id.');
    if (!parents.has(group.parentId)) throw invalid('Each group must sit in the destination or in a group listed before it.');
    parents.add(groupId);
    return { id: groupId, title: bounded(group.title, 'A group name', MAX_TITLE), parentId: group.parentId };
  });
  const seen = new Set<string>();
  const assignments = (raw.assignments as unknown[]).map((assignment) => {
    if (!isObject(assignment) || typeof assignment.itemId !== 'string' || typeof assignment.parentId !== 'string') throw bad();
    if (seen.has(assignment.itemId)) throw invalid('Each note can be placed only once.');
    if (!parents.has(assignment.parentId)) throw invalid('Each note must go into the destination or one of the proposal’s groups.');
    seen.add(assignment.itemId);
    return { itemId: assignment.itemId, parentId: assignment.parentId };
  });
  if (assignments.length === 0) throw invalid('This proposal places no notes.');
  const items = (raw.items as unknown[]).map((item) => {
    if (!isObject(item) || typeof item.id !== 'string') throw bad();
    return item as unknown as OrganizationCandidate;
  });
  return {
    ...(raw as unknown as OrganizationProposal), id,
    destination: { id: rootId, title: bounded(destination.title, 'The destination name', MAX_TITLE), create: destination.create },
    groups, assignments, items,
    ...(raw.additionalIds === undefined ? {} : { additionalIds: relatedIds(raw.additionalIds) }),
  };
}

function relatedIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 50) throw invalid('Organizing can include at most 50 suggested related notes.');
  return [...new Set(raw.map((id) => clientId(id, 'Suggested note id')))];
}

function validSelection(includeIds: unknown, all: string[]): Set<string> {
  if (!Array.isArray(includeIds) || includeIds.length === 0) throw invalid('Choose at least one note to organize.');
  const known = new Set(all);
  const selected = new Set<string>();
  for (const id of includeIds as unknown[]) {
    if (typeof id !== 'string' || !known.has(id)) throw invalid('Only notes in this proposal can be selected.');
    selected.add(id);
  }
  return selected;
}

// Keep intentionally empty categories and their ancestors when pruning unselected branches.
function organizeCommands(proposal: OrganizationProposal, selected: Set<string>): EditorCommand[] {
  const planned = new Set<string>();
  const chosen = new Set<string>();
  const parentOf = new Map(proposal.groups.map((group) => [group.id, group.parentId]));
  for (const { itemId, parentId } of proposal.assignments) {
    for (let id: string | undefined = parentId; id !== undefined && id !== proposal.destination.id; id = parentOf.get(id)) {
      planned.add(id);
      if (selected.has(itemId)) chosen.add(id);
    }
  }
  for (const group of proposal.groups) {
    if (planned.has(group.id)) continue;
    for (let id: string | undefined = group.id; id !== undefined && id !== proposal.destination.id; id = parentOf.get(id)) chosen.add(id);
  }
  const commands: EditorCommand[] = [];
  if (proposal.destination.create) commands.push({ op: 'create', id: proposal.destination.id, parentId: null, title: proposal.destination.title });
  for (const group of proposal.groups) {
    if (planned.has(group.id) && !chosen.has(group.id)) continue;
    commands.push({ op: 'create', id: group.id, parentId: group.parentId, title: group.title }, { op: 'presentation', id: group.id, patch: { kind: 'heading' } });
  }
  for (const { itemId, parentId } of proposal.assignments) if (selected.has(itemId)) commands.push({ op: 'move', id: itemId, parentId });
  return commands;
}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} can’t be empty.`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${label} is longer than ${max} characters; shorten it.`);
  return text;
}

const excerpt = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stale = () => new MemoryError('conflict', 'Notes on this topic changed since the proposal was made. Ask for a new proposal.');
