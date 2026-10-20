import type {
  BiscottiImportRequest, BiscottiImportResult, BiscottiMeeting, BiscottiMeetingPage, BiscottiPreview, BiscottiPreviewEntry, BiscottiSavedMeeting,
} from '@enve-memory/importers';
import { useEffect, useId, useRef, useState } from 'react';
import type { BiscottiQueryResult } from '../../shared/biscotti.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { formatBytes } from '../lib/format.ts';
import { type AskSeed, useApp } from '../context.ts';
import { Empty, Icon, MarkdownView, ProjectSelect, useFeedback } from '../ui.tsx';
import { plural, timestamp } from './KnowledgeCommon.tsx';
import './meetings.css';

// The importer's own limit; main checks the text again.
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const SEARCH_LIMIT = 50;
const PAGE_SIZE = 25;
const SHOWN = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Staged =
  | { kind: 'csv'; key: string; token: number; name: string; data: string; preview: BiscottiPreview }
  | { kind: 'mcp'; key: string; token: number; meetingId: string; preview: BiscottiPreview };

type AiAction = 'ask' | 'prepare' | 'followUps' | 'brief';

const AI_ACTIONS: { action: AiAction; label: string }[] = [
  { action: 'ask', label: 'Ask about it' },
  { action: 'prepare', label: 'Prepare next meeting' },
  { action: 'followUps', label: 'Find follow-ups' },
  { action: 'brief', label: 'Write a brief' },
];

const ACTION_DRAFTS: Record<Exclude<AiAction, 'ask' | 'prepare'>, (meeting: string) => string> = {
  followUps: (meeting) => `List the follow-ups from ${meeting} as tasks. Use only owners and due dates the notes state, and leave them out where the notes don’t say.`,
  brief: (meeting) => `Write a short brief of ${meeting}: what was discussed, what was decided and what’s still open. Don’t suggest tasks.`,
};

let seeds = 0;

const untitled = (title: string) => title.trim() || 'Untitled meeting';

/** Source dates as Biscotti recorded them; date-only values stay on their calendar day. */
function meetingDate(value: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value || 'No date';
  return date.toLocaleString(undefined, dateOnly ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' });
}

/** Start of a local calendar day as ISO, `days` later. */
function dayStart(value: string, days = 0): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day! + days).toISOString();
}

function names(list: string[], max = 4): string {
  return list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', ');
}

function snippet(text: string, max = 220): string {
  const plain = text.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

const meetingOf = (entry: BiscottiPreviewEntry): BiscottiMeeting => ({
  id: entry.id,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  notes: entry.notes,
  transcript: entry.transcript,
  participants: entry.participants,
  tags: entry.tags,
});

/** Biscotti meetings: preview a CSV export or one meeting from the Mac app, import the chosen ones, then work with them. */
export function Meetings() {
  const { info } = useApp();
  const mac = (info?.platform ?? window.enve.platform) === 'darwin';
  const fileInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const browserId = useId();
  const [browsing, setBrowsing] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [loading, setLoading] = useState<{ token: number; label: string } | null>(null);
  const [error, setError] = useState<{ message: string; retry?: () => void } | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ label: string; result: BiscottiImportResult } | null>(null);

  useEffect(() => () => void seq.current++, []);

  // Every new file, search or choice supersedes whatever was loading or shown before it.
  const begin = (label: string | null) => {
    const token = ++seq.current;
    setStaged(null);
    setError(null);
    setResult(null);
    setLoading(label ? { token, label } : null);
    return token;
  };
  const settle = (token: number) => setLoading((current) => (current?.token === token ? null : current));

  const readCsv = async (file: File) => {
    setChosen(null);
    const token = begin(`Reading ${file.name}…`);
    try {
      if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') throw new Error('Choose the CSV file that Biscotti exported.');
      if (file.size > MAX_CSV_BYTES) {
        throw new Error(`That file is ${formatBytes(file.size)}; exports can be at most ${formatBytes(MAX_CSV_BYTES)}. Export fewer meetings at a time.`);
      }
      const bytes = await file.arrayBuffer();
      let data: string;
      try {
        data = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('That file isn’t UTF-8 text. Export it from Biscotti again as CSV.');
      }
      const preview = await call('biscotti.previewCsv', data);
      if (seq.current === token) setStaged({ kind: 'csv', key: `csv:${token}`, token, name: file.name, data, preview });
    } catch (err) {
      if (seq.current === token) setError({ message: errorMessage(err) });
    } finally {
      settle(token);
    }
  };

  const previewLive = async (id: string) => {
    setChosen(id);
    const token = begin('Opening the meeting…');
    try {
      const preview = await call('biscotti.previewMeeting', id);
      if (seq.current === token) setStaged({ kind: 'mcp', key: `mcp:${token}`, token, meetingId: id, preview });
    } catch (err) {
      if (seq.current === token) setError({ message: errorMessage(err), retry: () => void previewLive(id) });
    } finally {
      settle(token);
    }
  };

  // Checks the same source again, keeping the preview (and its choices) on screen meanwhile.
  const refresh = async () => {
    if (!staged) return;
    const current = staged;
    const token = ++seq.current;
    setError(null);
    setLoading({ token, label: 'Checking again…' });
    try {
      const preview = current.kind === 'csv'
        ? await call('biscotti.previewCsv', current.data)
        : await call('biscotti.previewMeeting', current.meetingId);
      if (seq.current === token) setStaged({ ...current, token, preview });
    } catch (err) {
      if (seq.current === token) setError({ message: errorMessage(err), retry: () => void refresh() });
    } finally {
      settle(token);
    }
  };

  const importStaged = async (includeIds: string[], project: string | null) => {
    if (!staged) return;
    const { token, preview } = staged;
    const request: BiscottiImportRequest = staged.kind === 'csv'
      ? { source: 'csv', data: staged.data, fingerprint: preview.fingerprint, includeIds, ...(project ? { project } : {}) }
      : { source: 'mcp', data: preview.entries.map(meetingOf), fingerprint: preview.fingerprint, includeIds, ...(project ? { project } : {}) };
    const label = staged.kind === 'csv' ? staged.name : untitled(preview.entries[0]?.title ?? '');
    setImporting(true);
    try {
      const imported = await call('biscotti.import', request);
      if (seq.current !== token) return;
      seq.current++;
      setStaged(null);
      setChosen(null);
      setResult({ label, result: imported });
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="knowledge-section meetings" aria-labelledby="meetings-heading">
      <div className="panel-header">
        <h2 id="meetings-heading">Meetings</h2>
        <div className="inline-actions">
          <input
            ref={fileInput}
            type="file"
            hidden
            disabled={importing}
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void readCsv(file);
            }}
          />
          <button className="button small" disabled={importing} onClick={() => fileInput.current?.click()}>
            <Icon name="file" size={14} /> Import CSV…
          </button>
          {mac && (
            <button className="button small" aria-expanded={browsing} aria-controls={browserId} disabled={importing} onClick={() => setBrowsing(!browsing)}>
              <Icon name="search" size={14} /> Browse Biscotti
            </button>
          )}
        </div>
      </div>
      <p className="note">
        Bring in summaries, your notes and speaker transcripts from Biscotti. You choose which meetings to copy into this library; they then
        follow its sync and AI settings. Recordings stay in Biscotti, and nothing is imported automatically.
      </p>
      {!mac && <p className="muted small">Browsing the Biscotti app works on a Mac. On this computer, export meetings from Biscotti as CSV and import the file.</p>}

      {mac && browsing && (
        <BiscottiBrowser
          id={browserId}
          chosen={chosen}
          disabled={importing}
          onSearch={() => {
            setChosen(null);
            begin(null);
          }}
          onChoose={(id) => void previewLive(id)}
        />
      )}

      {loading && <p className="muted" role="status">{loading.label}</p>}
      {error && (
        <div className="meetings-error" role="alert">
          <p className="error-text">{error.message}</p>
          {error.retry && <button className="button small" onClick={error.retry}>Try again</button>}
        </div>
      )}
      {staged && (
        <MeetingPreview
          key={staged.key}
          staged={staged}
          checking={loading !== null}
          onImport={importStaged}
          onRefresh={() => void refresh()}
          onCancel={() => {
            seq.current++;
            setStaged(null);
            setChosen(null);
            setLoading(null);
          }}
        />
      )}
      {result && <ImportSummary label={result.label} result={result.result} onDone={() => setResult(null)} />}

      <MeetingLibrary mac={mac} />
    </section>
  );
}

/** Read-only search of the Biscotti app on this Mac, run only when asked; full meetings load one at a time. */
function BiscottiBrowser({ id, chosen, disabled, onSearch, onChoose }: {
  id: string;
  chosen: string | null;
  disabled: boolean;
  onSearch: () => void;
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [found, setFound] = useState<BiscottiQueryResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => () => void seq.current++, []);

  const search = async () => {
    if (from && to && from > to) {
      setError('The start date is after the end date.');
      return;
    }
    const token = ++seq.current;
    onSearch();
    setFound(null);
    setError(null);
    setSearching(true);
    try {
      const text = query.trim();
      const result = await call('biscotti.query', {
        ...(text ? { query: text } : {}),
        ...(from ? { after: dayStart(from) } : {}),
        ...(to ? { before: new Date(new Date(dayStart(to, 1)).getTime() - 1).toISOString() } : {}),
        limit: SEARCH_LIMIT,
      });
      if (seq.current !== token) return;
      setFound(result);
      setConnected(true);
    } catch (err) {
      if (seq.current === token) setError(errorMessage(err));
    } finally {
      if (seq.current === token) setSearching(false);
    }
  };

  const results = found?.results ?? [];

  return (
    <div id={id} className="meetings-panel" role="region" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Browse Biscotti</h3>
      <p className="muted small">
        Reads meetings from the Biscotti app on this Mac. Open Biscotti and turn on Settings › General › MCP first. Nothing is recorded or
        changed in Biscotti.
      </p>
      <form
        className="meetings-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="field inline meetings-query">
          <span>Search</span>
          <input type="search" value={query} placeholder="Title, person or topic" maxLength={200} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="field inline">
          <span>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field inline">
          <span>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button type="submit" className="button primary small" disabled={searching || disabled}>
          {searching ? 'Searching…' : connected ? 'Search' : 'Connect and search'}
        </button>
      </form>
      {searching && <p className="muted small" role="status">{connected ? 'Searching Biscotti…' : 'Connecting to Biscotti…'}</p>}
      {error && (
        <div className="meetings-error" role="alert">
          <p className="error-text">{error}</p>
          <button className="button small" disabled={searching || disabled} onClick={() => void search()}>Try again</button>
        </div>
      )}
      {found && (
        <>
          <p className="muted small" role="status">
            {results.length ? `${plural(results.length, 'meeting')}. Choose one to preview it before importing.` : 'No meetings match.'}
            {found.truncated && ` Showing the first ${SEARCH_LIMIT}; narrow the search or dates to find others.`}
          </p>
          {results.length > 0 && (
            <ul className="meetings-results" aria-label="Biscotti meetings">
              {results.map((result) => (
                <li key={result.id}>
                  <button
                    className={chosen === result.id ? 'active' : ''}
                    aria-current={chosen === result.id ? 'true' : undefined}
                    disabled={disabled}
                    onClick={() => onChoose(result.id)}
                  >
                    <span className="meetings-result-title">{untitled(result.title)}</span>
                    <span className="muted small">{meetingDate(result.date)}</span>
                    {result.querySnippet && <span className="small meetings-result-snippet">{result.querySnippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** What a CSV file or a Biscotti meeting contains; only the ticked new meetings are imported. */
function MeetingPreview({ staged, checking, onImport, onRefresh, onCancel }: {
  staged: Staged;
  checking: boolean;
  onImport: (includeIds: string[], project: string | null) => Promise<void>;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const { projects, openItem } = useApp();
  const { preview } = staged;
  const baseId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const selectable = preview.entries.filter((entry) => !entry.existingId).map((entry) => entry.id);
  const [selected, setSelected] = useState(() => new Set(selectable));
  const [project, setProject] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => heading.current?.focus(), []);

  // Checking again keeps the choices that still apply to the new preview.
  useEffect(() => {
    const allowed = new Set(selectable);
    setSelected((current) => new Set([...current].filter((id) => allowed.has(id))));
    setError(null);
  }, [preview.fingerprint]);

  const chosen = selectable.filter((id) => selected.has(id));
  const existing = preview.entries.length - selectable.length;

  const toggle = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const submit = async () => {
    if (submitting.current || !chosen.length) return;
    submitting.current = true;
    setImporting(true);
    setError(null);
    try {
      await onImport(chosen, project);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setImporting(false);
    }
  };

  return (
    <div className="meetings-panel" aria-busy={importing || checking}>
      <h3 ref={heading} tabIndex={-1}>{staged.kind === 'csv' ? staged.name : 'From Biscotti'}</h3>
      <p>
        {preview.entries.length ? `${plural(preview.entries.length, 'meeting')} found` : 'No meetings found'}
        {existing > 0 && `, ${existing} already imported`}
        {preview.skipped > 0 && `. ${plural(preview.skipped, 'row')} couldn’t be read`}.
      </p>
      {preview.warnings.length > 0 && (
        <details className="meetings-warnings">
          <summary>{plural(preview.warnings.length, 'warning')}</summary>
          <ul>
            {preview.warnings.slice(0, 100).map((warning, index) => <li key={index}>Row {warning.row}: {warning.message}</li>)}
          </ul>
          {preview.warnings.length > 100 && <p className="muted small">And {preview.warnings.length - 100} more.</p>}
        </details>
      )}

      {preview.entries.length > 0 && (
        <>
          <div className="meetings-selection">
            <span className="small" aria-live="polite">
              {selectable.length ? `${chosen.length} of ${selectable.length} selected` : 'Everything here is already imported.'}
            </span>
            {selectable.length > 1 && (
              <span className="inline-actions">
                <button className="button ghost small" disabled={importing || chosen.length === selectable.length} onClick={() => setSelected(new Set(selectable))}>Select all</button>
                <button className="button ghost small" disabled={importing || chosen.length === 0} onClick={() => setSelected(new Set())}>Select none</button>
              </span>
            )}
          </div>
          <ul className="meetings-entries" aria-label="Meetings to import">
            {preview.entries.map((entry, index) => {
              const domId = `${baseId}-${index}`;
              const expanded = open === entry.id;
              return (
                <li key={entry.id} className={`meetings-entry ${entry.existingId ? 'existing' : ''}`}>
                  <div className="meetings-entry-head">
                    <input
                      id={`${domId}-check`}
                      type="checkbox"
                      checked={!entry.existingId && selected.has(entry.id)}
                      disabled={Boolean(entry.existingId) || importing}
                      aria-describedby={`${domId}-meta`}
                      onChange={(event) => toggle(entry.id, event.target.checked)}
                    />
                    <label htmlFor={`${domId}-check`} className="meetings-entry-title">{untitled(entry.title)}</label>
                    <button className="button ghost small" aria-expanded={expanded} aria-controls={`${domId}-detail`} onClick={() => setOpen(expanded ? null : entry.id)}>
                      {expanded ? 'Hide details' : 'Details'}
                    </button>
                  </div>
                  <p id={`${domId}-meta`} className="muted small meetings-entry-meta">
                    {meetingDate(entry.date)}{entry.speakers.length > 0 && ` · ${names(entry.speakers)}`}
                    {entry.existingId && <> · <span className="meetings-badge">Already imported</span></>}
                  </p>
                  {entry.existingId && (
                    <button className="link-button small meetings-entry-open" onClick={() => openItem(entry.existingId!)}>Open saved note</button>
                  )}
                  {expanded && <MeetingDetail id={`${domId}-detail`} entry={entry} />}
                </li>
              );
            })}
          </ul>
          <div className="meetings-import-bar">
            <label className="field inline">
              <span>Save to</span>
              <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Inbox" label="Save to" />
            </label>
            <button className="button primary" disabled={!chosen.length || importing || checking} onClick={() => void submit()}>
              {importing ? 'Importing…' : chosen.length ? `Import ${plural(chosen.length, 'meeting')}` : 'Import'}
            </button>
            <button className="button ghost" disabled={importing} onClick={onCancel}>Cancel</button>
          </div>
          <p className="muted small">Selected meetings’ text is copied into this library and uses its sync and AI settings. Recordings stay in Biscotti.</p>
        </>
      )}
      {preview.entries.length === 0 && <div className="inline-actions"><button className="button ghost small" onClick={onCancel}>Close</button></div>}
      {error && (
        <div className="meetings-error" role="alert">
          <p className="error-text">{error}</p>
          <div className="inline-actions">
            <button className="button small" disabled={importing || checking || !chosen.length} onClick={() => void submit()}>Try again</button>
            <button className="button ghost small" disabled={importing || checking} onClick={onRefresh}>Preview again</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingDetail({ id, entry }: { id: string; entry: BiscottiPreviewEntry }) {
  return (
    <div id={id} className="meetings-detail">
      {entry.participants.length > 0 && <p className="small"><strong>Participants:</strong> {entry.participants.join(', ')}</p>}
      {entry.tags.length > 0 && <p className="small"><strong>Tags:</strong> {entry.tags.join(', ')}</p>}
      <h4>Summary</h4>
      {entry.summary.trim() ? <MarkdownView source={entry.summary} /> : <p className="muted small">No summary.</p>}
      {entry.notes.trim() && (
        <>
          <h4>Your notes</h4>
          <MarkdownView source={entry.notes} />
        </>
      )}
      <h4>Transcript</h4>
      {entry.turns.length > 0 ? (
        <ol className="meetings-transcript">
          {entry.turns.map((turn, index) => (
            <li key={index}>
              <span className="meetings-time">{timestamp(turn.start)}</span>
              <span><strong>{turn.speaker || 'Unknown speaker'}</strong> {turn.text}</span>
            </li>
          ))}
        </ol>
      ) : entry.transcript.trim() ? (
        <p className="meetings-plain">{entry.transcript}</p>
      ) : (
        <p className="muted small">No transcript.</p>
      )}
      {entry.turns.length > 0 && (
        <details>
          <summary>Full original transcript</summary>
          <p className="meetings-plain">{entry.transcript}</p>
        </details>
      )}
    </div>
  );
}

function ImportSummary({ label, result, onDone }: { label: string; result: BiscottiImportResult; onDone: () => void }) {
  const { openItem } = useApp();
  return (
    <div className="meetings-panel meetings-result">
      <p role="status">
        <strong>{label}:</strong> imported {result.created}, skipped {result.skipped} already saved{result.failed.length ? `, ${result.failed.length} failed` : ''}.
      </p>
      {result.items.length > 0 && (
        <ul className="meetings-saved">
          {result.items.slice(0, SHOWN).map((item) => (
            <li key={item.id}>
              <span>{untitled(item.title)}</span>
              {!item.created && <span className="muted small">already saved</span>}
              <button className="link-button" onClick={() => openItem(item.id)}>Open note</button>
            </li>
          ))}
        </ul>
      )}
      {result.items.length > SHOWN && <p className="muted small">The other {result.items.length - SHOWN} are in the list below.</p>}
      {result.failed.length > 0 && (
        <ul className="meetings-failed">
          {result.failed.slice(0, SHOWN).map((failure) => <li key={failure.source}><span>{failure.source}</span> <span className="error-text">{failure.error}</span></li>)}
        </ul>
      )}
      <div className="inline-actions"><button className="button ghost small" onClick={onDone}>Done</button></div>
    </div>
  );
}

/** Imported meeting notes, ordered by their last library update. */
function MeetingLibrary({ mac }: { mac: boolean }) {
  const { projects } = useApp();
  const [project, setProject] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [filter, setFilter] = useState('');
  const meetings = useLive(async () => {
    const items: BiscottiSavedMeeting[] = [];
    let before: string | null = null;
    for (let page = 0; page < pages; page++) {
      const result: BiscottiMeetingPage = await call('biscotti.list', { ...(project ? { project } : {}), ...(before ? { before } : {}), limit: PAGE_SIZE });
      items.push(...result.items);
      if (!result.next) return { items, more: false, pages, project };
      before = result.next;
    }
    return { items, more: true, pages, project };
  }, [project, pages]);

  // A list for another project is never shown while the chosen one loads.
  const data = meetings.data?.project === project ? meetings.data : undefined;
  const items = data?.items ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? items.filter((meeting) => [meeting.title, meeting.summary, ...meeting.speakers, ...meeting.participants].some((text) => text.toLowerCase().includes(needle)))
    : items;
  const loadingMore = data !== undefined && data.pages !== pages;

  return (
    <section className="meetings-library" aria-labelledby="meetings-library-heading">
      <h3 id="meetings-library-heading">Imported meetings</h3>
      <div className="meetings-toolbar">
        <ProjectSelect
          value={project}
          onChange={(next) => {
            setProject(next);
            setPages(1);
          }}
          projects={projects}
          emptyLabel="All projects"
          label="Show meetings from"
        />
        <input type="search" aria-label="Filter loaded meetings" placeholder="Filter loaded meetings" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {meetings.error && <p className="error-text" role="alert">{meetings.error.message}</p>}
      {!data && !meetings.error && <p className="muted" role="status">Loading meetings…</p>}
      {data && items.length === 0 && (
        <Empty title={project ? 'No meetings in this project' : 'No meetings yet'}>
          {project ? 'Choose another project, or import meetings into this one.'
            : mac ? 'Import a Biscotti CSV export or browse the Biscotti app, then choose which meetings to keep.'
              : 'Import a CSV export from Biscotti, then choose which meetings to keep.'}
        </Empty>
      )}
      {needle && items.length > 0 && (
        <p className="muted small" role="status">{shown.length} of {plural(items.length, 'loaded meeting')} match.</p>
      )}
      {shown.length > 0 && (
        <ul className="meetings-list">
          {shown.map((meeting) => <MeetingCard key={meeting.id} meeting={meeting} mac={mac} />)}
        </ul>
      )}
      {data?.more && (
        <button className="button small ghost meetings-more" disabled={loadingMore} onClick={() => setPages(pages + 1)}>
          {loadingMore ? 'Loading…' : 'Load older meetings'}
        </button>
      )}
    </section>
  );
}

function MeetingCard({ meeting, mac }: { meeting: BiscottiSavedMeeting; mac: boolean }) {
  const { openItem, go } = useApp();
  const { toast } = useFeedback();
  const [scheduling, setScheduling] = useState(false);
  const titleId = useId();
  const title = untitled(meeting.title);
  const playable = mac && UUID.test(meeting.meetingId);
  const summary = snippet(meeting.summary);

  const openInBiscotti = (seconds?: number) => {
    const opening = seconds === undefined ? call('biscotti.open', meeting.meetingId) : call('biscotti.open', meeting.meetingId, seconds);
    opening.catch((err: unknown) => toast(errorMessage(err), 'error'));
  };

  const askAi = (action: AiAction) => {
    const label = `“${title}” (${meetingDate(meeting.date)})`;
    const key = `meeting-${meeting.id}-${++seeds}`;
    const seed: AskSeed = action === 'ask' || action === 'prepare'
      ? { key, mode: 'ask', draft: action === 'ask' ? `What was discussed and decided in my meeting ${label}? Cite the source notes.`
        : `Help me prepare for the next meeting after ${label}. Use the meeting and related project notes to identify open questions, promises and preparation. Do not invent owners or deadlines.`,
        ...(meeting.project ? { project: meeting.project.id } : {}) }
      : { key, mode: 'actions', targetId: meeting.id, draft: ACTION_DRAFTS[action](label) };
    go({ view: 'ask', seed });
  };

  const scheduleReview = () => {
    if (scheduling) return;
    setScheduling(true);
    call('review.schedule', meeting.id, 7).then(
      () => toast(`“${title}” will be in Review in a week`),
      (err: unknown) => toast(errorMessage(err), 'error'),
    ).finally(() => setScheduling(false));
  };

  return (
    <li className="meetings-card">
      <article aria-labelledby={titleId}>
        <div className="meetings-card-head">
          <h4 id={titleId}><button className="link-button heading" onClick={() => openItem(meeting.id)}>{title}</button></h4>
          <span className="muted small">{meetingDate(meeting.date)}</span>
        </div>
        <p className="muted small meetings-meta">
          <span className="meetings-badge">{meeting.source === 'csv' ? 'CSV' : 'Biscotti app'}</span>
          <span>{meeting.project?.name ?? 'Inbox'}</span>
          {meeting.speakers.length > 0 && <span>{names(meeting.speakers)}</span>}
        </p>
        {summary && <p className="meetings-snippet">{summary}</p>}
        <div className="inline-actions">
          <button className="button small" onClick={() => openItem(meeting.id)}><Icon name="note" size={14} /> Open note</button>
          {playable && (
            <button className="button small ghost" onClick={() => openInBiscotti()}><Icon name="external" size={14} /> Open in Biscotti</button>
          )}
        </div>
        <div className="chips meetings-ai" role="group" aria-label={`Work with ${title}`}>
          {AI_ACTIONS.map(({ action, label }) => (
            <button key={action} className="chip" onClick={() => askAi(action)}><Icon name="sparkle" size={12} /> {label}</button>
          ))}
          <button className="chip" disabled={scheduling} onClick={scheduleReview}><Icon name="review" size={12} /> {scheduling ? 'Scheduling…' : 'Review in a week'}</button>
        </div>
        {meeting.moments.length > 0 && (
          <details className="meetings-moments">
            <summary>{plural(meeting.moments.length, 'moment')}</summary>
            <ul>
              {meeting.moments.map((moment, index) => (
                <li key={index}>
                  {playable ? (
                    <button
                      className="button ghost small"
                      aria-label={`Play from ${timestamp(moment.start)} in Biscotti${moment.speaker ? `, ${moment.speaker}` : ''}`}
                      onClick={() => openInBiscotti(moment.start)}
                    >
                      <span className="meetings-time">{timestamp(moment.start)}</span> {moment.speaker}
                    </button>
                  ) : (
                    <span className="small"><span className="meetings-time">{timestamp(moment.start)}</span> {moment.speaker}</span>
                  )}
                </li>
              ))}
            </ul>
            {!playable && (
              <p className="muted small">{mac ? 'This meeting can’t be opened in Biscotti.' : 'Moments play in Biscotti on a Mac.'}</p>
            )}
          </details>
        )}
      </article>
    </li>
  );
}
