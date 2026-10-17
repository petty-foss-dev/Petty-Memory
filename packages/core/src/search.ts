import { type Context, ITEM_COLUMNS, ITEM_FROM, ITEM_JOINS, type ItemRow, toItem } from './context.ts';
import type { Embedder, EmbeddingService } from './embeddings.ts';
import { invalid } from './errors.ts';
import { type ItemFilter, type ItemService, clampLimit } from './items.ts';
import type { SearchHit } from './types.ts';

// bm25 column weights for (title, body, url, content): the user's own words outrank extracted source text.
const RANK = 'bm25(items_fts, 10.0, 1.5, 2.0, 1.0)';
// Reciprocal rank fusion constant; 60 is the value from the original RRF paper and is robust across corpora.
const RRF_K = 60;
const CANDIDATES = 50;
const SNIPPET_LENGTH = 220;

export class SearchService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly embeddings: EmbeddingService;
  embedder: Embedder | null = null;

  constructor(ctx: Context, items: ItemService, embeddings: EmbeddingService) {
    this.ctx = ctx;
    this.items = items;
    this.embeddings = embeddings;
  }

  /** Keyword search (FTS5 + bm25). */
  query(text: string, filter: ItemFilter = {}, limit?: number): SearchHit[] {
    const match = toFtsQuery(text);
    if (!match) throw invalid('Search needs at least one word or number.');
    const { where, params } = this.items.filterClauses(filter);
    return this.ctx
      .all<ItemRow & { snippet: string }>(
        `SELECT ${ITEM_COLUMNS}, snippet(items_fts, -1, char(1), char(2), '…', 24) AS snippet
         FROM items_fts JOIN items i ON i.seq = items_fts.rowid ${ITEM_JOINS}
         WHERE items_fts MATCH ? ${where.map((w) => `AND ${w}`).join(' ')}
         ORDER BY ${RANK}, i.updated_at DESC
         LIMIT ?`,
        match, ...params, clampLimit(limit ?? 20),
      )
      .map((row) => toHit(row, plainSnippet(row.snippet), 'keyword'));
  }

  /**
   * Keyword and meaning together: FTS5 and vector results fused by reciprocal rank, so an exact term match and a
   * paraphrase both surface. Falls back to keyword search when no embedder is attached or nothing is indexed yet.
   */
  async hybrid(text: string, filter: ItemFilter = {}, limit?: number): Promise<SearchHit[]> {
    const wanted = clampLimit(limit ?? 20);
    const hasTerms = toFtsQuery(text) !== null;
    if (!hasTerms) throw invalid('Search needs at least one word or number.');
    const keyword = this.query(text, filter, CANDIDATES);
    const embedder = this.embedder;
    if (!embedder || !this.embeddings.hasIndex(embedder.model)) return keyword.slice(0, wanted);

    const { where, params } = this.items.filterClauses(filter);
    const narrowed = where.length > (filter.includeArchived ? 0 : 1);
    const allowed = narrowed
      ? new Set(this.ctx.all<{ id: string }>(`SELECT i.id FROM items i WHERE ${where.join(' AND ')}`, ...params).map((r) => r.id))
      : undefined;
    const [vector] = await embedder.embed([text], 'query');
    const semantic = this.embeddings.nearest(embedder.model, vector!, CANDIDATES, allowed, embedder.minScore);

    const fused = new Map<string, { score: number; keyword?: SearchHit; chunk?: string }>();
    keyword.forEach((hit, rank) => fused.set(hit.id, { score: 1 / (RRF_K + rank + 1), keyword: hit }));
    semantic.forEach((hit, rank) => {
      const entry = fused.get(hit.itemId) ?? { score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.chunk = hit.chunk;
      fused.set(hit.itemId, entry);
    });
    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);

    // Vector hits carry only ids; load them with the same visibility rules (archived, filters) as keyword search.
    const semanticOnly = ranked.filter(([, e]) => !e.keyword).map(([id]) => id);
    const rows = new Map<string, ItemRow>();
    if (semanticOnly.length) {
      const visible = [...where, `i.id IN (${semanticOnly.map(() => '?').join(', ')})`];
      for (const row of this.ctx.all<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${visible.join(' AND ')}`, ...params, ...semanticOnly)) {
        rows.set(row.id, row);
      }
    }

    const hits: SearchHit[] = [];
    for (const [id, entry] of ranked) {
      if (entry.keyword) hits.push(entry.chunk ? { ...entry.keyword, match: 'both' } : entry.keyword);
      else if (rows.has(id)) hits.push(toHit(rows.get(id)!, excerpt(entry.chunk ?? ''), 'semantic'));
      if (hits.length === wanted) break;
    }
    return hits;
  }
}

function toHit(row: ItemRow, snippet: string, match: SearchHit['match']): SearchHit {
  const item = toItem(row);
  const preview = item.body.replace(/\s+/g, ' ').trim();
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    url: item.url,
    project: item.project,
    snippet,
    preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
    match,
    taskStatus: row.task_status,
    updatedAt: item.updatedAt,
  };
}

/**
 * Snippets come from stored Markdown; drop its syntax (headings, emphasis, link targets) so they read as text.
 * Matches are marked with control characters first, so they can't be mistaken for Markdown brackets, then shown as [match].
 */
function plainSnippet(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|[\s…])#{1,6}\s+/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\u0001/g, '[')
    .replace(/\u0002/g, ']')
    .trim();
}

const excerpt = (text: string) => {
  const flat = plainSnippet(text);
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat;
};

// Function words that match nearly everything; dropping them keeps natural-language questions from ranking on "the".
const STOPWORDS = new Set(
  ('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or '
    + 'our should so than that the their them then there these they this those to was we were what when where which who '
    + 'why will with would you your').split(' '),
);

/**
 * Free text → FTS5 query. Every term is quoted so user input can never be parsed as FTS syntax,
 * terms are OR'd so partial matches still surface (bm25 ranks fuller matches first), stopwords are
 * dropped unless they're all there is, and the last term is a prefix match so half-typed queries work.
 */
export function toFtsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const meaningful = words.filter((word) => !STOPWORDS.has(word));
  const terms = meaningful.length ? meaningful : words;
  if (terms.length === 0) return null;
  return terms.map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(' OR ');
}
