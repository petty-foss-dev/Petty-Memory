import type { Context } from './context.ts';
import { invalid } from './errors.ts';
import { type ItemService, isSecret } from './items.ts';
import type { ProjectService } from './projects.ts';
import type { LibraryPage, RelationKind } from './types.ts';

const DEFAULT_PAGE = 200;
const MAX_PAGE = 500;

/** Read-only ordinary states for offline clients; protected items become cache evictions. */
export class FeedService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  get revision(): number {
    return this.ctx.get<{ seq: number }>(`SELECT coalesce(max(seq), 0) AS seq FROM changes`)!.seq;
  }

  /** `limit` counts changes consumed, so a page stays bounded however the changes group by entity. */
  page(cursor = 0, limit = DEFAULT_PAGE): LibraryPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw invalid('Cursor must be a non-negative integer.');
    if (!Number.isInteger(limit) || limit < 1) throw invalid('Limit must be a positive integer.');
    const latest = this.revision;
    // A cursor past the log means this library was restored from a backup: the client starts its replica over.
    const reset = cursor > latest;
    const from = reset ? 0 : cursor;
    const end = this.ctx.get<{ seq: number }>(
      `SELECT seq FROM changes WHERE seq > ? ORDER BY seq LIMIT 1 OFFSET ?`, from, Math.min(limit, MAX_PAGE) - 1,
    )?.seq ?? latest;
    const page: LibraryPage = {
      deviceId: this.ctx.deviceId, cursor: end, hasMore: end < latest, reset,
      items: [], deletedItemIds: [], projects: [], deletedProjectIds: [], relations: [], deletedRelationIds: [],
    };
    const changed = this.ctx.all<{ entity: string; entity_id: string }>(
      `SELECT entity, entity_id FROM changes WHERE seq > ? AND seq <= ? GROUP BY entity, entity_id ORDER BY max(seq)`, from, end,
    );
    for (const { entity, entity_id: id } of changed) {
      if (entity === 'item') {
        const row = this.ctx.get<{ parent_id: string | null; sort_order: number; metadata: string }>(
          `SELECT parent_id, sort_order, metadata FROM items WHERE id = ?`, id,
        );
        if (!row || isSecret(row)) page.deletedItemIds.push(id);
        else page.items.push({ item: this.items.get(id), parentId: row.parent_id, position: row.sort_order });
      } else if (entity === 'project') {
        if (this.ctx.get(`SELECT 1 FROM projects WHERE id = ?`, id)) page.projects.push(this.projects.resolve(id));
        else page.deletedProjectIds.push(id);
      } else {
        const relation = this.ctx.get<{ id: string; from_id: string; to_id: string; kind: RelationKind }>(
          `SELECT r.id, r.from_id, r.to_id, r.kind FROM relations r
           JOIN items f ON f.id = r.from_id JOIN items t ON t.id = r.to_id
           WHERE r.id = ? AND coalesce(json_extract(f.metadata, '$.secret'), 0) = 0 AND coalesce(json_extract(t.metadata, '$.secret'), 0) = 0`,
          id,
        );
        if (relation) page.relations.push({ id: relation.id, fromId: relation.from_id, toId: relation.to_id, kind: relation.kind });
        else page.deletedRelationIds.push(id);
      }
    }
    return page;
  }
}
