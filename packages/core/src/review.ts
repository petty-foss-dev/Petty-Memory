import { type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, toSummaryItem } from './context.ts';
import { invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import { pathToRoot } from './placement.ts';
import type { ProjectService } from './projects.ts';
import type { Item, ItemDetail, ItemMetadata } from './types.ts';

export interface ReviewCard {
  item: Item;
  dueAt: string | null;
  lastReviewedAt: string | null;
  reviewCount: number;
  reason: string;
}

export interface ReviewQueueOptions {
  limit?: number;
  project?: string;
}

/** `metadata.reviewSchedule`; the history keeps the most recent reviews only. */
export interface ReviewSchedule {
  version: 1;
  dueAt: string;
  lastReviewedAt: string;
  count: number;
  history: { at: string; days: number }[];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_DAYS = 3650;
const MAX_HISTORY = 50;
const DAY_MS = 86_400_000;
const REVIEWABLE: readonly string[] = ['note', 'bookmark', 'file', 'image'];

const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;
// Tasks, decisions, secrets, saved views, saved conversations and template branches are never knowledge to revisit.
const KNOWLEDGE = `i.type IN ('note', 'bookmark', 'file', 'image') AND i.archived_at IS NULL
  AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0 AND json_extract(i.metadata, '$.savedView') IS NULL
  AND json_extract(i.metadata, '$.conversation') IS NULL AND coalesce(json_extract(i.metadata, '$.knowledgeDefinition'), 0) = 0 AND i.id NOT IN (SELECT id FROM template_members)`;
// A due date another device wrote in any other shape counts as never scheduled.
const DUE = `CASE WHEN json_type(i.metadata, '$.reviewSchedule.dueAt') = 'text'
  AND json_extract(i.metadata, '$.reviewSchedule.dueAt') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  THEN json_extract(i.metadata, '$.reviewSchedule.dueAt') END`;
const IMPORTANT = `(i.pinned_at IS NOT NULL OR json_extract(i.metadata, '$.presentation.attention') = 'high'
  OR json_extract(i.metadata, '$.presentation.review') = 1)`;

type QueueRow = ItemRow & { due_at: string | null; tier: number };

/** Local, deterministic spaced review: due items oldest first, then unreviewed pinned or marked items, then the rest oldest first. */
export class ReviewService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  queue({ limit, project }: ReviewQueueOptions = {}): ReviewCard[] {
    const size = limit === undefined ? DEFAULT_LIMIT : limit;
    if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    const projectId = project === undefined ? null : this.projects.resolve(project).id;
    const rows = this.ctx.all<QueueRow>(
      `${TEMPLATE_MEMBERS} SELECT * FROM (
         SELECT ${ITEM_COLUMNS}, ${DUE} AS due_at, CASE WHEN ${DUE} IS NOT NULL THEN 0 WHEN ${IMPORTANT} THEN 1 ELSE 2 END AS tier
         FROM ${ITEM_FROM} WHERE ${KNOWLEDGE}${projectId === null ? '' : ' AND i.project_id = ?'}
       )
       WHERE due_at IS NULL OR due_at <= ?
       ORDER BY tier, due_at, pinned_at IS NULL, created_at, id LIMIT ?`,
      ...(projectId === null ? [] : [projectId]), this.ctx.now(), size,
    );
    const items = this.items.withTags(rows.map(toSummaryItem));
    return rows.map((row, index) => {
      const item = items[index]!;
      const { lastReviewedAt, count } = scheduleOf(item.metadata);
      return { item, dueAt: row.due_at, lastReviewedAt, reviewCount: count, reason: reason(row, item) };
    });
  }

  /** Records a review now and when to see the item again; other metadata is left as it was. */
  schedule(id: string, days: number): ItemDetail {
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw invalid(`days must be a whole number from 1 to ${MAX_DAYS}.`);
    return this.ctx.tx(() => {
      const row = this.reviewable(id);
      const metadata = JSON.parse(row.metadata) as ItemMetadata;
      const previous = scheduleOf(metadata);
      const now = this.ctx.now();
      const reviewSchedule: ReviewSchedule = {
        version: 1,
        dueAt: new Date(Date.parse(now) + days * DAY_MS).toISOString(),
        lastReviewedAt: now,
        count: previous.count + 1,
        history: [...previous.history, { at: now, days }].slice(-MAX_HISTORY),
      };
      this.items.write(row, { metadata: JSON.stringify({ ...metadata, reviewSchedule }) }, 'review', { reviewSchedule }, false);
      return this.items.get(row.id);
    });
  }

  private reviewable(id: string): ItemRow {
    const row = this.items.row(id);
    if (row.archived_at !== null) throw invalid('That item is archived. Unarchive it to review it again.');
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (!REVIEWABLE.includes(row.type) || metadata.secret === true || metadata.savedView != null || metadata.conversation != null || metadata.knowledgeDefinition === true
      || inTemplate(this.ctx, row.id)) {
      throw invalid('Only notes, links, files and images can be reviewed. Tasks, decisions, secret notes, saved conversations, saved views and templates stay out of review.');
    }
    return row;
  }
}

function reason(row: QueueRow, item: Item): string {
  if (row.tier === 0) return 'Due for review';
  if (row.tier === 2) return 'Not reviewed yet';
  if (item.pinnedAt !== null) return 'Pinned and not reviewed yet';
  return item.metadata.presentation?.attention === 'high' ? 'Marked important and not reviewed yet' : 'Marked for review and not reviewed yet';
}

/** Read leniently: a malformed schedule from another device starts over rather than blocking review. */
function scheduleOf(metadata: ItemMetadata): Pick<ReviewSchedule, 'count' | 'history'> & { lastReviewedAt: string | null } {
  const stored = metadata.reviewSchedule;
  if (!isObject(stored)) return { lastReviewedAt: null, count: 0, history: [] };
  return {
    lastReviewedAt: isTimestamp(stored.lastReviewedAt) ? stored.lastReviewedAt : null,
    count: Number.isSafeInteger(stored.count) && (stored.count as number) > 0 ? stored.count as number : 0,
    history: Array.isArray(stored.history)
      ? stored.history.filter((entry): entry is ReviewSchedule['history'][number] =>
        isObject(entry) && isTimestamp(entry.at) && Number.isInteger(entry.days) && (entry.days as number) >= 1 && (entry.days as number) <= MAX_DAYS)
      : [],
  };
}

const inTemplate = (ctx: Context, id: string) => ctx.get(
  `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND (json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1)`,
  JSON.stringify(pathToRoot(ctx, id)),
) !== undefined;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
