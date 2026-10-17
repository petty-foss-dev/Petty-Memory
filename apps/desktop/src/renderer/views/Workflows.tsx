import type { Intent, Item, ItemType, SavedView, SavedViewFilter, SavedViewInput, TaskStatus } from '@enve-memory/core';
import { useEffect, useRef, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { INTENT_LABELS, TYPE_LABELS, displayTitle } from '../lib/format.ts';
import { ATTENTION_LABELS } from '../lib/presentation.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, Modal, useFeedback } from '../ui.tsx';
import { ItemRow } from './ItemRow.tsx';

const PAGE_SIZE = 50;
const NAME_MAX = 120;
const QUERY_MAX = 500;

const STATUS_LABELS: Record<TaskStatus, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };

const EXAMPLES: { name: string; query?: string; filter: SavedViewFilter; why: string }[] = [
  { name: 'To review', filter: { review: true }, why: 'everything marked for review' },
  { name: 'High-attention notes', filter: { type: 'note', attention: 'high' }, why: 'notes you flagged as important' },
  { name: 'Open tasks', filter: { taskStatus: 'open' }, why: 'tasks nobody has started' },
  { name: 'Links to read', filter: { type: 'bookmark', intent: 'read' }, why: 'saved articles waiting for you' },
];

/** Form controls cover these; anything else a view carries (set by another client) is kept as it is. */
const FORM_KEYS = ['project', 'inbox', 'type', 'tag', 'taskStatus', 'attention', 'intent', 'pinned', 'review', 'reminders', 'unopenedDays'] as const;

const localToday = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

function describe(view: Pick<SavedView, 'query' | 'filter'>, projectName: (id: string) => string): string[] {
  const f = view.filter;
  const parts: string[] = [];
  if (view.query) parts.push(`Matches “${view.query}”`);
  if (f.project) parts.push(`In ${projectName(f.project)}`);
  if (f.inbox) parts.push('In the Inbox');
  if (f.type) parts.push(TYPE_LABELS[f.type as ItemType] ?? f.type);
  if (f.tag) parts.push(`#${f.tag}`);
  if (f.taskStatus) parts.push(`${STATUS_LABELS[f.taskStatus as TaskStatus] ?? f.taskStatus} tasks`);
  if (f.pinned) parts.push('Pinned');
  if (f.review) parts.push('Marked for review');
  if (f.attention) parts.push(`${ATTENTION_LABELS[f.attention as keyof typeof ATTENTION_LABELS] ?? f.attention} attention`);
  if (f.intent) parts.push(INTENT_LABELS[f.intent as Intent] ?? f.intent);
  if (f.unopenedDays !== undefined) parts.push(`Unopened for ${f.unopenedDays}+ days`);
  if (f.reminders) parts.push('Has a reminder');
  return parts.length ? parts : ['Every active item'];
}

export function SavedViews({ id }: { id?: string }) {
  const { go, projects } = useApp();
  const { toast, confirm } = useFeedback();
  const views = useLive(() => call('views.list'), []);
  const [editing, setEditing] = useState<{ view?: SavedView; draft: SavedViewInput } | null>(null);
  const list = views.data ?? [];
  // A view removed elsewhere falls back to the first one rather than showing a dead page.
  const selected = list.find((view) => view.id === id) ?? list[0];
  const projectName = (projectId: string) => projects.find((p) => p.id === projectId)?.name ?? 'an archived project';

  const remove = async (view: SavedView) => {
    const ok = await confirm({
      title: 'Remove this saved view?',
      body: <p>“{view.name}” is archived. The items it shows aren’t changed.</p>,
      confirmLabel: 'Remove view',
      danger: true,
    });
    if (!ok) return;
    call('views.remove', view.id).then(() => {
      toast('View removed');
      go({ view: 'views' });
    }, (error: unknown) => toast(errorMessage(error), 'error'));
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Saved views</h1>
        <button className="button primary small" onClick={() => setEditing({ draft: { name: '', query: '', filter: {} } })}>
          <Icon name="plus" size={14} /> New view
        </button>
        <p className="subtitle">Named filters that stay current. Results are matched by keyword and filters only, newest change first; secrets and templates never appear.</p>
      </header>
      {views.error && <p className="error-text" role="alert">{views.error.message}</p>}
      {views.data && list.length === 0 && (
        <Empty title="No saved views yet">
          Save a search you run often. Start from an example and adjust it:
        </Empty>
      )}
      {views.data && list.length === 0 && (
        <div className="workflow-examples">
          {EXAMPLES.map((example) => (
            <button key={example.name} className="hint-card" onClick={() => setEditing({ draft: { name: example.name, query: example.query ?? '', filter: example.filter } })}>
              <Icon name="filter" />
              <span><strong>{example.name}</strong> {example.why}</span>
            </button>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <nav className="chips workflow-tabs" aria-label="Saved views">
          {list.map((view) => (
            <button
              key={view.id}
              className={`chip ${view.id === selected?.id ? 'active' : ''}`}
              aria-current={view.id === selected?.id ? 'page' : undefined}
              onClick={() => go({ view: 'views', id: view.id })}
            >
              {view.name}
            </button>
          ))}
        </nav>
      )}
      {selected && (
        <section className="workflow-view" aria-label={selected.name}>
          <div className="panel-header">
            <h2>{selected.name}</h2>
            <div className="inline-actions">
              <button className="button small" onClick={() => setEditing({ view: selected, draft: { name: selected.name, query: selected.query, filter: selected.filter } })}>Edit…</button>
              <button className="button small danger-ghost" onClick={() => void remove(selected)}><Icon name="archive" size={14} /> Remove…</button>
            </div>
          </div>
          <div className="chips" aria-label="Filters">
            {describe(selected, projectName).map((part) => <span key={part} className="chip">{part}</span>)}
          </div>
          <ViewResults key={selected.id} view={selected} />
        </section>
      )}
      {editing && (
        <ViewForm
          view={editing.view}
          initial={editing.draft}
          onClose={(saved) => {
            setEditing(null);
            if (saved) go({ view: 'views', id: saved.id });
          }}
        />
      )}
    </div>
  );
}

function ViewResults({ view }: { view: SavedView }) {
  const { openItem } = useApp();
  const [pages, setPages] = useState(1);
  const results = useLive(async () => {
    const items: Item[] = [];
    let before: string | undefined;
    for (let page = 0; page < pages; page++) {
      const result = await call('views.results', view.id, { before, limit: PAGE_SIZE });
      items.push(...result.items);
      if (!result.next) return { items, more: false };
      before = result.next;
    }
    return { items, more: true };
  }, [view.id, view.updatedAt, pages]);
  return (
    <>
      {results.error && <p className="error-text" role="alert">{results.error.message}</p>}
      {results.data?.items.length === 0 && <Empty title="Nothing matches yet">Items that match appear here as soon as they’re saved or changed.</Empty>}
      <div className="rows">
        {(results.data?.items ?? []).map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)}
      </div>
      {results.data?.more && (
        <div className="load-more">
          <button className="button" onClick={() => setPages(pages + 1)}>Load more</button>
        </div>
      )}
    </>
  );
}

function ViewForm({ view, initial, onClose }: { view?: SavedView; initial: SavedViewInput; onClose: (saved: SavedView | null) => void }) {
  const { projects, info } = useApp();
  const { confirm } = useFeedback();
  const start = initial.filter ?? {};
  const [name, setName] = useState(initial.name);
  const [query, setQuery] = useState(initial.query ?? '');
  const [filter, setFilter] = useState<SavedViewFilter>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asking = useRef(false);

  const set = <K extends keyof SavedViewFilter>(key: K, value: SavedViewFilter[K] | '' | false) => {
    setFilter((current) => {
      const next = { ...current };
      if (value === '' || value === false || value === undefined) delete next[key];
      else next[key] = value as SavedViewFilter[K];
      return next;
    });
  };
  const input = (): SavedViewInput => {
    const { tag, ...rest } = filter;
    return { name: name.trim(), query: query.trim(), filter: tag?.trim() ? { ...rest, tag: tag.trim() } : rest };
  };
  const dirty = JSON.stringify(input()) !== JSON.stringify({ name: initial.name.trim(), query: (initial.query ?? '').trim(), filter: start });
  const kept = describe({ query: '', filter: Object.fromEntries(Object.entries(filter).filter(([key]) => !(FORM_KEYS as readonly string[]).includes(key))) }, () => '')
    .filter((part) => part !== 'Every active item');
  const unknownProject = filter.project && !projects.some((p) => p.id === filter.project);

  const close = async () => {
    if (asking.current) return;
    if (dirty) {
      asking.current = true;
      const discard = await confirm({ title: 'Discard this view?', body: <p>Your changes to the view haven’t been saved.</p>, confirmLabel: 'Discard changes', danger: true });
      asking.current = false;
      if (!discard) return;
    }
    onClose(null);
  };

  const save = () => {
    setBusy(true);
    setError(null);
    (view ? call('views.update', view.id, input()) : call('views.create', input())).then(onClose, (failure: unknown) => {
      setBusy(false);
      setError(errorMessage(failure));
    });
  };

  return (
    <Modal label={view ? 'Edit saved view' : 'New saved view'} onClose={() => void close()} busy={busy} className="workflow-dialog">
      <h2>{view ? 'Edit saved view' : 'New saved view'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) save(); }}>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder="Garage notes to review" />
        </label>
        <label className="field">
          <span>Words to match <span className="muted">(optional)</span></span>
          <input type="search" value={query} maxLength={QUERY_MAX} onChange={(event) => setQuery(event.target.value)} placeholder="opener wiring" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Project</span>
            <select value={filter.inbox ? '__inbox__' : filter.project ?? ''} onChange={(event) => {
              const value = event.target.value;
              setFilter((current) => {
                const next = { ...current };
                delete next.inbox;
                delete next.project;
                if (value === '__inbox__') next.inbox = true;
                else if (value) next.project = value;
                return next;
              });
            }}>
              <option value="">Any project</option>
              <option value="__inbox__">Inbox only</option>
              {unknownProject && <option value={filter.project}>Archived project</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Type</span>
            <select value={filter.type ?? ''} onChange={(event) => set('type', event.target.value)}>
              <option value="">Any type</option>
              {(Object.entries(TYPE_LABELS) as [ItemType, string][]).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Tag</span>
            <input list="workflow-tags" value={filter.tag ?? ''} onChange={(event) => set('tag', event.target.value.replace(/^#/, ''))} placeholder="wiring" />
            <datalist id="workflow-tags">{(info?.stats.tagNames ?? []).map((tag) => <option key={tag} value={tag} />)}</datalist>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Task status</span>
            <select value={filter.taskStatus ?? ''} onChange={(event) => set('taskStatus', event.target.value)}>
              <option value="">Any (or not a task)</option>
              {Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Attention</span>
            <select value={filter.attention ?? ''} onChange={(event) => set('attention', event.target.value)}>
              <option value="">Any attention</option>
              {Object.entries(ATTENTION_LABELS).map(([level, label]) => <option key={level} value={level}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Intent</span>
            <select value={filter.intent ?? ''} onChange={(event) => set('intent', event.target.value)}>
              <option value="">Any intent</option>
              {Object.entries(INTENT_LABELS).map(([intent, label]) => <option key={intent} value={intent}>{label}</option>)}
            </select>
          </label>
        </div>
        <div className="inline-actions">
          <label className="check"><input type="checkbox" checked={filter.pinned === true} onChange={(event) => set('pinned', event.target.checked)} /> Pinned only</label>
          <label className="check"><input type="checkbox" checked={filter.review === true} onChange={(event) => set('review', event.target.checked)} /> Marked for review only</label>
          <label className="check"><input type="checkbox" checked={filter.reminders === true} onChange={(event) => set('reminders', event.target.checked)} /> Has a reminder</label>
        </div>
        <label className="field">
          <span>Unopened for at least (days)</span>
          <input type="number" min={0} max={36500} step={1} value={filter.unopenedDays ?? ''} placeholder="Any age" onChange={(event) => set('unopenedDays', event.target.value === '' ? '' : Number(event.target.value))} />
          <span className="muted small">Only bookmarks that have never been opened. Leave empty for any age.</span>
        </label>
        {kept.length > 0 && <p className="muted small">Also keeps: {kept.join(', ')}.</p>}
        <p className="muted small">Every filter must match. Words are matched as plain keywords, never run as code.</p>
        {error && <p className="error-text small" role="alert">Not saved: {error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" onClick={() => void close()} disabled={busy}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>{view ? 'Save view' : 'Create view'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Templates() {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const templates = useLive(() => call('templates.list'), []);
  const [using, setUsing] = useState<Item | null>(null);
  const list = templates.data ?? [];

  useEffect(() => {
    if (using && templates.data && !templates.data.some((t) => t.id === using.id)) setUsing(null);
  }, [templates.data, using]);

  const archive = (template: Item) =>
    call('items.archive', template.id).then(() => toast('Template archived'), (error: unknown) => toast(errorMessage(error), 'error'));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Templates</h1>
        <p className="subtitle">Reusable note outlines. Using one copies the whole tree into a project or the Inbox; the template stays as it is.</p>
      </header>
      {templates.error && <p className="error-text" role="alert">{templates.error.message}</p>}
      {templates.data && list.length === 0 && (
        <Empty title="No templates yet">
          Open any note, nested notes included, and choose Save as template. Write {'{{date}}'} or {'{{project}}'} in its titles or text,
          for example “Standup {'{{date}}'}” or “{'{{project}}'} retro”, and they’re filled in each time you use it.
        </Empty>
      )}
      <div className="rows">
        {list.map((template) => (
          <ItemRow key={template.id} item={template} onOpen={openItem}>
            <button className="button primary small" onClick={() => setUsing(template)}>Use…</button>
            <button className="button small" onClick={() => openItem(template.id)}>Edit</button>
            <button className="button small" aria-label={`Archive ${displayTitle(template)}`} onClick={() => void archive(template)}>
              <Icon name="archive" size={14} /> Archive
            </button>
          </ItemRow>
        ))}
      </div>
      {list.length > 0 && <PlaceholderHelp />}
      {using && <UseTemplateDialog template={using} onClose={() => setUsing(null)} />}
    </div>
  );
}

function PlaceholderHelp() {
  return (
    <p className="muted small workflow-help">
      Placeholders: <code>{'{{date}}'}</code> becomes the date you choose (YYYY-MM-DD) and <code>{'{{project}}'}</code> the destination
      project’s name, or Inbox. Anything else in braces is left as written.
    </p>
  );
}

export function UseTemplateDialog({ template, onClose }: { template: Item; onClose: () => void }) {
  const { projects, openItem } = useApp();
  const { toast } = useFeedback();
  const [title, setTitle] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [date, setDate] = useState(localToday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const use = () => {
    setBusy(true);
    setError(null);
    call('templates.instantiate', template.id, { title: title.trim() || undefined, project, date: date || undefined }).then((created) => {
      toast(`Created “${displayTitle(created)}”`);
      onClose();
      openItem(created.id);
    }, (failure: unknown) => {
      setBusy(false);
      setError(errorMessage(failure));
    });
  };

  return (
    <Modal label={`Use template ${displayTitle(template)}`} onClose={onClose} busy={busy} className="workflow-dialog">
      <h2>Use “{displayTitle(template)}”</h2>
      <form onSubmit={(event) => { event.preventDefault(); use(); }}>
        <label className="field">
          <span>Title <span className="muted">(optional)</span></span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={displayTitle(template)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Put it in</span>
            <select value={project ?? ''} onChange={(event) => setProject(event.target.value || null)}>
              <option value="">Inbox</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Date for {'{{date}}'}</span>
            <input type="date" value={date} required onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>
        <PlaceholderHelp />
        {error && <p className="error-text small" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy || !date}>Create and open</button>
        </div>
      </form>
    </Modal>
  );
}

export function SaveTemplateDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [name, setName] = useState(`${displayTitle(item)} template`.slice(0, NAME_MAX));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setBusy(true);
    setError(null);
    call('templates.create', item.id, name.trim() || undefined).then((created) => {
      toast('Template saved');
      onClose();
      openItem(created.id);
    }, (failure: unknown) => {
      setBusy(false);
      setError(errorMessage(failure));
    });
  };

  return (
    <Modal label="Save as template" onClose={onClose} busy={busy} className="workflow-dialog">
      <h2>Save as template</h2>
      <form onSubmit={(event) => { event.preventDefault(); save(); }}>
        <div className="dialog-body">
          <p>Copies this note and every note inside it into a new template. This note isn’t changed.</p>
          <p>Checkboxes start unchecked; pins, reminders and AI suggestions aren’t copied. Only plain notes can be included, so a tree holding links, files, tasks or secrets can’t be saved.</p>
        </div>
        <label className="field">
          <span>Template name</span>
          <input autoFocus value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)} />
        </label>
        <PlaceholderHelp />
        {error && <p className="error-text small" role="alert">Not saved: {error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy}>Save template</button>
        </div>
      </form>
    </Modal>
  );
}
