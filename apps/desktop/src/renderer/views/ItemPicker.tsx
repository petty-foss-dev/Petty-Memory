import type { ItemFilter, ItemType, SearchHit } from '@enve-memory/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { call, errorMessage } from '../lib/api.ts';
import { TYPE_LABELS, displayTitle, firstLine } from '../lib/format.ts';
import { Modal, TypeIcon } from '../ui.tsx';

export interface Picked {
  id: string;
  title: string;
  type: ItemType;
}

const hitTitle = (hit: SearchHit) => hit.title || hit.url || firstLine(hit.preview, 80) || 'Untitled';
const PAGE = 25;
/** Core's MAX_LIMIT: search ranks at most this many. */
const MAX_HITS = 200;

/** Finds one item by searching, or from the most recent ones. `footer` sits above the actions (e.g. a kind choice). */
export function ItemPicker({ title, exclude = [], filter = {}, footer, onPick, onClose }: {
  title: string;
  exclude?: string[];
  filter?: ItemFilter;
  footer?: ReactNode;
  onPick: (item: Picked) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Picked[] | null>(null);
  const [more, setMore] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  // Recent items page by cursor; search widens its ranked list up to core's limit.
  const load = (text: string, found: Picked[], cursor: string | null, limit: number) => {
    const id = ++request.current;
    const run: Promise<{ items: Picked[]; next: (() => void) | null }> = text
      ? call('search.hybrid', text, filter, limit).then((hits) => ({
        items: hits.map((hit) => ({ id: hit.id, title: hitTitle(hit), type: hit.type })),
        next: hits.length === limit && limit < MAX_HITS ? () => load(text, [], null, Math.min(MAX_HITS, limit + PAGE)) : null,
      }))
      : call('items.page', filter, cursor, PAGE).then((page) => {
        const items = [...found, ...page.items.map((item) => ({ id: item.id, title: displayTitle(item), type: item.type }))];
        const after = page.next;
        return { items, next: after ? () => load(text, items, after, PAGE) : null };
      });
    run.then(({ items, next }) => {
      if (id !== request.current) return;
      setResults(items.filter((item) => !exclude.includes(item.id)));
      setMore(() => next);
    }, (err: unknown) => id === request.current && setError(errorMessage(err)));
  };

  useEffect(() => {
    const text = query.trim();
    const timer = setTimeout(() => load(text, [], null, PAGE), text ? 120 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <Modal label={title} onClose={onClose} className="move-dialog">
      <h2>{title}</h2>
      <input type="search" autoFocus aria-label="Find an item" placeholder="Search your library…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ul className="move-list" aria-label={query.trim() ? 'Matching items' : 'Recent items'}>
        {results?.map((item) => (
          <li key={item.id}>
            <button onClick={() => onPick(item)}>
              <TypeIcon type={item.type} size={15} />
              <span className="move-name">{item.title}</span>
              <span className="muted small">{TYPE_LABELS[item.type]}</span>
            </button>
          </li>
        ))}
        {results?.length === 0 && <li className="move-status muted">Nothing found.</li>}
        {!results && !error && <li className="move-status muted">Loading…</li>}
        {results && more && (
          <li className="move-status">
            <button className="button small" onClick={more}>{query.trim() ? 'Show more matches' : 'Show older items'}</button>
          </li>
        )}
      </ul>
      {error && <p className="error-text" role="alert">{error}</p>}
      {footer}
      <div className="dialog-actions">
        <button className="button ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
