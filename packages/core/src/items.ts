import type { SQLInputValue } from 'node:sqlite';
import {
  type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, newId, normalizeTag, oneOf, required, toItem, toSummaryItem, toTaskFields,
} from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type AttachmentRow, removeBlobIfUnused, toAttachment } from './blobs.ts';
import { detectIntent } from './intent.ts';
import { adoptChildren, assertParent, slots } from './placement.ts';
import { parseWhen } from './when.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import {
  ATTENTION_LEVELS, type AiSuggestions, INTENTS, type Intent, ITEM_TYPES, type Item, type ItemDetail, type ItemMetadata, type ItemType, RELATION_KINDS, type RelatedItem, type RelationKind, TASK_STATUSES,
} from './types.ts';

export interface ItemFilter {
  project?: string;
  /** Only items in no project. */
  inbox?: boolean;
  /** Paging cursor: `<updatedAt>,<id>` of the last item of the previous page (see pageCursor). */
  before?: string;
  pinned?: boolean;
  intent?: string;
  /** Bookmarks saved at least this many days ago and never opened. */
  unopenedDays?: number;
  /** Items with a reminder set; list() orders them soonest first. */
  reminders?: boolean;
  type?: string;
  tag?: string;
  importedKind?: string;
  includeArchived?: boolean;
  /** Only items marked for review. */
  review?: boolean;
  attention?: string;
  secret?: boolean;
  /** Only tasks with this status. */
  taskStatus?: string;
  excludeDefinitions?: boolean;
}

export interface NewItem {
  type: ItemType;
  title?: string;
  body?: string;
  url?: string | null;
  content?: string;
  metadata?: ItemMetadata;
  project?: string;
  tags?: string[];
  /** Importers restoring an Enve export keep the original id and creation time. */
  id?: string;
  createdAt?: string;
  intent?: Intent | null;
  /** Nest it at the end of this item's children instead of at the end of the top level. */
  parentId?: string | null;
}

export interface SourceUpdate {
  /** Applied only when the item has no title yet; the user's own title always wins. */
  title?: string;
  content?: string;
  metadata: ItemMetadata;
}

export interface SaveNoteInput {
  body: string;
  title?: string;
  project?: string;
  tags?: string[];
  /** For imports and demos that recreate notes written earlier. */
  createdAt?: string;
}

export interface SaveLinkInput {
  url: string;
  title?: string;
  note?: string;
  project?: string;
  tags?: string[];
  /** Fetch and extract the page afterwards. Defaults to the library's fetchLinks setting. */
  ingest?: boolean;
  /** Why it's being saved; guessed from the address when omitted. */
  intent?: Intent;
  /** When it was originally bookmarked (importers); applies only to a new bookmark. */
  createdAt?: string;
}

export interface UpdateItemInput {
  title?: string;
  body?: string;
  url?: string | null;
  project?: string | null;
  baseTitle?: string;
  baseBody?: string;
}

/** The cursor that fetches the page after the one ending with this item. */
export const pageCursor = (item: Pick<Item, 'updatedAt' | 'id'>) => `${item.updatedAt},${item.id}`;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw invalid('Limit must be a positive integer.');
  return Math.min(limit, MAX_LIMIT);
}

export class ItemService {
  private readonly ctx: Context;
  private readonly projects: ProjectService;

  private readonly settings: SettingsService;
  /** Set by EnveMemory to run automations after an item is created or its source is archived. */
  afterSave: ((id: string) => void) | null = null;

  constructor(ctx: Context, projects: ProjectService, settings: SettingsService) {
    this.ctx = ctx;
    this.projects = projects;
    this.settings = settings;
  }

  saveNote(input: SaveNoteInput): ItemDetail {
    const body = required(input.body, 'Note text');
    return this.get(this.insert({ type: 'note', body, title: input.title, project: input.project, tags: input.tags, createdAt: input.createdAt }));
  }

  /**
   * Saving a URL that is already bookmarked returns the existing bookmark, appending any new note, adding any new tags,
   * and filing it into the given project if it has none. It never moves a bookmark out of a project it's already in.
   */
  saveLink(input: SaveLinkInput): { item: ItemDetail; created: boolean } {
    const url = parseUrl(input.url);
    const existing = this.findByUrl(url);
    if (existing) {
      this.ctx.tx(() => {
        const note = input.note?.trim();
        if (note) {
          const row = this.row(existing.id);
          if (!row.body.includes(note)) this.write(row, { body: row.body ? `${row.body}\n\n${note}` : note }, 'update');
        }
        if (input.tags?.length) this.tag(existing.id, { add: input.tags });
        if (input.project && !existing.project) {
          this.write(this.row(existing.id), { project_id: this.projects.resolve(input.project).id }, 'update');
        }
      });
      return { item: this.get(existing.id), created: false };
    }
    const id = this.insert({
      type: 'bookmark', url, title: input.title, body: input.note, project: input.project, tags: input.tags,
      metadata: {
        ...((input.ingest ?? this.settings.get('fetchLinks')) ? { ingest: { status: 'pending' as const } } : {}),
        intentAuto: input.intent === undefined,
      },
      intent: input.intent ?? detectIntent(url),
      createdAt: input.createdAt,
    });
    return { item: this.get(id), created: true };
  }

  pin(id: string, pinned: boolean): ItemDetail {
    const row = this.row(id);
    if (pinned !== (row.pinned_at !== null)) {
      const pinnedAt = pinned ? this.ctx.now() : null;
      this.write(row, { pinned_at: pinnedAt }, pinned ? 'pin' : 'unpin', { pinned_at: pinnedAt }, false);
    }
    return this.get(row.id);
  }

  /** Records that the user opened the item or its link. */
  markOpened(id: string): void {
    const now = this.ctx.now();
    this.write(this.row(id), { opened_at: now }, 'open', { opened_at: now }, false);
  }

  /** `when` is anything parseWhen understands; null clears the reminder. */
  setReminder(id: string, when: string | null): ItemDetail {
    const row = this.row(id);
    const remindAt = when === null ? null : parseWhen(when);
    this.write(row, { remind_at: remindAt, reminded_at: null }, 'remind', { remind_at: remindAt }, false);
    return this.get(row.id);
  }

  setIntent(id: string, intent: string | null): ItemDetail {
    const row = this.row(id);
    const value = intent === null ? null : oneOf(intent, INTENTS, 'intent');
    const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), intentAuto: false };
    this.write(row, { intent: value, metadata: JSON.stringify(metadata) }, 'intent', { intent: value }, false);
    return this.get(row.id);
  }

  /** Reminders whose time has come and that haven't been delivered yet. */
  dueReminders(now = new Date()): Item[] {
    return this.withTags(this.ctx
      .all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE i.remind_at IS NOT NULL AND i.remind_at <= ? AND i.reminded_at IS NULL AND i.archived_at IS NULL
         ORDER BY i.remind_at`,
        now.toISOString(),
      )
      .map(toSummaryItem));
  }

  /** Marks a reminder delivered so it fires once; it stays listed until cleared or rescheduled. */
  markReminded(id: string): void {
    const now = this.ctx.now();
    this.write(this.row(id), { reminded_at: now }, 'reminded', { reminded_at: now }, false);
  }

  /** The active bookmark for a URL, if one exists. */
  findByUrl(url: string): ItemDetail | null {
    const row = this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE type = 'bookmark' AND url = ? AND archived_at IS NULL ORDER BY seq LIMIT 1`, parseUrl(url),
    );
    return row ? this.get(row.id) : null;
  }

  /** Low-level create shared by the typed services. Returns the new item's id. */
  insert(input: NewItem, { automations = true }: { automations?: boolean } = {}): string {
    const projectId = input.project ? this.projects.resolve(input.project).id : null;
    const tags = (input.tags ?? []).map(normalizeTag);
    const id = input.id ?? newId();
    if (input.id && this.ctx.get(`SELECT 1 FROM items WHERE id = ?`, input.id)) throw new MemoryError('conflict', `An item with id "${input.id}" already exists.`);
    const now = this.ctx.now();
    const created = input.createdAt ?? now;
    const title = input.title?.trim() ?? '';
    const body = input.body?.trim() ?? '';
    const url = input.url ?? null;
    const content = input.content ?? '';
    const metadata = input.metadata ?? {};
    const parentId = input.parentId ?? null;
    if (parentId !== null && input.type === 'decision') throw invalid('Decisions are append-only and always stay at the top level.');
    this.ctx.tx(() => {
      if (parentId !== null) assertParent(this.ctx, parentId, undefined, metadata.secret === true);
      const [sortOrder] = slots(this.ctx, parentId, null, 1, []);
      this.ctx.run(
        `INSERT INTO items (id, type, title, body, url, content, metadata, intent, project_id, source, created_at, updated_at, parent_id, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.type, title, body, url, content, JSON.stringify(metadata), input.intent ?? null, projectId, this.ctx.actor, created, created,
        parentId, sortOrder!,
      );
      this.ctx.record('item', id, 'create', projectId, {
        type: input.type, title, body, url, content, metadata, intent: input.intent ?? null, projectId, parentId, sortOrder,
      });
      if (tags.length) this.applyTags(id, projectId, tags, []);
    });
    if (automations) this.afterSave?.(id);
    return id;
  }

  get(id: string): ItemDetail {
    const row = this.row(id);
    const tags = this.ctx
      .all<{ name: string }>(
        `SELECT tg.name FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = ? ORDER BY tg.name`, row.id,
      )
      .map((r) => r.name);
    const relations = this.ctx
      .all<{ kind: RelationKind; direction: RelatedItem['direction']; id: string; type: ItemType; title: string }>(
        `SELECT r.kind, 'outgoing' AS direction, i.id, i.type, i.title
           FROM relations r JOIN items i ON i.id = r.to_id WHERE r.from_id = ?
         UNION ALL
         SELECT r.kind, 'incoming' AS direction, i.id, i.type, i.title
           FROM relations r JOIN items i ON i.id = r.from_id WHERE r.to_id = ?`,
        row.id, row.id,
      )
      .map((r) => ({ kind: r.kind, direction: r.direction, id: r.id, type: r.type, title: r.title }));
    const { content } = this.ctx.get<{ content: string }>(`SELECT content FROM items WHERE id = ?`, row.id)!;
    const attachments = this.ctx
      .all<AttachmentRow>(`SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at`, row.id)
      .map(toAttachment);
    return { ...toItem(row), content, attachments, tags, task: toTaskFields(row), relations };
  }

  /** Records what ingestion extracted from the item's source. Metadata is merged shallowly. */
  setSource(id: string, update: SourceUpdate): ItemDetail {
    const row = this.row(id);
    const changes: Record<string, SQLInputValue> = {
      metadata: JSON.stringify({ ...(JSON.parse(row.metadata) as ItemMetadata), ...update.metadata }),
    };
    if (update.content !== undefined) changes.content = update.content;
    if (update.title?.trim() && !row.title) changes.title = update.title.trim();
    // The page's Open Graph type can sharpen a guessed intent (a video → watch), never one the user chose.
    const current = JSON.parse(row.metadata) as ItemMetadata;
    if (update.metadata.ogType && row.url && row.type === 'bookmark' && current.intentAuto !== false) {
      const intent = detectIntent(row.url, update.metadata.ogType);
      if (intent !== row.intent) changes.intent = intent;
    }
    // Archiving isn't an edit by the user, so it doesn't move the item in "recently updated".
    this.write(row, changes, 'ingest', { ...changes, metadata: update.metadata }, false);
    this.afterSave?.(row.id);
    return this.get(row.id);
  }

  /** Records AI suggestions (summary, tags, project) for an item without applying them. */
  suggest(id: string, ai: AiSuggestions): ItemDetail {
    const row = this.row(id);
    const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), ai };
    this.write(row, { metadata: JSON.stringify(metadata) }, 'enrich', { ai }, false);
    return this.get(row.id);
  }

  /** Applies an item's suggested tags, and its suggested project when it has none. */
  acceptSuggestions(id: string): ItemDetail {
    const item = this.get(id);
    const ai = item.metadata.ai;
    if (!ai || ai.status !== 'done') throw invalid('This item has no suggestions to accept.');
    this.ctx.tx(() => {
      if (ai.tags?.length) this.tag(item.id, { add: ai.tags });
      if (ai.project && !item.project) this.update(item.id, { project: ai.project.id });
      const row = this.row(item.id);
      this.write(row, { metadata: JSON.stringify({ ...(JSON.parse(row.metadata) as ItemMetadata), ai: { ...ai, accepted: true } }) }, 'accept');
    });
    return this.get(item.id);
  }

  /** Saved since `since`, readable, and not yet enriched; oldest first. */
  pendingEnrichment(since: string, limit = 20): string[] {
    if (!since) return [];
    return this.ctx
      .all<{ id: string }>(
        `WITH RECURSIVE definitions(id) AS (
           SELECT id FROM items WHERE coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
           UNION SELECT i.id FROM items i JOIN definitions d ON i.parent_id = d.id
         ) SELECT id FROM items
         WHERE created_at >= ? AND archived_at IS NULL AND type IN ('note', 'bookmark', 'file', 'image')
           AND json_extract(metadata, '$.ai') IS NULL AND json_extract(metadata, '$.secret') IS NULL
           AND json_extract(metadata, '$.aiAction') IS NULL AND json_extract(metadata, '$.conversation') IS NULL
           AND id NOT IN (SELECT id FROM definitions)
           AND coalesce(json_extract(metadata, '$.ingest.status'), 'done') != 'pending'
         ORDER BY seq LIMIT ?`,
        since, limit,
      )
      .map((r) => r.id);
  }

  /** The item an importer already created from this source, so re-running an import doesn't duplicate. */
  findImported(kind: string, path: string): string | null {
    return this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE json_extract(metadata, '$.importedFrom.kind') = ? AND json_extract(metadata, '$.importedFrom.path') = ? LIMIT 1`,
      kind, path,
    )?.id ?? null;
  }

  /** Queues failed fetches/extractions for another attempt. Returns how many. */
  retryFailedIngest(): number {
    const failed = this.ctx.all<{ id: string }>(`SELECT id FROM items WHERE json_extract(metadata, '$.ingest.status') = 'failed'`);
    for (const { id } of failed) this.setSource(id, { metadata: { ingest: { status: 'pending' } } });
    return failed.length;
  }

  /** Oldest first, so a backlog drains in the order things were saved. */
  pendingIngest(limit = 20): string[] {
    return this.ctx
      .all<{ id: string }>(
        `SELECT id FROM items WHERE json_extract(metadata, '$.ingest.status') = 'pending' AND archived_at IS NULL ORDER BY seq LIMIT ?`,
        limit,
      )
      .map((r) => r.id);
  }

  list(filter: ItemFilter = {}, limit?: number): Item[] {
    const { where, params } = this.filterClauses(filter);
    return this.withTags(this.ctx
      .all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${filter.reminders ? 'i.remind_at, ' : filter.pinned ? 'i.pinned_at DESC, ' : ''}i.updated_at DESC, i.id DESC LIMIT ?`,
        ...params, clampLimit(limit),
      )
      .map(toSummaryItem));
  }

  /** Fills in tags for a page of items with one query. */
  withTags<T extends Item>(items: T[]): T[] {
    if (items.length === 0) return items;
    const rows = this.ctx.all<{ item_id: string; name: string }>(
      `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
       WHERE it.item_id IN (${items.map(() => '?').join(', ')}) ORDER BY t.name`,
      ...items.map((i) => i.id),
    );
    const byItem = new Map<string, string[]>();
    for (const row of rows) byItem.set(row.item_id, [...(byItem.get(row.item_id) ?? []), row.name]);
    return items.map((item) => ({ ...item, tags: byItem.get(item.id) ?? [] }));
  }

  /** `touch: false` for automatic filing (rules, AI) that shouldn't count as the user editing the item. */
  update(id: string, input: UpdateItemInput, touch = true): ItemDetail {
    const row = this.row(id);
    assertMutable(row);
    if ((input.title !== undefined && input.baseTitle !== undefined && row.title !== input.baseTitle)
      || (input.body !== undefined && input.baseBody !== undefined && row.body !== input.baseBody)) {
      throw new MemoryError('conflict', 'This item changed since editing began. Review the latest text, or save your draft as a new note.');
    }
    if ((input.title !== undefined || input.body !== undefined || input.url !== undefined) && isSecret(row)) {
      throw invalid('This is a secret note. Change its text through the vault, so it stays encrypted. A secret note can’t have a link.');
    }
    const changes: Record<string, SQLInputValue> = {};
    if (input.title !== undefined) changes.title = input.title.trim();
    if (input.body !== undefined) changes.body = input.body.trim();
    if (input.url !== undefined) changes.url = input.url === null ? null : parseUrl(input.url);
    if (input.project !== undefined) {
      changes.project_id = input.project === null ? null : this.projects.resolve(input.project).id;
    }
    if (row.type === 'bookmark' && changes.url === null) throw invalid('A bookmark needs a URL.');
    this.write(row, changes, 'update', changes, touch);
    return this.get(row.id);
  }

  archive(id: string): ItemDetail {
    const row = this.row(id);
    assertMutable(row);
    if (row.archived_at === null) this.write(row, { archived_at: this.ctx.now() }, 'archive');
    return this.get(row.id);
  }

  unarchive(id: string): ItemDetail {
    const row = this.row(id);
    if (row.archived_at !== null) this.write(row, { archived_at: null }, 'unarchive');
    return this.get(row.id);
  }

  /** Permanent. Only exposed to the user directly, never to AI clients. */
  delete(id: string): void {
    const row = this.row(id);
    const blobs = this.ctx.all<{ sha256: string }>(`SELECT sha256 FROM attachments WHERE item_id = ?`, row.id);
    this.ctx.tx(() => {
      adoptChildren(this.ctx, row.id);
      this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, row.id);
      this.ctx.run(`DELETE FROM items WHERE id = ?`, row.id);
      this.ctx.run(`DELETE FROM settings WHERE key IN (?, ?)`, `sources.folder.${row.id}`, `sources.queue.${row.id}`);
      this.ctx.record('item', row.id, 'delete', row.project_id, { type: row.type, title: row.title });
    });
    for (const { sha256 } of blobs) removeBlobIfUnused(this.ctx, sha256);
  }

  tag(id: string, { add = [], remove = [] }: { add?: string[]; remove?: string[] }, touch = true): ItemDetail {
    const row = this.row(id);
    const added = add.map(normalizeTag);
    const removed = remove.map(normalizeTag);
    if (added.length || removed.length) {
      this.ctx.tx(() => {
        this.applyTags(row.id, row.project_id, added, removed);
        if (touch) this.touch(row.id);
      });
    }
    return this.get(row.id);
  }

  relate(fromId: string, toId: string, kind: string): ItemDetail {
    const from = this.row(fromId);
    const to = this.row(toId);
    const relationKind = oneOf(kind, RELATION_KINDS, 'relation kind');
    if (from.id === to.id) throw invalid('An item cannot relate to itself.');
    this.link(from.id, to.id, relationKind, from.project_id);
    return this.get(from.id);
  }

  /** Removes an explicit connection; logged, and synced as a removal. Superseding is the decision log's, never undone here. */
  unrelate(fromId: string, toId: string, kind: string): ItemDetail {
    const from = this.row(fromId);
    const relationKind = oneOf(kind, RELATION_KINDS, 'relation kind');
    if (relationKind === 'supersedes') throw invalid('Superseding is part of the append-only decision log and can’t be removed.');
    const relation = this.ctx.get<{ id: string }>(
      `SELECT id FROM relations WHERE from_id = ? AND to_id = ? AND kind = ?`, from.id, toId, relationKind,
    );
    if (!relation) throw notFound(`"${from.title || from.id}" has no ${relationKind} connection to "${toId}".`);
    this.ctx.tx(() => {
      this.ctx.run(`DELETE FROM relations WHERE id = ?`, relation.id);
      this.ctx.record('relation', relation.id, 'delete', from.project_id, { from: from.id, to: toId, kind: relationKind });
    });
    return this.get(from.id);
  }

  link(fromId: string, toId: string, kind: RelationKind, projectId: string | null): void {
    this.ctx.tx(() => {
      const exists = this.ctx.get(
        `SELECT 1 FROM relations WHERE from_id = ? AND to_id = ? AND kind = ?`, fromId, toId, kind,
      );
      if (exists) return;
      const id = newId();
      this.ctx.run(
        `INSERT INTO relations (id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, fromId, toId, kind, this.ctx.now(),
      );
      this.ctx.record('relation', id, 'create', projectId, { from: fromId, to: toId, kind });
    });
  }

  row(id: string): ItemRow {
    const row = this.ctx.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`, required(id, 'Item id'));
    if (!row) throw notFound(`No item with id "${id}".`);
    return row;
  }

  /** `touch: false` for changes that aren't edits (pinning, opening, reminders), so "recently updated" stays meaningful. */
  write(row: ItemRow, changes: Record<string, SQLInputValue>, op: string, data: object = changes, touch = true): void {
    if (Object.keys(data).length === 0) return;
    this.ctx.tx(() => {
      const fields = { ...changes, ...(touch ? { updated_at: this.ctx.now() } : {}) };
      if (Object.keys(fields).length) {
        this.ctx.run(`UPDATE items SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(fields), row.id);
      }
      const projectId = 'project_id' in changes ? (changes.project_id as string | null) : row.project_id;
      this.ctx.record('item', row.id, op, projectId, data);
    });
  }

  filterClauses(filter: ItemFilter): { where: string[]; params: SQLInputValue[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (!filter.includeArchived) where.push('i.archived_at IS NULL');
    if (filter.inbox) where.push('i.project_id IS NULL');
    if (filter.pinned) where.push('i.pinned_at IS NOT NULL');
    if (filter.reminders) where.push('i.remind_at IS NOT NULL');
    if (filter.excludeDefinitions) where.push(`i.id NOT IN (
      WITH RECURSIVE definitions(id) AS (
        SELECT id FROM items WHERE coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
          OR json_extract(metadata, '$.template') IS NOT NULL
        UNION SELECT child.id FROM items child JOIN definitions d ON child.parent_id = d.id
      ) SELECT id FROM definitions
    )`);
    if (filter.intent !== undefined) {
      where.push('i.intent = ?');
      params.push(oneOf(filter.intent, INTENTS, 'intent'));
    }
    if (filter.unopenedDays !== undefined) {
      if (!Number.isInteger(filter.unopenedDays) || filter.unopenedDays < 0) throw invalid('unopenedDays must be a non-negative integer.');
      where.push(`i.type = 'bookmark' AND i.opened_at IS NULL AND i.created_at <= ?`);
      params.push(new Date(Date.now() - filter.unopenedDays * 86_400_000).toISOString());
    }
    if (filter.before) {
      const [updatedAt, id] = filter.before.split(',');
      if (!updatedAt || !id) throw invalid('"before" must be "<updatedAt>,<id>" from the last item of the previous page.');
      where.push('(i.updated_at, i.id) < (?, ?)');
      params.push(updatedAt, id);
    }
    if (filter.project !== undefined) {
      where.push('i.project_id = ?');
      params.push(this.projects.resolve(filter.project).id);
    }
    if (filter.type !== undefined) {
      where.push('i.type = ?');
      params.push(oneOf(filter.type, ITEM_TYPES, 'item type'));
    }
    if (filter.review) where.push(`json_extract(i.metadata, '$.presentation.review') = 1`);
    if (filter.secret !== undefined) {
      where.push(`coalesce(json_extract(i.metadata, '$.secret'), 0) = ?`);
      params.push(filter.secret ? 1 : 0);
    }
    if (filter.attention !== undefined) {
      where.push(`coalesce(json_extract(i.metadata, '$.presentation.attention'), 'normal') = ?`);
      params.push(oneOf(filter.attention, ATTENTION_LEVELS, 'attention'));
    }
    // A subquery rather than the tasks join, since hybrid search applies these clauses to a bare items scan.
    if (filter.taskStatus !== undefined) {
      where.push('EXISTS (SELECT 1 FROM tasks ts WHERE ts.item_id = i.id AND ts.status = ?)');
      params.push(oneOf(filter.taskStatus, TASK_STATUSES, 'task status'));
    }
    if (filter.tag !== undefined) {
      where.push('EXISTS (SELECT 1 FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = i.id AND tg.name = ?)');
      params.push(normalizeTag(filter.tag));
    }
    if (filter.importedKind !== undefined) {
      where.push("json_extract(i.metadata, '$.importedFrom.kind') = ?");
      params.push(required(filter.importedKind, 'Import source'));
    }
    return { where, params };
  }

  private touch(id: string): void {
    this.ctx.run(`UPDATE items SET updated_at = ? WHERE id = ?`, this.ctx.now(), id);
  }

  private applyTags(itemId: string, projectId: string | null, add: string[], remove: string[]): void {
    const now = this.ctx.now();
    for (const name of add) {
      this.ctx.run(`INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING`, newId(), name, now);
      this.ctx.run(
        `INSERT INTO item_tags (item_id, tag_id, created_at)
         SELECT ?, id, ? FROM tags WHERE name = ? ON CONFLICT DO NOTHING`,
        itemId, now, name,
      );
    }
    for (const name of remove) {
      this.ctx.run(`DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)`, itemId, name);
    }
    this.ctx.record('item', itemId, 'tag', projectId, { add, remove });
  }
}

export const isSecret = (row: Pick<ItemRow, 'metadata'>) => (JSON.parse(row.metadata) as ItemMetadata).secret === true;

function assertMutable(row: ItemRow): void {
  if (row.type === 'decision') {
    throw new MemoryError('invalid', 'Decisions are append-only. Record a new decision that supersedes this one instead.');
  }
}

function parseUrl(value: string): string {
  const trimmed = required(value, 'URL');
  try {
    return new URL(trimmed).href;
  } catch {
    throw invalid(`"${trimmed}" is not a valid URL.`);
  }
}
