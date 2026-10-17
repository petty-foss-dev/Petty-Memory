import type { ItemDetail, RelatedItem } from '@enve-memory/core';
import { useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { useApp } from '../context.ts';
import { Icon, TypeIcon, useFeedback } from '../ui.tsx';
import { ItemPicker } from './ItemPicker.tsx';

/** Connections the user can add; `supersedes` belongs to decisions and is only made by recording one. */
const KINDS = [
  { kind: 'related_to', label: 'Related to' },
  { kind: 'references', label: 'Refers to' },
  { kind: 'depends_on', label: 'Depends on' },
  { kind: 'derived_from', label: 'Derived from' },
] as const;

export function relationLabel(kind: string, direction: 'outgoing' | 'incoming'): string {
  if (kind === 'supersedes') return direction === 'outgoing' ? 'supersedes' : 'superseded by';
  if (kind === 'depends_on') return direction === 'outgoing' ? 'depends on' : 'needed by';
  if (kind === 'derived_from') return direction === 'outgoing' ? 'derived from' : 'source of';
  if (kind === 'references') return direction === 'outgoing' ? 'refers to' : 'referred to by';
  return kind.replace('_', ' ');
}

export const useReferences = (id: string) => useLive(() => call('references.list', id), [id]);

export function ConnectionsSection({ item, backlinks }: { item: ItemDetail; backlinks: RelatedItem[] }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]['kind']>('related_to');
  const fail = (error: unknown) => toast(errorMessage(error), 'error');

  const remove = (relation: RelatedItem) => {
    const [from, to] = relation.direction === 'outgoing' ? [item.id, relation.id] : [relation.id, item.id];
    call('items.unrelate', from, to, relation.kind).then(() => toast('Connection removed'), fail);
  };

  return (
    <section className="detail-section">
      <div className="panel-header">
        <h2>Connections</h2>
        <button className="button small" onClick={() => setPicking(true)}><Icon name="plus" size={14} /> Connect…</button>
      </div>
      {item.relations.length === 0 && backlinks.length === 0 && <p className="muted small">Connect this to related notes, links or files. Inline references show up here too.</p>}
      {item.relations.length > 0 && (
        <ul className="mini-list">
          {item.relations.map((relation) => (
            <li key={`${relation.kind}-${relation.direction}-${relation.id}`} className="connection">
              <button onClick={() => openItem(relation.id)}>
                <span><TypeIcon type={relation.type} size={14} /> {relation.title || 'Untitled'}</span>
                <span className="muted small">{relationLabel(relation.kind, relation.direction)}</span>
              </button>
              {relation.kind !== 'supersedes' && (
                <button className="icon-button" aria-label={`Remove connection to ${relation.title || 'Untitled'}`} title="Remove connection" onClick={() => remove(relation)}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {backlinks.length > 0 && (
        <>
          <h3 className="small muted">Mentioned in</h3>
          <ul className="mini-list">
            {backlinks.map((link) => (
              <li key={link.id}>
                <button onClick={() => openItem(link.id)}>
                  <span><TypeIcon type={link.type} size={14} /> {link.title || 'Untitled'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {picking && (
        <ItemPicker
          title="Connect to…"
          exclude={[item.id]}
          footer={(
            <label className="field inline">
              <span>This item</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                {KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
              </select>
            </label>
          )}
          onClose={() => setPicking(false)}
          onPick={(target) => {
            setPicking(false);
            call('items.relate', item.id, target.id, kind).then(() => toast(`Connected to ${target.title}`), fail);
          }}
        />
      )}
    </section>
  );
}
