import type { Collection, CollectionRow, CollectionRowsPage, PropertyField, PropertyValue } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { TYPE_LABELS, displayTitle } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, TypeIcon, useDraft, useFeedback } from '../ui.tsx';
import { LiveStatus, knowledgePath, plural, useKnowledge } from './KnowledgeCommon.tsx';

const PAGE = 50;
const KANBAN_PAGE = 25;
/** Core's largest page. */
const MAX_ROWS = 200;
const UNSET = '__unset';

const setValue = (collectionId: string, itemId: string, fieldId: string, value: PropertyValue | null) =>
  knowledgeRequest(`/collections/${encodeURIComponent(collectionId)}/values`, 'POST', { itemId, values: { [fieldId]: value } });

/** One field of one row, edited with a native control. Typed text is kept while the library refreshes underneath it. */
function ValueEditor({ collectionId, row, field }: { collectionId: string; row: CollectionRow; field: PropertyField }) {
  const { toast } = useFeedback();
  const value = row.values[field.id];
  const text = useDraft(value === undefined || typeof value === 'boolean' ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const label = `${field.name} for ${displayTitle(row.item)}`;

  const commit = (next: PropertyValue | null) => {
    setSaving(true);
    setValue(collectionId, row.item.id, field.id, next)
      .catch((error: unknown) => {
        toast(errorMessage(error), 'error');
        text.reset();
      })
      .finally(() => setSaving(false));
  };
  const commitText = () => {
    if (!text.dirty) return;
    const draft = text.draft.trim();
    if (field.type === 'number') {
      if (draft && !Number.isFinite(Number(draft))) {
        toast(`${field.name} needs a number.`, 'error');
        text.reset();
        return;
      }
      commit(draft ? Number(draft) : null);
      return;
    }
    commit(draft || null);
  };
  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    else if (event.key === 'Escape' && text.dirty) {
      event.stopPropagation();
      text.reset();
    }
  };

  switch (field.type) {
    case 'checkbox':
      return <input type="checkbox" aria-label={label} disabled={saving} checked={value === true} onChange={(event) => commit(event.target.checked)} />;
    case 'select':
      return (
        <select aria-label={label} disabled={saving} value={typeof value === 'string' ? value : ''} onChange={(event) => commit(event.target.value || null)}>
          <option value="">—</option>
          {field.options!.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      );
    case 'date':
      return <input type="date" aria-label={label} disabled={saving} value={typeof value === 'string' ? value : ''} onChange={(event) => commit(event.target.value || null)} />;
    case 'number':
      return <input type="number" step="any" aria-label={label} disabled={saving} value={text.draft} onChange={(event) => text.setDraft(event.target.value)} onBlur={commitText} onKeyDown={onKey} />;
    case 'text':
      return <input aria-label={label} maxLength={2000} disabled={saving} value={text.draft} onChange={(event) => text.setDraft(event.target.value)} onBlur={commitText} onKeyDown={onKey} />;
  }
}

function RowTitle({ row }: { row: CollectionRow }) {
  const { openItem } = useApp();
  return (
    <button className="link-button collection-title" onClick={() => openItem(row.item.id)} title={`Open ${TYPE_LABELS[row.item.type].toLowerCase()}`}>
      <TypeIcon type={row.item.type} size={14} /> {displayTitle(row.item)}
    </button>
  );
}

function Coverage({ page, range = true }: { page: CollectionRowsPage; range?: boolean }) {
  const first = page.offset + 1;
  const last = page.offset + page.rows.length;
  return (
    <p className="muted small" role="status">
      {!page.total ? 'No rows match.' : range ? `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${plural(page.total, 'match', 'matches')}.` : `${plural(page.total, 'match', 'matches')}.`}{' '}
      Checked the {plural(page.evaluated, 'most recently changed item')} of {plural(page.matched, 'item')} in scope.
      {page.capped && <strong className="warning"> Older items aren’t included; narrow the scope with a project, type or keywords to cover them.</strong>}
    </p>
  );
}

function Pager({ page, onOffset }: { page: CollectionRowsPage; onOffset: (offset: number) => void }) {
  if (page.offset === 0 && page.next === null) return null;
  return (
    <div className="inline-actions load-more">
      <button className="button small" disabled={page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>Previous</button>
      <button className="button small" disabled={page.next === null} onClick={() => page.next !== null && onOffset(page.next)}>Next</button>
    </div>
  );
}

function usePage(collection: Collection, offset: number, limit: number, group?: string) {
  return useKnowledge<CollectionRowsPage>(knowledgePath(`/collections/${encodeURIComponent(collection.id)}/rows`, { offset, limit, group }));
}

/** A page of rows that returns to the first page when edits elsewhere leave the current one empty. */
function usePagedRows(collection: Collection) {
  const [offset, setOffset] = useState(0);
  const page = usePage(collection, offset, PAGE);
  useEffect(() => {
    if (page.data && !page.data.rows.length && offset > 0) setOffset(0);
  }, [page.data, offset]);
  return { page, setOffset };
}

export function CollectionTable({ collection }: { collection: Collection }) {
  const { page, setOffset } = usePagedRows(collection);
  return (
    <>
      <LiveStatus live={page} label="Loading rows…" />
      {page.data && <Coverage page={page.data} />}
      {page.data?.rows.length === 0 && <Empty title="No rows">Change the collection’s scope or filters, or save items that match it.</Empty>}
      {page.data && page.data.rows.length > 0 && (
        <div className="collection-table-wrap">
          <table className="collection-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                {collection.fields.map((field) => <th key={field.id} scope="col">{field.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {page.data.rows.map((row) => (
                <tr key={row.item.id}>
                  <th scope="row"><RowTitle row={row} /></th>
                  {collection.fields.map((field) => <td key={field.id}><ValueEditor collectionId={collection.id} row={row} field={field} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.data && <Pager page={page.data} onOffset={setOffset} />}
    </>
  );
}

export function CollectionCards({ collection }: { collection: Collection }) {
  const { page, setOffset } = usePagedRows(collection);
  return (
    <>
      <LiveStatus live={page} label="Loading rows…" />
      {page.data && <Coverage page={page.data} />}
      {page.data?.rows.length === 0 && <Empty title="No rows">Change the collection’s scope or filters, or save items that match it.</Empty>}
      <ul className="collection-cards">
        {(page.data?.rows ?? []).map((row) => (
          <li key={row.item.id} className="knowledge-card">
            <RowTitle row={row} />
            {collection.fields.map((field) => (
              <label key={field.id} className="field inline collection-card-field">
                <span>{field.name}</span>
                <ValueEditor collectionId={collection.id} row={row} field={field} />
              </label>
            ))}
          </li>
        ))}
      </ul>
      {page.data && <Pager page={page.data} onOffset={setOffset} />}
    </>
  );
}

/** One column per option of the grouping field, plus rows without a value. Moving a card is an explicit choice on that card. */
export function CollectionKanban({ collection }: { collection: Collection }) {
  const field = collection.fields.find((f) => f.id === collection.groupBy);
  const summary = usePage(collection, 0, 1);
  if (!field) return <p className="error-text" role="alert">Choose a select field to group by.</p>;
  return (
    <>
      <LiveStatus live={summary} label="Loading columns…" />
      {summary.data && <Coverage page={summary.data} range={false} />}
      {summary.data?.groups && (
        <div className="kanban" role="list" aria-label={`${collection.name} by ${field.name}`}>
          {summary.data.groups.map((group) => (
            <KanbanColumn key={group.option ?? UNSET} collection={collection} field={field} option={group.option} name={group.name} count={group.count} />
          ))}
        </div>
      )}
    </>
  );
}

function KanbanColumn({ collection, field, option, name, count }: { collection: Collection; field: PropertyField; option: string | null; name: string; count: number }) {
  const { toast } = useFeedback();
  const [limit, setLimit] = useState(KANBAN_PAGE);
  const [moving, setMoving] = useState<string | null>(null);
  const page = usePage(collection, 0, limit, option ?? UNSET);
  const move = (row: CollectionRow, target: string) => {
    setMoving(row.item.id);
    setValue(collection.id, row.item.id, field.id, target || null)
      .catch((error: unknown) => toast(errorMessage(error), 'error'))
      .finally(() => setMoving(null));
  };
  return (
    <section className="kanban-column" role="listitem" aria-label={`${name}, ${plural(count, 'card')}`}>
      <h3>{name} <span className="count">{count}</span></h3>
      {page.error && <p className="error-text small" role="alert">{page.error.message}</p>}
      <ul>
        {(page.data?.rows ?? []).map((row) => (
          <li key={row.item.id} className="kanban-card">
            <RowTitle row={row} />
            <label className="field inline">
              <span>{field.name}</span>
              <select aria-label={`Move ${displayTitle(row.item)} to`} disabled={moving === row.item.id} value={option ?? ''} onChange={(event) => move(row, event.target.value)}>
                <option value="">—</option>
                {field.options!.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          </li>
        ))}
      </ul>
      {page.data && page.data.next !== null && (limit < MAX_ROWS ? (
        <button className="button small ghost" onClick={() => setLimit(Math.min(MAX_ROWS, limit + KANBAN_PAGE))}>Show more</button>
      ) : <p className="muted small">Showing the first {MAX_ROWS}. Add a filter to see the rest.</p>)}
    </section>
  );
}
