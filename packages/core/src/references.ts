import type { Context } from './context.ts';
import { invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import type { ItemDetail, ItemType, RelatedItem } from './types.ts';

/** `[[item:<uuid>]]` or `[[item:<uuid>|label]]`: identity is stable, the label is only what the writer saw. */
export const REFERENCE_PATTERN = /\[\[item:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([^\]\n]*))?\]\]/g;

export function referencedIds(text: string): string[] {
  return [...new Set([...text.matchAll(REFERENCE_PATTERN)].map((m) => m[1]!))];
}

/** Inline references inside item text, and the backlinks derived from them. Explicit connections stay in relations. */
export class ReferenceService {
  private readonly ctx: Context;
  private readonly items: ItemService;

  constructor(ctx: Context, items: ItemService) {
    this.ctx = ctx;
    this.items = items;
  }

  /** Appends a reference to `toId` on a new line of `fromId`'s text. */
  insert(fromId: string, toId: string, label?: string): ItemDetail {
    const from = this.items.row(fromId);
    const to = this.items.row(toId);
    if (from.id === to.id) throw invalid('An item can’t reference itself.');
    const clean = (label ?? '').replace(/[\]|\n\r]+/g, ' ').trim();
    const token = `[[item:${to.id}${clean ? `|${clean}` : ''}]]`;
    return this.items.update(from.id, { body: from.body ? `${from.body}\n${token}` : token });
  }

  /** Targets that no longer exist are left out; the text still holds their reference. */
  list(id: string): { outgoing: RelatedItem[]; incoming: RelatedItem[] } {
    const row = this.items.row(id);
    const outgoing = referencedIds(row.body).flatMap((target) => {
      const item = this.ctx.get<{ id: string; type: ItemType; title: string }>(`SELECT id, type, title FROM items WHERE id = ?`, target);
      return item ? [{ kind: 'references' as const, direction: 'outgoing' as const, ...item }] : [];
    });
    const incoming = this.ctx
      .all<{ id: string; type: ItemType; title: string; body: string }>(
        `SELECT id, type, title, body FROM items WHERE id != ? AND instr(body, ?) > 0 ORDER BY updated_at DESC`, row.id, `[[item:${row.id}`,
      )
      .filter((source) => referencedIds(source.body).includes(row.id))
      .map(({ id: from, type, title }) => ({ kind: 'references' as const, direction: 'incoming' as const, id: from, type, title }));
    return { outgoing, incoming };
  }
}
