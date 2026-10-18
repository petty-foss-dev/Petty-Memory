import type { Collection, CollectionLayout } from '@enve-memory/core';
import { useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { TYPE_LABELS } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, useFeedback } from '../ui.tsx';
import { BUILT_IN_SORT_LABELS, CollectionForm, SortFilterDialog } from './CollectionsForm.tsx';
import { CollectionCards, CollectionKanban, CollectionTable } from './CollectionsRows.tsx';
import { LiveStatus, plural, useKnowledge } from './KnowledgeCommon.tsx';

const LAYOUTS: { layout: CollectionLayout; label: string }[] = [
  { layout: 'table', label: 'Table' },
  { layout: 'cards', label: 'Cards' },
  { layout: 'kanban', label: 'Kanban' },
];

/** Collections: typed fields on ordinary items, shown as a table, cards or a Kanban board. */
export function Collections() {
  const { toast } = useFeedback();
  const list = useKnowledge<Collection[]>('/collections');
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const collections = list.data ?? [];
  const selected = collections.find((collection) => collection.id === chosen) ?? collections[0];

  return (
    <section className="knowledge-section" aria-labelledby="collections-heading">
      <div className="panel-header">
        <h2 id="collections-heading">Collections</h2>
        <button className="button primary small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New collection</button>
      </div>
      <p className="note">
        Give items your own fields, like Status, Rating or Due date, and see them as a table, cards or a board. Values are saved on the items
        themselves, so they keep their history and travel with exports and sync.
      </p>
      <LiveStatus live={list} />
      {list.data?.length === 0 && <Empty title="No collections yet">Make one for a reading list, a project tracker or anything you sort by status.</Empty>}
      {collections.length > 0 && (
        <nav className="chips workflow-tabs" aria-label="Collections">
          {collections.map((collection) => (
            <button
              key={collection.id}
              className={`chip ${collection.id === selected?.id ? 'active' : ''}`}
              aria-current={collection.id === selected?.id ? 'page' : undefined}
              onClick={() => setChosen(collection.id)}
            >
              {collection.name}
            </button>
          ))}
        </nav>
      )}
      {selected && <CollectionView key={selected.id} collection={selected} />}
      {creating && (
        <CollectionForm
          collection={null}
          onClose={(saved) => {
            setCreating(false);
            if (saved) {
              setChosen(saved.id);
              toast('Collection saved');
            }
          }}
        />
      )}
    </section>
  );
}

function describeScope(collection: Collection, projectName: (id: string) => string): string {
  const { project, query, type } = collection.scope;
  const parts = [
    type ? `${TYPE_LABELS[type]}s` : 'Items',
    ...(project ? [`in ${projectName(project)}`] : []),
    ...(query ? [`matching “${query}”`] : []),
  ];
  return parts.join(' ');
}

function CollectionView({ collection }: { collection: Collection }) {
  const { projects } = useApp();
  const { toast, confirm } = useFeedback();
  const [dialog, setDialog] = useState<'edit' | 'sort' | null>(null);
  const [saving, setSaving] = useState(false);
  const selects = collection.fields.filter((field) => field.type === 'select');
  const fieldName = (id: string) => BUILT_IN_SORT_LABELS[id] ?? collection.fields.find((field) => field.id === id)?.name ?? 'a removed field';
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'an archived project';

  const save = (patch: { layout?: CollectionLayout; groupBy?: string | null }) => {
    setSaving(true);
    knowledgeRequest('/collections', 'POST', { id: collection.id, ...patch })
      .catch((error: unknown) => toast(errorMessage(error), 'error'))
      .finally(() => setSaving(false));
  };

  const chooseLayout = (layout: CollectionLayout) => {
    if (layout === collection.layout) return;
    save(layout === 'kanban' ? { layout, groupBy: collection.groupBy ?? selects[0]!.id } : { layout });
  };

  const archive = async () => {
    if (!(await confirm({
      title: 'Remove this collection?',
      body: <p>“{collection.name}” is archived as a note and can be restored. Field values stay on the items, and come back if you restore it.</p>,
      confirmLabel: 'Remove collection',
      danger: true,
    }))) return;
    knowledgeRequest(`/collections/${encodeURIComponent(collection.id)}`, 'DELETE').then(() => toast('Collection removed'), (error: unknown) => toast(errorMessage(error), 'error'));
  };

  return (
    <section className="workflow-view" aria-label={collection.name}>
      <div className="panel-header">
        <h3 className="collection-name">{collection.name}</h3>
        <div className="inline-actions">
          <button className="button small" onClick={() => setDialog('sort')}><Icon name="filter" size={14} /> Sort and filter…</button>
          <button className="button small" onClick={() => setDialog('edit')}>Edit fields…</button>
          <button className="button small danger-ghost" onClick={() => void archive()}><Icon name="archive" size={14} /> Remove…</button>
        </div>
      </div>
      <div className="chips" aria-label="Collection settings">
        <span className="chip">{describeScope(collection, projectName)}</span>
        <span className="chip">{plural(collection.fields.length, 'field')}</span>
        {collection.sort.map((rule) => <span key={rule.field} className="chip">Sorted by {fieldName(rule.field)} {rule.direction === 'asc' ? '↑' : '↓'}</span>)}
        {collection.filters.length > 0 && <span className="chip">{plural(collection.filters.length, 'filter')}</span>}
      </div>
      <div className="toolbar collection-toolbar">
        <div className="segmented small" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map(({ layout, label }) => {
            const blocked = layout === 'kanban' && !selects.length;
            return (
              <button
                key={layout}
                role="radio"
                aria-checked={collection.layout === layout}
                className={collection.layout === layout ? 'active' : ''}
                disabled={saving || blocked}
                title={blocked ? 'Add a select field to show a Kanban board' : undefined}
                onClick={() => chooseLayout(layout)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {collection.layout === 'kanban' && (
          <label className="field inline collection-group">
            <span>Columns from</span>
            <select value={collection.groupBy ?? ''} disabled={saving} onChange={(event) => save({ groupBy: event.target.value })}>
              {selects.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </label>
        )}
        {collection.fields.length === 0 && (
          <span className="muted small">Add fields to start filling in values. <button className="link-button" onClick={() => setDialog('edit')}>Add fields</button></span>
        )}
      </div>
      {collection.layout === 'table' && <CollectionTable collection={collection} />}
      {collection.layout === 'cards' && <CollectionCards collection={collection} />}
      {collection.layout === 'kanban' && <CollectionKanban key={collection.groupBy} collection={collection} />}
      {dialog === 'edit' && (
        <CollectionForm
          collection={collection}
          onClose={(saved) => {
            setDialog(null);
            if (saved) toast('Collection updated');
          }}
        />
      )}
      {dialog === 'sort' && (
        <SortFilterDialog
          collection={collection}
          onClose={(saved) => {
            setDialog(null);
            if (saved) toast('Sort and filters saved');
          }}
        />
      )}
    </section>
  );
}
