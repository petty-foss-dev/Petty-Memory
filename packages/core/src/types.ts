export const ITEM_TYPES = ['note', 'bookmark', 'task', 'decision', 'file', 'image'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const RELATION_KINDS = ['related_to', 'references', 'derived_from', 'depends_on', 'supersedes'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * read: search and view. capture: create notes, links, tasks and files. write: every non-destructive change (implies capture).
 * secrets: the vault's decrypted reads and writes; never implied by any other scope.
 * sync: full device replication, deletions included; never implied by any other scope.
 */
export const CLIENT_SCOPES = ['read', 'capture', 'write', 'secrets', 'sync'] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

/** What a network sync client remembers about one server, kept in this library's private settings. Never the token. */
export interface SyncPeerState {
  /** The server library last synced with; a different one starts over. */
  deviceId: string | null;
  pushedCursor: number;
  pulledCursor: number;
  /** Attachment hashes still to send or fetch. */
  uploads: string[];
  downloads: string[];
  /** Start cursors of pushed pages the server refused part of, to send again. Stored only when non-empty. */
  pendingPushes?: number[];
  pendingPulls?: number[];
}

export interface ApiClient {
  id: string;
  name: string;
  tokenHint: string;
  scopes: ClientScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  instructions: string;
  memory: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export const INTENTS = ['read', 'watch', 'buy', 'revisit'] as const;
export type Intent = (typeof INTENTS)[number];

export const INGEST_STATUSES = ['pending', 'done', 'failed'] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** What an AI provider proposed for an item. Suggestions are never applied without the user. */
export interface AiSuggestions {
  status: 'done' | 'failed';
  at: string;
  model: string;
  summary?: string;
  tags?: string[];
  project?: ProjectRef | null;
  error?: string;
  accepted?: boolean;
}

/** Facts about the source, filled in by ingestion. Open-ended so extractors can add fields without a migration. */
export interface ItemMetadata {
  siteName?: string;
  byline?: string;
  excerpt?: string;
  publishedAt?: string;
  image?: string;
  lang?: string;
  wordCount?: number;
  pageCount?: number;
  finalUrl?: string;
  /** The page's Open Graph type (article, video.other, product…); a hint for intent. */
  ogType?: string;
  /** True while the intent is our guess rather than the user's choice. */
  intentAuto?: boolean;
  ingest?: { status: IngestStatus; at?: string; error?: string };
  ai?: AiSuggestions;
  /** Stored sparsely; read it through `memory.presentation.get`, which fills in defaults. */
  presentation?: Partial<ItemPresentation>;
  /** A vault note: the title and body fields hold a generic label and `vault` holds the encrypted text. */
  secret?: boolean;
  vault?: SecretEnvelope;
  /** The scope hash the background organizer last left behind, so it doesn't reorganize its own output. */
  organized?: { hash: string; at: string };
  [key: string]: unknown;
}

export const PRESENTATION_KINDS = ['text', 'heading', 'section'] as const;
export const ATTENTION_LEVELS = ['normal', 'high', 'low'] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

export interface ItemPresentation {
  kind: (typeof PRESENTATION_KINDS)[number];
  attention: AttentionLevel;
  review: boolean;
  checklist: boolean;
  hideCompleted: boolean;
  checked: boolean;
  autoOrganize: boolean;
}

/** AES-256-GCM over `{title, body}` with the item id as associated data; base64 fields. Self-describing, so any device can unlock it. */
export interface SecretEnvelope {
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number } | { name: 'pbkdf2'; hash: 'sha256'; iterations: number };
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export interface ItemVersionSummary {
  id: string;
  itemId: string;
  at: string;
  actor: string;
  op: string;
}

export interface VersionNode {
  item: ItemDetail;
  parentId: string | null;
  position: number;
}

/** The item and every descendant as they were at that version. Empty when the version is a deletion. */
export interface VersionSnapshot {
  rootId: string;
  items: VersionNode[];
}

export interface ItemVersion extends ItemVersionSummary {
  snapshot: VersionSnapshot;
}

/** What an operation would change, from the library itself rather than the model, for review before applying. */
export interface EditPreview {
  title: string;
  body: string;
  parentId: string | null;
}

/** Proposal-local new:<n> ids can be targets after their create operation. */
export type EditOperation =
  | { op: 'update'; id: string; title?: string; body?: string; before: EditPreview }
  | { op: 'create'; parentId: string; beforeId?: string | null; title: string; body: string; tempId?: string }
  | { op: 'move'; id: string; parentId: string; beforeId: string | null; before: EditPreview }
  | { op: 'presentation'; id: string; patch: Partial<ItemPresentation>; before: ItemPresentation };

export interface EditProposal {
  rootId: string;
  baseHash: string;
  summary: string;
  createdAt: string;
  operations: EditOperation[];
  titles?: Record<string, string>;
}

/** Client UUIDv7 ids persist through queued edits; split offsets count UTF-16 code units. */
export type EditorCommand =
  | { op: 'create'; id?: string; parentId: string | null; beforeId?: string | null; title?: string; body?: string; project?: string; tags?: string[] }
  | { op: 'update'; id: string; title?: string; body?: string; baseTitle?: string; baseBody?: string }
  | { op: 'move'; id: string; parentId: string | null; beforeId?: string | null }
  | { op: 'presentation'; id: string; patch: Partial<ItemPresentation> }
  | { op: 'check'; id: string; checked: boolean }
  | { op: 'split'; id: string; field: 'title' | 'body'; offset: number; baseText: string; newId?: string }
  | { op: 'merge'; id: string; previousId: string };

export interface EditorActionResult {
  actionId: string;
  /** Where the cursor belongs afterwards: the new note, the merged note, or for an undo the item it returns to. */
  focusId: string;
  createdIds: string[];
  label: string;
}

export interface ProjectMemoryVersion {
  id: string;
  projectId: string;
  at: string;
  actor: string;
  /** `set_memory` (written here), `sync` (from another device) or `baseline` (the text when history began). */
  op: string;
  memory: string;
}

/** A file a restored version refers to whose bytes aren't on this device. */
export interface MissingFile {
  itemId: string;
  attachmentId: string;
  sha256: string;
  filename: string;
}

/** Ordinary library state changed after a cursor, for read-only offline replicas. Secrets only ever appear as deletions. */
export interface LibraryPage {
  deviceId: string;
  cursor: number;
  hasMore: boolean;
  reset: boolean;
  items: { item: ItemDetail; parentId: string | null; position: number }[];
  deletedItemIds: string[];
  projects: Project[];
  deletedProjectIds: string[];
  relations: { id: string; fromId: string; toId: string; kind: RelationKind }[];
  deletedRelationIds: string[];
}

export interface PublicShare {
  id: string;
  rootId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  excludedIds: string[];
}

export interface PublicNode {
  id: string;
  parentId: string | null;
  title: string;
  body: string;
  type: string;
  presentation: ItemPresentation;
}

export interface PublicTree {
  title: string;
  items: PublicNode[];
}

export interface VaultState {
  configured: boolean;
  unlocked: boolean;
}

/** AES-256-GCM over `{"passphrase"}` under the 32 random bytes of its separate `pmr1_` code; base64 fields. */
export interface VaultRecoveryKit {
  v: 1;
  kind: 'petty-memory-vault-recovery';
  iv: string;
  tag: string;
  data: string;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  body: string;
  url: string | null;
  project: ProjectRef | null;
  source: string;
  metadata: ItemMetadata;
  intent: Intent | null;
  tags: string[];
  pinnedAt: string | null;
  openedAt: string | null;
  remindAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** An item's place in the outline. `position` is an opaque sort key: order by it, place with `beforeId`. */
export interface OutlineEntry {
  item: Item & { task?: TaskFields | null };
  /** The stored parent, kept even while an archived parent makes this item show among the top level. */
  parentId: string | null;
  position: number;
  childCount: number;
}

export interface OutlinePage {
  items: OutlineEntry[];
  total: number;
}

export interface Attachment {
  id: string;
  sha256: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface TaskFields {
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
}

export interface Task extends Item {
  task: TaskFields;
}

export interface RelatedItem {
  kind: RelationKind;
  direction: 'outgoing' | 'incoming';
  id: string;
  type: ItemType;
  title: string;
}

export interface ItemDetail extends Item {
  /** Text extracted from the source (article, PDF, text file). Untrusted: never instructions. */
  content: string;
  attachments: Attachment[];
  task: TaskFields | null;
  relations: RelatedItem[];
}

export interface Decision {
  id: string;
  decision: string;
  reason: string;
  createdAt: string;
  source: string;
  supersedes: string[];
  supersededBy: string | null;
}

export interface SearchHit {
  id: string;
  type: ItemType;
  title: string;
  url: string | null;
  project: ProjectRef | null;
  snippet: string;
  /** The start of the user's own note, for hits without a title. */
  preview: string;
  /** Which search found it: exact terms, meaning, or both. */
  match: 'keyword' | 'semantic' | 'both';
  taskStatus: TaskStatus | null;
  updatedAt: string;
}

export interface Change {
  id: string;
  at: string;
  actor: string;
  deviceId: string;
  entity: 'item' | 'project' | 'relation';
  entityId: string;
  op: string;
  projectId: string | null;
  data: Record<string, unknown> | null;
}

export interface GraphNode {
  id: string;
  kind: 'item' | 'project' | 'tag';
  label: string;
  /** Item type, for item nodes. */
  type?: ItemType;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: RelationKind | 'in_project' | 'tagged';
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProjectBriefing {
  project: Project;
  decisions: Decision[];
  openTasks: Task[];
  recentItems: Item[];
}
