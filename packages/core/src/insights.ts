import { createHash } from 'node:crypto';
import type { Context } from './context.ts';
import type { EditorService } from './editor.ts';
import { MemoryError, invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import { descendants, pathToRoot } from './placement.ts';
import { referencedIds } from './references.ts';
import type { EditorActionResult, EditorCommand, ItemMetadata, ItemType } from './types.ts';
import { readItemState } from './versions.ts';

export interface KnowledgeSuggestion {
  id: string;
  title: string;
  snippet: string;
  reason: string;
  /** 0 to 1; higher is a stronger suggestion. */
  score: number;
}

/** `scanned` of `total` candidates were compared, newest first. */
export interface ItemInsights {
  itemId: string;
  mentions: KnowledgeSuggestion[];
  related: KnowledgeSuggestion[];
  duplicates: KnowledgeSuggestion[];
  scanned: number;
  total: number;
}

/** The target as it would read after the merge. Children move under it; attachments stay on the archived source. */
export interface MergePreview {
  title: string;
  body: string;
  movedChildren: number;
  retainedAttachments: number;
}

export interface MergeProposal {
  sourceId: string;
  targetId: string;
  baseHash: string;
  sourceTitle: string;
  targetTitle: string;
  preview: MergePreview;
}

interface DocRow {
  id: string;
  type: ItemType;
  title: string;
  body: string;
  content: string;
  url: string | null;
}

interface Doc {
  row: DocRow;
  text: string;
  folded: string;
  title: string;
  terms: Map<string, number>;
}

/** A suggestion before ranking; snippets are quoted only for the suggestions returned. */
interface Candidate {
  doc: Doc;
  reason: string;
  score: number;
  quote?: { text: string; phrase: string };
}

const MAX_SCAN = 1000;
const MAX_SUGGESTIONS = 10;
const MAX_BRANCH = 500;
const BODY_SCAN = 8000;
const CONTENT_SCAN = 4000;
const SNIPPET_RADIUS = 80;
const EXCERPT = 160;
const TITLE_WEIGHT = 3;
const MAX_TITLE_WORDS = 12;
const MIN_RELATED = 0.15;
const MIN_SHARED_TERMS = 2;
const MIN_DUPLICATE = 0.6;
const MIN_DUPLICATE_WORDS = 3;

const TEMPLATE_MEMBERS = `WITH RECURSIVE template_members(id) AS (
  SELECT id FROM items WHERE json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1
  UNION SELECT c.id FROM items c JOIN template_members m ON c.parent_id = m.id
)`;
const DISCOVERABLE = `i.type != 'decision' AND i.archived_at IS NULL AND coalesce(json_extract(i.metadata, '$.secret'), 0) = 0
  AND json_extract(i.metadata, '$.savedView') IS NULL AND json_extract(i.metadata, '$.conversation') IS NULL AND coalesce(json_extract(i.metadata, '$.knowledgeDefinition'), 0) = 0
  AND i.id NOT IN (SELECT id FROM template_members)`;
const DOC_COLUMNS = `i.id, i.type, i.title, substr(i.body, 1, ${BODY_SCAN}) AS body, substr(coalesce(i.content, ''), 1, ${CONTENT_SCAN}) AS content, i.url`;

// Common words and generic labels never make a title worth matching, or two notes related.
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'like', 'may', 'me', 'more', 'my', 'no', 'not', 'now', 'of', 'on', 'one', 'or', 'our', 'out', 'over', 'she', 'should',
  'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'draft', 'idea', 'ideas', 'inbox', 'list', 'misc', 'new', 'note', 'notes', 'page', 'secret', 'stuff', 'thing', 'things', 'todo',
  'untitled',
]);

/** Deterministic, keyword-only connection suggestions and reviewed merges of duplicate notes. No model is involved. */
export class InsightService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly editor: EditorService;

  constructor(ctx: Context, items: ItemService, editor: EditorService) {
    this.ctx = ctx;
    this.items = items;
    this.editor = editor;
  }

  forItem(id: string): ItemInsights {
    const subject = toDoc(this.subject(id));
    const { total } = this.ctx.get<{ total: number }>(
      `${TEMPLATE_MEMBERS} SELECT count(*) AS total FROM items i WHERE ${DISCOVERABLE} AND i.id != ?`, subject.row.id,
    )!;
    const docs = this.ctx
      .all<DocRow>(
        `${TEMPLATE_MEMBERS} SELECT ${DOC_COLUMNS} FROM items i WHERE ${DISCOVERABLE} AND i.id != ?
         ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
        subject.row.id, MAX_SCAN,
      )
      .map(toDoc);
    const linked = this.linked(subject.row.id);
    const unlinked = docs.filter((doc) => !linked.has(doc.row.id));

    const found = new Map<string, Candidate>();
    const mention = (candidate: Candidate) => {
      if ((found.get(candidate.doc.row.id)?.score ?? 0) < candidate.score) found.set(candidate.doc.row.id, candidate);
    };
    if (mentionable(subject.title)) {
      for (const doc of unlinked) {
        const count = occurrences(doc.folded, subject.title);
        if (count) {
          mention({
            doc, quote: { text: doc.text, phrase: subject.title }, score: score(count / (count + 1)),
            reason: `Mentions “${subject.row.title.trim()}” without a link`,
          });
        }
      }
    }
    for (const doc of unlinked) {
      if (doc.title === subject.title || !mentionable(doc.title)) continue;
      const count = occurrences(subject.folded, doc.title);
      if (count) {
        mention({
          doc, quote: { text: subject.text, phrase: doc.title }, score: score(count / (count + 1)),
          reason: `This ${NOUNS[subject.row.type]} mentions “${doc.row.title.trim()}” without a link`,
        });
      }
    }
    const mentions = suggestions([...found.values()]);

    const near: Candidate[] = [];
    const own = subject.row.type === 'note' ? shingles(subject) : null;
    if (own) {
      for (const doc of docs) {
        const theirs = doc.row.type === 'note' ? shingles(doc) : null;
        if (!theirs) continue;
        const overlap = jaccard(own, theirs);
        if (overlap < MIN_DUPLICATE) continue;
        const percent = `${Math.round(overlap * 100)}% of the same wording`;
        near.push({
          doc, score: score(overlap),
          reason: doc.title === subject.title && subject.title ? `Same title and ${percent}` : `Nearly the same note: ${percent}`,
        });
      }
    }
    const duplicates = suggestions(near);

    const shown = new Set([...mentions, ...duplicates].map((suggestion) => suggestion.id));
    const df = new Map<string, number>();
    for (const doc of [subject, ...docs]) for (const term of doc.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    const weigh = (terms: Map<string, number>) => {
      const vector = new Map([...terms].map(([term, tf]) => [term, (1 + Math.log(tf)) * Math.log(1 + (docs.length + 1) / df.get(term)!)]));
      return { vector, norm: Math.sqrt([...vector.values()].reduce((sum, weight) => sum + weight * weight, 0)) };
    };
    const mine = weigh(subject.terms);
    const related: Candidate[] = [];
    for (const doc of unlinked) {
      if (shown.has(doc.row.id) || mine.norm === 0) continue;
      const theirs = weigh(doc.terms);
      const shared = [...mine.vector.keys()]
        .filter((term) => theirs.vector.has(term))
        .map((term) => ({ term, weight: mine.vector.get(term)! * theirs.vector.get(term)! }))
        .sort((a, b) => b.weight - a.weight || (a.term < b.term ? -1 : 1));
      if (shared.length < MIN_SHARED_TERMS || theirs.norm === 0) continue;
      const similarity = shared.reduce((sum, { weight }) => sum + weight, 0) / (mine.norm * theirs.norm);
      if (!(similarity >= MIN_RELATED)) continue;
      related.push({ doc, score: score(similarity), reason: `Shares ${shared.slice(0, 3).map(({ term }) => `“${term}”`).join(', ')}` });
    }

    return { itemId: subject.row.id, mentions, related: suggestions(related), duplicates, scanned: docs.length, total };
  }

  /** Read-only: describes the merge and binds it to the current state of both notes and everything under them. */
  previewMerge(sourceId: string, targetId: string): MergeProposal {
    return this.proposal(sourceId, targetId);
  }

  /** One editor action, so `editor.undo` restores both notes, the children and the source's place together. */
  merge(proposal: MergeProposal): EditorActionResult {
    if (!isObject(proposal) || typeof proposal.sourceId !== 'string' || typeof proposal.targetId !== 'string' || typeof proposal.baseHash !== 'string') {
      throw invalid('That isn’t a merge proposal. Preview the merge again.');
    }
    return this.ctx.tx(() => {
      const live = this.proposal(proposal.sourceId, proposal.targetId);
      if (live.baseHash !== proposal.baseHash) {
        throw new MemoryError('conflict', 'One of these notes, or something inside them, changed since the merge was previewed. Preview it again.');
      }
      const target = this.ctx.get<{ parent_id: string | null; sort_order: number }>(
        `SELECT parent_id, sort_order FROM items WHERE id = ?`, live.targetId,
      )!;
      // The editor merges a note into the one just before it, so the source first lands right after the target.
      const following = this.ctx.get<{ id: string }>(
        `SELECT id FROM items WHERE parent_id IS ? AND archived_at IS NULL AND id != ? AND (sort_order, id) > (?, ?) ORDER BY sort_order, id LIMIT 1`,
        target.parent_id, live.sourceId, target.sort_order, live.targetId,
      )?.id ?? null;
      const commands: EditorCommand[] = [
        { op: 'move', id: live.sourceId, parentId: target.parent_id, beforeId: following },
        { op: 'merge', id: live.sourceId, previousId: live.targetId },
      ];
      // Merging two notes with the same title would otherwise repeat it.
      if (live.preview.title !== joined(live.targetTitle, live.sourceTitle, ' ').trim()) commands.push({ op: 'update', id: live.targetId, title: live.preview.title });
      return this.editor.apply(commands, { automations: false });
    });
  }

  private proposal(sourceId: unknown, targetId: unknown): MergeProposal {
    const source = this.mergeable(sourceId, 'source');
    const target = this.mergeable(targetId, 'target');
    if (source.id === target.id) throw invalid('Choose two different notes to merge.');
    if (pathToRoot(this.ctx, target.id).includes(source.id)) {
      throw invalid('The target is inside the note being merged. Merge them the other way round, or move the target out first.');
    }
    if (this.size(source.id) + this.size(target.id) > MAX_BRANCH) {
      throw invalid(`Merging these notes would touch more than ${MAX_BRANCH} items, counting what is nested under them. Merge smaller branches.`);
    }
    const sourceTree = [source.id, ...descendants(this.ctx, source.id)];
    const targetTree = [target.id, ...descendants(this.ctx, target.id)];
    const secret = this.ctx.get(
      `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(metadata, '$.secret') = 1`,
      JSON.stringify([...sourceTree, ...targetTree]),
    );
    if (secret) throw invalid('One of these notes holds a secret note, which merging never reads or moves. Move the secret note out first.');
    const duplicateTitle = target.title.trim() !== '' && fold(source.title) === fold(target.title);
    const { movedChildren } = this.ctx.get<{ movedChildren: number }>(`SELECT count(*) AS movedChildren FROM items WHERE parent_id = ?`, source.id)!;
    const { retainedAttachments } = this.ctx.get<{ retainedAttachments: number }>(
      `SELECT count(*) AS retainedAttachments FROM attachments WHERE item_id = ?`, source.id,
    )!;
    return {
      sourceId: source.id,
      targetId: target.id,
      baseHash: digest({ sourceId: source.id, targetId: target.id, source: this.states(sourceTree), target: this.states(targetTree) }),
      sourceTitle: source.title,
      targetTitle: target.title,
      preview: {
        title: duplicateTitle ? target.title.trim() : joined(target.title, source.title, ' ').trim(),
        body: joined(target.body, source.body, '\n\n').trim(),
        movedChildren,
        retainedAttachments,
      },
    };
  }

  private mergeable(id: unknown, role: 'source' | 'target') {
    if (typeof id !== 'string' || !id) throw invalid(`The merge ${role} must be an item id.`);
    const row = this.items.row(id);
    const { parent_id } = this.ctx.get<{ parent_id: string | null }>(`SELECT parent_id FROM items WHERE id = ?`, row.id)!;
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (row.type !== 'note' || row.archived_at !== null || metadata.secret === true || metadata.savedView != null
      || metadata.conversation != null || metadata.knowledgeDefinition === true || inTemplate(this.ctx, row.id)) {
      throw invalid('Only active, ordinary notes can be merged. Decisions, tasks, links, files, secret notes, saved conversations, saved views and templates can’t.');
    }
    if (parent_id !== null) {
      const parent = this.ctx.get<{ archived_at: string | null }>(`SELECT archived_at FROM items WHERE id = ?`, parent_id);
      if (!parent || parent.archived_at !== null) throw invalid(`The ${role} sits under an archived or missing note. Unarchive it, or move the ${role} first.`);
    }
    return { id: row.id, title: row.title, body: row.body, parent_id };
  }

  private subject(id: string): DocRow {
    const row = this.items.row(id);
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (row.archived_at !== null || row.type === 'decision' || metadata.secret === true || metadata.savedView != null
      || metadata.conversation != null || metadata.knowledgeDefinition === true || inTemplate(this.ctx, row.id)) {
      throw invalid('Connections are suggested only for active, ordinary items. Decisions, secret notes, saved conversations, saved views and templates are left out.');
    }
    return this.ctx.get<DocRow>(`SELECT ${DOC_COLUMNS} FROM items i WHERE i.id = ?`, row.id)!;
  }

  /** Explicit connections, inline references either way, and the item's own parent and children. */
  private linked(id: string): Set<string> {
    const { body, parent_id } = this.ctx.get<{ body: string; parent_id: string | null }>(`SELECT body, parent_id FROM items WHERE id = ?`, id)!;
    const ids = this.ctx.all<{ id: string }>(
      `SELECT to_id AS id FROM relations WHERE from_id = ? UNION SELECT from_id FROM relations WHERE to_id = ?
       UNION SELECT id FROM items WHERE parent_id = ?`,
      id, id, id,
    ).map((row) => row.id);
    const incoming = this.ctx
      .all<{ id: string; body: string }>(`SELECT id, body FROM items WHERE id != ? AND instr(body, ?) > 0`, id, `[[item:${id}`)
      .filter((row) => referencedIds(row.body).includes(id))
      .map((row) => row.id);
    return new Set([...ids, ...incoming, ...referencedIds(body), ...(parent_id === null ? [] : [parent_id])]);
  }

  private size(rootId: string): number {
    return this.ctx.get<{ n: number }>(
      `WITH RECURSIVE branch(id) AS (SELECT ? UNION SELECT c.id FROM items c JOIN branch b ON c.parent_id = b.id)
       SELECT count(*) AS n FROM (SELECT id FROM branch LIMIT ?)`,
      rootId, MAX_BRANCH + 1,
    )!.n;
  }

  // Opening an item or delivering its reminder is bookkeeping, so it doesn't make a preview stale.
  private states(ids: string[]) {
    return ids.map((id) => {
      const state = readItemState(this.ctx, id);
      return state && { ...state, item: { ...state.item, opened_at: null, reminded_at: null } };
    });
  }
}

const NOUNS: Record<ItemType, string> = { note: 'note', bookmark: 'link', task: 'task', decision: 'decision', file: 'file', image: 'image' };

function toDoc(row: DocRow): Doc {
  const text = [row.body, row.content].filter((part) => part.trim()).join('\n');
  const title = fold(row.title);
  const folded = fold(text);
  const terms = new Map<string, number>();
  const count = (words: string, weight: number) => {
    for (const word of words.split(' ')) {
      const term = stem(word);
      if (term.length < 3 || STOPWORDS.has(word) || STOPWORDS.has(term)) continue;
      terms.set(term, (terms.get(term) ?? 0) + weight);
    }
  };
  count(title, TITLE_WEIGHT);
  count(folded, 1);
  return { row, text, folded, title, terms };
}

/** Case, accents and punctuation are ignored; words are separated by single spaces. */
const fold = (text: string) => foldUnit(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const foldUnit = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');

/** `fold`, plus where each folded character came from, for quoting the original text. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let index = 0;
  for (const char of text) {
    for (const unit of foldUnit(char)) {
      if (/[\p{L}\p{N}]/u.test(unit)) {
        folded += unit;
        for (let i = 0; i < unit.length; i++) map.push(index);
      } else if (folded && !folded.endsWith(' ')) {
        folded += ' ';
        map.push(index);
      }
    }
    index += char.length;
  }
  if (folded.endsWith(' ')) {
    folded = folded.slice(0, -1);
    map.pop();
  }
  return { folded, map };
}

function mentionable(title: string): boolean {
  const words = title.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_TITLE_WORDS) return false;
  if (words.every((word) => STOPWORDS.has(word) || /^\p{N}+$/u.test(word))) return false;
  return words.length > 1 || words[0]!.length >= 4;
}

function occurrences(folded: string, phrase: string): number {
  const haystack = ` ${folded} `;
  const needle = ` ${phrase} `;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length - 1)) count++;
  return count;
}

function snippetAround(text: string, phrase: string): string {
  const { folded, map } = foldWithMap(text);
  const at = Math.max(0, ` ${folded} `.indexOf(` ${phrase} `));
  const position = map[at] ?? 0;
  let start = Math.max(0, position - SNIPPET_RADIUS);
  let end = Math.min(text.length, position + phrase.length + SNIPPET_RADIUS);
  if (isLowSurrogate(text.charCodeAt(start))) start--;
  if (isLowSurrogate(text.charCodeAt(end))) end++;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function excerpt(doc: Doc): string {
  const text = (doc.text || doc.row.url || '').replace(/\s+/g, ' ').trim();
  return [...text].length > EXCERPT ? `${[...text].slice(0, EXCERPT).join('').trimEnd()}…` : text;
}

/** Plural endings only, so a shared word reads as the word. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:oes|xes|ches|shes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Word pairs of the title and text; too little text to compare is never called a duplicate. */
function shingles(doc: Doc): Set<string> | null {
  const words = `${doc.title} ${doc.folded}`.split(' ').filter(Boolean);
  if (words.length < MIN_DUPLICATE_WORDS) return null;
  return new Set(words.slice(1).map((word, i) => `${words[i]} ${word}`));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
}

// The sort is stable, so equal scores keep the scan's newest-first order.
const suggestions = (candidates: Candidate[]): KnowledgeSuggestion[] => candidates
  .sort((a, b) => b.score - a.score)
  .slice(0, MAX_SUGGESTIONS)
  .map(({ doc, reason, score: value, quote }) => ({
    id: doc.row.id, title: doc.row.title, snippet: quote ? snippetAround(quote.text, quote.phrase) : excerpt(doc), reason, score: value,
  }));
const score = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const joined = (a: string, b: string, separator: string) => [a, b].filter((part) => part.trim()).join(separator);
const inTemplate = (ctx: Context, id: string) => ctx.get(
  `SELECT 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) AND (json_extract(metadata, '$.template') IS NOT NULL OR coalesce(json_extract(metadata, '$.knowledgeDefinition'), 0) = 1)`,
  JSON.stringify(pathToRoot(ctx, id)),
) !== undefined;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
