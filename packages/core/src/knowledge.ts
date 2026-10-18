import type { SQLInputValue } from 'node:sqlite';
import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, clientId, newId, oneOf, slugify, toSummaryItem, toTaskFields } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type ItemService, clampLimit } from './items.ts';
import { pathToRoot } from './placement.ts';
import type { ProjectService } from './projects.ts';
import { toFtsQuery } from './search.ts';
import { ITEM_TYPES, type Item, type ItemMetadata, type ItemType, type TaskFields } from './types.ts';

export const KNOWLEDGE_KINDS = ['recipe', 'preference', 'collection'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const PROPERTY_TYPES = ['text', 'number', 'date', 'checkbox', 'select'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
/** A date value is a calendar date written YYYY-MM-DD; a select value is the chosen option's id. */
export type PropertyValue = string | number | boolean;

export const COLLECTION_LAYOUTS = ['table', 'cards', 'kanban'] as const;
export type CollectionLayout = (typeof COLLECTION_LAYOUTS)[number];

export const FILTER_OPS = ['equals', 'notEquals', 'contains', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const BUILT_IN_SORTS = ['title', 'createdAt', 'updatedAt'] as const;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export const ROW_TYPES = ITEM_TYPES.filter((type) => type !== 'decision');

export const KNOWLEDGE_LIMITS = {
  name: 120,
  recipeInstruction: 4000,
  preferenceInstruction: 1000,
  query: 500,
  fields: 20,
  fieldName: 80,
  fieldKey: 40,
  options: 50,
  optionName: 80,
  textValue: 2000,
  number: 1e15,
  sorts: 3,
  filters: 10,
  evaluatedRows: 1000,
  selectedPreferences: 10,
  preferenceContext: 4000,
} as const;

export interface RecipeScope {
  rootId: string | null;
  query: string | null;
  /** A project id; only with a query. */
  project: string | null;
}

export interface Recipe {
  id: string;
  name: string;
  instruction: string;
  scope: RecipeScope;
  createdAt: string;
  updatedAt: string;
}

/** Without an id this saves a new recipe; with one, omitted fields keep their current values and a given scope replaces the whole scope. */
export interface SaveRecipeInput {
  id?: string;
  name?: string;
  instruction?: string;
  scope?: { rootId?: string | null; query?: string | null; project?: string | null };
}

export interface OrganizationPreference {
  id: string;
  name: string;
  instruction: string;
  /** The project id it applies to; null applies everywhere. */
  project: string | null;
  createdAt: string;
  updatedAt: string;
}

/** With an id, omitted fields keep their current values. A missing or null name is derived from the instruction. */
export interface SavePreferenceInput {
  id?: string;
  name?: string | null;
  instruction?: string;
  project?: string | null;
}

export interface SelectOption {
  id: string;
  name: string;
}

export interface PropertyField {
  id: string;
  key: string;
  name: string;
  type: PropertyType;
  /** Select fields only. */
  options?: SelectOption[];
}

/** Ids and keys are generated when omitted; pass an existing field's id to keep its values. A field's type can't change. */
export interface PropertyFieldInput {
  id?: string;
  key?: string;
  name: string;
  type: PropertyType;
  options?: { id?: string; name: string }[];
}

export interface CollectionScope {
  /** A project id. */
  project: string | null;
  query: string | null;
  type: ItemType | null;
}

/** `field` is a property field id or one of BUILT_IN_SORTS. */
export interface CollectionSort {
  field: string;
  direction: (typeof SORT_DIRECTIONS)[number];
}

/** `field` is a property field id. `empty` and `notEmpty` take no value. */
export interface CollectionFilter {
  field: string;
  op: FilterOp;
  value?: PropertyValue;
}

export interface Collection {
  id: string;
  name: string;
  fields: PropertyField[];
  scope: CollectionScope;
  layout: CollectionLayout;
  /** The id of a select field; required for kanban. */
  groupBy: string | null;
  sort: CollectionSort[];
  filters: CollectionFilter[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Without an id this saves a new collection; with one, omitted fields keep their current values. Field, sort, filter and
 * groupBy references accept a field's id or key and are stored as ids.
 */
export interface SaveCollectionInput {
  id?: string;
  name?: string;
  fields?: PropertyFieldInput[];
  scope?: { project?: string | null; query?: string | null; type?: string | null };
  layout?: CollectionLayout;
  groupBy?: string | null;
  sort?: { field: string; direction?: CollectionSort['direction'] }[];
  filters?: { field: string; op: FilterOp; value?: PropertyValue }[];
}

export interface CollectionRowsOptions {
  offset?: number;
  limit?: number;
  /** Only rows in one group: an option id of the groupBy field, or null for rows without a value. */
  group?: string | null;
}

export interface CollectionRow {
  item: Item & { task: TaskFields | null };
  /** Valid values by field id; unset fields are absent. */
  values: Record<string, PropertyValue>;
}

export interface CollectionGroup {
  /** The option id, or null for rows without a value. */
  option: string | null;
  name: string;
  count: number;
}

export interface CollectionRowsPage {
  collection: Collection;
  rows: CollectionRow[];
  offset: number;
  limit: number;
  /** Rows after filters (and the group, if one was chosen), among the evaluated items. */
  total: number;
  next: number | null;
  /** Ordinary items the scope matches. */
  matched: number;
  /** The most recently updated scope items that were filtered and sorted. */
  evaluated: number;
  /** True when the scope matched more items than were evaluated, so the rows don't cover the whole scope. */
  capped: boolean;
  /** Counts per option of the groupBy field over the filtered rows, ignoring the chosen group; null without groupBy. */
  groups: CollectionGroup[] | null;
}

interface StoredScope {
  rootId: string | null;
  query: string | null;
  project: string | null;
}

const RECIPE_INPUT = ['id', 'name', 'instruction', 'scope'] as const;
const RECIPE_SCOPE_INPUT = ['rootId', 'query', 'project'] as const;
const PREFERENCE_INPUT = ['id', 'name', 'instruction', 'project'] as const;
const COLLECTION_INPUT = ['id', 'name', 'fields', 'scope', 'layout', 'groupBy', 'sort', 'filters'] as const;
const COLLECTION_SCOPE_INPUT = ['project', 'query', 'type'] as const;
const FIELD_INPUT = ['id', 'key', 'name', 'type', 'options'] as const;
const OPTION_INPUT = ['id', 'name'] as const;
const SORT_INPUT = ['field', 'direction'] as const;
const FILTER_INPUT = ['field', 'op', 'value'] as const;
const ROWS_INPUT = ['offset', 'limit', 'group'] as const;

const OPS_BY_TYPE: Record<PropertyType, readonly FilterOp[]> = {
  text: ['equals', 'notEquals', 'contains', 'empty', 'notEmpty'],
  number: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  date: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  checkbox: ['equals'],
  select: ['equals', 'notEquals', 'empty', 'notEmpty'],
};

const LABELS: Record<KnowledgeKind, string> = { recipe: 'AI recipe', preference: 'organization preference', collection: 'collection' };
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const RESERVED_KEY = 'title';
const DERIVED_NAME = 80;
const EMPTY_SCOPE: CollectionScope = { project: null, query: null, type: null };
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;
// Definitions and templates, with anything nested below them.
const EXCLUDED = `WITH RECURSIVE excluded(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL OR json_extract(metadata, '$.knowledgeDefinition') IS NOT NULL
  UNION SELECT c.id FROM items c JOIN excluded e ON c.parent_id = e.id
)`;
const ORDINARY = `i.archived_at IS NULL AND i.type != 'decision'
  AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
  AND json_extract(i.metadata, '$.savedView') IS NULL
  AND json_extract(i.metadata, '$.conversation') IS NULL
  AND i.id NOT IN (SELECT id FROM excluded)`;

/**
 * Recipes, organization preferences and collections are ordinary notes carrying `metadata.knowledgeDefinition = true`
 * and `metadata.knowledge = {version: 1, kind, …}`; the note's title is the name. Field values live on ordinary items in
 * `metadata.fieldValues[collectionId][fieldId]`, so they travel with history, export and sync.
 */
export class KnowledgeService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  listRecipes(): Recipe[] {
    return this.list('recipe', (row) => this.recipe(row));
  }

  getRecipe(id: string): Recipe {
    return this.recipe(this.definition(id, 'recipe'));
  }

  saveRecipe(input: SaveRecipeInput): Recipe {
    const fields = fieldsOf(input, RECIPE_INPUT, 'recipe');
    return this.ctx.tx(() => {
      const row = fields.id === undefined ? null : this.definition(fields.id, 'recipe');
      const current = row && this.recipe(row);
      const name = fields.name === undefined ? current?.name : text(fields.name, 'The recipe name', KNOWLEDGE_LIMITS.name);
      if (!name) throw invalid('A recipe needs a name.');
      const instruction = fields.instruction === undefined ? current?.instruction
        : text(fields.instruction, 'The recipe instruction', KNOWLEDGE_LIMITS.recipeInstruction);
      if (!instruction) throw invalid('A recipe needs an instruction saying what the AI should propose.');
      const scope = fields.scope === undefined ? current?.scope : this.recipeScope(fields.scope, true);
      if (!scope) throw invalid('A recipe needs a scope: one branch (rootId) or one keyword topic (query).');
      return this.getRecipe(this.save(row, 'recipe', name, { instruction, scope }));
    });
  }

  /** Reversible: the definition stays an archived note. */
  archiveRecipe(id: string): void {
    this.items.archive(this.definition(id, 'recipe').id);
  }

  /** With a project, the preferences that apply there: global ones and that project's own. */
  listPreferences({ project }: { project?: string } = {}): OrganizationPreference[] {
    const all = this.list('preference', (row) => this.preference(row));
    if (project === undefined) return all;
    const projectId = this.projects.resolve(text(project, 'The project', 200)).id;
    return all.filter((preference) => preference.project === null || preference.project === projectId);
  }

  getPreference(id: string): OrganizationPreference {
    return this.preference(this.definition(id, 'preference'));
  }

  savePreference(input: SavePreferenceInput): OrganizationPreference {
    const fields = fieldsOf(input, PREFERENCE_INPUT, 'organization preference');
    return this.ctx.tx(() => {
      const row = fields.id === undefined ? null : this.definition(fields.id, 'preference');
      const current = row && this.preference(row);
      const instruction = fields.instruction === undefined ? current?.instruction
        : text(fields.instruction, 'The preference', KNOWLEDGE_LIMITS.preferenceInstruction);
      if (!instruction) throw invalid('An organization preference needs an instruction, such as “File receipts under Finance”.');
      const named = fields.name === undefined || fields.name === null ? '' : text(fields.name, 'The preference name', KNOWLEDGE_LIMITS.name);
      const name = named || (fields.name === undefined && current ? current.name : derivedName(instruction));
      const project = fields.project === undefined ? current?.project ?? null
        : fields.project === null ? null : this.projects.resolve(text(fields.project, 'The project', 200)).id;
      return this.getPreference(this.save(row, 'preference', name, { instruction, project }));
    });
  }

  archivePreference(id: string): void {
    this.items.archive(this.definition(id, 'preference').id);
  }

  /**
   * The preferences a person explicitly chose for one AI request, checked against where it runs. A project preference
   * only applies to a request in that project; `project` is the request's project id or name, or null for none.
   */
  selectPreferences(ids: string[], { project = null }: { project?: string | null } = {}): OrganizationPreference[] {
    if (!Array.isArray(ids) || ids.length > KNOWLEDGE_LIMITS.selectedPreferences || new Set(ids).size !== ids.length) {
      throw invalid(`Choose at most ${KNOWLEDGE_LIMITS.selectedPreferences} different organization preferences.`);
    }
    const projectId = project === null ? null : this.projects.resolve(text(project, 'The project', 200)).id;
    const chosen = ids.map((id) => this.getPreference(id));
    for (const preference of chosen) {
      if (preference.project !== null && preference.project !== projectId) {
        throw invalid(`“${preference.name}” applies only to its own project. Leave it out, or run this in that project.`);
      }
    }
    if (chosen.reduce((sum, preference) => sum + preference.instruction.length, 0) > KNOWLEDGE_LIMITS.preferenceContext) {
      throw invalid(`The chosen preferences hold more than ${KNOWLEDGE_LIMITS.preferenceContext} characters. Choose fewer.`);
    }
    return chosen;
  }

  listCollections(): Collection[] {
    return this.list('collection', (row) => this.collection(row));
  }

  getCollection(id: string): Collection {
    return this.collection(this.definition(id, 'collection'));
  }

  saveCollection(input: SaveCollectionInput): Collection {
    const fields = fieldsOf(input, COLLECTION_INPUT, 'collection');
    return this.ctx.tx(() => {
      const row = fields.id === undefined ? null : this.definition(fields.id, 'collection');
      const current = row && this.collection(row);
      const name = fields.name === undefined ? current?.name : text(fields.name, 'The collection name', KNOWLEDGE_LIMITS.name);
      if (!name) throw invalid('A collection needs a name.');
      const definition = this.collectionDefinition({
        fields: fields.fields === undefined ? current?.fields ?? [] : fields.fields,
        scope: fields.scope === undefined ? current?.scope ?? EMPTY_SCOPE : fields.scope,
        layout: fields.layout === undefined ? current?.layout ?? 'table' : fields.layout,
        groupBy: fields.groupBy === undefined ? current?.groupBy ?? null : fields.groupBy,
        sort: fields.sort === undefined ? current?.sort ?? [] : fields.sort,
        filters: fields.filters === undefined ? current?.filters ?? [] : fields.filters,
      }, { current: current?.fields ?? [], stored: false, resolveProject: fields.scope !== undefined });
      return this.getCollection(this.save(row, 'collection', name, definition));
    });
  }

  /** Reversible. Field values stay on their items and return if the collection is unarchived. */
  archiveCollection(id: string): void {
    this.items.archive(this.definition(id, 'collection').id);
  }

  /**
   * Scope items, newest updated first, filtered and sorted in core. At most KNOWLEDGE_LIMITS.evaluatedRows of them are
   * evaluated; `capped` says when the scope held more.
   */
  collectionRows(id: string, options: CollectionRowsOptions = {}): CollectionRowsPage {
    const collection = this.getCollection(id);
    const request = fieldsOf(options, ROWS_INPUT, 'rows request');
    const limit = clampLimit(request.limit as number | undefined);
    const offset = request.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw invalid('offset must be a whole number from 0.');
    const groupField = collection.groupBy === null ? null : collection.fields.find((field) => field.id === collection.groupBy)!;
    const group = request.group;
    if (group !== undefined) {
      if (!groupField) throw invalid('This collection isn’t grouped. Choose a groupBy field before asking for one group.');
      if (group !== null && (typeof group !== 'string' || !groupField.options!.some((option) => option.id === group))) {
        throw invalid(`group must be null or the id of one of ${groupField.name}’s options.`);
      }
    }

    const { where, params } = this.scopeClauses(collection.scope);
    const matched = this.ctx.get<{ n: number }>(`${EXCLUDED} SELECT count(*) AS n FROM items i WHERE ${where}`, ...params)!.n;
    const scoped = this.ctx.all<ItemRow>(
      `${EXCLUDED} SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${where} ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
      ...params, KNOWLEDGE_LIMITS.evaluatedRows,
    );
    const byId = new Map(collection.fields.map((field) => [field.id, field]));
    const filtered = scoped
      .map((row) => ({ row, values: readValues(collection, parseMetadata(row.metadata)) }))
      .filter(({ values }) => collection.filters.every((filter) => matches(filter, byId.get(filter.field)!, values[filter.field])));
    const groups = groupField && [
      ...groupField.options!.map((option) => ({ option: option.id, name: option.name, count: filtered.filter((r) => r.values[groupField.id] === option.id).length })),
      { option: null, name: `No ${groupField.name}`, count: filtered.filter((r) => r.values[groupField.id] === undefined).length },
    ];
    const selected = group === undefined ? filtered : filtered.filter((r) => (r.values[groupField!.id] ?? null) === group);
    selected.sort((a, b) => {
      for (const rule of collection.sort) {
        const order = compare(rule.field, byId.get(rule.field), a.row, b.row, a.values, b.values, rule.direction);
        if (order) return order;
      }
      return 0;
    });
    const page = selected.slice(offset, offset + limit);
    const items = this.items.withTags(page.map(({ row }) => toSummaryItem(row)));
    return {
      collection,
      rows: items.map((item, index) => ({ item: { ...item, task: toTaskFields(page[index]!.row) }, values: page[index]!.values })),
      offset,
      limit,
      total: selected.length,
      next: offset + limit < selected.length ? offset + limit : null,
      matched,
      evaluated: scoped.length,
      capped: matched > scoped.length,
      groups,
    };
  }

  /** Valid values the item holds for one collection, by field id. */
  getValues(itemId: string, collectionId: string): Record<string, PropertyValue> {
    const collection = this.getCollection(collectionId);
    return readValues(collection, parseMetadata(this.ordinaryRow(itemId).metadata));
  }

  /**
   * Sets values by field id or key; null or empty text clears a field. Other fields, values of fields since removed and
   * other collections' values are kept. Returns the item's values for this collection.
   */
  setValues(itemId: string, collectionId: string, values: Record<string, PropertyValue | null>): Record<string, PropertyValue> {
    const collection = this.getCollection(collectionId);
    if (!isObject(values) || !Object.keys(values).length) throw invalid('Give at least one field value to set, by field id or key.');
    if (Object.keys(values).length > KNOWLEDGE_LIMITS.fields) throw invalid(`Set at most ${KNOWLEDGE_LIMITS.fields} field values at once.`);
    const updates = new Map<string, PropertyValue | null>();
    for (const [reference, raw] of Object.entries(values)) {
      const field = fieldRef(reference, collection.fields, 'the values');
      if (updates.has(field.id)) throw invalid(`${field.name} is given twice. Set each field once.`);
      updates.set(field.id, raw === null ? null : parseValue(field, raw, field.name));
    }
    return this.ctx.tx(() => {
      const row = this.ordinaryRow(itemId);
      const metadata = parseMetadata(row.metadata);
      const all = isObject(metadata.fieldValues) ? metadata.fieldValues : {};
      const entry: Record<string, unknown> = isObject(all[collection.id]) ? { ...all[collection.id] as Record<string, unknown> } : {};
      for (const [fieldId, value] of updates) {
        if (value === null) delete entry[fieldId];
        else entry[fieldId] = value;
      }
      const fieldValues: Record<string, unknown> = { ...all, [collection.id]: entry };
      if (!Object.keys(entry).length) delete fieldValues[collection.id];
      const next: ItemMetadata = { ...metadata, fieldValues };
      if (!Object.keys(fieldValues).length) delete next.fieldValues;
      if (JSON.stringify(next) !== JSON.stringify(metadata)) {
        this.items.write(row, { metadata: JSON.stringify(next) }, 'field_values', { collectionId: collection.id, fieldValues: entry });
      }
      return readValues(collection, next);
    });
  }

  private list<T>(kind: KnowledgeKind, read: (row: ItemRow) => T): T[] {
    // One damaged by another device's sync is left out rather than failing the list.
    return this.ctx
      .all<ItemRow>(
        `${TEMPLATE_MEMBERS} SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE json_extract(i.metadata, '$.knowledgeDefinition') = 1 AND json_extract(i.metadata, '$.knowledge.version') = 1
           AND json_extract(i.metadata, '$.knowledge.kind') = ? AND i.type = 'note' AND i.archived_at IS NULL
           AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 AND i.id NOT IN (SELECT id FROM template_members)
         ORDER BY i.title COLLATE NOCASE, i.id`,
        kind,
      )
      .flatMap((row) => {
        try {
          return [read(row)];
        } catch (error) {
          if (error instanceof MemoryError) return [];
          throw error;
        }
      });
  }

  private definition(id: unknown, kind: KnowledgeKind): ItemRow {
    if (typeof id !== 'string' || !id.trim()) throw invalid(`The ${LABELS[kind]} id is required.`);
    const row = this.ctx.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`, id);
    const metadata = row ? parseMetadata(row.metadata) : null;
    const knowledge = metadata?.knowledge;
    if (!row || !metadata || row.type !== 'note' || row.archived_at !== null || metadata.secret === true || metadata.knowledgeDefinition !== true
      || !isObject(knowledge) || knowledge.version !== 1 || knowledge.kind !== kind || inTemplate(this.ctx, row.id)) {
      throw notFound(`No ${LABELS[kind]} with id "${id}". List ${LABELS[kind]}s to find it.`);
    }
    return row;
  }

  private stored(row: ItemRow): Record<string, unknown> {
    return parseMetadata(row.metadata).knowledge as Record<string, unknown>;
  }

  private save(row: ItemRow | null, kind: KnowledgeKind, title: string, data: object): string {
    const knowledge = { version: 1, kind, ...data };
    const body = 'instruction' in data ? String(data.instruction)
      : (data as Pick<Collection, 'fields'>).fields.map((field) => `- ${field.name} (${field.type})${field.options ? `: ${field.options.map((option) => option.name).join(', ')}` : ''}`).join('\n');
    if (!row) return this.items.insert({ type: 'note', title, body, metadata: { knowledgeDefinition: true, knowledge } }, { automations: false });
    const metadata = { ...parseMetadata(row.metadata), knowledgeDefinition: true, knowledge };
    this.items.write(row, { title, body, metadata: JSON.stringify(metadata) }, 'update', { title, body, knowledge });
    return row.id;
  }

  private recipe(row: ItemRow): Recipe {
    const stored = this.stored(row);
    const instruction = text(stored.instruction, 'The recipe instruction', KNOWLEDGE_LIMITS.recipeInstruction);
    if (!instruction) throw invalid('This recipe has no instruction.');
    return {
      id: row.id, name: row.title, instruction, scope: this.recipeScope(stored.scope, false),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private recipeScope(value: unknown, resolve: boolean): StoredScope {
    const fields = fieldsOf(value, RECIPE_SCOPE_INPUT, 'recipe scope');
    const rootId = fields.rootId === undefined || fields.rootId === null ? null : clientId(fields.rootId, 'The branch');
    const query = optionalText(fields.query, 'The topic', KNOWLEDGE_LIMITS.query);
    if ((rootId === null) === (query === null)) throw invalid('Choose either one branch (rootId) or one keyword topic (query) for the recipe.');
    if (query !== null && !toFtsQuery(query)) throw invalid('Name the topic with at least one word or number.');
    const projectRef = fields.project === undefined || fields.project === null ? null : text(fields.project, 'The project', 200);
    if (rootId !== null && projectRef) throw invalid('A branch already determines its project; choose a project only for a topic.');
    const project = projectRef === null ? null : resolve ? this.projects.resolve(projectRef).id : clientId(projectRef, 'The project');
    if (rootId !== null && resolve) this.ordinaryRow(rootId);
    return { rootId, query, project };
  }

  private preference(row: ItemRow): OrganizationPreference {
    const stored = this.stored(row);
    const instruction = text(stored.instruction, 'The preference', KNOWLEDGE_LIMITS.preferenceInstruction);
    if (!instruction) throw invalid('This preference has no instruction.');
    const project = stored.project === undefined || stored.project === null ? null : clientId(stored.project, 'The project');
    return { id: row.id, name: row.title, instruction, project, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private collection(row: ItemRow): Collection {
    const definition = this.collectionDefinition(this.stored(row), { current: [], stored: true, resolveProject: false });
    return { id: row.id, name: row.title, ...definition, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** Stored definitions must already carry every id and key; input may leave them to be generated. */
  private collectionDefinition(
    raw: Record<string, unknown>, { current, stored, resolveProject }: { current: PropertyField[]; stored: boolean; resolveProject: boolean },
  ): Omit<Collection, 'id' | 'name' | 'createdAt' | 'updatedAt'> {
    const fields = parseFields(raw.fields, current, stored);
    const scope = this.collectionScope(raw.scope, resolveProject);
    const layout = oneOf(text(raw.layout, 'The layout'), COLLECTION_LAYOUTS, 'layout');
    const groupBy = raw.groupBy === null || raw.groupBy === undefined ? null : fieldRef(raw.groupBy, fields, 'groupBy');
    if (groupBy && groupBy.type !== 'select') throw invalid(`Group by a select field; ${groupBy.name} is a ${groupBy.type} field.`);
    if (layout === 'kanban' && !groupBy) throw invalid('A Kanban collection needs groupBy: a select field whose options become its columns.');
    return { fields, scope, layout, groupBy: groupBy?.id ?? null, sort: parseSort(raw.sort, fields), filters: parseFilters(raw.filters, fields) };
  }

  private collectionScope(value: unknown, resolve: boolean): CollectionScope {
    const fields = fieldsOf(value, COLLECTION_SCOPE_INPUT, 'collection scope');
    const projectRef = fields.project === undefined || fields.project === null ? null : text(fields.project, 'The project', 200);
    const project = projectRef === null ? null : resolve ? this.projects.resolve(projectRef).id : clientId(projectRef, 'The project');
    const query = optionalText(fields.query, 'The topic', KNOWLEDGE_LIMITS.query);
    if (query !== null && !toFtsQuery(query)) throw invalid('Name the topic with at least one word or number, or leave it empty.');
    const type = fields.type === undefined || fields.type === null ? null : oneOf(text(fields.type, 'The item type'), ROW_TYPES, 'collection item type');
    return { project, query, type };
  }

  private scopeClauses(scope: CollectionScope): { where: string; params: SQLInputValue[] } {
    const where = [ORDINARY];
    const params: SQLInputValue[] = [];
    if (scope.query !== null) {
      where.push('i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      params.push(toFtsQuery(scope.query)!.replaceAll(' OR ', ' AND '));
    }
    if (scope.project !== null) {
      where.push('i.project_id = ?');
      params.push(scope.project);
    }
    if (scope.type !== null) {
      where.push('i.type = ?');
      params.push(scope.type);
    }
    return { where: where.join(' AND '), params };
  }

  /** An item that can hold field values or be a recipe's branch. */
  private ordinaryRow(id: unknown): ItemRow {
    if (typeof id !== 'string' || !id.trim()) throw invalid('An item id is required.');
    const row = this.items.row(id);
    const metadata = parseMetadata(row.metadata);
    const label = `"${row.title || row.id}"`;
    if (metadata.secret === true) throw invalid(`${label} is a secret note. Secret notes stay outside collections and AI recipes.`);
    if (row.type === 'decision') throw invalid(`${label} is a decision. Decisions are append-only and take no field values or AI actions.`);
    if (row.archived_at !== null) throw invalid(`${label} is archived. Unarchive it first.`);
    if (metadata.knowledgeDefinition != null || metadata.savedView != null || metadata.conversation != null) {
      throw invalid(`${label} is a saved definition or chat, not an ordinary item.`);
    }
    if (this.ctx.get(
      `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?))
         AND (json_extract(metadata, '$.template') IS NOT NULL OR json_extract(metadata, '$.knowledgeDefinition') IS NOT NULL)`,
      JSON.stringify(pathToRoot(this.ctx, row.id)),
    )) {
      throw invalid(`${label} belongs to a template or saved definition. Use an ordinary note outside it.`);
    }
    return row;
  }
}

function parseFields(raw: unknown, current: PropertyField[], stored: boolean): PropertyField[] {
  if (!Array.isArray(raw)) throw invalid('fields must be a list.');
  if (raw.length > KNOWLEDGE_LIMITS.fields) throw invalid(`A collection can define at most ${KNOWLEDGE_LIMITS.fields} fields.`);
  const existing = new Map(current.map((field) => [field.id, field]));
  const ids = new Set<string>();
  const keys = new Set<string>([RESERVED_KEY]);
  const parsed = raw.map((value: unknown, index) => {
    const label = `Field ${index + 1}`;
    const fields = fieldsOf(value, FIELD_INPUT, label.toLowerCase());
    const name = text(fields.name, `${label}’s name`, KNOWLEDGE_LIMITS.fieldName);
    if (!name) throw invalid(`${label} needs a name.`);
    const type = oneOf(text(fields.type, `${label}’s type`), PROPERTY_TYPES, 'field type');
    const id = fields.id === undefined && !stored ? newId() : clientId(fields.id, `${label}’s id`);
    if (ids.has(id)) throw invalid(`${label} repeats the id of another field. Each field needs its own id.`);
    ids.add(id);
    const previous = existing.get(id);
    if (previous && previous.type !== type) {
      throw invalid(`${previous.name} is a ${previous.type} field and a field’s type can’t change. Add a new field instead.`);
    }
    const key = fields.key === undefined && !stored ? previous?.key ?? null : fieldKey(fields.key, label);
    if (key !== null) {
      if (keys.has(key)) throw invalid(`Two fields use the key "${key}". Give each field its own key.`);
      keys.add(key);
    }
    if (type !== 'select' && fields.options !== undefined) throw invalid(`${name} is a ${type} field; only select fields have options.`);
    const options = type === 'select' ? parseOptions(fields.options, name, stored) : undefined;
    return { id, key, name, type, ...(options && { options }) };
  });
  return parsed.map((field) => ({ ...field, key: field.key ?? derivedKey(field.name, keys) }));
}

function parseOptions(raw: unknown, fieldName: string, stored: boolean): SelectOption[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > KNOWLEDGE_LIMITS.options) {
    throw invalid(`${fieldName} is a select field and needs between 1 and ${KNOWLEDGE_LIMITS.options} options.`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  return raw.map((value: unknown, index) => {
    const label = `Option ${index + 1} of ${fieldName}`;
    const fields = fieldsOf(value, OPTION_INPUT, label.toLowerCase());
    const name = text(fields.name, label, KNOWLEDGE_LIMITS.optionName);
    if (!name) throw invalid(`${label} needs a name.`);
    if (names.has(name.toLowerCase())) throw invalid(`${fieldName} lists “${name}” twice. Give each option its own name.`);
    names.add(name.toLowerCase());
    const id = fields.id === undefined && !stored ? newId() : clientId(fields.id, `${label}’s id`);
    if (ids.has(id)) throw invalid(`${fieldName} repeats an option id. Each option needs its own id.`);
    ids.add(id);
    return { id, name };
  });
}

function fieldKey(value: unknown, label: string): string {
  const key = text(value, `${label}’s key`, KNOWLEDGE_LIMITS.fieldKey);
  if (!FIELD_KEY.test(key)) throw invalid(`${label}’s key must start with a lowercase letter and use only lowercase letters, digits and underscores.`);
  if (key === RESERVED_KEY) throw invalid(`"${RESERVED_KEY}" is reserved for sorting by the item title. Choose another key for ${label.toLowerCase()}.`);
  return key;
}

function derivedKey(name: string, taken: Set<string>): string {
  const slug = slugify(name).replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  const base = (/^[a-z]/.test(slug) ? slug : `field_${slug}`).replace(/_+/g, '_').replace(/_$/, '').slice(0, KNOWLEDGE_LIMITS.fieldKey - 4);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

function fieldRef(value: unknown, fields: PropertyField[], label: string): PropertyField {
  const reference = typeof value === 'string' ? value.trim() : '';
  const field = fields.find((f) => f.id === reference) ?? fields.find((f) => f.key === reference);
  if (!field) {
    throw invalid(`Unknown field "${String(value).slice(0, 80)}" in ${label}. Use a field id or one of the keys: ${fields.map((f) => f.key).join(', ') || 'none defined'}.`);
  }
  return field;
}

function parseSort(raw: unknown, fields: PropertyField[]): CollectionSort[] {
  if (!Array.isArray(raw) || raw.length > KNOWLEDGE_LIMITS.sorts) throw invalid(`sort must be a list of at most ${KNOWLEDGE_LIMITS.sorts} rules.`);
  const seen = new Set<string>();
  return raw.map((value: unknown, index) => {
    const rule = fieldsOf(value, SORT_INPUT, `sort rule ${index + 1}`);
    const field = (BUILT_IN_SORTS as readonly unknown[]).includes(rule.field) ? rule.field as string : fieldRef(rule.field, fields, 'sort').id;
    if (seen.has(field)) throw invalid('Sort by each field once.');
    seen.add(field);
    const direction = rule.direction === undefined ? 'asc' : oneOf(text(rule.direction, 'The sort direction'), SORT_DIRECTIONS, 'sort direction');
    return { field, direction };
  });
}

function parseFilters(raw: unknown, fields: PropertyField[]): CollectionFilter[] {
  if (!Array.isArray(raw) || raw.length > KNOWLEDGE_LIMITS.filters) throw invalid(`filters must be a list of at most ${KNOWLEDGE_LIMITS.filters} rules.`);
  return raw.map((value: unknown, index) => {
    const rule = fieldsOf(value, FILTER_INPUT, `filter ${index + 1}`);
    const field = fieldRef(rule.field, fields, 'filters');
    const op = oneOf(text(rule.op, 'The filter operation'), FILTER_OPS, 'filter operation');
    if (!OPS_BY_TYPE[field.type].includes(op)) throw invalid(`A ${field.type} field can be filtered with: ${OPS_BY_TYPE[field.type].join(', ')}.`);
    if (op === 'empty' || op === 'notEmpty') {
      if (rule.value !== undefined) throw invalid(`The ${op} filter on ${field.name} takes no value.`);
      return { field: field.id, op };
    }
    if (rule.value === undefined || rule.value === null) throw invalid(`The ${op} filter on ${field.name} needs a value.`);
    const parsed = parseValue(field, rule.value, `The filter value for ${field.name}`);
    if (parsed === null) throw invalid(`The ${op} filter on ${field.name} needs a value.`);
    return { field: field.id, op, value: parsed };
  });
}

/** Null means "clear": empty text clears a text field. */
function parseValue(field: PropertyField, value: unknown, label: string): PropertyValue | null {
  switch (field.type) {
    case 'text': {
      const trimmed = text(value, label, KNOWLEDGE_LIMITS.textValue);
      return trimmed || null;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > KNOWLEDGE_LIMITS.number) {
        throw invalid(`${label} must be a finite number no larger than ${KNOWLEDGE_LIMITS.number.toLocaleString('en')} either way.`);
      }
      return value;
    case 'date':
      if (!isCalendarDate(value)) throw invalid(`${label} must be a real calendar date written YYYY-MM-DD.`);
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') throw invalid(`${label} must be true or false.`);
      return value;
    case 'select': {
      const option = field.options!.find((o) => o.id === value) ?? field.options!.find((o) => o.name === value);
      if (!option) throw invalid(`${label} must be one of ${field.name}’s options: ${field.options!.map((o) => o.name).join(', ')}.`);
      return option.id;
    }
  }
}

/** Values that no longer fit their field (changed on another device, or an option since removed) are left out, not fixed. */
function readValues(collection: Collection, metadata: ItemMetadata): Record<string, PropertyValue> {
  const all = isObject(metadata.fieldValues) ? metadata.fieldValues : {};
  const stored = isObject(all[collection.id]) ? all[collection.id] as Record<string, unknown> : {};
  const values: Record<string, PropertyValue> = {};
  for (const field of collection.fields) {
    const value = stored[field.id];
    if (value === undefined || value === null) continue;
    try {
      const parsed = field.type === 'select' && !field.options!.some((o) => o.id === value) ? null : parseValue(field, value, field.name);
      if (parsed !== null) values[field.id] = parsed;
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
    }
  }
  return values;
}

function matches(filter: CollectionFilter, field: PropertyField, value: PropertyValue | undefined): boolean {
  if (filter.op === 'empty') return value === undefined;
  if (filter.op === 'notEmpty') return value !== undefined;
  if (field.type === 'checkbox') return (value ?? false) === filter.value;
  if (filter.op === 'notEquals') return value === undefined || !equal(field, value, filter.value!);
  if (value === undefined) return false;
  if (filter.op === 'equals') return equal(field, value, filter.value!);
  if (filter.op === 'contains') return (value as string).toLowerCase().includes((filter.value as string).toLowerCase());
  const order = ordered(value, filter.value!);
  return filter.op === 'lt' ? order < 0 : filter.op === 'lte' ? order <= 0 : filter.op === 'gt' ? order > 0 : order >= 0;
}

const equal = (field: PropertyField, a: PropertyValue, b: PropertyValue) =>
  field.type === 'text' ? collator.compare(a as string, b as string) === 0 : a === b;

// Dates are YYYY-MM-DD, so their text order is their calendar order.
const ordered = (a: PropertyValue, b: PropertyValue) =>
  typeof a === 'number' && typeof b === 'number' ? Math.sign(a - b) : a === b ? 0 : String(a) < String(b) ? -1 : 1;

/** Rows without a value sort last in either direction. */
function compare(
  key: string, field: PropertyField | undefined, a: ItemRow, b: ItemRow,
  aValues: Record<string, PropertyValue>, bValues: Record<string, PropertyValue>, direction: CollectionSort['direction'],
): number {
  const sign = direction === 'asc' ? 1 : -1;
  if (!field) {
    if (key === 'title') {
      if (!a.title !== !b.title) return a.title ? -1 : 1;
      return sign * collator.compare(a.title, b.title);
    }
    const column = key === 'createdAt' ? 'created_at' : 'updated_at';
    return sign * ordered(a[column], b[column]);
  }
  const x = aValues[field.id];
  const y = bValues[field.id];
  if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
  if (field.type === 'text') return sign * collator.compare(x as string, y as string);
  if (field.type === 'select') {
    const position = (id: PropertyValue) => field.options!.findIndex((o) => o.id === id);
    return sign * (position(x) - position(y));
  }
  return sign * ordered(x, y);
}

const inTemplate = (ctx: Context, id: string) => ctx.get(
  `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(metadata, '$.template') IS NOT NULL`,
  JSON.stringify(pathToRoot(ctx, id)),
) !== undefined;

function derivedName(instruction: string): string {
  const flat = instruction.replace(/\s+/g, ' ');
  return flat.length > DERIVED_NAME ? `${flat.slice(0, DERIVED_NAME - 1).trimEnd()}…` : flat;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function parseMetadata(json: string): ItemMetadata {
  const metadata = JSON.parse(json) as unknown;
  return isObject(metadata) ? metadata as ItemMetadata : {};
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function fieldsOf(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw invalid(`The ${label} must be an object.`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} field "${unknown}". Expected: ${allowed.join(', ')}.`);
  return value;
}

function text(value: unknown, label: string, max = Infinity): string {
  if (typeof value !== 'string') throw invalid(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${label} is longer than ${max} characters.`);
  return trimmed;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === undefined || value === null ? null : text(value, label, max) || null;
}
