import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, clientId, newId, normalizeTag, oneOf, toItem } from './context.ts';
import { invalid, notFound } from './errors.ts';
import { type ItemService, clampLimit, pageCursor } from './items.ts';
import { validPresentationPatch } from './presentation.ts';
import type { ProjectService } from './projects.ts';
import { REFERENCE_PATTERN } from './references.ts';
import { toFtsQuery } from './search.ts';
import {
  ATTENTION_LEVELS, INTENTS, ITEM_TYPES, type Item, type ItemDetail, type ItemMetadata, type ItemPresentation, TASK_STATUSES,
} from './types.ts';

export interface SavedViewFilter {
  project?: string;
  inbox?: boolean;
  type?: string;
  tag?: string;
  taskStatus?: string;
  pinned?: boolean;
  intent?: string;
  unopenedDays?: number;
  reminders?: boolean;
  review?: boolean;
  attention?: string;
}

export interface SavedViewInput {
  name: string;
  query?: string;
  filter?: SavedViewFilter;
}

export interface SavedView {
  id: string;
  name: string;
  query: string;
  filter: SavedViewFilter;
  createdAt: string;
  updatedAt: string;
}

export interface ViewPage {
  items: Item[];
  next: string | null;
}

export interface TemplateUseInput {
  title?: string;
  project?: string | null;
  /** The caller's local date as YYYY-MM-DD; defaults to today in UTC. */
  date?: string;
}

interface SavedViewDefinition {
  version: 1;
  query: string;
  filter: SavedViewFilter;
}

const MAX_VIEW_NAME = 120;
const MAX_VIEW_QUERY = 500;
const MAX_UNOPENED_DAYS = 36_500;
const MAX_TEMPLATE_NODES = 200;

const VIEW_FIELDS = ['name', 'query', 'filter'] as const;
const FILTER_FIELDS = ['project', 'inbox', 'type', 'tag', 'taskStatus', 'pinned', 'intent', 'unopenedDays', 'reminders', 'review', 'attention'] as const;
const FILTER_FLAGS = ['inbox', 'pinned', 'reminders', 'review'] as const;
const USE_FIELDS = ['title', 'project', 'date'] as const;
// Completion, review and organizing state start fresh in every copy.
const COPIED_PRESENTATION = ['kind', 'attention', 'checklist', 'hideCompleted'] as const;

/** Saved views are note items carrying `metadata.savedView`; their name is the item's title. */
export class ViewService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  list(): SavedView[] {
    return this.ctx
      .all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE json_extract(i.metadata, '$.savedView.version') = 1 AND i.archived_at IS NULL
           AND i.type = 'note' AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
         ORDER BY i.title COLLATE NOCASE, i.id`,
      )
      .map((row) => this.view(row));
  }

  get(id: string): SavedView {
    return this.view(this.definition(id));
  }

  create(input: SavedViewInput): SavedView {
    const { name, savedView } = this.validate(input);
    return this.get(this.items.insert({ type: 'note', title: name, metadata: { savedView } }, { automations: false }));
  }

  update(id: string, input: SavedViewInput): SavedView {
    const row = this.definition(id);
    const { name, savedView } = this.validate(input);
    const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), savedView };
    this.items.write(row, { title: name, metadata: JSON.stringify(metadata) }, 'update', { title: name, savedView });
    return this.get(row.id);
  }

  /** Archives the definition; the items it matched are untouched. */
  remove(id: string): void {
    this.items.archive(this.definition(id).id);
  }

  /** Newest first. Matching is keyword-only and deterministic, so results never depend on a model. */
  results(id: string, { before, limit }: { before?: string; limit?: number } = {}): ViewPage {
    const { query, filter } = this.get(id);
    const { project, ...rest } = filter;
    const { where, params } = this.items.filterClauses({ ...rest, before, secret: false });
    // The stored id, not a resolved reference, so a renamed project keeps its view.
    if (project !== undefined) {
      where.push('i.project_id = ?');
      params.push(project);
    }
    where.push(`json_extract(i.metadata, '$.savedView') IS NULL`, 'i.id NOT IN (SELECT id FROM template_members)');
    const match = query ? toFtsQuery(query) : null;
    if (match) {
      where.unshift('i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      params.unshift(match);
    }
    const size = clampLimit(limit);
    // Notes added under a template with the ordinary editor belong to it too, though they carry no template metadata.
    const rows = this.ctx.all<ItemRow>(
      `WITH RECURSIVE template_members(id) AS (
         SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL
         UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
       )
       SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
       WHERE ${where.join(' AND ')}
       ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
      ...params, size + 1,
    );
    const items = this.items.withTags(rows.slice(0, size).map(toItem));
    return { items, next: rows.length > size ? pageCursor(items.at(-1)!) : null };
  }

  private definition(id: string): ItemRow {
    const row = this.items.row(id);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (row.type !== 'note' || metadata.secret === true || row.archived_at !== null || (metadata.savedView as SavedViewDefinition | undefined)?.version !== 1) {
      throw notFound(`No saved view with id "${id}". List saved views to find it.`);
    }
    return row;
  }

  private view(row: ItemRow): SavedView {
    const definition = (JSON.parse(row.metadata) as ItemMetadata).savedView as SavedViewDefinition;
    const { name, savedView } = this.validate({ name: row.title, query: definition.query, filter: definition.filter }, false);
    return { id: row.id, name, query: savedView.query, filter: savedView.filter, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private validate(input: unknown, resolveProject = true): { name: string; savedView: SavedViewDefinition } {
    const fields = fieldsOf(input, VIEW_FIELDS, 'saved view');
    const name = text(fields.name, 'Saved view name', MAX_VIEW_NAME);
    if (!name) throw invalid('A saved view needs a name.');
    const query = fields.query === undefined ? '' : text(fields.query, 'Saved view query', MAX_VIEW_QUERY);
    if (query && !toFtsQuery(query)) throw invalid('The query needs at least one word or number. Leave it empty to match every item.');
    return { name, savedView: { version: 1, query, filter: fields.filter === undefined ? {} : this.filter(fields.filter, resolveProject) } };
  }

  private filter(input: unknown, resolveProject: boolean): SavedViewFilter {
    const fields = fieldsOf(input, FILTER_FIELDS, 'saved view filter');
    const filter: SavedViewFilter = {};
    for (const flag of FILTER_FLAGS) {
      if (fields[flag] === undefined) continue;
      if (typeof fields[flag] !== 'boolean') throw invalid(`${flag} must be true or false.`);
      if (fields[flag]) filter[flag] = true;
    }
    if (fields.project !== undefined) {
      const project = text(fields.project, 'project');
      filter.project = resolveProject ? this.projects.resolve(project).id : clientId(project, 'Saved project id');
    }
    if (filter.project && filter.inbox) throw invalid('A saved view can filter by a project or by the Inbox, not both.');
    if (fields.type !== undefined) filter.type = oneOf(text(fields.type, 'type'), ITEM_TYPES, 'item type');
    if (fields.tag !== undefined) filter.tag = normalizeTag(text(fields.tag, 'tag'));
    if (fields.taskStatus !== undefined) filter.taskStatus = oneOf(text(fields.taskStatus, 'taskStatus'), TASK_STATUSES, 'task status');
    if (fields.intent !== undefined) filter.intent = oneOf(text(fields.intent, 'intent'), INTENTS, 'intent');
    if (fields.attention !== undefined) filter.attention = oneOf(text(fields.attention, 'attention'), ATTENTION_LEVELS, 'attention');
    if (fields.unopenedDays !== undefined) {
      const days = fields.unopenedDays;
      if (!Number.isInteger(days) || (days as number) < 0 || (days as number) > MAX_UNOPENED_DAYS) {
        throw invalid(`unopenedDays must be a whole number of days from 0 to ${MAX_UNOPENED_DAYS}.`);
      }
      filter.unopenedDays = days as number;
    }
    return filter;
  }
}

interface TemplateNode {
  row: ItemRow;
  /** The source parent; null for the root, which every copy places at the top level. */
  parentId: string | null;
  tags: string[];
  presentation: Partial<ItemPresentation>;
}

/** Templates are ordinary note trees whose every note carries `metadata.template.rootId`. */
export class TemplateService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  list(): Item[] {
    return this.items.withTags(this.ctx
      .all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE json_extract(i.metadata, '$.template.rootId') = i.id AND json_extract(i.metadata, '$.template.version') = 1
           AND i.type = 'note' AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 AND i.archived_at IS NULL
         ORDER BY i.title COLLATE NOCASE, i.id`,
      )
      .map(toItem));
  }

  /** Copies the note and everything below it into a new template; the source is left as it was. */
  create(sourceId: string, name?: string): ItemDetail {
    const nodes = this.tree(sourceId, false);
    const title = (name === undefined ? '' : text(name, 'Template name', MAX_VIEW_NAME)) || `${nodes[0]!.row.title || 'Untitled'} template`;
    return this.items.get(this.copy(nodes, title, null, (value) => value, true));
  }

  /** A new ordinary note tree from the template, with {{date}} and {{project}} filled in. Archived template notes are left out. */
  instantiate(id: string, input: TemplateUseInput = {}): ItemDetail {
    const fields = fieldsOf(input, USE_FIELDS, 'template use');
    const project = fields.project === undefined || fields.project === null ? null : this.projects.resolve(text(fields.project, 'project'));
    const values = { date: fields.date === undefined ? this.ctx.now().slice(0, 10) : calendarDate(fields.date), project: project?.name ?? 'Inbox' };
    const expand = (value: string) => value.replace(/\{\{(date|project)\}\}/g, (_, key: keyof typeof values) => values[key]);
    const root = this.items.row(id);
    const template = (JSON.parse(root.metadata) as ItemMetadata).template as { version?: unknown; rootId?: unknown } | undefined;
    if (root.archived_at !== null || template?.version !== 1 || template.rootId !== root.id) throw notFound(`No template with id "${id}". List templates to find it.`);
    const nodes = this.tree(root.id, true);
    const title = expand((fields.title === undefined ? '' : text(fields.title, 'title')) || root.title);
    return this.items.get(this.copy(nodes, title, project?.id ?? null, expand, false));
  }

  /** The whole subtree, parents before children and siblings in order, refused as a whole if any note can't be copied. */
  private tree(rootId: string, skipArchived: boolean): TemplateNode[] {
    const nodes = [this.node(this.items.row(rootId), null)];
    for (let index = 0; index < nodes.length; index++) {
      const parent = nodes[index]!.row;
      const children = this.ctx.all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.parent_id = ? ORDER BY i.sort_order, i.id`, parent.id,
      );
      for (const child of children) {
        if (skipArchived && child.archived_at !== null) continue;
        if (nodes.length === MAX_TEMPLATE_NODES) {
          throw invalid(`A template can hold at most ${MAX_TEMPLATE_NODES} notes. Save a smaller part of this outline as a template.`);
        }
        nodes.push(this.node(child, parent.id));
      }
    }
    return nodes;
  }

  private node(row: ItemRow, parentId: string | null): TemplateNode {
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    const label = `"${row.title || row.id}"`;
    const move = 'Move it out of this outline first, or save a part of the outline without it.';
    if (row.archived_at !== null) throw invalid(`${label} is archived and can’t go into a template. Unarchive it, or move it out of this outline first.`);
    if (metadata.secret === true) throw invalid(`${label} is a secret note, which templates never copy. ${move}`);
    if (row.type !== 'note') throw invalid(`${label} is a ${row.type}; templates copy only notes. ${move}`);
    if (metadata.savedView) throw invalid(`${label} is a saved view, not a note a template can copy. ${move}`);
    if (this.ctx.get(`SELECT 1 FROM attachments WHERE item_id = ?`, row.id)) throw invalid(`${label} has an attached file, which templates don’t copy. ${move}`);
    const stored = metadata.presentation ?? {};
    const presentation = validPresentationPatch(Object.fromEntries(COPIED_PRESENTATION.filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]])));
    const tags = this.ctx
      .all<{ name: string }>(`SELECT tg.name FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = ? ORDER BY tg.name`, row.id)
      .map((tag) => tag.name);
    return { row, parentId, tags, presentation };
  }

  private copy(
    nodes: TemplateNode[], title: string, projectId: string | null, expand: (value: string) => string, template: boolean,
  ): string {
    const ids = new Map(nodes.map((node) => [node.row.id, newId()]));
    const rootId = ids.get(nodes[0]!.row.id)!;
    const remap = (body: string) => body.replace(REFERENCE_PATTERN, (token, target: string, label: string | undefined) =>
      ids.has(target) ? `[[item:${ids.get(target)}${label === undefined ? '' : `|${label}`}]]` : token);
    this.ctx.tx(() => {
      nodes.forEach(({ row, parentId, tags, presentation }, index) => {
        this.items.insert({
          id: ids.get(row.id)!,
          type: 'note',
          title: index === 0 ? title : expand(row.title),
          body: expand(remap(resetChecklist(row.body))),
          project: projectId ?? undefined,
          tags,
          parentId: parentId === null ? null : ids.get(parentId)!,
          metadata: {
            ...(Object.keys(presentation).length ? { presentation } : {}),
            ...(template ? { template: { version: 1, rootId } } : {}),
          },
        }, { automations: false });
      });
    });
    return rootId;
  }
}

function fieldsOf(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`The ${label} must be an object.`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} field "${unknown}". Expected: ${allowed.join(', ')}.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = Infinity): string {
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${label} is longer than ${max} characters.`);
  return trimmed;
}

function calendarDate(value: unknown): string {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw invalid('date must be a real calendar date written YYYY-MM-DD.');
  }
  return value as string;
}

const CHECKED_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[xX]\]/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const columns = (text: string) => [...text].reduce((column, character) => character === '\t' ? column + 4 - column % 4 : column + 1, 0);

/** List indentation determines whether a checkbox-looking line is a task or an indented code example. */
function resetChecklist(markdown: string): string {
  let fence: string | null = null;
  const containers: number[] = [];
  return markdown
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
        return line;
      }
      const indent = columns(/^[ \t]*/.exec(line)![0]);
      while (containers.length && indent < containers.at(-1)!) containers.pop();
      if (indent >= (containers.at(-1) ?? 0) + 4) return line;
      const list = LIST_MARKER.exec(line)?.[0];
      if (list) {
        containers.push(columns(list));
        fence = FENCE.exec(line.slice(list.length))?.[1] ?? null;
      } else if (marker) {
        fence = marker;
      }
      return line.replace(CHECKED_BOX, '$1[ ]');
    })
    .join('\n');
}
