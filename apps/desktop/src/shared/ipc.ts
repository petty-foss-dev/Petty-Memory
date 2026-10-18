import type { Answer, ChatRequest, ChatResponse } from '@enve-memory/ai';
import type {
  ApiClient, Backup, Change, ClientScope, CreateProjectInput, CreateRuleInput, CreateTaskInput, Decision, EditProposal, EditorActionResult,
  EditorCommand, EnveMemory,
  ExportSummary, Graph, Item, Intent, ItemDetail, ItemFilter, ItemPresentation, ItemType, ItemVersion, ItemVersionSummary, OrganizationProposal,
  OrganizationReceipt, OrganizationResult, OutlineEntry, OutlineListOptions, OutlineMoveInput, OutlineNoteInput, OutlinePage, Project, ProjectBriefing, PublicShare, RecordDecisionInput,
  RelatedItem, Rule, SaveLinkInput, SaveNoteInput, SavedView, SavedViewInput, SearchHit, Settings, SyncResult, Task, TemplateUseInput,
  UpdateItemInput, UpdateProjectInput, UpdateTaskInput, VaultState, ViewPage,
} from '@enve-memory/core';
import type { ImportResult, previewEnveHighlights } from '@enve-memory/importers';
import type { KnowledgeRequest, ResearchFile, TranscriptionStatus } from './knowledge.ts';

export type ThemeMode = 'system' | 'dark' | 'light';

export type SavedConversation = ReturnType<EnveMemory['chats']['get']>;
export type ConversationInput = Parameters<EnveMemory['chats']['save']>[0];
export type ReviewCard = ReturnType<EnveMemory['review']['queue']>[number];
export type ItemInsights = ReturnType<EnveMemory['insights']['forItem']>;
export type KnowledgeSuggestion = ItemInsights['mentions'][number];
export type MergeProposal = ReturnType<EnveMemory['insights']['previewMerge']>;
export type ActionProposal = Parameters<EnveMemory['actions']['apply']>[0];
export type ActionOperation = ActionProposal['operations'][number];
export type ActionResult = ReturnType<EnveMemory['actions']['apply']>;
export type ActionUndoReceipt = Parameters<EnveMemory['actions']['undo']>[0];
export type HighlightPreview = Awaited<ReturnType<typeof previewEnveHighlights>>;
export type EnveHighlight = HighlightPreview['entries'][number];

export interface OcrResult {
  text: string;
  engine: string;
}

/** Enve highlight exports are read as UTF-8 text in the renderer and checked again in main. */
export const MAX_HIGHLIGHT_FILE_BYTES = 2 * 1024 * 1024;

export type LibraryStats = { projects: number; tags: number; tagNames: string[] } & Record<ItemType, number>;

export interface AppInfo {
  version: string;
  home: string;
  database: string;
  platform: string;
  isPackaged: boolean;
  schemaVersion: number;
  deviceId: string;
  stats: LibraryStats;
  inboxCount: number;
  aiEnabled: boolean;
  /** Any MCP or API client has used the library, or a token exists. */
  aiClientsSeen: boolean;
}

export interface Prefs {
  theme: ThemeMode;
  lan: boolean;
  shortcut: string;
  shortcutRegistered: boolean;
}

export interface ProjectSummary extends Project {
  openTasks: number;
}

export type MemoryHistoryPage = ReturnType<EnveMemory['projects']['memoryHistory']>;
export type MemoryVersion = MemoryHistoryPage['items'][number];

export interface ApiStatus {
  running: boolean;
  url: string | null;
  port: number;
  lan: boolean;
  lanUrls: string[];
  error: string | null;
}

export interface IndexStatus {
  /** The local embedding runtime exists for this OS and CPU (not on Intel Macs). */
  supported: boolean;
  enabled: boolean;
  model: string | null;
  indexed: number;
  pending: number;
  chunks: number;
}

export interface ProviderOption {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  defaultModel: string | null;
  /** Sends item text to a third party's servers. */
  cloud: boolean;
}

export interface AiStatus {
  provider: string;
  model: string;
  baseUrl: string;
  enrich: boolean;
  enrichSince: string;
  autoApply: boolean;
  providers: ProviderOption[];
  /** Providers with a key saved in the encrypted store. */
  keys: string[];
  encryptionAvailable: boolean;
  error: string | null;
}

export interface AiConfig {
  provider: string;
  model: string;
  baseUrl: string;
  /** A key typed but not saved yet; falls back to the stored one. */
  apiKey?: string;
}

export interface McpSetup {
  command: string;
  args: string[];
  env: Record<string, string>;
  claudeCode: string;
  codex: string;
  json: string;
  httpUrl: string;
  claudeAvailable: boolean;
}

export interface PairLink {
  url: string;
  link: string;
  qr: string;
}

export interface PairResult {
  client: ApiClient;
  token: string;
  links: PairLink[];
}

export interface SyncStatus {
  folder: string;
  encrypted: boolean;
  running: boolean;
  /** The folder is encrypted and this library has no key yet. */
  needsPassphrase: boolean;
  last: { at: string; result: SyncResult | null; error: string | null; code: string | null } | null;
}

export interface SecretNoteInput {
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  /** Another secret note, or an ordinary parent; null or absent for the top level. */
  parentId?: string | null;
}

/** A secret note in the vault's outline. `title` is decrypted in main and exists only while the vault is unlocked. */
export interface VaultNode {
  id: string;
  parentId: string | null;
  title: string;
  childCount: number;
  updatedAt: string;
}

/** An encrypted attachment's real name and type, read from inside its ciphertext. */
export interface VaultFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface VaultAttachResult {
  attached: number;
  /** Files that weren't encrypted, with why; the others were still saved. */
  failed: { filename: string; message: string }[];
}

export type EditUndoReceipt = NonNullable<ReturnType<EnveMemory['edits']['apply']>['undo']>;

export interface CreatedShare {
  share: PublicShare;
  token: string;
  /** Addresses where this app's local server shows it: a web page if the browser client is bundled, else the JSON. */
  links: { url: string; label: string }[];
  /** The links open a readable page rather than JSON. */
  page: boolean;
}

export interface RemoteStatus {
  url: string | null;
  hasToken: boolean;
  running: boolean;
  last: { at: string; pushed: number; pulled: number; conflicts: number; rejected: number; error: string | null } | null;
}

export const IMPORT_KINDS = ['bookmarks', 'markdown', 'csv', 'enve'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Sidebar shelves: pinned, by intent, and links saved a month ago but never opened. */
export const SHELVES = ['pinned', 'read', 'watch', 'buy', 'revisit', 'unopened'] as const;
export type Shelf = (typeof SHELVES)[number];
export const UNOPENED_DAYS = 30;

export type ShelfCounts = Record<Shelf | 'reminders' | 'due', number>;

export interface Reminders {
  due: Item[];
  upcoming: Item[];
}

export interface ItemPage {
  items: Item[];
  /** Cursor for the next page, or null when this was the last one. */
  next: string | null;
}

export interface TaskQuery {
  project?: string;
  status?: string;
  tag?: string;
}

/**
 * Every call the renderer can make. Main implements exactly these keys (the handler map is typed against this),
 * and nothing else reaches core.
 */
export interface Api {
  'knowledge.request': (request: KnowledgeRequest) => unknown;
  'research.file': (sourceId: string) => ResearchFile;
  'research.saveAudio': (data: Uint8Array, filename: string, mimeType: string) => ItemDetail;
  'research.transcriptionStatus': () => TranscriptionStatus;
  'research.configureTranscription': (input: { baseUrl: string; model: string; apiKey?: string }) => TranscriptionStatus;
  'sources.approveFolder': (watchId: string) => unknown;
  'app.info': () => AppInfo;
  'app.openLibraryFolder': () => void;
  'app.openExternal': (url: string) => void;
  'prefs.get': () => Prefs;
  'prefs.setTheme': (theme: ThemeMode) => Prefs;

  'items.list': (filter?: ItemFilter, limit?: number) => Item[];
  'items.page': (filter: ItemFilter, cursor: string | null, limit: number) => ItemPage;
  'items.inbox': () => Item[];
  'items.get': (id: string) => ItemDetail;
  'items.saveNote': (input: SaveNoteInput) => ItemDetail;
  'items.saveLink': (input: SaveLinkInput) => { item: ItemDetail; created: boolean };
  'items.update': (id: string, input: UpdateItemInput) => ItemDetail;
  'items.tag': (id: string, change: { add?: string[]; remove?: string[] }) => ItemDetail;
  'items.archive': (id: string) => ItemDetail;
  'items.unarchive': (id: string) => ItemDetail;
  'items.delete': (id: string) => void;
  'items.acceptSuggestions': (id: string) => ItemDetail;
  'items.enrich': (id: string) => ItemDetail;
  'items.retryIngest': (id: string) => ItemDetail;
  'items.retryFailed': () => number;
  'items.openFile': (id: string) => void;
  'items.openUrl': (id: string) => void;
  'items.pin': (id: string, pinned: boolean) => ItemDetail;
  'items.setReminder': (id: string, when: string | null) => ItemDetail;
  'items.setIntent': (id: string, intent: Intent | null) => ItemDetail;
  'shelves.counts': () => ShelfCounts;
  'shelves.list': (shelf: Shelf) => Item[];
  'reminders.list': () => Reminders;
  'files.save': (paths: string[], project?: string) => ItemDetail[];

  'outline.children': (parentId: string | null, options?: OutlineListOptions) => OutlinePage;
  'outline.get': (id: string) => OutlineEntry;
  'outline.ancestors': (id: string) => Item[];
  'outline.move': (id: string, input: OutlineMoveInput) => OutlineEntry;
  'outline.createNote': (input: OutlineNoteInput) => OutlineEntry;

  /** Journalled structural and text edits; undo and redo take the action id these return. */
  'editor.apply': (commands: EditorCommand[], options?: { id?: string }) => EditorActionResult;
  'editor.undo': (actionId: string) => EditorActionResult;
  'editor.redo': (actionId: string) => EditorActionResult;

  'presentation.get': (id: string) => ItemPresentation;
  'presentation.update': (id: string, patch: Partial<ItemPresentation>) => ItemPresentation;
  'presentation.toggle': (id: string, checked: boolean) => ItemDetail;
  'presentation.reset': (id: string) => { updated: number };
  'presentation.progress': (id: string) => { done: number; total: number };

  'versions.list': (itemId: string, options?: { offset?: number; limit?: number }) => { items: ItemVersionSummary[]; total: number };
  'versions.get': (versionId: string) => ItemVersion;
  'versions.restore': (versionId: string) => ReturnType<EnveMemory['versions']['restore']>;

  'references.insert': (fromId: string, toId: string, label?: string) => ItemDetail;
  'references.list': (id: string) => { outgoing: RelatedItem[]; incoming: RelatedItem[] };
  'items.relate': (fromId: string, toId: string, kind: string) => ItemDetail;
  'items.unrelate': (fromId: string, toId: string, kind: string) => ItemDetail;

  'edits.propose': (rootId: string, instruction: string) => EditProposal;
  'edits.apply': (proposal: EditProposal) => ReturnType<EnveMemory['edits']['apply']>;
  'edits.undo': (receipt: EditUndoReceipt) => ReturnType<EnveMemory['edits']['undo']>;
  'organizer.apply': (proposal: OrganizationProposal, includeIds?: string[]) => OrganizationResult;
  'organizer.undo': (receipt: OrganizationReceipt) => EditorActionResult;
  'actions.apply': (proposal: ActionProposal, includeIds?: string[]) => ActionResult;
  'actions.undo': (receipt: ActionUndoReceipt) => ReturnType<EnveMemory['actions']['undo']>;

  /** The newest 100 saved chats, or the newest 100 whose text matches `query` anywhere in the library. */
  'chats.list': (options?: { query?: string }) => SavedConversation[];
  'chats.get': (id: string) => SavedConversation;
  /** Saved only when the user asks; an `id` updates that conversation. */
  'chats.save': (input: ConversationInput) => SavedConversation;
  'chats.archive': (id: string) => ReturnType<EnveMemory['chats']['archive']>;

  'review.queue': (options?: { limit?: number; project?: string }) => ReviewCard[];
  'review.schedule': (id: string, days: number) => ReturnType<EnveMemory['review']['schedule']>;

  'insights.forItem': (id: string) => ItemInsights;
  'insights.previewMerge': (sourceId: string, targetId: string) => MergeProposal;
  /** Undone and redone with `editor.undo` and `editor.redo`. */
  'insights.merge': (proposal: MergeProposal) => EditorActionResult;

  /** Reads text from one ordinary image attachment; nothing is saved. */
  'ocr.extract': (attachmentId: string) => OcrResult;

  'vault.state': () => VaultState;
  'vault.setup': (passphrase: string) => VaultState;
  'vault.unlock': (passphrase: string) => VaultState;
  'vault.lock': () => VaultState;
  'vault.create': (input: SecretNoteInput) => ItemDetail;
  'vault.read': (id: string) => { id: string; title: string; body: string };
  'vault.update': (id: string, input: { title: string; body: string }) => ItemDetail;
  'vault.outline': () => VaultNode[];
  'vault.files': (itemId: string) => VaultFile[];
  /** Main shows the file picker; null when cancelled. */
  'vault.attachFiles': (itemId: string) => VaultAttachResult | null;
  /** Main decrypts and shows the save dialog; the file is written, never opened. Null when cancelled. */
  'vault.saveFile': (itemId: string, attachmentId: string) => { filename: string } | null;
  'vault.removeFile': (itemId: string, attachmentId: string) => { removed: boolean };
  /** Main saves the kit through a save dialog and returns the code to show once; null when cancelled. */
  'vault.recoveryKit': () => { code: string } | null;
  /** Main asks for the kit file, then recovers with `code`; null when no file was chosen. */
  'vault.recover': (code: string) => VaultState | null;
  'vault.restoreVersion': (versionId: string) => ReturnType<EnveMemory['vault']['restoreVersion']>;

  'views.list': () => SavedView[];
  'views.get': (id: string) => SavedView;
  'views.results': (id: string, options?: { before?: string; limit?: number }) => ViewPage;
  'views.create': (input: SavedViewInput) => SavedView;
  'views.update': (id: string, input: SavedViewInput) => SavedView;
  'views.remove': (id: string) => void;

  'templates.list': () => Item[];
  'templates.create': (sourceId: string, name?: string) => ItemDetail;
  'templates.instantiate': (id: string, input?: TemplateUseInput) => ItemDetail;

  'shares.list': () => PublicShare[];
  'shares.create': (rootId: string, options?: { excludedIds?: string[]; expiresAt?: string | null }) => CreatedShare;
  'shares.revoke': (shareId: string) => PublicShare;

  'remoteSync.get': () => RemoteStatus;
  /** Leaving `token` out keeps the saved one (changing only the address). */
  'remoteSync.configure': (config: { url: string; token?: string }) => RemoteStatus;
  'remoteSync.run': () => RemoteStatus;
  'remoteSync.disconnect': () => RemoteStatus;

  'projects.list': (status?: string) => ProjectSummary[];
  'projects.create': (input: CreateProjectInput) => Project;
  'projects.update': (ref: string, input: UpdateProjectInput) => Project;
  'projects.setMemory': (ref: string, memory: string) => Project;
  'projects.briefing': (ref: string) => ProjectBriefing;
  'projects.memoryHistory': (ref: string, options?: { offset?: number; limit?: number }) => MemoryHistoryPage;
  'decisions.record': (input: RecordDecisionInput) => Decision;

  'tasks.list': (query?: TaskQuery, limit?: number) => Task[];
  'tasks.create': (input: CreateTaskInput) => Task;
  'tasks.update': (id: string, input: UpdateTaskInput) => Task;

  'search.hybrid': (text: string, filter?: ItemFilter, limit?: number) => SearchHit[];
  'graph.get': (project?: string) => Graph;
  'activity.recent': (query?: { project?: string; entityId?: string }, limit?: number) => Change[];

  'settings.get': () => Settings;
  'settings.set': (key: 'fetchLinks' | 'semanticSearch', value: boolean) => Settings;
  'index.status': () => IndexStatus;

  'ai.status': () => AiStatus;
  'ai.configure': (config: { provider: string; model: string; baseUrl: string }) => AiStatus;
  'ai.setKey': (provider: string, key: string | null) => AiStatus;
  'ai.models': (config: AiConfig) => string[];
  'ai.test': (config: AiConfig) => string;
  'ai.setEnrich': (on: boolean) => AiStatus;
  'ai.setAutoApply': (on: boolean) => AiStatus;
  'ai.ask': (question: string, project?: string) => Answer;
  /** Previews only; the renderer keeps the conversation. */
  'ai.chat': (request: ChatRequest) => ChatResponse;

  'clients.list': () => ApiClient[];
  'clients.create': (name: string, scopes: ClientScope[]) => { client: ApiClient; token: string };
  'clients.pair': (name: string, options?: { secrets?: boolean }) => PairResult;
  'clients.revoke': (id: string) => ApiClient;
  'api.status': () => ApiStatus;
  'api.setLan': (lan: boolean) => ApiStatus;
  'mcp.setup': () => McpSetup;
  'mcp.addToClaudeCode': () => { ok: boolean; output: string };

  'backups.list': () => Backup[];
  'backups.create': () => Backup;
  'backups.restore': (file: string) => { saved: string };
  'exports.run': () => ExportSummary | null;

  'rules.list': () => Rule[];
  'rules.create': (input: CreateRuleInput) => Rule;
  'rules.setEnabled': (id: string, enabled: boolean) => Rule;
  'rules.delete': (id: string) => void;
  'imports.run': (kind: ImportKind, project?: string) => ImportResult | null;
  /** `data` is the export's text, never a path. */
  'highlights.preview': (data: string) => HighlightPreview;
  'highlights.import': (data: string, options?: { project?: string }) => ImportResult;

  'sync.status': () => SyncStatus;
  'sync.pickFolder': () => string | null;
  'sync.start': (folder: string, passphrase: string | null) => SyncStatus;
  'sync.unlock': (passphrase: string) => SyncStatus;
  'sync.now': () => SyncStatus;
  'sync.stop': () => SyncStatus;

  'capture.open': () => void;
  'capture.close': () => void;
}

export type Method = keyof Api;
/**
 * The runtime allow-list: every method and whether it changes the library (after a write, main kicks the background
 * workers and tells every window to refresh). Typed as a full Record so adding a method to `Api` without listing it
 * here fails to compile.
 */
export const METHOD_KINDS: Record<Method, 'read' | 'write'> = {
  'knowledge.request': 'read',
  'research.file': 'read',
  'research.saveAudio': 'write',
  'research.transcriptionStatus': 'read',
  'research.configureTranscription': 'write',
  'sources.approveFolder': 'write',
  'app.info': 'read',
  'app.openLibraryFolder': 'read',
  'app.openExternal': 'read',
  'prefs.get': 'read',
  'prefs.setTheme': 'read',
  'items.list': 'read',
  'items.page': 'read',
  'items.inbox': 'read',
  'items.get': 'read',
  'items.saveNote': 'write',
  'items.saveLink': 'write',
  'items.update': 'write',
  'items.tag': 'write',
  'items.archive': 'write',
  'items.unarchive': 'write',
  'items.delete': 'write',
  'items.acceptSuggestions': 'write',
  'items.enrich': 'write',
  'items.retryIngest': 'write',
  'items.retryFailed': 'write',
  'items.openFile': 'write',
  'items.openUrl': 'write',
  'items.pin': 'write',
  'items.setReminder': 'write',
  'items.setIntent': 'write',
  'shelves.counts': 'read',
  'shelves.list': 'read',
  'reminders.list': 'read',
  'files.save': 'write',
  'outline.children': 'read',
  'outline.get': 'read',
  'outline.ancestors': 'read',
  'outline.move': 'write',
  'outline.createNote': 'write',
  'editor.apply': 'write',
  'editor.undo': 'write',
  'editor.redo': 'write',
  'presentation.get': 'read',
  'presentation.update': 'write',
  'presentation.toggle': 'write',
  'presentation.reset': 'write',
  'presentation.progress': 'read',
  'versions.list': 'read',
  'versions.get': 'read',
  'versions.restore': 'write',
  'references.insert': 'write',
  'references.list': 'read',
  'items.relate': 'write',
  'items.unrelate': 'write',
  'edits.propose': 'read',
  'edits.apply': 'write',
  'edits.undo': 'write',
  'organizer.apply': 'write',
  'organizer.undo': 'write',
  'actions.apply': 'write',
  'actions.undo': 'write',
  'chats.list': 'read',
  'chats.get': 'read',
  'chats.save': 'write',
  'chats.archive': 'write',
  'review.queue': 'read',
  'review.schedule': 'write',
  'insights.forItem': 'read',
  'insights.previewMerge': 'read',
  'insights.merge': 'write',
  'ocr.extract': 'read',
  'vault.state': 'read',
  'vault.setup': 'write',
  'vault.unlock': 'write',
  'vault.lock': 'write',
  'vault.create': 'write',
  'vault.read': 'read',
  'vault.update': 'write',
  'vault.outline': 'read',
  'vault.files': 'read',
  'vault.attachFiles': 'write',
  'vault.saveFile': 'read',
  'vault.removeFile': 'write',
  'vault.recoveryKit': 'read',
  'vault.recover': 'write',
  'vault.restoreVersion': 'write',
  'views.list': 'read',
  'views.get': 'read',
  'views.results': 'read',
  'views.create': 'write',
  'views.update': 'write',
  'views.remove': 'write',
  'templates.list': 'read',
  'templates.create': 'write',
  'templates.instantiate': 'write',
  'shares.list': 'read',
  'shares.create': 'write',
  'shares.revoke': 'write',
  'remoteSync.get': 'read',
  'remoteSync.configure': 'write',
  'remoteSync.run': 'write',
  'remoteSync.disconnect': 'write',
  'projects.list': 'read',
  'projects.create': 'write',
  'projects.update': 'write',
  'projects.setMemory': 'write',
  'projects.briefing': 'read',
  'projects.memoryHistory': 'read',
  'decisions.record': 'write',
  'tasks.list': 'read',
  'tasks.create': 'write',
  'tasks.update': 'write',
  'search.hybrid': 'read',
  'graph.get': 'read',
  'activity.recent': 'read',
  'settings.get': 'read',
  'settings.set': 'write',
  'index.status': 'read',
  'ai.status': 'read',
  'ai.configure': 'write',
  'ai.setKey': 'write',
  'ai.models': 'read',
  'ai.test': 'read',
  'ai.setEnrich': 'write',
  'ai.setAutoApply': 'write',
  'ai.ask': 'read',
  'ai.chat': 'read',
  'clients.list': 'read',
  'clients.create': 'write',
  'clients.pair': 'write',
  'clients.revoke': 'write',
  'api.status': 'read',
  'api.setLan': 'read',
  'mcp.setup': 'read',
  'mcp.addToClaudeCode': 'read',
  'backups.list': 'read',
  'backups.create': 'read',
  'backups.restore': 'read',
  'exports.run': 'read',
  'rules.list': 'read',
  'rules.create': 'write',
  'rules.setEnabled': 'write',
  'rules.delete': 'write',
  'imports.run': 'write',
  'highlights.preview': 'read',
  'highlights.import': 'write',
  'sync.status': 'read',
  'sync.pickFolder': 'read',
  'sync.start': 'write',
  'sync.unlock': 'write',
  'sync.now': 'write',
  'sync.stop': 'write',
  'capture.open': 'read',
  'capture.close': 'read',
};

export const isMethod = (value: unknown): value is Method => typeof value === 'string' && Object.hasOwn(METHOD_KINDS, value);

export type Args<M extends Method> = Parameters<Api[M]>;
export type Result<M extends Method> = Awaited<ReturnType<Api[M]>>;

export interface CallError {
  code: string;
  message: string;
}

export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: CallError };

/** Events main pushes to renderers. `command` carries a menu/shortcut action such as `search`; `open` an item id to show. */
export const EVENTS = ['changed', 'command', 'open'] as const;
export type EventName = (typeof EVENTS)[number];

export const COMMANDS = ['search', 'new-note', 'save-link', 'settings', 'import'] as const;
export type Command = (typeof COMMANDS)[number];

/** What preload exposes as `window.enve`. */
export interface Bridge {
  call(method: string, ...args: unknown[]): Promise<Envelope>;
  on(event: EventName, listener: (...payload: unknown[]) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}
