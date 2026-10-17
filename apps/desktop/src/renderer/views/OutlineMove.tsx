import type { OutlineEntry, OutlinePage, SearchHit } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { applyEdit } from '../lib/edits.ts';
import { displayTitle, firstLine } from '../lib/format.ts';
import { canHoldChildren } from '../lib/outline.ts';
import { Icon, TypeIcon } from '../ui.tsx';

/** Core's MAX_LIMIT. */
const MAX_PAGE = 200;
const PICKER_PAGE = 50;
const SEARCH_PAGE = 20;

/** The first `want` children of a parent, in as many core-sized pages as that takes. */
export async function loadChildren(parentId: string | null, want: number, includeArchived = false): Promise<OutlinePage> {
  const items: OutlineEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await call('outline.children', parentId, { offset, limit: Math.min(MAX_PAGE, want - offset), includeArchived });
    offset += page.items.length;
    // A write between pages can shift offsets by one; the next refresh settles it.
    for (const entry of page.items) {
      if (!seen.has(entry.item.id)) items.push(entry);
      seen.add(entry.item.id);
    }
    if (page.items.length === 0 || offset >= Math.min(want, page.total)) return { items, total: page.total };
  }
}

interface Place {
  id: string;
  title: string;
}

export interface Moved {
  parentId: string | null;
  title: string;
}

const hitTitle = (hit: SearchHit) => hit.title || hit.url || firstLine(hit.preview, 80) || 'Untitled';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Picks a new parent by browsing the outline or searching. Moves to the end of the chosen parent's notes. */
export function MoveDialog({ entry, onClose }: { entry: OutlineEntry; onClose: (moved: Moved | null) => void }) {
  const self = entry.item;
  const name = displayTitle(self);
  const [path, setPath] = useState<Place[]>([]);
  const [want, setWant] = useState(PICKER_PAGE);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitLimit, setHitLimit] = useState(SEARCH_PAGE);
  const [moreHits, setMoreHits] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // Once a move is sent the dialog stays until it answers, so a late reply can't close something else.
  const locked = useRef(false);
  const cancel = () => {
    if (!locked.current) onClose(null);
  };
  const here = path.at(-1) ?? null;
  const location = here?.id ?? null;
  const list = useLive(async () => ({ location, page: await loadChildren(location, want) }), [location, want]);
  const page = list.data?.location === location ? list.data.page : null;
  const candidates = (page?.items ?? []).filter((e) => e.item.id !== self.id && canHoldChildren(e, self));
  const already = location === entry.parentId;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => () => {
    if (opener?.isConnected) opener.focus();
  }, [opener]);

  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  useEffect(() => {
    const text = query.trim();
    const id = ++request.current;
    if (!text) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      call('search.hybrid', text, {}, hitLimit).then(
        (result) => {
          if (id !== request.current) return;
          setHits(result.filter((hit) => hit.type !== 'decision' && hit.id !== self.id));
          setMoreHits(result.length === hitLimit && hitLimit < MAX_PAGE);
        },
        (err: unknown) => id === request.current && setError(errorMessage(err)),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [query, self.id, hitLimit]);

  const goTo = (next: Place[]) => {
    setPath(next);
    setWant(PICKER_PAGE);
    setError(null);
  };

  const jump = async (hit: SearchHit) => {
    try {
      const ancestors = await call('outline.ancestors', hit.id);
      if (ancestors.some((a) => a.id === self.id)) {
        setError(`“${hitTitle(hit)}” is inside “${name}”, so it can’t hold it.`);
        return;
      }
      goTo([...ancestors.map((a) => ({ id: a.id, title: displayTitle(a) })), { id: hit.id, title: hitTitle(hit) }]);
      setQuery('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const move = () => {
    if (locked.current) return;
    locked.current = true;
    setSaving(true);
    setError(null);
    applyEdit([{ op: 'move', id: self.id, parentId: location, beforeId: null }]).then(
      () => onClose({ parentId: location, title: here?.title ?? '' }),
      (err: unknown) => {
        locked.current = false;
        setError(errorMessage(err));
        setSaving(false);
      },
    );
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div className="dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-title" aria-busy={saving} ref={dialog} onKeyDown={trapTab}>
        <h2 id="move-title">Move “{name}”</h2>
        <p className="muted small">
          {entry.childCount === 1 && 'The note inside it moves too. '}
          {entry.childCount > 1 && `The ${entry.childCount} notes inside it move too. `}
          It goes to the end of the place you pick.
        </p>
        <input
          type="search"
          autoFocus
          aria-label="Find a note to move it into"
          placeholder="Find a note…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHitLimit(SEARCH_PAGE);
          }}
        />
        {query.trim() ? (
          <ul className="move-list" aria-label="Matching notes">
            {hits?.map((hit) => (
              <li key={hit.id}>
                <button onClick={() => void jump(hit)}>
                  <TypeIcon type={hit.type} size={15} />
                  <span className="move-name">{hitTitle(hit)}</span>
                  <Icon name="chevron" size={14} />
                </button>
              </li>
            ))}
            {hits?.length === 0 && <li className="move-status muted">No matching notes.</li>}
            {moreHits && (
              <li className="move-status">
                <button className="button small" onClick={() => setHitLimit(Math.min(MAX_PAGE, hitLimit + SEARCH_PAGE))}>Show more matches</button>
              </li>
            )}
          </ul>
        ) : (
          <>
            <nav className="crumbs" aria-label="Location">
              <ol>
                <li>
                  <button className="link-button" aria-current={here ? undefined : 'location'} onClick={() => goTo([])}>Top level</button>
                </li>
                {path.map((place, index) => (
                  <li key={place.id}>
                    <button className="link-button" aria-current={index === path.length - 1 ? 'location' : undefined} onClick={() => goTo(path.slice(0, index + 1))}>
                      {place.title}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <ul className="move-list" aria-label={here ? `Inside ${here.title}` : 'Top level'}>
              {candidates.map((candidate) => (
                <li key={candidate.item.id}>
                  <button onClick={() => goTo([...path, { id: candidate.item.id, title: displayTitle(candidate.item) }])}>
                    <TypeIcon type={candidate.item.type} size={15} />
                    <span className="move-name">{displayTitle(candidate.item)}</span>
                    {candidate.childCount > 0 && <span className="muted small">{candidate.childCount} inside</span>}
                    <Icon name="chevron" size={14} />
                  </button>
                </li>
              ))}
              {list.error && (
                <li className="move-status">
                  <span className="error-text">{list.error.message}</span>
                  <button className="button small" onClick={list.reload}>Try again</button>
                </li>
              )}
              {!page && !list.error && <li className="move-status muted">Loading…</li>}
              {page && candidates.length === 0 && (
                <li className="move-status muted">{here ? 'Nothing inside yet.' : 'Nothing else at the top level.'}</li>
              )}
              {page && page.items.length < page.total && (
                <li className="move-status">
                  <button className="button small" onClick={() => setWant(want + PICKER_PAGE)}>Show more</button>
                </li>
              )}
            </ul>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button ghost" disabled={saving} onClick={cancel}>Cancel</button>
          <button className="button primary" disabled={saving || already} onClick={move}>
            {already ? 'Already here' : here ? 'Move here' : 'Move to the top level'}
          </button>
        </div>
      </div>
    </div>
  );
}
