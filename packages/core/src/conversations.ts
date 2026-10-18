import type { SQLInputValue } from 'node:sqlite';
import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, clientId, oneOf } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import type { ItemService } from './items.ts';
import { pathToRoot } from './placement.ts';
import type { ProjectService } from './projects.ts';
import { toFtsQuery } from './search.ts';
import type { ItemDetail, ItemMetadata } from './types.ts';

export const CONVERSATION_MODES = ['ask', 'edit', 'organize', 'actions'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SavedConversation {
  id: string;
  title: string;
  mode: ConversationMode;
  /** The id of the project the conversation is filed in. */
  project?: string;
  rootId?: string;
  query?: string;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Without an id this saves a new conversation; with one it replaces that saved conversation's messages and context.
 * On a replace, an omitted title or project keeps the current one. A new conversation without a title is named by its first message.
 */
export interface SaveConversationInput {
  id?: string;
  title?: string | null;
  mode: ConversationMode;
  project?: string | null;
  rootId?: string | null;
  query?: string | null;
  messages: ConversationMessage[];
}

interface ConversationDefinition {
  version: 1;
  mode: ConversationMode;
  rootId: string | null;
  query: string | null;
  messages: ConversationMessage[];
}

const MAX_MESSAGES = 100;
const MAX_CHARACTERS = 200_000;
const MAX_TITLE = 200;
const MAX_QUERY = 500;
const MAX_LISTED = 100;
const DERIVED_TITLE = 80;

const INPUT_FIELDS = ['id', 'title', 'mode', 'project', 'rootId', 'query', 'messages'] as const;
const MESSAGE_FIELDS = ['role', 'content'] as const;
const SPEAKERS = { user: 'You', assistant: 'Assistant' } as const;

const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;

/** Saved conversations are ordinary notes: the body is a readable transcript and `metadata.conversation` keeps the exact messages. */
export class ConversationService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  /** The newest saved conversations. One damaged by another device's sync is left out rather than failing the list. */
  list({ query }: { query?: string } = {}): SavedConversation[] {
    const search = optionalText(query, 'The conversation search', MAX_QUERY);
    const match = search ? toFtsQuery(search) : null;
    if (search && !match) throw invalid('Search conversations with at least one word or number.');
    return this.ctx
      .all<ItemRow>(
        `${TEMPLATE_MEMBERS} SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE json_extract(i.metadata, '$.conversation.version') = 1 AND i.type = 'note' AND i.archived_at IS NULL
           AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 AND json_extract(i.metadata, '$.savedView') IS NULL
           AND i.id NOT IN (SELECT id FROM template_members)
           ${match ? 'AND i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)' : ''}
         ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
        ...(match ? [match] : []), MAX_LISTED,
      )
      .flatMap((row) => {
        try {
          return [this.conversation(row)];
        } catch (error) {
          if (error instanceof MemoryError) return [];
          throw error;
        }
      });
  }

  get(id: string): SavedConversation {
    return this.conversation(this.definition(id));
  }

  save(input: SaveConversationInput): SavedConversation {
    const fields = fieldsOf(input, INPUT_FIELDS, 'conversation');
    const mode = oneOf(text(fields.mode, 'mode'), CONVERSATION_MODES, 'conversation mode');
    const messages = validMessages(fields.messages);
    const rootId = fields.rootId === undefined || fields.rootId === null ? null : this.root(fields.rootId);
    const query = optionalText(fields.query, 'query', MAX_QUERY);
    assertContext(mode, rootId, query);
    const title = conversationTitle(fields.title, messages);
    const projectId = fields.project === undefined ? undefined
      : fields.project === null ? null : this.projects.resolve(text(fields.project, 'project')).id;
    const conversation: ConversationDefinition = { version: 1, mode, rootId, query, messages };
    const body = transcript(messages);
    return this.ctx.tx(() => {
      if (fields.id === undefined) {
        return this.get(this.items.insert({ type: 'note', title, body, project: projectId ?? undefined, metadata: { conversation } }, { automations: false }));
      }
      const row = this.definition(fields.id);
      const name = fields.title === undefined ? row.title : title;
      const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), conversation };
      const changes: Record<string, SQLInputValue> = { title: name, body, metadata: JSON.stringify(metadata) };
      if (projectId !== undefined) changes.project_id = projectId;
      this.items.write(row, changes, 'update', { title: name, body, conversation, ...(projectId !== undefined && { projectId }) });
      return this.get(row.id);
    });
  }

  /** Reversible: the transcript stays an archived note. */
  archive(id: string): ItemDetail {
    return this.items.archive(this.definition(id).id);
  }

  private definition(id: unknown): ItemRow {
    if (typeof id !== 'string' || !id.trim()) throw invalid('A conversation id is required.');
    const row = this.ctx.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ?`, id);
    const metadata = row ? (JSON.parse(row.metadata) as ItemMetadata) : null;
    if (!row || !metadata || row.type !== 'note' || row.archived_at !== null || metadata.secret === true || metadata.savedView != null
      || (metadata.conversation as { version?: unknown } | undefined)?.version !== 1 || inTemplate(this.ctx, row.id)) {
      throw notFound(`No saved conversation with id "${id}". List saved conversations to find it.`);
    }
    return row;
  }

  private conversation(row: ItemRow): SavedConversation {
    const stored = (JSON.parse(row.metadata) as ItemMetadata).conversation as Record<string, unknown>;
    const mode = oneOf(text(stored.mode, 'mode'), CONVERSATION_MODES, 'conversation mode');
    const messages = validMessages(stored.messages);
    const rootId = stored.rootId === undefined || stored.rootId === null ? null : clientId(stored.rootId, 'rootId');
    const query = optionalText(stored.query, 'query', MAX_QUERY);
    assertContext(mode, rootId, query);
    return {
      id: row.id,
      title: row.title,
      mode,
      ...(row.project_id !== null && { project: row.project_id }),
      ...(rootId !== null && { rootId }),
      ...(query !== null && { query }),
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private root(value: unknown): string {
    const id = clientId(value, 'rootId');
    const row = this.ctx.get<{ secret: number | null }>(`SELECT json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, id);
    if (!row) throw notFound(`No item with id "${id}" to keep as this conversation's context.`);
    if (row.secret === 1) throw invalid('A conversation can’t keep a secret note as its context.');
    return id;
  }
}

function validMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid('A conversation needs at least one message.');
  if (value.length > MAX_MESSAGES) throw invalid(`A conversation can hold at most ${MAX_MESSAGES} messages. Save a shorter part of it.`);
  let characters = 0;
  return value.map((raw: unknown, index): ConversationMessage => {
    const label = `Message ${index + 1}`;
    const fields = fieldsOf(raw, MESSAGE_FIELDS, label.toLowerCase());
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (fields.role !== role) {
      throw invalid(`${label} must have the role "${role}": a conversation starts with the user and then alternates with the assistant.`);
    }
    const content = text(fields.content, label);
    if (!content) throw invalid(`${label} is empty.`);
    characters += content.length;
    if (characters > MAX_CHARACTERS) throw invalid(`A conversation can hold at most ${MAX_CHARACTERS} characters. Save a shorter part of it.`);
    return { role, content };
  });
}

function assertContext(mode: ConversationMode, rootId: string | null, query: string | null): void {
  if (mode === 'edit' && rootId === null) throw invalid('An edit conversation needs the rootId of the branch it edited.');
  if (mode === 'actions' && (rootId === null) === (query === null)) throw invalid('An actions conversation needs exactly one of rootId or query.');
}

function conversationTitle(value: unknown, messages: ConversationMessage[]): string {
  const title = value === undefined || value === null ? '' : text(value, 'Conversation title', MAX_TITLE);
  if (title) return title;
  const opening = messages[0]!.content.replace(/\s+/g, ' ');
  return opening.length > DERIVED_TITLE ? `${opening.slice(0, DERIVED_TITLE - 1).trimEnd()}…` : opening;
}

const transcript = (messages: ConversationMessage[]) =>
  messages.map(({ role, content }) => `**${SPEAKERS[role]}:** ${content}`).join('\n\n');

const inTemplate = (ctx: Context, id: string) => ctx.get(
  `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(metadata, '$.template') IS NOT NULL`,
  JSON.stringify(pathToRoot(ctx, id)),
) !== undefined;

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

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === undefined || value === null ? null : text(value, label, max) || null;
}
