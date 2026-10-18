import { createHash } from 'node:crypto';
import { type Dirent, type Stats, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, clientId, newId, oneOf } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import type { FileService } from './files.ts';
import { detectIntent } from './intent.ts';
import type { ItemService } from './items.ts';
import { mimeFor } from './mime.ts';
import { defaultHome } from './paths.ts';
import { descendants, pathToRoot } from './placement.ts';
import type { ProjectService } from './projects.ts';
import { toFtsQuery } from './search.ts';
import type { ItemMetadata, ItemType, ProjectRef } from './types.ts';
import { readItemState } from './versions.ts';

export const SOURCE_LIMITS = {
  watches: 100,
  /** Entries one URL/RSS check may queue. */
  entries: 50,
  /** Bytes a URL/RSS check may download. */
  fetchBytes: 2 * 1024 * 1024,
  candidateText: 100_000,
  /** Characters of source text across one URL/RSS check. */
  checkText: 2 * 1024 * 1024,
  folderFiles: 200,
  fileBytes: 20 * 1024 * 1024,
  /** Bytes one folder check reads; unchanged files are recognized by size and modification time without reading. */
  folderCheckBytes: 64 * 1024 * 1024,
  folderPreview: 4000,
  applyBatch: 20,
  applyBytes: 64 * 1024 * 1024,
  appliedHistory: 200,
  freshnessItems: 100,
  freshnessBranch: 500,
  excerpt: 3000,
  dismissed: 100,
  maxAgeDays: 36_500,
} as const;

export const WATCH_KINDS = ['url', 'rss', 'folder'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const FOLDER_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf'] as const;

export interface WatchInput {
  name: string;
  kind: WatchKind;
  /** Required for url and rss; folders are approved separately on the library's computer. */
  url?: string;
  project?: string | null;
  /** Periodic checks run only for enabled watches. Defaults to false. */
  enabled?: boolean;
}

export interface WatchPatch {
  name?: string;
  url?: string;
  project?: string | null;
  enabled?: boolean;
}

/** Whether this computer has approved a folder for the watch, and whether it can be read now. Never the path. */
export interface FolderStatus {
  approved: boolean;
  available: boolean;
}

export interface SourceCheck {
  at: string;
  status: 'ok' | 'failed' | 'stale';
  found: number;
  queued: number;
  unchanged: number;
  /** Archived imports, oversized or unreadable files. */
  skipped: number;
  /** More entries, files or text existed than one check takes. */
  truncated: boolean;
  error: string | null;
}

export interface WatchedSource {
  id: string;
  name: string;
  kind: WatchKind;
  url: string | null;
  project: ProjectRef | null;
  enabled: boolean;
  /** Fingerprint of what the watch reads; queued previews are bound to it. */
  hash: string;
  folder: FolderStatus | null;
  lastCheck: SourceCheck | null;
  pending: number;
  createdAt: string;
  updatedAt: string;
}

/** What a host check read from a URL or feed, before comparison with the library. */
export interface SourceObservation {
  key: string;
  title: string;
  url: string | null;
  text: string;
  publishedAt: string | null;
  truncated?: boolean;
}

export interface CheckReport {
  /** `WatchedSource.hash` when the check started; a watch edited meanwhile records a stale check. */
  sourceHash: string;
  observations?: SourceObservation[];
  truncated?: boolean;
  error?: string;
}

export interface CandidateFile {
  name: string;
  size: number;
  sha256: string;
  mimeType: string;
  modifiedAt: string;
}

/** A reviewed import or update waiting for the person. Applying it is always explicit. */
export interface SourceCandidate {
  id: string;
  watchId: string;
  /** The URL, the feed entry's id, or the file name. */
  key: string;
  change: 'new' | 'changed';
  title: string;
  url: string | null;
  /** Exactly what an import or update stores (URL/RSS), or a preview of a text file. */
  text: string;
  truncated: boolean;
  publishedAt: string | null;
  file: CandidateFile | null;
  fingerprint: string;
  sourceHash: string;
  targetId: string | null;
  targetHash: string | null;
  checkedAt: string;
}

export interface SourceQueue {
  watchId: string;
  check: SourceCheck | null;
  candidates: SourceCandidate[];
}

export interface AppliedCandidate {
  candidateId: string;
  itemId: string;
  change: 'new' | 'changed';
  /** The earlier file snapshot a changed file supersedes; it is kept unchanged. */
  previousId: string | null;
}

export interface SourceApplyResult {
  watchId: string;
  applied: AppliedCandidate[];
}

export interface FreshnessScopeInput {
  rootId?: string;
  query?: string;
  project?: string;
}

/** Published comes from the source, captured is when it was saved, edited is the last change, checked is the last freshness review. */
export interface FreshnessDates {
  publishedAt: string | null;
  capturedAt: string;
  editedAt: string;
  checkedAt: string | null;
}

export interface FreshnessItem {
  id: string;
  type: ItemType;
  title: string;
  url: string | null;
  /** The exact text quotes must come from. */
  excerpt: string;
  truncated: boolean;
  dates: FreshnessDates;
  stateHash: string;
  dismissed: string[];
}

export interface FreshnessScope {
  rootId: string | null;
  query: string | null;
  project: string | null;
  baseHash: string;
  items: FreshnessItem[];
}

export interface StaleInput {
  olderThanDays: number;
  rootId?: string;
  project?: string;
}

export interface StaleItem extends FreshnessItem {
  ageDays: number;
  basis: 'checked' | 'edited';
}

export interface StaleItems {
  olderThanDays: number;
  cutoff: string;
  items: StaleItem[];
  total: number;
}

export interface FreshnessRef {
  id: string;
  stateHash: string;
}

export type FreshnessAction = 'check' | 'dismiss' | 'supersede';

export interface FreshnessReceipt {
  action: FreshnessAction;
  itemIds: string[];
  at: string;
}

interface WatchDefinition {
  version: 1;
  kind: WatchKind;
  url: string | null;
  project: string | null;
  enabled: boolean;
}

interface FolderState {
  path: string;
  approvalId: string;
  approvedAt: string;
  files: Record<string, { size: number; mtimeMs: number; sha256: string }>;
}

interface QueueState {
  check: SourceCheck | null;
  candidates: SourceCandidate[];
  applied: AppliedCandidate[];
  targets: Record<string, string>;
}

interface WatchedFrom {
  version: 1;
  watchId: string;
  key: string;
  fingerprint: string;
  checkedAt: string;
  appliedAt: string;
  previousId: string | null;
}

interface FreshnessState {
  version: 1;
  checkedAt?: string;
  dismissed?: string[];
  supersededBy?: string;
  supersededAt?: string;
  lastReview?: { action: FreshnessAction; base: string; at: string };
}

interface FolderFile {
  size: number;
  mtimeMs: number;
  data: Buffer | null;
}

const WATCH_FIELDS = ['name', 'kind', 'url', 'project', 'enabled'] as const;
const PATCH_FIELDS = ['name', 'url', 'project', 'enabled'] as const;
const REPORT_FIELDS = ['sourceHash', 'observations', 'truncated', 'error'] as const;
const INFO_TYPES = ['note', 'bookmark', 'file', 'image'] as const;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;
const ELIGIBLE = `i.archived_at IS NULL AND i.type IN ('note', 'bookmark', 'file', 'image')
  AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 AND json_extract(i.metadata, '$.savedView') IS NULL
  AND json_extract(i.metadata, '$.conversation') IS NULL AND coalesce(json_extract(i.metadata, '$.knowledgeDefinition'), 0) = 0
  AND json_extract(i.metadata, '$.freshness.supersededBy') IS NULL AND i.id NOT IN (SELECT id FROM template_members)`;
const DEFINITIONS = `json_extract(i.metadata, '$.watchedSource.version') = 1 AND coalesce(json_extract(i.metadata, '$.knowledgeDefinition'), 0) = 1
  AND i.type = 'note' AND i.archived_at IS NULL AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0`;

/**
 * Watched sources are definition notes (`metadata.knowledgeDefinition`, `metadata.watchedSource`), so they export and sync
 * like any note. Folder paths, review queues and file indexes are device-local settings that never sync. Checks only queue
 * previews; nothing reaches the library until `apply`.
 */
export class SourceService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;
  private readonly files: FileService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService, files: FileService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
    this.files = files;
  }

  list(): WatchedSource[] {
    return this.ctx
      .all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${DEFINITIONS} ORDER BY i.title COLLATE NOCASE, i.id`)
      .flatMap((row) => {
        const definition = parseDefinition((JSON.parse(row.metadata) as ItemMetadata).watchedSource);
        return definition ? [this.describe(row, definition)] : [];
      });
  }

  get(id: string): WatchedSource {
    const { row, definition } = this.definition(id);
    return this.describe(row, definition);
  }

  create(input: WatchInput): WatchedSource {
    const fields = fieldsOf(input, WATCH_FIELDS, 'watched source');
    const name = text(fields.name, 'The watch name', 120);
    const kind = oneOf(text(fields.kind, 'The kind', 20), WATCH_KINDS, 'watch kind');
    const definition: WatchDefinition = {
      version: 1, kind,
      url: this.urlFor(kind, fields.url),
      project: fields.project === undefined || fields.project === null ? null : this.projects.resolve(text(fields.project, 'The project', 200)).id,
      enabled: flag(fields.enabled, 'enabled') ?? false,
    };
    const { n } = this.ctx.get<{ n: number }>(`SELECT count(*) AS n FROM items i WHERE ${DEFINITIONS}`)!;
    if (n >= SOURCE_LIMITS.watches) throw invalid(`A library can watch at most ${SOURCE_LIMITS.watches} sources. Remove one you no longer need first.`);
    const id = this.items.insert({ type: 'note', title: name, metadata: { knowledgeDefinition: true, watchedSource: definition } }, { automations: false });
    return this.get(id);
  }

  update(id: string, patch: WatchPatch): WatchedSource {
    const { row, definition } = this.definition(id);
    const fields = fieldsOf(patch, PATCH_FIELDS, 'watched source change');
    const name = fields.name === undefined ? row.title : text(fields.name, 'The watch name', 120);
    const next: WatchDefinition = {
      ...definition,
      url: fields.url === undefined ? definition.url : this.urlFor(definition.kind, fields.url),
      project: fields.project === undefined ? definition.project
        : fields.project === null ? null : this.projects.resolve(text(fields.project, 'The project', 200)).id,
      enabled: flag(fields.enabled, 'enabled') ?? definition.enabled,
    };
    const folder = this.folderState(row.id);
    const before = this.hash(row.id, definition, folder);
    this.ctx.tx(() => {
      const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), watchedSource: next };
      this.items.write(row, { title: name, metadata: JSON.stringify(metadata) }, 'update', { title: name, watchedSource: next });
      if (this.hash(row.id, next, folder) !== before) this.clearQueue(row.id);
    });
    return this.get(row.id);
  }

  /** Archives the definition and forgets this computer's folder approval and queue; imported items stay as they are. */
  remove(id: string): void {
    const { row } = this.definition(id);
    this.ctx.tx(() => {
      this.items.archive(row.id);
      this.setSetting(folderKey(row.id), null);
      this.setSetting(queueKey(row.id), null);
    });
  }

  /**
   * Host-only: binds a folder on this computer to the watch. Only the library's own local UI may call this, after the
   * person picked the folder; remote clients can check and apply an approved watch but never supply a path.
   */
  approveFolder(id: string, path: string): WatchedSource {
    const { row, definition } = this.definition(id);
    if (definition.kind !== 'folder') throw invalid('Only folder watches take a folder.');
    if (!this.ctx.attachmentsDir) throw invalid('Folder watches need a library saved on disk.');
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) {
      throw invalid('Choose a folder on this computer by its full path.');
    }
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      throw invalid('That folder doesn’t exist on this computer. Choose it again.');
    }
    if (stat.isSymbolicLink()) throw invalid('Choose the folder itself rather than a shortcut or symbolic link to it.');
    if (!stat.isDirectory()) throw invalid('Choose a folder, not a file.');
    const real = realpathSync.native(path);
    if (dirname(real) === real) throw invalid('Choose a specific folder, not a whole disk.');
    if (real === realOrSelf(homedir())) throw invalid('Choose a specific folder, not your whole home folder.');
    for (const library of this.libraryRoots()) {
      if (inside(real, library) || inside(library, real)) {
        throw invalid('That folder overlaps a Petty Memory library or its backups. Choose a folder of your own documents.');
      }
    }
    const state: FolderState = { path: real, approvalId: newId(), approvedAt: this.ctx.now(), files: {} };
    this.ctx.tx(() => {
      this.setSetting(folderKey(row.id), state);
      this.clearQueue(row.id);
    });
    return this.get(row.id);
  }

  /** Host-only: forgets the folder approved on this computer. */
  revokeFolder(id: string): WatchedSource {
    const { row } = this.definition(id);
    this.ctx.tx(() => {
      this.setSetting(folderKey(row.id), null);
      this.clearQueue(row.id);
    });
    return this.get(row.id);
  }

  queue(id: string): SourceQueue {
    const { row } = this.definition(id);
    const state = this.queueState(row.id);
    return { watchId: row.id, check: state.check, candidates: state.candidates };
  }

  /** Enabled watches of `kinds` this computer can check whose last check is older than `intervalMs`, least recently checked first. */
  due(intervalMs: number, limit: number = SOURCE_LIMITS.watches, kinds: readonly WatchKind[] = WATCH_KINDS): string[] {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw invalid('The check interval must be a non-negative number of milliseconds.');
    const cutoff = new Date(Date.now() - intervalMs).toISOString();
    return this.list()
      .filter((watch) => watch.enabled && kinds.includes(watch.kind) && (watch.kind !== 'folder' || watch.folder?.available)
        && (watch.lastCheck?.at ?? '') <= cutoff)
      .sort((a, b) => (a.lastCheck?.at ?? '').localeCompare(b.lastCheck?.at ?? '') || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((watch) => watch.id);
  }

  /** Records what the host read from a URL or feed and queues new or changed material. Never writes library content. */
  recordCheck(id: string, report: CheckReport): SourceQueue {
    const fields = fieldsOf(report, REPORT_FIELDS, 'check report');
    const sourceHash = text(fields.sourceHash, 'The source hash', 64);
    const at = this.ctx.now();
    return this.ctx.tx(() => {
      const { row, definition } = this.definition(id);
      if (definition.kind === 'folder') throw invalid('Folder watches are checked on this computer with checkFolder.');
      const state = this.queueState(row.id);
      if (sourceHash !== this.hash(row.id, definition, null)) {
        return this.saveQueue(row.id, { ...state, check: emptyCheck(at, 'stale', 'The watch changed while it was being checked. Check it again.') });
      }
      if (fields.error !== undefined) {
        const error = text(fields.error, 'The check error', 500);
        return this.saveQueue(row.id, { ...state, check: emptyCheck(at, 'failed', error) });
      }
      if (!Array.isArray(fields.observations) || fields.observations.length > SOURCE_LIMITS.entries) {
        throw invalid(`A check reports at most ${SOURCE_LIMITS.entries} entries.`);
      }
      let budget: number = SOURCE_LIMITS.checkText;
      let truncated = flag(fields.truncated, 'truncated') ?? false;
      const keys = new Set<string>();
      const urls = new Set<string>();
      const counts = { unchanged: 0, skipped: 0 };
      const next: Omit<SourceCandidate, 'id'>[] = [];
      for (const raw of fields.observations as unknown[]) {
        const observation = parseObservation(raw);
        if (keys.has(observation.key) || (observation.url && urls.has(observation.url))) continue;
        if (budget <= 0) {
          truncated = true;
          break;
        }
        keys.add(observation.key);
        if (observation.url) urls.add(observation.url);
        let body = clip(observation.text, Math.min(SOURCE_LIMITS.candidateText, budget));
        if (body.length < observation.text.length) truncated = true;
        budget -= body.length;
        body = body.trim();
        const fingerprint = digest({ title: observation.title, url: observation.url, text: body });
        const target = this.target(row.id, observation.key, definition.kind === 'url' ? observation.url : null);
        if (target?.archived_at) {
          counts.skipped++;
          continue;
        }
        if (target && (watchedFrom(target)?.fingerprint === fingerprint || this.content(target.id).trim() === body)) {
          counts.unchanged++;
          continue;
        }
        next.push({
          watchId: row.id, key: observation.key, change: target ? 'changed' : 'new', title: observation.title, url: observation.url,
          text: body, truncated: !!observation.truncated || body.length < observation.text.trim().length, publishedAt: observation.publishedAt,
          file: null, fingerprint, sourceHash, targetId: target?.id ?? null, targetHash: target ? this.stateHash(target.id) : null, checkedAt: at,
        });
      }
      const candidates = keepIds(state.candidates, next);
      return this.saveQueue(row.id, {
        ...state, candidates,
        check: { at, status: 'ok', found: keys.size, queued: candidates.length, ...counts, truncated, error: null },
      });
    });
  }

  /** Host-only: reads the approved folder's top level (no subfolders, no symbolic links) and queues new or changed files. */
  checkFolder(id: string): SourceQueue {
    const { row, definition } = this.definition(id);
    if (definition.kind !== 'folder') throw invalid('Only folder watches read a folder; check URL and feed watches through ingestion.');
    const folder = this.folderState(row.id);
    if (!folder) throw invalid('Approve a folder for this watch on this computer first.');
    const at = this.ctx.now();
    const sourceHash = this.hash(row.id, definition, folder);
    const fail = (error: string) => this.ctx.tx(() => this.saveQueue(row.id, { ...this.queueState(row.id), check: emptyCheck(at, 'failed', error) }));
    if (!available(folder)) return fail('The approved folder can’t be read now. Reconnect it, or approve it again on this computer.');
    let entries: Dirent[];
    try {
      entries = readdirSync(folder.path, { withFileTypes: true });
    } catch {
      // The system's message names the folder, and its path never leaves this computer's settings.
      return fail('Petty Memory couldn’t list the approved folder. Check that it may open the folder and that the disk is connected, or approve it again on this computer.');
    }
    const names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && (FOLDER_EXTENSIONS as readonly string[]).includes(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
    let truncated = names.length > SOURCE_LIMITS.folderFiles;
    let budget: number = SOURCE_LIMITS.folderCheckBytes;
    const counts = { unchanged: 0, skipped: 0 };
    const index: FolderState['files'] = {};
    const next: Omit<SourceCandidate, 'id'>[] = [];
    for (const name of names.slice(0, SOURCE_LIMITS.folderFiles)) {
      const known = folder.files[name];
      const file = readFolderFile(folder.path, name, (size, mtimeMs) => {
        if (known && known.size === size && known.mtimeMs === mtimeMs) return false;
        if (size > budget) return null;
        budget -= size;
        return true;
      });
      if (file === 'deferred') {
        truncated = true;
        continue;
      }
      if (!file) {
        counts.skipped++;
        continue;
      }
      const sha256 = file.data ? sha(file.data) : known!.sha256;
      index[name] = { size: file.size, mtimeMs: file.mtimeMs, sha256 };
      const target = this.target(row.id, name, null);
      if (target?.archived_at) {
        counts.skipped++;
        continue;
      }
      const same = target
        ? this.ctx.get(`SELECT 1 FROM attachments WHERE item_id = ? AND sha256 = ?`, target.id, sha256)
        : this.ctx.get(
          `SELECT 1 FROM attachments a JOIN items i ON i.id = a.item_id WHERE a.sha256 = ? AND i.archived_at IS NULL
           AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0`, sha256,
        );
      if (same) {
        counts.unchanged++;
        continue;
      }
      // A file recognized by size and time is read only now that it needs a preview.
      let bytes = file.data;
      if (!bytes) {
        if (file.size > budget) {
          truncated = true;
          continue;
        }
        budget -= file.size;
        const reread = readFolderFile(folder.path, name, () => true);
        bytes = reread && reread !== 'deferred' ? reread.data : null;
      }
      if (!bytes || sha(bytes) !== sha256) {
        counts.skipped++;
        continue;
      }
      const preview = TEXT_EXTENSIONS.has(extname(name).toLowerCase()) ? bytes.toString('utf8') : '';
      const body = clip(preview, SOURCE_LIMITS.folderPreview);
      next.push({
        watchId: row.id, key: name, change: target ? 'changed' : 'new', title: name, url: null, text: body, truncated: body.length < preview.length,
        publishedAt: null, file: { name, size: file.size, sha256, mimeType: mimeFor(name), modifiedAt: new Date(file.mtimeMs).toISOString() },
        fingerprint: sha256, sourceHash, targetId: target?.id ?? null, targetHash: target ? this.stateHash(target.id) : null, checkedAt: at,
      });
    }
    return this.ctx.tx(() => {
      this.setSetting(folderKey(row.id), { ...folder, files: index });
      const state = this.queueState(row.id);
      const candidates = keepIds(state.candidates, next);
      return this.saveQueue(row.id, {
        ...state, candidates,
        check: { at, status: 'ok', found: Math.min(names.length, SOURCE_LIMITS.folderFiles), queued: candidates.length, ...counts, truncated, error: null },
      });
    });
  }

  /**
   * Imports or updates the selected previews, all or nothing. Each must still match its watch, its target's current state and,
   * for files, the bytes on disk; otherwise nothing is written and the person checks again. Changed files become new snapshot
   * items that supersede the earlier one; changed pages update the source text and keep the person's own note and history.
   */
  apply(id: string, candidateIds: string[]): SourceApplyResult {
    const { row, definition } = this.definition(id);
    if (!Array.isArray(candidateIds) || !candidateIds.length || candidateIds.length > SOURCE_LIMITS.applyBatch
      || new Set(candidateIds).size !== candidateIds.length) {
      throw invalid(`Select between 1 and ${SOURCE_LIMITS.applyBatch} different previews to apply.`);
    }
    const ids = candidateIds.map((value) => clientId(value, 'Preview id'));
    const folder = definition.kind === 'folder' ? this.folderState(row.id) : null;
    if (definition.kind === 'folder' && (!folder || !available(folder))) {
      throw new MemoryError('conflict', 'The approved folder can’t be read now. Reconnect it, or approve it again on this computer, then check again.');
    }
    // Files are read before the write transaction; their hashes bind them to the reviewed preview.
    const queued = this.queueState(row.id).candidates;
    const bytes = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const candidate of queued) {
      if (!ids.includes(candidate.id) || !candidate.file) continue;
      const file = readFolderFile(folder!.path, candidate.key, () => true);
      const data = file && file !== 'deferred' ? file.data : null;
      if (!data || sha(data) !== candidate.file.sha256) throw stalePreview(`“${candidate.key}” changed or moved since it was previewed.`);
      totalBytes += data.byteLength;
      if (totalBytes > SOURCE_LIMITS.applyBytes) throw invalid('Import at most 64 MB of files in one batch. Select fewer previews.');
      bytes.set(candidate.id, data);
    }
    return this.ctx.tx(() => {
      const state = this.queueState(row.id);
      const live = this.definition(row.id).definition;
      const sourceHash = this.hash(row.id, live, live.kind === 'folder' ? this.folderState(row.id) : null);
      const results: AppliedCandidate[] = [];
      const selected: SourceCandidate[] = [];
      for (const candidateId of ids) {
        const candidate = state.candidates.find((entry) => entry.id === candidateId);
        if (candidate) selected.push(candidate);
        else {
          const done = state.applied.find((entry) => entry.candidateId === candidateId);
          if (!done) throw stalePreview('That preview is no longer queued.');
          results.push(done);
        }
      }
      if (!selected.length) return { watchId: row.id, applied: results };
      for (const candidate of selected) {
        if (candidate.sourceHash !== sourceHash) throw stalePreview('The watch changed since this was previewed.');
        if (candidate.file && !bytes.has(candidate.id)) throw stalePreview(`“${candidate.key}” changed since it was previewed.`);
        const target = this.target(row.id, candidate.key, live.kind === 'url' ? candidate.url : null);
        if ((target?.id ?? null) !== candidate.targetId || (target ? this.stateHash(target.id) : null) !== candidate.targetHash) {
          throw stalePreview(`The library’s copy of “${candidate.title}” changed since this was previewed.`);
        }
      }
      if (live.project && !this.ctx.get(`SELECT 1 FROM projects WHERE id = ?`, live.project)) {
        throw new MemoryError('conflict', 'The project this watch files into no longer exists. Choose another project for the watch.');
      }
      const project = live.project ?? undefined;
      const at = this.ctx.now();
      const targets = { ...state.targets };
      for (const candidate of selected) {
        const from: WatchedFrom = {
          version: 1, watchId: row.id, key: candidate.key, fingerprint: candidate.fingerprint, checkedAt: candidate.checkedAt, appliedAt: at,
          previousId: candidate.file ? candidate.targetId : null,
        };
        const dated = candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {};
        let itemId: string;
        if (candidate.file) {
          // Always a fresh snapshot: reusing an item with the same bytes would claim an unrelated file, or loop the supersedes chain.
          itemId = this.files.save({ data: bytes.get(candidate.id)!, filename: candidate.key, title: candidate.key, project, deduplicate: false }).item.id;
          this.mark(itemId, from);
          if (candidate.targetId) this.items.relate(itemId, candidate.targetId, 'supersedes');
        } else if (candidate.targetId) {
          itemId = candidate.targetId;
          this.items.setSource(itemId, { title: candidate.title, content: candidate.text, metadata: { ...dated, watchedFrom: from } });
        } else {
          const ingest = { status: 'done' as const, at };
          itemId = candidate.url
            ? this.items.insert({
              type: 'bookmark', url: candidate.url, title: candidate.title, content: candidate.text, project, intent: detectIntent(candidate.url),
              metadata: { ...dated, intentAuto: true, ingest, watchedFrom: from },
            })
            : this.items.insert({ type: 'note', title: candidate.title, content: candidate.text, project, metadata: { ...dated, ingest, watchedFrom: from } });
        }
        results.push({ candidateId: candidate.id, itemId, change: candidate.change, previousId: from.previousId });
        delete targets[candidate.key];
        targets[candidate.key] = itemId;
      }
      const appliedIds = new Set(selected.map((candidate) => candidate.id));
      this.saveQueue(row.id, {
        check: state.check,
        candidates: state.candidates.filter((candidate) => !appliedIds.has(candidate.id)),
        applied: [...state.applied, ...results.filter((result) => appliedIds.has(result.candidateId))].slice(-SOURCE_LIMITS.appliedHistory),
        targets: Object.fromEntries(Object.entries(targets).slice(-SOURCE_LIMITS.appliedHistory)),
      });
      return { watchId: row.id, applied: results };
    });
  }

  /** A bounded snapshot of ordinary items for outdated/conflicting-information review. Read-only. */
  freshnessScope(input: FreshnessScopeInput): FreshnessScope {
    if (!isObject(input)) throw invalid('Choose a branch, a topic or a project to review.');
    const rootId = optional(input.rootId, 'The branch', 100);
    const query = optional(input.query, 'The topic', 500);
    const project = input.project === undefined || input.project === null ? null : this.projects.resolve(text(input.project, 'The project', 200)).id;
    if (rootId && query) throw invalid('Choose either one branch or one keyword topic to review.');
    if (rootId && project) throw invalid('A branch already determines what is reviewed; choose a project only for a topic or a whole project.');
    if (!rootId && !query && !project) throw invalid('Choose a branch, a topic or a project to review.');
    const where = [ELIGIBLE];
    const params: string[] = [];
    if (rootId) {
      this.items.row(rootId);
      const branch = [rootId, ...descendants(this.ctx, rootId)];
      if (branch.length > SOURCE_LIMITS.freshnessBranch) throw invalid(`That branch has more than ${SOURCE_LIMITS.freshnessBranch} items. Choose a smaller branch.`);
      where.push('i.id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(branch));
    }
    if (query) {
      const match = toFtsQuery(query)?.replaceAll(' OR ', ' AND ');
      if (!match) throw invalid('Name the topic with at least one word or number.');
      where.push('i.seq IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      params.push(match);
    }
    if (project) {
      where.push('i.project_id = ?');
      params.push(project);
    }
    const rows = this.ctx.all<ItemRow & { content: string }>(
      `${TEMPLATE_MEMBERS} SELECT ${ITEM_COLUMNS}, i.content FROM ${ITEM_FROM} WHERE ${where.join(' AND ')} ORDER BY i.seq LIMIT ?`,
      ...params, SOURCE_LIMITS.freshnessItems + 1,
    );
    if (!rows.length) throw invalid('No ordinary notes, links or files match. Choose another branch, topic or project.');
    if (rows.length > SOURCE_LIMITS.freshnessItems) throw invalid(`More than ${SOURCE_LIMITS.freshnessItems} items match. Choose a narrower topic or a smaller branch.`);
    const items = rows.map((row) => this.freshnessItem(row));
    return { rootId, query, project, baseHash: digest(items.map((item) => [item.id, item.stateHash])), items };
  }

  /** Deterministic: items not edited or checked within the chosen number of days, oldest first. No model is involved. */
  staleItems(input: StaleInput): StaleItems {
    if (!isObject(input)) throw invalid('Choose how many days old an item must be.');
    const days = input.olderThanDays;
    if (!Number.isInteger(days) || days < 1 || days > SOURCE_LIMITS.maxAgeDays) {
      throw invalid(`olderThanDays must be a whole number of days from 1 to ${SOURCE_LIMITS.maxAgeDays}.`);
    }
    const rootId = optional(input.rootId, 'The branch', 100);
    if (rootId && input.project !== undefined) throw invalid('Choose a branch or a project, not both.');
    const project = input.project === undefined ? null : this.projects.resolve(text(input.project, 'The project', 200)).id;
    const now = Date.now();
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const basis = `coalesce(json_extract(i.metadata, '$.freshness.checkedAt'), i.updated_at)`;
    const where = [ELIGIBLE, `${basis} < ?`];
    const params: string[] = [cutoff];
    if (rootId) {
      this.items.row(rootId);
      where.push('i.id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify([rootId, ...descendants(this.ctx, rootId)]));
    }
    if (project) {
      where.push('i.project_id = ?');
      params.push(project);
    }
    const { total } = this.ctx.get<{ total: number }>(`${TEMPLATE_MEMBERS} SELECT count(*) AS total FROM items i WHERE ${where.join(' AND ')}`, ...params)!;
    const rows = this.ctx.all<ItemRow & { content: string }>(
      `${TEMPLATE_MEMBERS} SELECT ${ITEM_COLUMNS}, i.content FROM ${ITEM_FROM} WHERE ${where.join(' AND ')} ORDER BY ${basis}, i.id LIMIT ?`,
      ...params, SOURCE_LIMITS.freshnessItems,
    );
    return {
      olderThanDays: days, cutoff, total,
      items: rows.map((row): StaleItem => {
        const item = this.freshnessItem(row);
        const since = item.dates.checkedAt ?? item.dates.editedAt;
        return { ...item, basis: item.dates.checkedAt ? 'checked' : 'edited', ageDays: Math.floor((now - Date.parse(since)) / 86_400_000) };
      }),
    };
  }

  /** Records that the person checked the item is still current. Content is unchanged. */
  markChecked(ref: FreshnessRef): FreshnessReceipt {
    const { id, stateHash } = parseRef(ref);
    return this.ctx.tx((): FreshnessReceipt => {
      const row = this.reviewable(id);
      const state = freshnessOf(row);
      if (this.stateHash(row.id) !== stateHash) {
        if (repeated(state, 'check', stateHash)) return { action: 'check', itemIds: [row.id], at: state.lastReview!.at };
        throw staleReview();
      }
      const at = this.ctx.now();
      this.setFreshness(row, { ...state, checkedAt: at, lastReview: { action: 'check', base: stateHash, at } });
      return { action: 'check', itemIds: [row.id], at };
    });
  }

  /** Stops suggesting this pair. Both items keep their content. */
  dismissPair(refs: [FreshnessRef, FreshnessRef]): FreshnessReceipt {
    const [a, b] = parsePair(refs);
    return this.ctx.tx((): FreshnessReceipt => {
      const rows = [this.reviewable(a.id), this.reviewable(b.id)];
      const states = rows.map(freshnessOf);
      const pair = [a, b];
      const done = rows.every((row, index) => states[index]!.dismissed?.includes(rows[1 - index]!.id) && repeated(states[index]!, 'dismiss', pair[index]!.stateHash));
      if (done) return { action: 'dismiss', itemIds: rows.map((row) => row.id), at: states[0]!.lastReview!.at };
      if (rows.some((row, index) => this.stateHash(row.id) !== pair[index]!.stateHash)) throw staleReview();
      const at = this.ctx.now();
      rows.forEach((row, index) => {
        const other = rows[1 - index]!.id;
        const dismissed = [...(states[index]!.dismissed ?? []).filter((value) => value !== other), other].slice(-SOURCE_LIMITS.dismissed);
        this.setFreshness(row, { ...states[index]!, dismissed, lastReview: { action: 'dismiss', base: pair[index]!.stateHash, at } });
      });
      return { action: 'dismiss', itemIds: rows.map((row) => row.id), at };
    });
  }

  /** Marks the older ordinary note as superseded by the newer one with a permanent `supersedes` connection. Both texts stay. */
  supersede(input: { newer: FreshnessRef; older: FreshnessRef }): FreshnessReceipt {
    if (!isObject(input)) throw invalid('Choose the newer and the older note.');
    const [newer, older] = parsePair([input.newer, input.older]);
    return this.ctx.tx((): FreshnessReceipt => {
      const newerRow = this.reviewable(newer.id);
      const olderRow = this.reviewable(older.id);
      if (newerRow.type !== 'note' || olderRow.type !== 'note') throw invalid('Only ordinary notes can be superseded. Mark links and files as checked instead.');
      const state = freshnessOf(olderRow);
      if (state.supersededBy === newerRow.id && repeated(state, 'supersede', older.stateHash)) {
        return { action: 'supersede', itemIds: [newerRow.id, olderRow.id], at: state.lastReview!.at };
      }
      if (state.supersededBy || freshnessOf(newerRow).supersededBy) throw invalid('One of these notes is already superseded. Review the newer note instead.');
      if (this.stateHash(newerRow.id) !== newer.stateHash || this.stateHash(olderRow.id) !== older.stateHash) throw staleReview();
      const at = this.ctx.now();
      this.items.relate(newerRow.id, olderRow.id, 'supersedes');
      this.setFreshness(this.items.row(olderRow.id), {
        ...state, supersededBy: newerRow.id, supersededAt: at, lastReview: { action: 'supersede', base: older.stateHash, at },
      });
      return { action: 'supersede', itemIds: [newerRow.id, olderRow.id], at };
    });
  }

  private describe(row: ItemRow, definition: WatchDefinition): WatchedSource {
    const folder = definition.kind === 'folder' ? this.folderState(row.id) : null;
    const queue = this.queueState(row.id);
    const project = definition.project
      ? this.ctx.get<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ?`, definition.project) ?? null
      : null;
    return {
      id: row.id, name: row.title, kind: definition.kind, url: definition.url, project: project ? { id: project.id, name: project.name } : null, enabled: definition.enabled,
      hash: this.hash(row.id, definition, folder),
      folder: definition.kind === 'folder' ? { approved: !!folder, available: !!folder && available(folder) } : null,
      lastCheck: queue.check, pending: queue.candidates.length, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private definition(id: string): { row: ItemRow; definition: WatchDefinition } {
    const row = this.items.row(id);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    const definition = parseDefinition(metadata.watchedSource);
    if (row.type !== 'note' || row.archived_at !== null || metadata.knowledgeDefinition !== true || metadata.secret === true || !definition) {
      throw notFound(`No watched source with id "${id}". List watched sources to find it.`);
    }
    return { row, definition };
  }

  private urlFor(kind: WatchKind, value: unknown): string | null {
    if (kind === 'folder') {
      if (value !== undefined && value !== null) throw invalid('A folder watch has no URL. Approve its folder on the library’s computer.');
      return null;
    }
    const raw = text(value, 'The URL', 2048);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw invalid(`"${raw}" is not a valid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('Only http and https sources can be watched.');
    if (url.username || url.password) throw invalid('Watched URLs can’t contain a user name or password.');
    if (url.href.length > 2048) throw invalid('That URL is longer than 2048 characters once encoded. Use a shorter address for the page or feed.');
    return url.href;
  }

  private hash(id: string, definition: WatchDefinition, folder: FolderState | null): string {
    return digest({ id, kind: definition.kind, url: definition.url, project: definition.project, approval: folder?.approvalId ?? null });
  }

  /**
   * The newest item this watch produced for the key, else an unclaimed bookmark for `adoptUrl`. Only URL watches adopt, since
   * they fetch the whole page; a feed's summary must never replace an article the person saved.
   */
  private target(watchId: string, key: string, adoptUrl: string | null): ItemRow | null {
    const targetId = this.queueState(watchId).targets[key];
    if (targetId) {
      const target = this.ctx.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE i.id = ? AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0`, targetId);
      if (target) return target;
    }
    const claimed = this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE json_extract(metadata, '$.watchedFrom.watchId') = ? AND json_extract(metadata, '$.watchedFrom.key') = ?
       AND coalesce(json_extract(metadata, '$.secret'), 0) = 0 ORDER BY seq DESC LIMIT 1`,
      watchId, key,
    );
    if (claimed) return this.items.row(claimed.id);
    if (!adoptUrl) return null;
    const bookmark = this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE type = 'bookmark' AND url = ? AND archived_at IS NULL AND json_extract(metadata, '$.watchedFrom') IS NULL
       AND coalesce(json_extract(metadata, '$.secret'), 0) = 0 ORDER BY seq LIMIT 1`,
      adoptUrl,
    );
    return bookmark ? this.items.row(bookmark.id) : null;
  }

  private content(id: string): string {
    return this.ctx.get<{ content: string }>(`SELECT content FROM items WHERE id = ?`, id)!.content;
  }

  private mark(id: string, from: WatchedFrom): void {
    const row = this.items.row(id);
    const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), watchedFrom: from };
    this.items.write(row, { metadata: JSON.stringify(metadata) }, 'watch', { watchedFrom: from }, false);
  }

  // Opening an item or delivering its reminder is bookkeeping, so it doesn't make a preview stale.
  private stateHash(id: string): string {
    const state = readItemState(this.ctx, id);
    const relations = this.ctx.all<{ from_id: string; to_id: string; kind: string }>(
      `SELECT from_id, to_id, kind FROM relations WHERE from_id = ? OR to_id = ? ORDER BY from_id, to_id, kind`, id, id,
    );
    return digest({ state: state && { ...state, item: { ...state.item, opened_at: null, reminded_at: null } }, relations });
  }

  private freshnessItem(row: ItemRow & { content: string }): FreshnessItem {
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    const state = freshnessOf(row);
    const full = [row.body, row.content].filter((part) => part.trim()).join('\n\n');
    const excerpt = clip(full, SOURCE_LIMITS.excerpt);
    return {
      id: row.id, type: row.type, title: row.title, url: row.url, excerpt, truncated: excerpt.length < full.length,
      dates: {
        publishedAt: isoOrNull(metadata.publishedAt), capturedAt: row.created_at, editedAt: row.updated_at, checkedAt: isoOrNull(state.checkedAt),
      },
      stateHash: this.stateHash(row.id),
      dismissed: state.dismissed ?? [],
    };
  }

  private reviewable(id: string): ItemRow {
    const row = this.items.row(id);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (row.type === 'decision') throw invalid('Decisions are append-only. Record a new decision that supersedes this one instead.');
    const template = this.ctx.get(
      `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND (json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1)`,
      JSON.stringify(pathToRoot(this.ctx, row.id)),
    );
    if (row.archived_at !== null || metadata.secret === true || metadata.savedView != null || metadata.conversation != null
      || metadata.knowledgeDefinition === true || template || !(INFO_TYPES as readonly string[]).includes(row.type)) {
      throw invalid('Only active, ordinary notes, links and files take part in freshness review. Secret notes, saved conversations, definitions and templates are left out.');
    }
    return row;
  }

  private setFreshness(row: ItemRow, state: FreshnessState): void {
    const metadata = { ...(JSON.parse(row.metadata) as ItemMetadata), freshness: state };
    this.items.write(row, { metadata: JSON.stringify(metadata) }, 'freshness', { freshness: state }, false);
  }

  private libraryRoots(): string[] {
    return [...new Set([dirname(this.ctx.attachmentsDir!), defaultHome()].map(realOrSelf))];
  }

  private folderState(id: string): FolderState | null {
    return this.setting<FolderState>(folderKey(id));
  }

  private queueState(id: string): QueueState {
    return this.setting<QueueState>(queueKey(id)) ?? { check: null, candidates: [], applied: [], targets: {} };
  }

  private saveQueue(id: string, state: QueueState): SourceQueue {
    this.setSetting(queueKey(id), state);
    return { watchId: id, check: state.check, candidates: state.candidates };
  }

  private clearQueue(id: string): void {
    const state = this.queueState(id);
    this.setSetting(queueKey(id), { check: null, candidates: [], applied: state.applied, targets: state.targets });
  }

  private setting<T>(key: string): T | null {
    const row = this.ctx.get<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setSetting(key: string, value: unknown): void {
    if (value === null) this.ctx.run(`DELETE FROM settings WHERE key = ?`, key);
    else this.ctx.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
  }
}

const folderKey = (id: string) => `sources.folder.${id}`;
const queueKey = (id: string) => `sources.queue.${id}`;

function parseDefinition(value: unknown): WatchDefinition | null {
  if (!isObject(value) || value.version !== 1 || !(WATCH_KINDS as readonly unknown[]).includes(value.kind) || typeof value.enabled !== 'boolean') return null;
  if (value.kind === 'folder' ? value.url !== null : typeof value.url !== 'string') return null;
  if (value.project !== null && typeof value.project !== 'string') return null;
  return { version: 1, kind: value.kind as WatchKind, url: value.url as string | null, project: value.project as string | null, enabled: value.enabled };
}

function parseObservation(raw: unknown): SourceObservation {
  if (!isObject(raw)) throw invalid('Each checked entry must be an object.');
  const key = text(raw.key, 'The entry key', 2048);
  const title = typeof raw.title === 'string' ? clip(raw.title.replace(/\s+/g, ' ').trim(), 500) : '';
  let url: string | null = null;
  if (raw.url !== undefined && raw.url !== null) {
    try {
      const parsed = new URL(text(raw.url, 'The entry URL', 2048));
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.href.length <= 2048) url = parsed.href;
    } catch {}
  }
  if (typeof raw.text !== 'string') throw invalid('Each checked entry needs its text.');
  return { key, title: title || url || key, url, text: raw.text, publishedAt: isoOrNull(raw.publishedAt), truncated: raw.truncated === true };
}

function keepIds(previous: SourceCandidate[], next: Omit<SourceCandidate, 'id'>[]): SourceCandidate[] {
  return next.map((candidate) => {
    const same = previous.find((old) => old.key === candidate.key && old.fingerprint === candidate.fingerprint
      && old.sourceHash === candidate.sourceHash && old.targetId === candidate.targetId && old.targetHash === candidate.targetHash);
    return { ...candidate, id: same?.id ?? newId(), checkedAt: same?.checkedAt ?? candidate.checkedAt };
  });
}

/**
 * Opens without following a symbolic link and checks the open file, so a swapped name can't redirect the read.
 * `decide` sees size and modification time: true reads, false skips reading, null defers the file to a later check.
 */
function readFolderFile(root: string, name: string, decide: (size: number, mtimeMs: number) => boolean | null): FolderFile | 'deferred' | null {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') return null;
  let fd: number;
  try {
    fd = openSync(join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > SOURCE_LIMITS.fileBytes) return null;
    const read = decide(stat.size, stat.mtimeMs);
    if (read === null) return 'deferred';
    if (!read) return { size: stat.size, mtimeMs: stat.mtimeMs, data: null };
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs, data };
  } catch {
    // A disk error mid-read leaves the file unreadable this time, like one that disappeared.
    return null;
  } finally {
    closeSync(fd);
  }
}

function available(folder: FolderState): boolean {
  try {
    const stat = lstatSync(folder.path);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync.native(folder.path) === folder.path;
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function watchedFrom(row: Pick<ItemRow, 'metadata'>): WatchedFrom | null {
  const value = (JSON.parse(row.metadata) as ItemMetadata).watchedFrom;
  return isObject(value) && value.version === 1 ? (value as unknown as WatchedFrom) : null;
}

function freshnessOf(row: Pick<ItemRow, 'metadata'>): FreshnessState {
  const value = (JSON.parse(row.metadata) as ItemMetadata).freshness;
  return isObject(value) && value.version === 1 ? (value as unknown as FreshnessState) : { version: 1 };
}

const repeated = (state: FreshnessState, action: FreshnessAction, base: string) => state.lastReview?.action === action && state.lastReview.base === base;

function parseRef(value: unknown): FreshnessRef {
  if (!isObject(value)) throw invalid('Choose a reviewed item with its state hash.');
  return { id: text(value.id, 'The item', 100), stateHash: text(value.stateHash, 'The state hash', 64) };
}

function parsePair(value: unknown): [FreshnessRef, FreshnessRef] {
  if (!Array.isArray(value) || value.length !== 2) throw invalid('Choose exactly two reviewed items.');
  const pair = [parseRef(value[0]), parseRef(value[1])] as [FreshnessRef, FreshnessRef];
  if (pair[0].id === pair[1].id) throw invalid('Choose two different items.');
  return pair;
}

function emptyCheck(at: string, status: SourceCheck['status'], error: string): SourceCheck {
  return { at, status, found: 0, queued: 0, unchanged: 0, skipped: 0, truncated: false, error };
}

function fieldsOf(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw invalid(`The ${label} must be an object.`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} field "${unknown}". Expected: ${allowed.join(', ')}.`);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(`${label} needs between 1 and ${max} characters.`);
  return value.trim();
}

const optional = (value: unknown, label: string, max: number): string | null => value === undefined || value === null ? null : text(value, label, max);

function flag(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${label} must be true or false.`);
  return value;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Cuts at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const stalePreview = (detail: string) => new MemoryError('conflict', `${detail} Nothing was imported. Check the source again and review the fresh preview.`);
const staleReview = () => new MemoryError('conflict', 'These items changed since they were reviewed. Review them again.');
