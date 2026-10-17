import { type ApiClient, type ClientScope, type EditProposal, type EditorCommand, type EnveMemory, INTENTS, type Intent, type ItemPresentation, type SavedViewInput, type SyncRecord } from '@enve-memory/core';
import { type AiProvider, proposeEdit } from '@enve-memory/ai';
import { HttpError } from './errors.ts';

export interface RouteContext {
  memory: EnveMemory;
  client: ApiClient;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  aiProvider: () => AiProvider | null;
  maxSyncBytes: number;
  waitForChange: (since: number, timeout: number) => Promise<number>;
}

export interface Route {
  method: string;
  pattern: RegExp;
  /** null: any valid token, e.g. so a capture-only client can confirm it's connected. */
  scope: ClientScope | null;
  status?: number;
  hostVault?: boolean;
  handle: (ctx: RouteContext) => unknown | Promise<unknown>;
}

const badField = (name: string, expected: string) => new HttpError(400, 'invalid', `"${name}" must be ${expected}.`);

function str(body: RouteContext['body'], name: string): string | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badField(name, 'a string');
  return value;
}

function nullableStr(body: RouteContext['body'], name: string): string | null | undefined {
  return body?.[name] === null ? null : str(body, name);
}

function strList(body: RouteContext['body'], name: string): string[] | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw badField(name, 'an array of strings');
  return value as string[];
}

function queryOffset(query: URLSearchParams): number {
  const raw = query.get('offset');
  const offset = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(offset) || offset < 0) throw badField('offset', 'a non-negative integer');
  return offset;
}

function queryLimit(query: URLSearchParams): number | undefined {
  const raw = query.get('limit');
  return raw === null ? undefined : Number(raw);
}

function queryCursor(query: URLSearchParams, name = 'cursor'): number {
  const value = Number(query.get(name) ?? '0');
  if (!Number.isSafeInteger(value) || value < 0) throw badField(name, 'a non-negative integer');
  return value;
}

function queryWait(query: URLSearchParams): number {
  const value = Number(query.get('wait') ?? '0');
  if (!Number.isInteger(value) || value < 0 || value > 25_000) throw badField('wait', 'an integer from 0 to 25000');
  return value;
}

const queryFilter = (query: URLSearchParams) => ({
  project: query.get('project') ?? undefined,
  type: query.get('type') ?? undefined,
  tag: query.get('tag') ?? undefined,
  includeArchived: query.get('archived') === 'true',
  inbox: query.get('inbox') === 'true',
  before: query.get('before') ?? undefined,
  pinned: query.get('pinned') === 'true' || undefined,
  intent: query.get('intent') ?? undefined,
  reminders: query.get('reminders') === 'true' || undefined,
  unopenedDays: query.get('unopened') === null ? undefined : Number(query.get('unopened')),
  review: query.get('review') === null ? undefined : query.get('review') === 'true',
  attention: query.get('attention') ?? undefined,
  secret: query.has('secret') ? query.get('secret') === 'true' : undefined,
});

const ID = '([^/]+)';
const path = (template: string) => new RegExp(`^/api/v1${template.replaceAll(':id', ID)}$`);

function bool(body: RouteContext['body'], name: string): boolean | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw badField(name, 'true or false');
  return value;
}

const MAX_BATCH = 2000;

function presentationPatch(body: RouteContext['body']): Partial<ItemPresentation> {
  const patch: Partial<ItemPresentation> = {};
  for (const key of ['review', 'checklist', 'hideCompleted', 'checked', 'autoOrganize'] as const) {
    const value = bool(body, key);
    if (value !== undefined) patch[key] = value;
  }
  const kind = str(body, 'kind');
  if (kind !== undefined) {
    if (kind !== 'text' && kind !== 'heading' && kind !== 'section') throw badField('kind', 'text, heading or section');
    patch.kind = kind;
  }
  const attention = str(body, 'attention');
  if (attention !== undefined) {
    if (attention !== 'normal' && attention !== 'high' && attention !== 'low') throw badField('attention', 'normal, high or low');
    patch.attention = attention;
  }
  return patch;
}

/** One capture: a URL becomes a bookmark (re-saving merges), anything else a note. Pin, reminder and intent apply at capture time. */
function capture(memory: EnveMemory, body: RouteContext['body']) {
  const url = str(body, 'url');
  const note = captureNote(str(body, 'note'), str(body, 'selection'));
  const common = { title: str(body, 'title'), project: str(body, 'project'), tags: strList(body, 'tags') };
  const intent = str(body, 'intent');
  const createdAt = str(body, 'createdAt');
  if (createdAt !== undefined && Number.isNaN(Date.parse(createdAt))) throw badField('createdAt', 'an ISO 8601 time');
  const saved = url
    ? memory.items.saveLink({
      ...common, url, note, ...(intent ? { intent: oneOfIntent(intent) } : {}),
      ...(createdAt ? { createdAt: new Date(Date.parse(createdAt)).toISOString() } : {}),
    })
    : { item: memory.items.saveNote({ ...common, body: note ?? '' }), created: true };
  // Re-saving a page is how capture-only clients say "actually, I want to watch this".
  if (!saved.created && intent && saved.item.intent !== intent) memory.items.setIntent(saved.item.id, intent);
  const remind = str(body, 'remind');
  if (remind) memory.items.setReminder(saved.item.id, remind);
  if (bool(body, 'pinned')) memory.items.pin(saved.item.id, true);
  const changed = remind || bool(body, 'pinned') || (!saved.created && intent);
  return { item: changed ? memory.items.get(saved.item.id) : saved.item, created: saved.created };
}

function oneOfIntent(value: string): Intent {
  if (!(INTENTS as readonly string[]).includes(value)) throw badField('intent', `one of ${INTENTS.join(', ')}`);
  return value as Intent;
}

/** Combines the page note and any selected text into one bookmark note. */
function captureNote(note: string | undefined, selection: string | undefined): string | undefined {
  const quoted = selection?.trim() ? selection.trim().split('\n').map((line) => `> ${line}`).join('\n') : undefined;
  return [note?.trim(), quoted].filter(Boolean).join('\n\n') || undefined;
}

export const routes: Route[] = [
  { method: 'GET', pattern: path('/whoami'), scope: null, handle: ({ client }) => client },
  {
    method: 'GET', pattern: path('/capabilities'), scope: 'read',
    handle: ({ memory }) => ({
      api: 1, schema: memory.schemaVersion,
      features: ['outline', 'item-versions', 'editor-actions', 'library-feed', 'changes-wait', 'vault-sealed-v1', 'vault-sealed-files-v1', 'secret-outlines-v1', 'public-shares', 'saved-views', 'note-templates'],
      maxWait: 25_000,
    }),
  },
  {
    method: 'GET', pattern: path('/changes'), scope: 'read',
    handle: async ({ memory, query, waitForChange }) => ({
      revision: await waitForChange(queryCursor(query, 'since'), queryWait(query)), deviceId: memory.deviceId,
    }),
  },
  {
    method: 'GET', pattern: path('/library'), scope: 'read',
    handle: ({ memory, query }) => memory.feed.page(queryCursor(query), queryLimit(query)),
  },
  {
    method: 'POST', pattern: path('/editor/actions'), scope: 'write', status: 201,
    handle: ({ memory, body }) => {
      if (!Array.isArray(body?.commands)) throw badField('commands', 'an array');
      return memory.editor.apply(body.commands as EditorCommand[], { id: str(body, 'id') });
    },
  },
  { method: 'POST', pattern: path('/editor/actions/:id/undo'), scope: 'write', handle: ({ memory, params }) => memory.editor.undo(params[0]!) },
  { method: 'POST', pattern: path('/editor/actions/:id/redo'), scope: 'write', handle: ({ memory, params }) => memory.editor.redo(params[0]!) },

  {
    method: 'GET', pattern: path('/search'), scope: 'read',
    handle: ({ memory, query }) => memory.search.hybrid(query.get('q') ?? '', queryFilter(query), queryLimit(query)),
  },

  {
    method: 'GET', pattern: path('/items'), scope: 'read',
    handle: ({ memory, query }) => memory.items.list(queryFilter(query), queryLimit(query)),
  },
  { method: 'GET', pattern: path('/views'), scope: 'read', handle: ({ memory }) => memory.views.list() },
  {
    method: 'POST', pattern: path('/views'), scope: 'write', status: 201,
    handle: ({ memory, body }) => memory.views.create(body as unknown as SavedViewInput),
  },
  { method: 'GET', pattern: path('/views/:id'), scope: 'read', handle: ({ memory, params }) => memory.views.get(params[0]!) },
  {
    method: 'PATCH', pattern: path('/views/:id'), scope: 'write',
    handle: ({ memory, params, body }) => memory.views.update(params[0]!, body as unknown as SavedViewInput),
  },
  {
    method: 'DELETE', pattern: path('/views/:id'), scope: 'write',
    handle: ({ memory, params }) => { memory.views.remove(params[0]!); return { ok: true }; },
  },
  {
    method: 'GET', pattern: path('/views/:id/items'), scope: 'read',
    handle: ({ memory, params, query }) => memory.views.results(params[0]!, { before: query.get('before') ?? undefined, limit: queryLimit(query) }),
  },
  { method: 'GET', pattern: path('/templates'), scope: 'read', handle: ({ memory }) => memory.templates.list() },
  {
    method: 'POST', pattern: path('/templates'), scope: 'write', status: 201,
    handle: ({ memory, body }) => memory.templates.create(str(body, 'sourceId') ?? '', str(body, 'name')),
  },
  {
    method: 'POST', pattern: path('/templates/:id/use'), scope: 'write', status: 201,
    handle: ({ memory, params, body }) => memory.templates.instantiate(params[0]!, {
      title: str(body, 'title'), project: nullableStr(body, 'project'), date: str(body, 'date'),
    }),
  },
  {
    method: 'GET', pattern: path('/outline'), scope: 'read',
    handle: ({ memory, query }) => memory.outline.children(query.get('parent'), {
      offset: queryOffset(query), limit: queryLimit(query), includeArchived: query.get('archived') === 'true',
    }),
  },
  {
    method: 'GET', pattern: path('/outline/:id'), scope: 'read',
    handle: ({ memory, params }) => memory.outline.get(params[0]!),
  },
  {
    method: 'GET', pattern: path('/outline/:id/ancestors'), scope: 'read',
    handle: ({ memory, params }) => memory.outline.ancestors(params[0]!),
  },
  {
    method: 'POST', pattern: path('/outline'), scope: 'capture', status: 201,
    handle: ({ memory, body }) => memory.outline.createNote({
      id: str(body, 'id'),
      parentId: nullableStr(body, 'parentId') ?? null, title: str(body, 'title'), body: str(body, 'body'),
      project: str(body, 'project'), tags: strList(body, 'tags'),
    }),
  },
  {
    method: 'PUT', pattern: path('/outline/:id/parent'), scope: 'write',
    handle: ({ memory, params, body }) => {
      const parentId = nullableStr(body, 'parentId');
      if (parentId === undefined) throw badField('parentId', 'an item id or null for the root');
      return memory.outline.move(params[0]!, { parentId, beforeId: nullableStr(body, 'beforeId') });
    },
  },
  {
    method: 'GET', pattern: path('/lookup'), scope: 'read',
    handle: ({ memory, query }) => ({ item: memory.items.findByUrl(query.get('url') ?? '') }),
  },
  { method: 'GET', pattern: path('/items/:id'), scope: 'read', handle: ({ memory, params }) => memory.items.get(params[0]!) },
  { method: 'GET', pattern: path('/items/:id/presentation'), scope: 'read', handle: ({ memory, params }) => memory.presentation.get(params[0]!) },
  {
    method: 'PATCH', pattern: path('/items/:id/presentation'), scope: 'write',
    handle: ({ memory, params, body }) => memory.presentation.update(params[0]!, presentationPatch(body)),
  },
  {
    method: 'POST', pattern: path('/items/:id/check'), scope: 'write',
    handle: ({ memory, params, body }) => {
      const checked = bool(body, 'checked');
      if (checked === undefined) throw badField('checked', 'true or false');
      return memory.presentation.toggle(params[0]!, checked);
    },
  },
  { method: 'POST', pattern: path('/items/:id/checklist/reset'), scope: 'write', handle: ({ memory, params }) => memory.presentation.reset(params[0]!) },
  { method: 'GET', pattern: path('/items/:id/checklist'), scope: 'read', handle: ({ memory, params }) => memory.presentation.progress(params[0]!) },
  {
    method: 'GET', pattern: path('/items/:id/versions'), scope: 'read',
    handle: ({ memory, params, query }) => memory.versions.list(params[0]!, { offset: queryOffset(query), limit: queryLimit(query) }),
  },
  { method: 'GET', pattern: path('/versions/:id'), scope: 'read', handle: ({ memory, params }) => memory.versions.get(params[0]!) },
  { method: 'POST', pattern: path('/versions/:id/restore'), scope: 'write', handle: ({ memory, params }) => memory.versions.restore(params[0]!) },
  { method: 'GET', pattern: path('/items/:id/references'), scope: 'read', handle: ({ memory, params }) => memory.references.list(params[0]!) },
  {
    method: 'POST', pattern: path('/items/:id/references'), scope: 'write',
    handle: ({ memory, params, body }) => memory.references.insert(params[0]!, str(body, 'toId') ?? '', str(body, 'label')),
  },
  {
    method: 'POST', pattern: path('/items/:id/relations'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.relate(params[0]!, str(body, 'toId') ?? '', str(body, 'kind') ?? ''),
  },
  {
    method: 'DELETE', pattern: path('/items/:id/relations'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.unrelate(params[0]!, str(body, 'toId') ?? '', str(body, 'kind') ?? ''),
  },
  {
    method: 'POST', pattern: path('/ai/edit'), scope: 'write',
    handle: ({ memory, body, aiProvider }) => {
      const provider = aiProvider();
      if (!provider) throw new HttpError(400, 'invalid', 'Configure an AI provider on the host first with `petty-memory ai use`.');
      return proposeEdit(memory, provider, { rootId: str(body, 'rootId') ?? '', instruction: str(body, 'instruction') ?? '' });
    },
  },
  {
    method: 'POST', pattern: path('/ai/apply'), scope: 'write',
    handle: ({ memory, body }) => memory.edits.apply(body?.proposal as EditProposal),
  },
  {
    method: 'POST', pattern: path('/ai/undo'), scope: 'write',
    handle: ({ memory, body }) => memory.edits.undo(body?.receipt as Parameters<EnveMemory['edits']['undo']>[0]),
  },
  { method: 'GET', pattern: path('/vault'), scope: 'secrets', handle: ({ memory }) => memory.vault.state() },
  { method: 'POST', pattern: path('/vault/setup'), scope: 'secrets', hostVault: true, handle: ({ memory, body }) => memory.vault.setup(str(body, 'passphrase') ?? '') },
  { method: 'POST', pattern: path('/vault/unlock'), scope: 'secrets', hostVault: true, handle: ({ memory, body }) => memory.vault.unlock(str(body, 'passphrase') ?? '') },
  { method: 'POST', pattern: path('/vault/lock'), scope: 'secrets', hostVault: true, handle: ({ memory }) => memory.vault.lock() },
  {
    method: 'POST', pattern: path('/vault/sealed-items'), scope: 'secrets', status: 201,
    handle: ({ memory, body }) => memory.vault.createSealed({
      id: str(body, 'id') ?? '', envelope: body?.envelope, project: str(body, 'project'), tags: strList(body, 'tags'), parentId: nullableStr(body, 'parentId'),
    }),
  },
  {
    method: 'PATCH', pattern: path('/vault/sealed-items/:id'), scope: 'secrets',
    handle: ({ memory, params, body }) => memory.vault.updateSealed(params[0]!, { envelope: body?.envelope }),
  },
  {
    method: 'POST', pattern: path('/vault/items'), scope: 'secrets', status: 201, hostVault: true,
    handle: ({ memory, body }) => memory.vault.create({
      title: str(body, 'title') ?? '', body: str(body, 'body') ?? '', project: str(body, 'project'), tags: strList(body, 'tags'), parentId: nullableStr(body, 'parentId'),
    }),
  },
  { method: 'GET', pattern: path('/vault/items/:id'), scope: 'secrets', hostVault: true, handle: ({ memory, params }) => memory.vault.read(params[0]!) },
  {
    method: 'PATCH', pattern: path('/vault/items/:id'), scope: 'secrets', hostVault: true,
    handle: ({ memory, params, body }) => memory.vault.update(params[0]!, { title: str(body, 'title') ?? '', body: str(body, 'body') ?? '' }),
  },
  {
    method: 'PUT', pattern: path('/vault/items/:id/attachments/:id'), scope: 'secrets', status: 201,
    handle: ({ memory, params, body }) => memory.vault.attachSealed(params[0]!, params[1]!, body),
  },
  {
    method: 'GET', pattern: path('/vault/items/:id/attachments/:id'), scope: 'secrets',
    handle: ({ memory, params }) => memory.vault.sealedAttachment(params[0]!, params[1]!),
  },
  {
    method: 'DELETE', pattern: path('/vault/items/:id/attachments/:id'), scope: 'secrets',
    handle: ({ memory, params }) => memory.vault.removeFile(params[0]!, params[1]!),
  },
  {
    method: 'POST', pattern: path('/vault/versions/:id/restore'), scope: 'secrets',
    handle: ({ memory, params }) => memory.vault.restoreVersion(params[0]!),
  },
  { method: 'GET', pattern: path('/shares'), scope: 'write', handle: ({ memory }) => memory.shares.list() },
  {
    method: 'POST', pattern: path('/shares'), scope: 'write', status: 201,
    handle: ({ memory, body }) => memory.shares.create(str(body, 'rootId') ?? '', {
      excludedIds: strList(body, 'excludedIds'), expiresAt: nullableStr(body, 'expiresAt'),
    }),
  },
  { method: 'POST', pattern: path('/shares/:id/revoke'), scope: 'write', handle: ({ memory, params }) => memory.shares.revoke(params[0]!) },
  {
    method: 'GET', pattern: path('/sync'), scope: 'sync',
    handle: async ({ memory, query, waitForChange }) => {
      const cursor = queryCursor(query);
      const wait = queryWait(query);
      const revision = memory.feed.revision;
      const page = memory.sync.exportChanges(cursor, queryLimit(query));
      if (page.records.length || page.reset || !wait) return page;
      await waitForChange(revision, wait);
      return memory.sync.exportChanges(cursor, queryLimit(query));
    },
  },
  {
    method: 'GET', pattern: path('/sync/capabilities'), scope: 'sync',
    handle: ({ maxSyncBytes }) => ({ protocol: 1, features: ['wait', 'cursor-reset', 'blobs'], maxWait: 25_000, maxBodyBytes: maxSyncBytes }),
  },
  {
    method: 'POST', pattern: path('/sync'), scope: 'sync',
    handle: ({ memory, body }) => {
      if (!Array.isArray(body?.records)) throw badField('records', 'an array');
      return memory.sync.applyChanges(body.records as SyncRecord[]);
    },
  },
  {
    method: 'POST', pattern: path('/items'), scope: 'capture', status: 201,
    handle: ({ memory, body }) => {
      const type = str(body, 'type');
      const common = { title: str(body, 'title'), project: str(body, 'project'), tags: strList(body, 'tags') };
      switch (type) {
        case 'note':
          return memory.items.saveNote({ ...common, body: str(body, 'body') ?? '' });
        case 'bookmark':
          return memory.items.saveLink({ ...common, url: str(body, 'url') ?? '', note: str(body, 'body') }).item;
        case 'task':
          return memory.tasks.create({
            ...common, title: common.title ?? '', notes: str(body, 'body'), due: str(body, 'due'), priority: str(body, 'priority'),
          });
        default:
          throw badField('type', '"note", "bookmark" or "task"');
      }
    },
  },
  {
    method: 'PATCH', pattern: path('/items/:id'), scope: 'write',
    handle: ({ memory, params, body }) =>
      memory.items.update(params[0]!, {
        title: str(body, 'title'), body: str(body, 'body'), url: nullableStr(body, 'url'), project: nullableStr(body, 'project'),
        baseTitle: str(body, 'baseTitle'), baseBody: str(body, 'baseBody'),
      }),
  },
  {
    method: 'POST', pattern: path('/items/:id/pin'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.pin(params[0]!, bool(body, 'pinned') ?? true),
  },
  {
    // A signal, not an edit: capture-only clients (the extension) may report that a saved link was opened.
    method: 'POST', pattern: path('/items/:id/opened'), scope: 'capture',
    handle: ({ memory, params }) => {
      memory.items.markOpened(params[0]!);
      return { ok: true };
    },
  },
  {
    method: 'PUT', pattern: path('/items/:id/reminder'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.setReminder(params[0]!, nullableStr(body, 'at') ?? null),
  },
  {
    method: 'PUT', pattern: path('/items/:id/intent'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.setIntent(params[0]!, nullableStr(body, 'intent') ?? null),
  },
  {
    method: 'POST', pattern: path('/items/:id/accept'), scope: 'write',
    handle: ({ memory, params }) => memory.items.acceptSuggestions(params[0]!),
  },
  {
    // Whichever client shows a reminder first (desktop, extension, phone) marks it, so the others don't repeat it.
    method: 'POST', pattern: path('/items/:id/reminded'), scope: 'capture',
    handle: ({ memory, params }) => {
      memory.items.markReminded(params[0]!);
      return { ok: true };
    },
  },
  {
    method: 'GET', pattern: path('/reminders'), scope: 'read',
    handle: ({ memory, query }) => (query.get('due') === 'true' ? memory.items.dueReminders() : memory.items.list({ reminders: true }, queryLimit(query))),
  },
  { method: 'POST', pattern: path('/items/:id/archive'), scope: 'write', handle: ({ memory, params }) => memory.items.archive(params[0]!) },
  { method: 'POST', pattern: path('/items/:id/unarchive'), scope: 'write', handle: ({ memory, params }) => memory.items.unarchive(params[0]!) },
  {
    method: 'POST', pattern: path('/items/:id/tags'), scope: 'write',
    handle: ({ memory, params, body }) => memory.items.tag(params[0]!, { add: strList(body, 'add'), remove: strList(body, 'remove') }),
  },

  {
    // The browser extension and share sheets post here: a URL becomes a bookmark, anything else a note.
    method: 'POST', pattern: path('/capture'), scope: 'capture', status: 201,
    handle: ({ memory, body }) => capture(memory, body),
  },
  {
    // Bulk capture, e.g. importing a browser's whole bookmark tree. Each entry succeeds or fails on its own.
    method: 'POST', pattern: path('/capture/batch'), scope: 'capture',
    handle: ({ memory, body }) => {
      const entries = body?.items;
      if (!Array.isArray(entries)) throw badField('items', 'an array');
      if (entries.length > MAX_BATCH) throw badField('items', `at most ${MAX_BATCH} entries`);
      const results = entries.map((entry) => {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badField('item', 'an object');
          const { item, created } = capture(memory, entry as Record<string, unknown>);
          return { id: item.id, created };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });
      return {
        created: results.filter((r) => 'created' in r && r.created).length,
        skipped: results.filter((r) => 'created' in r && !r.created).length,
        failed: results.filter((r) => 'error' in r).length,
        results,
      };
    },
  },
  {
    // What's already in the library about the page you're looking at.
    method: 'GET', pattern: path('/related'), scope: 'read',
    handle: async ({ memory, query }) => {
      const url = query.get('url');
      const saved = url ? memory.items.findByUrl(url) : null;
      const text = [query.get('q'), saved?.title, saved?.metadata.excerpt].filter(Boolean).join(' ');
      if (!text.trim()) return [];
      const hits = await memory.search.hybrid(text, {}, (queryLimit(query) ?? 8) + 1);
      return hits.filter((h) => h.id !== saved?.id && h.url !== url).slice(0, queryLimit(query) ?? 8);
    },
  },

  { method: 'GET', pattern: path('/projects'), scope: 'read', handle: ({ memory, query }) => memory.projects.list(query.get('status') ?? undefined) },
  {
    method: 'POST', pattern: path('/projects'), scope: 'write', status: 201,
    handle: ({ memory, body }) =>
      memory.projects.create({ name: str(body, 'name') ?? '', description: str(body, 'description'), instructions: str(body, 'instructions') }),
  },
  { method: 'GET', pattern: path('/projects/:id'), scope: 'read', handle: ({ memory, params }) => memory.briefing(params[0]!) },
  {
    method: 'PATCH', pattern: path('/projects/:id'), scope: 'write',
    handle: ({ memory, params, body }) =>
      memory.projects.update(params[0]!, {
        name: str(body, 'name'), description: str(body, 'description'), instructions: str(body, 'instructions'), status: str(body, 'status'),
      }),
  },
  {
    method: 'PUT', pattern: path('/projects/:id/memory'), scope: 'write',
    handle: ({ memory, params, body }) => memory.projects.setMemory(params[0]!, str(body, 'memory') ?? ''),
  },
  {
    method: 'GET', pattern: path('/projects/:id/memory/versions'), scope: 'read',
    handle: ({ memory, params, query }) => memory.projects.memoryHistory(params[0]!, { offset: queryOffset(query), limit: queryLimit(query) }),
  },
  { method: 'GET', pattern: path('/projects/:id/decisions'), scope: 'read', handle: ({ memory, params }) => memory.decisions.list(params[0]!) },
  {
    method: 'POST', pattern: path('/projects/:id/decisions'), scope: 'write', status: 201,
    handle: ({ memory, params, body }) =>
      memory.decisions.record({
        project: params[0]!, decision: str(body, 'decision') ?? '', reason: str(body, 'reason'), supersedes: strList(body, 'supersedes'),
      }),
  },

  {
    method: 'GET', pattern: path('/tasks'), scope: 'read',
    handle: ({ memory, query }) =>
      memory.tasks.list(
        {
          project: query.get('project') ?? undefined, status: query.get('status') ?? undefined, tag: query.get('tag') ?? undefined,
          offset: queryOffset(query),
        },
        queryLimit(query),
      ),
  },
  {
    method: 'PATCH', pattern: path('/tasks/:id'), scope: 'write',
    handle: ({ memory, params, body }) =>
      memory.tasks.update(params[0]!, {
        title: str(body, 'title'), notes: str(body, 'notes'), status: str(body, 'status'), due: nullableStr(body, 'due'),
        priority: str(body, 'priority'), project: nullableStr(body, 'project'),
      }),
  },
  { method: 'POST', pattern: path('/tasks/:id/complete'), scope: 'write', handle: ({ memory, params }) => memory.tasks.complete(params[0]!) },

  {
    method: 'GET', pattern: path('/activity'), scope: 'read',
    handle: ({ memory, query }) => memory.activity.recent({ project: query.get('project') ?? undefined }, queryLimit(query)),
  },
];
