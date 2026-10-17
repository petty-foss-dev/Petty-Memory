import type { DatabaseSync } from 'node:sqlite';
import { ActivityService } from './activity.ts';
import { BackupService } from './backups.ts';
import { ClientService } from './clients.ts';
import { FileService } from './files.ts';
import { Context } from './context.ts';
import { IN_MEMORY, openDatabase, schemaVersion } from './db.ts';
import { DecisionService } from './decisions.ts';
import { EditorService } from './editor.ts';
import { EmbeddingService } from './embeddings.ts';
import { ExportService } from './export.ts';
import { FeedService } from './feed.ts';
import { ItemService, MAX_LIMIT } from './items.ts';
import { OrganizerService } from './organizer.ts';
import { OutlineService } from './outline.ts';
import { type MemoryPaths, defaultHome, pathsFor } from './paths.ts';
import { ProjectService, captureMemoryVersions } from './projects.ts';
import { SearchService } from './search.ts';
import { RuleService } from './rules.ts';
import { SettingsService } from './settings.ts';
import { SyncService } from './sync.ts';
import { TaskService } from './tasks.ts';
import { EditService } from './edits.ts';
import { PresentationService } from './presentation.ts';
import { ReferenceService } from './references.ts';
import { ShareService } from './shares.ts';
import { VaultService } from './vault.ts';
import { VersionService, captureVersions } from './versions.ts';
import { TemplateService, ViewService } from './workflows.ts';
import { type Graph, ITEM_TYPES, type ItemType, type ProjectBriefing, type RelationKind } from './types.ts';

export interface OpenOptions {
  /** Library folder. Defaults to the platform data directory (or $ENVE_MEMORY_HOME). */
  home?: string;
  /** Opens a throwaway in-memory library; for tests. */
  inMemory?: boolean;
  /** Who is making changes, recorded on every write: `cli`, `mcp:claude-code`, `desktop`… */
  actor: string;
}

/** The one entry point every client (CLI, MCP, HTTP API, desktop UI) goes through. */
export class EnveMemory {
  readonly paths: MemoryPaths | null;
  readonly projects: ProjectService;
  readonly settings: SettingsService;
  readonly items: ItemService;
  readonly outline: OutlineService;
  readonly tasks: TaskService;
  readonly decisions: DecisionService;
  readonly embeddings: EmbeddingService;
  readonly search: SearchService;
  readonly activity: ActivityService;
  readonly clients: ClientService;
  readonly backups: BackupService;
  readonly exports: ExportService;
  readonly sync: SyncService;
  readonly rules: RuleService;
  readonly files: FileService;
  readonly presentation: PresentationService;
  readonly versions: VersionService;
  readonly references: ReferenceService;
  readonly edits: EditService;
  readonly vault: VaultService;
  readonly shares: ShareService;
  readonly editor: EditorService;
  readonly feed: FeedService;
  readonly views: ViewService;
  readonly templates: TemplateService;
  readonly organizer: OrganizerService;
  private readonly db: DatabaseSync;
  private readonly ctx: Context;

  static open(options: OpenOptions): EnveMemory {
    if (options.inMemory) return new EnveMemory(openDatabase(IN_MEMORY), null, options.actor);
    const paths = pathsFor(options.home ?? defaultHome());
    return new EnveMemory(openDatabase(paths.database, { backupDir: paths.backups }), paths, options.actor);
  }

  private constructor(db: DatabaseSync, paths: MemoryPaths | null, actor: string) {
    this.db = db;
    this.paths = paths;
    this.ctx = new Context(db, actor, paths?.attachments ?? null);
    this.projects = new ProjectService(this.ctx);
    this.settings = new SettingsService(this.ctx);
    this.items = new ItemService(this.ctx, this.projects, this.settings);
    this.outline = new OutlineService(this.ctx, this.items);
    this.tasks = new TaskService(this.ctx, this.items, this.projects);
    this.decisions = new DecisionService(this.ctx, this.items, this.projects);
    this.embeddings = new EmbeddingService(this.ctx);
    this.search = new SearchService(this.ctx, this.items, this.embeddings);
    this.activity = new ActivityService(this.ctx, this.projects);
    this.clients = new ClientService(this.ctx);
    this.backups = new BackupService(this.ctx, paths);
    this.exports = new ExportService(this.ctx, this.items, this.projects, this.decisions);
    this.sync = new SyncService(this.ctx, this.items, this.settings);
    this.rules = new RuleService(this.ctx, this.items, this.projects);
    this.items.afterSave = (id) => this.rules.apply(id);
    this.files = new FileService(this.ctx, this.items);
    this.presentation = new PresentationService(this.ctx, this.items, this.tasks);
    this.versions = new VersionService(this.ctx);
    this.ctx.captureVersions = (items, projects) => {
      if (items.size) captureVersions(this.ctx, items);
      if (projects.size) captureMemoryVersions(this.ctx, projects);
    };
    this.references = new ReferenceService(this.ctx, this.items);
    this.edits = new EditService(this.ctx, this.items, this.outline, this.presentation, this.versions);
    this.vault = new VaultService(this.ctx, this.items, this.versions);
    this.shares = new ShareService(this.ctx, this.items);
    this.editor = new EditorService(this.ctx, this.items, this.outline, this.presentation);
    this.feed = new FeedService(this.ctx, this.items, this.projects);
    this.views = new ViewService(this.ctx, this.items, this.projects);
    this.templates = new TemplateService(this.ctx, this.items, this.projects);
    this.organizer = new OrganizerService(this.ctx, this.editor);
  }

  get actor(): string {
    return this.ctx.actor;
  }

  set actor(actor: string) {
    this.ctx.actor = actor;
  }

  /** Runs a synchronous write under a different actor, e.g. a background worker, then restores the current one. */
  withActor<T>(actor: string, fn: () => T): T {
    const previous = this.ctx.actor;
    this.ctx.actor = actor;
    try {
      return fn();
    } finally {
      this.ctx.actor = previous;
    }
  }

  get deviceId(): string {
    return this.ctx.deviceId;
  }

  /** Changes whenever another connection (an MCP server, the CLI) commits; poll it to notice outside edits. */
  get dataVersion(): number {
    return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  stats(): { projects: number; tags: number; tagNames: string[] } & Record<ItemType, number> {
    const counts = Object.fromEntries(ITEM_TYPES.map((type) => [type, 0])) as Record<ItemType, number>;
    for (const row of this.ctx.all<{ type: ItemType; n: number }>(`SELECT type, count(*) AS n FROM items GROUP BY type`)) {
      counts[row.type] = row.n;
    }
    const projects = this.ctx.get<{ n: number }>(`SELECT count(*) AS n FROM projects`)!.n;
    // Most-used first, so a capped list keeps the tags that matter.
    const tagNames = this.ctx
      .all<{ name: string }>(`SELECT t.name FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id GROUP BY t.id ORDER BY count(it.item_id) DESC, t.name`)
      .map((r) => r.name);
    return { projects, tags: tagNames.length, tagNames, ...counts };
  }

  /**
   * Items, projects and tags as a graph: explicit relations plus "in project" and "tagged" edges. Limited to the most
   * recently updated items (at most MAX_LIMIT) so a large library stays drawable.
   */
  graph({ project, limit }: { project?: string; limit?: number } = {}): Graph {
    const items = this.items.list({ project }, limit ?? MAX_LIMIT);
    const ids = new Set(items.map((i) => i.id));
    const nodes: Graph['nodes'] = items.map((i) => ({ id: i.id, kind: 'item', label: i.title || i.url || i.body.slice(0, 60) || i.type, type: i.type }));
    const edges: Graph['edges'] = [];
    const projectIds = new Set<string>();
    for (const item of items) {
      if (!item.project) continue;
      projectIds.add(item.project.id);
      edges.push({ from: item.id, to: item.project.id, kind: 'in_project' });
    }
    for (const p of this.projects.list()) if (projectIds.has(p.id)) nodes.push({ id: p.id, kind: 'project', label: p.name });
    if (ids.size) {
      const placeholders = [...ids].map(() => '?').join(', ');
      const tagged = this.ctx.all<{ item_id: string; name: string }>(
        `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id IN (${placeholders})`, ...ids,
      );
      for (const name of new Set(tagged.map((t) => t.name))) nodes.push({ id: `tag:${name}`, kind: 'tag', label: `#${name}` });
      for (const t of tagged) edges.push({ from: t.item_id, to: `tag:${t.name}`, kind: 'tagged' });
      const relations = this.ctx.all<{ from_id: string; to_id: string; kind: RelationKind }>(
        `SELECT from_id, to_id, kind FROM relations WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`, ...ids, ...ids,
      );
      for (const r of relations) edges.push({ from: r.from_id, to: r.to_id, kind: r.kind });
    }
    return { nodes, edges };
  }

  /** Everything an agent needs to pick up a project where the last one left off. */
  briefing(projectRef: string): ProjectBriefing {
    const project = this.projects.resolve(projectRef);
    return {
      project,
      decisions: this.decisions.list(project.id, 50),
      openTasks: this.tasks.list({ project: project.id }, 50),
      recentItems: this.items
        .list({ project: project.id }, 40)
        .filter((item) => item.type !== 'task' && item.type !== 'decision')
        .slice(0, 20),
    };
  }

  close(): void {
    this.vault.lock();
    this.db.close();
  }
}
