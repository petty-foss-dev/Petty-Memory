import type { Item, ItemFilter } from '@enve-memory/core';
import { type ReactNode, useState } from 'react';
import type { ItemPage } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { presentationOf } from '../lib/presentation.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, useFeedback } from '../ui.tsx';
import { ItemRow } from './ItemRow.tsx';

const PAGE = 50;
/** Core's MAX_LIMIT. */
const MAX_PAGE = 200;

/** Every item matching `filter`, newest first, a page at a time; loaded pages are re-read when the library changes. */
export function PagedItems({ filter, empty, actions }: { filter: ItemFilter; empty: ReactNode; actions?: (item: Item) => ReactNode }) {
  const { openItem } = useApp();
  const [want, setWant] = useState(PAGE);
  const list = useLive(async () => {
    const items: Item[] = [];
    let next: string | null = null;
    do {
      const page: ItemPage = await call('items.page', filter, next, Math.min(MAX_PAGE, want - items.length));
      items.push(...page.items);
      next = page.next;
    } while (next && items.length < want);
    return { items, more: next !== null };
  }, [JSON.stringify(filter), want]);
  if (list.error) return <p className="error-text">{list.error.message}</p>;
  if (!list.data) return <p className="muted small">Loading…</p>;
  if (!list.data.items.length) return <>{empty}</>;
  return (
    <>
      <div className="rows">
        {list.data.items.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem}>{actions?.(item)}</ItemRow>)}
      </div>
      {list.data.more && <button className="button small show-more" onClick={() => setWant(list.data!.items.length + PAGE)}>Show more</button>}
    </>
  );
}

function Group({ title, filter, empty, actions }: { title: string; filter: ItemFilter; empty: string; actions?: (item: Item) => ReactNode }) {
  return (
    <section className="task-group" aria-label={title}>
      <h2>{title}</h2>
      <PagedItems filter={filter} empty={<p className="muted small">{empty}</p>} actions={actions} />
    </section>
  );
}

const GROUPS: ItemFilter[] = [{ attention: 'high' }, { review: true }, { pinned: true }];

/** What deserves attention now: high-attention and review items, pins, and suggestions from links left unread. */
export function Highlights() {
  const { toast } = useFeedback();
  const any = useLive(() => Promise.all(GROUPS.map((filter) => call('items.list', filter, 1))), []);
  const suggested = useLive(async () => {
    const [revisit, unopened] = await Promise.all([call('shelves.list', 'revisit'), call('shelves.list', 'unopened')]);
    const seen = new Set<string>();
    return [...revisit, ...unopened]
      .filter((item) => !item.pinnedAt && presentationOf(item).attention !== 'high' && !seen.has(item.id) && seen.add(item.id))
      .slice(0, 12);
  }, []);
  const { openItem } = useApp();
  const fail = (error: unknown) => toast(errorMessage(error), 'error');
  const error = any.error ?? suggested.error;
  const nothing = any.data?.every((list) => list.length === 0) && suggested.data?.length === 0;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Highlights</h1>
        <p className="subtitle">What you marked as important or to review, what you pinned, and a few things worth another look.</p>
      </header>
      {error && <p className="error-text">{error.message}</p>}
      {nothing ? (
        <Empty title="Nothing highlighted yet">Set a note’s attention to High, mark it for review, or pin it, from its actions menu or details.</Empty>
      ) : (
        <>
          <Group title="High attention" filter={GROUPS[0]!} empty="Nothing set to high attention." />
          <Group title="Marked for review" filter={GROUPS[1]!} empty="Nothing waiting for review." actions={(item) => (
            <button className="button small" onClick={() => call('presentation.update', item.id, { review: false }).then(() => toast('Reviewed'), fail)}>
              <Icon name="check" size={14} /> Reviewed
            </button>
          )} />
          <Group title="Pinned" filter={GROUPS[2]!} empty="Nothing pinned." />
          <section className="task-group" aria-label="Suggested">
            <h2>Suggested</h2>
            {suggested.data?.length === 0 && <p className="muted small">No suggestions right now.</p>}
            <div className="rows">
              {(suggested.data ?? []).map((item) => (
                <ItemRow key={item.id} item={item} onOpen={openItem}>
                  <button className="button small" onClick={() => call('presentation.update', item.id, { attention: 'high' }).then(() => toast('Highlighted'), fail)}>
                    <Icon name="star" size={14} /> Highlight
                  </button>
                  <button className="button small" onClick={() => call('presentation.update', item.id, { review: true }).then(() => toast('Marked for review'), fail)}>
                    <Icon name="flag" size={14} /> Review
                  </button>
                </ItemRow>
              ))}
            </div>
          </section>
          <p className="muted small">Suggestions come from links you meant to revisit and ones saved a month ago that you never opened.</p>
        </>
      )}
    </div>
  );
}
