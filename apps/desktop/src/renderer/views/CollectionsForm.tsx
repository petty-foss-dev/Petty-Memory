import type {
  Collection, CollectionFilter, CollectionSort, FilterOp, ItemType, PropertyField, PropertyType, PropertyValue, SaveCollectionInput,
} from '@enve-memory/core';
import { useRef, useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { TYPE_LABELS } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Icon, Modal, ProjectSelect } from '../ui.tsx';

const NAME_MAX = 120;
const FIELD_NAME_MAX = 80;
const OPTION_NAME_MAX = 80;
const QUERY_MAX = 500;
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_SORTS = 3;
const MAX_FILTERS = 10;

export const ROW_TYPES: ItemType[] = ['note', 'bookmark', 'file', 'image', 'task'];

export const PROPERTY_LABELS: Record<PropertyType, string> = { text: 'Text', number: 'Number', date: 'Date', checkbox: 'Checkbox', select: 'Select' };

const OP_LABELS: Record<FilterOp, string> = {
  equals: 'is', notEquals: 'is not', contains: 'contains', lt: 'is before / less than', lte: 'is on or before / at most',
  gt: 'is after / more than', gte: 'is on or after / at least', empty: 'is empty', notEmpty: 'is not empty',
};

const OPS_BY_TYPE: Record<PropertyType, FilterOp[]> = {
  text: ['equals', 'notEquals', 'contains', 'empty', 'notEmpty'],
  number: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  date: ['equals', 'notEquals', 'lt', 'lte', 'gt', 'gte', 'empty', 'notEmpty'],
  checkbox: ['equals'],
  select: ['equals', 'notEquals', 'empty', 'notEmpty'],
};

export const BUILT_IN_SORT_LABELS: Record<string, string> = { title: 'Title', createdAt: 'Date saved', updatedAt: 'Last changed' };

interface OptionDraft {
  uid: number;
  id?: string;
  name: string;
}

interface FieldDraft {
  uid: number;
  id?: string;
  name: string;
  type: PropertyType;
  options: OptionDraft[];
}

/** Creates or edits a collection's name, scope and fields. Existing fields and options keep their ids, so their values stay attached. */
export function CollectionForm({ collection, onClose }: { collection: Collection | null; onClose: (saved: Collection | null) => void }) {
  const { projects } = useApp();
  const next = useRef(1);
  const uid = () => next.current++;
  const [name, setName] = useState(collection?.name ?? '');
  const [project, setProject] = useState<string | null>(collection?.scope.project ?? null);
  const [query, setQuery] = useState(collection?.scope.query ?? '');
  const [type, setType] = useState<ItemType | ''>(collection?.scope.type ?? '');
  const [fields, setFields] = useState<FieldDraft[]>(() => (collection?.fields ?? []).map((field) => ({
    uid: uid(), id: field.id, name: field.name, type: field.type, options: (field.options ?? []).map((option) => ({ uid: uid(), id: option.id, name: option.name })),
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (key: number, patch: Partial<FieldDraft>) => setFields((current) => current.map((field) => (field.uid === key ? { ...field, ...patch } : field)));
  const removed = (collection?.fields ?? []).filter((field) => !fields.some((draft) => draft.id === field.id));

  const save = async () => {
    const problem = !name.trim() ? 'Name the collection.'
      : fields.some((field) => !field.name.trim()) ? 'Every field needs a name.'
        : fields.some((field) => field.type === 'select' && !field.options.some((option) => option.name.trim())) ? 'Every select field needs at least one option.' : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const kept = new Map(fields.filter((field) => field.id).map((field) => [field.id!, field]));
    const input: SaveCollectionInput = {
      name: name.trim(),
      scope: { project, query: query.trim() || null, type: type || null },
      fields: fields.map((field) => ({
        ...(field.id ? { id: field.id } : {}),
        name: field.name.trim(),
        type: field.type,
        ...(field.type === 'select' ? { options: field.options.filter((option) => option.name.trim()).map((option) => ({ ...(option.id ? { id: option.id } : {}), name: option.name.trim() })) } : {}),
      })),
    };
    if (collection) {
      // Saved sort, filter and grouping rules may point at fields or options removed here; drop those rules rather than fail.
      const optionKept = (fieldId: string, value: PropertyValue | undefined) => {
        const field = kept.get(fieldId);
        return field?.type !== 'select' || value === undefined || field.options.some((option) => option.id === value);
      };
      input.sort = collection.sort.filter((rule) => rule.field in BUILT_IN_SORT_LABELS || kept.has(rule.field));
      input.filters = collection.filters.filter((rule) => kept.has(rule.field) && optionKept(rule.field, rule.value));
      input.groupBy = collection.groupBy && kept.has(collection.groupBy) ? collection.groupBy : null;
      if (collection.layout === 'kanban' && !input.groupBy) input.layout = 'table';
    }
    try {
      const saved = await knowledgeRequest<Collection>('/collections', 'POST', collection ? { ...input, id: collection.id } : { ...input });
      onClose(saved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal label={collection ? 'Edit collection' : 'New collection'} onClose={() => onClose(null)} busy={busy} className="workflow-dialog collection-dialog">
      <h2>{collection ? 'Edit collection' : 'New collection'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field">
          <span>Name</span>
          <input autoFocus maxLength={NAME_MAX} value={name} placeholder="Reading list" onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className="field">
          <legend>Which items</legend>
          <div className="field-row">
            <label className="field">
              <span>Project</span>
              <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Any project" />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={type} onChange={(event) => setType(event.target.value as ItemType | '')}>
                <option value="">Any type</option>
                {ROW_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Keywords (optional)</span>
              <input type="search" maxLength={QUERY_MAX} value={query} placeholder="All matching items" onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Fields</legend>
          {fields.length === 0 && <p className="muted small">Add fields such as Status, Rating or Due date. Values live on the items themselves.</p>}
          <ol className="collection-fields">
            {fields.map((field, index) => (
              <li key={field.uid}>
                <div className="field-row">
                  <label className="field">
                    <span>Field {index + 1}</span>
                    <input maxLength={FIELD_NAME_MAX} value={field.name} placeholder="Status" onChange={(event) => update(field.uid, { name: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>Type</span>
                    <select
                      value={field.type}
                      disabled={Boolean(field.id)}
                      title={field.id ? 'A saved field’s type can’t change. Add a new field instead.' : undefined}
                      onChange={(event) => update(field.uid, { type: event.target.value as PropertyType, options: event.target.value === 'select' && !field.options.length ? [{ uid: uid(), name: '' }] : field.options })}
                    >
                      {(Object.keys(PROPERTY_LABELS) as PropertyType[]).map((value) => <option key={value} value={value}>{PROPERTY_LABELS[value]}</option>)}
                    </select>
                  </label>
                  <button type="button" className="button small danger-ghost field-remove" aria-label={`Remove field ${field.name || index + 1}`} onClick={() => setFields(fields.filter((f) => f.uid !== field.uid))}>
                    <Icon name="close" size={14} /> Remove
                  </button>
                </div>
                {field.type === 'select' && (
                  <div className="collection-options">
                    {field.options.map((option, n) => (
                      <span key={option.uid} className="collection-option">
                        <input
                          aria-label={`${field.name || 'Select field'} option ${n + 1}`}
                          maxLength={OPTION_NAME_MAX}
                          value={option.name}
                          placeholder="Option"
                          onChange={(event) => update(field.uid, { options: field.options.map((o) => (o.uid === option.uid ? { ...o, name: event.target.value } : o)) })}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove option ${option.name || n + 1}`}
                          disabled={field.options.length === 1}
                          onClick={() => update(field.uid, { options: field.options.filter((o) => o.uid !== option.uid) })}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </span>
                    ))}
                    <button type="button" className="button small ghost" disabled={field.options.length >= MAX_OPTIONS} onClick={() => update(field.uid, { options: [...field.options, { uid: uid(), name: '' }] })}>
                      <Icon name="plus" size={13} /> Option
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="inline-actions">
            <button type="button" className="button small" disabled={fields.length >= MAX_FIELDS} onClick={() => setFields([...fields, { uid: uid(), name: '', type: 'text', options: [] }])}>
              <Icon name="plus" size={14} /> Add field
            </button>
          </div>
        </fieldset>
        {removed.length > 0 && (
          <p className="note">
            Removing {removed.map((field) => `“${field.name}”`).join(', ')} hides {removed.length === 1 ? 'it' : 'them'} here. Values already on items are kept,
            and sort, filter or grouping rules that used {removed.length === 1 ? 'it' : 'them'} are dropped.
          </p>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save collection'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface FilterDraft {
  uid: number;
  field: string;
  op: FilterOp;
  value: string;
}

const defaultValue = (field: PropertyField | undefined) => (field?.type === 'checkbox' ? 'true' : field?.type === 'select' ? field.options?.[0]?.id ?? '' : '');

function filterValue(field: PropertyField, raw: string): PropertyValue {
  if (field.type === 'number') return Number(raw);
  if (field.type === 'checkbox') return raw === 'true';
  return raw;
}

/** Saved sort order and typed filters; rows are sorted and filtered in core. */
export function SortFilterDialog({ collection, onClose }: { collection: Collection; onClose: (saved: boolean) => void }) {
  const next = useRef(1);
  const byId = new Map(collection.fields.map((field) => [field.id, field]));
  const [sorts, setSorts] = useState<CollectionSort[]>(collection.sort);
  const [filters, setFilters] = useState<FilterDraft[]>(() => collection.filters.map((filter) => ({
    uid: next.current++, field: filter.field, op: filter.op, value: filter.value === undefined ? '' : String(filter.value),
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortChoices = [...Object.entries(BUILT_IN_SORT_LABELS), ...collection.fields.map((field) => [field.id, field.name] as const)];

  const updateFilter = (key: number, patch: Partial<FilterDraft>) => setFilters((current) => current.map((filter) => (filter.uid === key ? { ...filter, ...patch } : filter)));

  const save = async () => {
    const parsed: CollectionFilter[] = [];
    for (const filter of filters) {
      const field = byId.get(filter.field)!;
      if (filter.op === 'empty' || filter.op === 'notEmpty') {
        parsed.push({ field: filter.field, op: filter.op });
        continue;
      }
      if (!filter.value.trim() || (field.type === 'number' && !Number.isFinite(Number(filter.value)))) {
        setError(`Give the filter on ${field.name} a ${field.type === 'number' ? 'number' : 'value'}.`);
        return;
      }
      parsed.push({ field: filter.field, op: filter.op, value: filterValue(field, filter.value.trim()) });
    }
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest('/collections', 'POST', { id: collection.id, sort: sorts, filters: parsed });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal label="Sort and filter" onClose={() => onClose(false)} busy={busy} className="workflow-dialog collection-dialog">
      <h2>Sort and filter “{collection.name}”</h2>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="field">
          <legend>Sort by</legend>
          {sorts.length === 0 && <p className="muted small">Most recently changed first.</p>}
          {sorts.map((sort, index) => (
            <div key={index} className="collection-rule">
              <select aria-label={`Sort ${index + 1} field`} value={sort.field} onChange={(event) => setSorts(sorts.map((s, i) => (i === index ? { ...s, field: event.target.value } : s)))}>
                {sortChoices.filter(([id]) => id === sort.field || !sorts.some((s) => s.field === id)).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <select aria-label={`Sort ${index + 1} direction`} value={sort.direction} onChange={(event) => setSorts(sorts.map((s, i) => (i === index ? { ...s, direction: event.target.value as CollectionSort['direction'] } : s)))}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              <button type="button" className="icon-button" aria-label={`Remove sort ${index + 1}`} onClick={() => setSorts(sorts.filter((_, i) => i !== index))}><Icon name="close" size={14} /></button>
            </div>
          ))}
          <div className="inline-actions">
            <button
              type="button"
              className="button small"
              disabled={sorts.length >= MAX_SORTS || sorts.length >= sortChoices.length}
              onClick={() => setSorts([...sorts, { field: sortChoices.find(([id]) => !sorts.some((s) => s.field === id))![0], direction: 'asc' }])}
            >
              <Icon name="plus" size={14} /> Add sort
            </button>
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Only show rows where</legend>
          {collection.fields.length === 0 && <p className="muted small">Add fields to the collection before filtering by them.</p>}
          {filters.map((filter) => {
            const field = byId.get(filter.field)!;
            const needsValue = filter.op !== 'empty' && filter.op !== 'notEmpty';
            return (
              <div key={filter.uid} className="collection-rule">
                <select aria-label="Filter field" value={filter.field} onChange={(event) => {
                  const chosen = byId.get(event.target.value)!;
                  updateFilter(filter.uid, { field: chosen.id, op: OPS_BY_TYPE[chosen.type][0]!, value: defaultValue(chosen) });
                }}>
                  {collection.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <select aria-label="Filter condition" value={filter.op} onChange={(event) => updateFilter(filter.uid, { op: event.target.value as FilterOp })}>
                  {OPS_BY_TYPE[field.type].map((op) => <option key={op} value={op}>{field.type === 'checkbox' ? 'is' : OP_LABELS[op]}</option>)}
                </select>
                {needsValue && <FilterValueInput field={field} value={filter.value} onChange={(value) => updateFilter(filter.uid, { value })} />}
                <button type="button" className="icon-button" aria-label={`Remove filter on ${field.name}`} onClick={() => setFilters(filters.filter((f) => f.uid !== filter.uid))}><Icon name="close" size={14} /></button>
              </div>
            );
          })}
          <div className="inline-actions">
            <button
              type="button"
              className="button small"
              disabled={!collection.fields.length || filters.length >= MAX_FILTERS}
              onClick={() => {
                const field = collection.fields[0]!;
                setFilters([...filters, { uid: next.current++, field: field.id, op: OPS_BY_TYPE[field.type][0]!, value: defaultValue(field) }]);
              }}
            >
              <Icon name="plus" size={14} /> Add filter
            </button>
          </div>
        </fieldset>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function FilterValueInput({ field, value, onChange }: { field: PropertyField; value: string; onChange: (value: string) => void }) {
  const label = `Filter value for ${field.name}`;
  switch (field.type) {
    case 'checkbox':
      return (
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="true">Checked</option>
          <option value="false">Not checked</option>
        </select>
      );
    case 'select':
      return (
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {field.options!.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      );
    case 'date':
      return <input aria-label={label} type="date" value={value} onChange={(event) => onChange(event.target.value)} />;
    case 'number':
      return <input aria-label={label} type="number" step="any" value={value} onChange={(event) => onChange(event.target.value)} />;
    case 'text':
      return <input aria-label={label} maxLength={2000} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
}
