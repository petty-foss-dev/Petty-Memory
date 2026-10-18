import type { SourceApplyResult, SourceCandidate, SourceCheck, SourceQueue, WatchKind, WatchedSource } from '@enve-memory/core';
import { useState } from 'react';
import { call, errorMessage } from '../lib/api.ts';
import { formatBytes, formatDate, relativeTime } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, Modal, ProjectSelect, Toggle, useFeedback } from '../ui.tsx';
import { LiveStatus, plural, useKnowledge } from './KnowledgeCommon.tsx';

const NAME_MAX = 120;
const URL_MAX = 2048;
const APPLY_MAX = 20;

const KIND_LABELS: Record<WatchKind, string> = { url: 'Web page', rss: 'Feed', folder: 'Folder' };

const path = (watch: { id: string }, rest = '') => `/sources/${encodeURIComponent(watch.id)}${rest}`;

function CheckSummary({ check }: { check: SourceCheck | null }) {
  if (!check) return <span className="muted small">Not checked yet.</span>;
  if (check.status !== 'ok') {
    return <span className="error-text small">Last check {relativeTime(check.at)} {check.status === 'stale' ? 'was stale' : 'failed'}: {check.error}</span>;
  }
  return (
    <span className="muted small">
      Checked {relativeTime(check.at)}: {plural(check.found, 'entry', 'entries')} found, {check.queued} waiting for review, {check.unchanged} unchanged
      {check.skipped > 0 && `, ${check.skipped} skipped (archived, too large or unreadable)`}.
      {check.truncated && <strong className="warning"> More was available than one check reads; check again after reviewing.</strong>}
    </span>
  );
}

/** Opt-in watches on pages, feeds and approved folders. Checks only queue previews; nothing enters the library until it’s applied. */
export function Sources() {
  const { toast } = useFeedback();
  const list = useKnowledge<WatchedSource[]>('/sources');
  const [editing, setEditing] = useState<WatchedSource | 'new' | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  return (
    <section className="knowledge-section" aria-labelledby="sources-heading">
      <div className="panel-header">
        <h2 id="sources-heading">Watched sources</h2>
        <button className="button primary small" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Watch a source</button>
      </div>
      <p className="note">
        Keep an eye on a web page, a feed or a folder of documents on this computer. Enabled watches are checked from time to time, and you
        can check any of them now. New and changed material waits here for review: nothing is imported, and nothing you saved is updated,
        until you tick it and choose Apply. Earlier versions stay in each item’s history.
      </p>
      <LiveStatus live={list} />
      {list.data?.length === 0 && <Empty title="No watched sources">Watch a blog’s feed, a documentation page or a folder where you save PDFs.</Empty>}
      <ul className="knowledge-list">
        {(list.data ?? []).map((watch) => (
          <WatchCard
            key={watch.id}
            watch={watch}
            reviewing={reviewing === watch.id}
            onReview={() => setReviewing(reviewing === watch.id ? null : watch.id)}
            onEdit={() => setEditing(watch)}
          />
        ))}
      </ul>
      {editing && (
        <WatchForm
          watch={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) toast(editing === 'new' ? (saved.kind === 'folder' ? 'Watch saved. Choose its folder next.' : 'Watch saved') : 'Watch updated');
          }}
        />
      )}
    </section>
  );
}

function WatchCard({ watch, reviewing, onReview, onEdit }: { watch: WatchedSource; reviewing: boolean; onReview: () => void; onEdit: () => void }) {
  const { toast, confirm } = useFeedback();
  const [busy, setBusy] = useState<'check' | 'folder' | 'toggle' | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);
  const folder = watch.folder;
  const checkable = watch.kind !== 'folder' || Boolean(folder?.available);

  const act = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const check = () => act('check', async () => {
    const queue = await knowledgeRequest<SourceQueue>(path(watch, '/check'), 'POST');
    setQueueVersion((version) => version + 1);
    toast(queue.check?.status === 'ok' ? (queue.candidates.length ? `${plural(queue.candidates.length, 'item')} to review` : 'Nothing new') : queue.check?.error ?? 'Checked');
  });

  const approve = () => act('folder', async () => {
    const result = await call('sources.approveFolder', watch.id);
    if (result) toast('Folder approved on this computer');
  });

  const forget = async () => {
    if (!(await confirm({
      title: 'Forget this folder?',
      body: <p>This computer stops reading the folder for “{watch.name}”, and its waiting previews are cleared. Files already imported stay in your library.</p>,
      confirmLabel: 'Forget folder',
    }))) return;
    await act('folder', () => knowledgeRequest(path(watch, '/revoke-folder'), 'POST'));
  };

  const remove = async () => {
    if (!(await confirm({
      title: 'Stop watching this source?',
      body: <p>“{watch.name}” is archived and its waiting previews are cleared. Everything already imported stays in your library.</p>,
      confirmLabel: 'Stop watching',
      danger: true,
    }))) return;
    knowledgeRequest(path(watch), 'DELETE').then(() => toast('Watch removed'), (error: unknown) => toast(errorMessage(error), 'error'));
  };

  return (
    <li className="knowledge-card">
      <div className="knowledge-card-head">
        <strong>{watch.name}</strong>
        <span className="badge">{KIND_LABELS[watch.kind]}</span>
        {watch.project && <span className="project-chip">{watch.project.name}</span>}
        <label className="check small watch-enabled">
          <Toggle
            label={`Check ${watch.name} periodically`}
            checked={watch.enabled}
            disabled={busy !== null}
            onChange={(enabled) => void act('toggle', () => knowledgeRequest(path(watch), 'PATCH', { enabled }))}
          />
          {watch.enabled ? 'Checked periodically' : 'Checked only when you ask'}
        </label>
      </div>
      {watch.url && <span className="muted small watch-url">{watch.url}</span>}
      {folder && (
        <p className={`small ${folder.approved && !folder.available ? 'error-text' : 'muted'}`}>
          {!folder.approved ? 'No folder approved on this computer yet. Choose one to start checking it.'
            : folder.available ? 'Folder approved on this computer. Only its top level is read: Markdown, text and PDF files.'
              : 'The approved folder can’t be read now. It may be on a disconnected drive, or it was moved or renamed. Reconnect it, or choose it again.'}
        </p>
      )}
      <CheckSummary check={watch.lastCheck} />
      <div className="inline-actions">
        <button className="button small" disabled={busy !== null || !checkable} title={checkable ? undefined : 'Choose a folder that this computer can read first'} onClick={() => void check()}>
          <Icon name="refresh" size={14} /> {busy === 'check' ? 'Checking…' : 'Check now'}
        </button>
        {folder && <button className="button small" disabled={busy !== null} onClick={() => void approve()}>{folder.approved ? 'Choose another folder…' : 'Choose folder…'}</button>}
        {folder?.approved && <button className="button small ghost" disabled={busy !== null} onClick={() => void forget()}>Forget folder…</button>}
        <button className={`button small ${watch.pending ? 'primary' : ''}`} disabled={!watch.pending && !reviewing} aria-expanded={reviewing} onClick={onReview}>
          {reviewing ? 'Hide review' : watch.pending ? `Review ${watch.pending}` : 'Nothing to review'}
        </button>
        <button className="button small" onClick={onEdit}>Edit…</button>
        <button className="button small danger-ghost" onClick={() => void remove()}><Icon name="archive" size={14} /> Stop watching…</button>
      </div>
      {reviewing && <ReviewQueue key={queueVersion} watch={watch} />}
    </li>
  );
}

/** The waiting previews. Ticks survive the queue refreshing underneath; only previews still waiting can be applied. */
function ReviewQueue({ watch }: { watch: WatchedSource }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const queue = useKnowledge<SourceQueue>(path(watch, '/queue'));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<SourceApplyResult | null>(null);
  const candidates = queue.data?.candidates ?? [];
  const chosen = candidates.filter((candidate) => ticked.has(candidate.id)).map((candidate) => candidate.id);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await knowledgeRequest<SourceApplyResult>(path(watch, '/apply'), 'POST', { candidateIds: chosen });
      setApplied(result);
      setTicked(new Set());
      toast(`Applied ${plural(result.applied.length, 'item')}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="watch-review">
      <LiveStatus live={queue} label="Loading previews…" />
      {queue.data && candidates.length === 0 && <p className="muted small">Nothing is waiting. Check the source to look for new material.</p>}
      {candidates.length > 0 && (
        <>
          <div className="inline-actions">
            <button className="button small ghost" disabled={busy} onClick={() => setTicked(new Set(candidates.slice(0, APPLY_MAX).map((c) => c.id)))}>
              Tick {candidates.length > APPLY_MAX ? `first ${APPLY_MAX}` : 'all'}
            </button>
            <button className="button small ghost" disabled={busy || !chosen.length} onClick={() => setTicked(new Set())}>Clear ticks</button>
          </div>
          <ul className="proposal-list" aria-label="Previews waiting for review">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                ticked={ticked.has(candidate.id)}
                disabled={busy || (!ticked.has(candidate.id) && chosen.length >= APPLY_MAX)}
                onToggle={(on) => toggle(candidate.id, on)}
                onOpen={openItem}
              />
            ))}
          </ul>
          <div className="inline-actions">
            <button className="button small primary" disabled={busy || !chosen.length} onClick={() => void apply()}>
              {busy ? 'Applying…' : `Apply ${plural(chosen.length, 'selected preview')}`}
            </button>
            <span className="muted small">Up to {APPLY_MAX} at a time. A preview that changed since it was checked is refused; check again for a fresh one.</span>
          </div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      {applied && applied.applied.length > 0 && (
        <ul className="mini-list" aria-label="Just applied">
          {applied.applied.map((entry) => (
            <li key={entry.candidateId}>
              <button onClick={() => openItem(entry.itemId)}>
                <span>{entry.change === 'new' ? 'Imported' : 'Updated'}{entry.previousId ? ' (earlier file kept and linked)' : ''}</span>
                <span className="muted small">Open</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({ candidate, ticked, disabled, onToggle, onOpen }: {
  candidate: SourceCandidate;
  ticked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <label className="check">
        <input type="checkbox" checked={ticked} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
        <div className="proposal-diff">
          <strong>
            <span className={`badge ${candidate.change === 'new' ? 'suggested' : 'pending'}`}>{candidate.change === 'new' ? 'New' : 'Changed'}</span> {candidate.title}
          </strong>
          {candidate.url && <span className="muted small watch-url">{candidate.url}</span>}
          <span className="muted small">
            {candidate.publishedAt && `Published ${formatDate(candidate.publishedAt)} · `}
            {candidate.file && `${formatBytes(candidate.file.size)} · modified ${formatDate(candidate.file.modifiedAt)} · `}
            Checked {relativeTime(candidate.checkedAt)}
          </span>
          {candidate.change === 'changed' && candidate.targetId && (
            <span className="small">
              {candidate.file ? 'Saved as a new file that supersedes ' : 'Replaces the source text of '}
              <button type="button" className="link-button" onClick={() => onOpen(candidate.targetId!)}>your current copy</button>; your own note on it is kept.
            </span>
          )}
          {candidate.text ? (
            <details>
              <summary className="small">{candidate.file ? 'Preview of the file' : 'Text that would be saved'}{candidate.truncated ? ' (shortened)' : ''}</summary>
              <div className="merge-preview">{candidate.text}</div>
            </details>
          ) : candidate.file && <span className="muted small">PDF files are read after import.</span>}
        </div>
      </label>
    </li>
  );
}

function WatchForm({ watch, onClose }: { watch: WatchedSource | null; onClose: (saved: WatchedSource | null) => void }) {
  const { projects } = useApp();
  const [name, setName] = useState(watch?.name ?? '');
  const [kind, setKind] = useState<WatchKind>(watch?.kind ?? 'rss');
  const [url, setUrl] = useState(watch?.url ?? '');
  const [project, setProject] = useState<string | null>(watch?.project?.id ?? null);
  const [enabled, setEnabled] = useState(watch?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsUrl = kind !== 'folder';

  const save = async () => {
    if (!name.trim() || (needsUrl && !url.trim())) {
      setError(needsUrl ? 'Name the watch and give its address.' : 'Name the watch.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = watch
        ? await knowledgeRequest<WatchedSource>(path(watch), 'PATCH', { name: name.trim(), project, enabled, ...(needsUrl ? { url: url.trim() } : {}) })
        : await knowledgeRequest<WatchedSource>('/sources', 'POST', { name: name.trim(), kind, project, enabled, ...(needsUrl ? { url: url.trim() } : {}) });
      onClose(saved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal label={watch ? 'Edit watch' : 'Watch a source'} onClose={() => onClose(null)} busy={busy} className="workflow-dialog">
      <h2>{watch ? 'Edit watch' : 'Watch a source'}</h2>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {!watch && (
          <fieldset className="field">
            <legend>Kind</legend>
            {(Object.keys(KIND_LABELS) as WatchKind[]).map((value) => (
              <label key={value} className="check">
                <input type="radio" name="watch-kind" checked={kind === value} onChange={() => setKind(value)} /> {KIND_LABELS[value]}
                <span className="muted small">
                  {value === 'url' ? ' · one page, saved as a link' : value === 'rss' ? ' · RSS or Atom entries, each saved as a link' : ' · a folder on this computer, chosen after saving'}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span>Name</span>
          <input autoFocus maxLength={NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {needsUrl && (
          <label className="field">
            <span>{kind === 'rss' ? 'Feed address' : 'Page address'}</span>
            <input type="url" maxLength={URL_MAX} value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Save into</span>
          <ProjectSelect value={project} onChange={setProject} projects={projects} />
        </label>
        <label className="check">
          <Toggle label="Check periodically" checked={enabled} onChange={setEnabled} /> Check periodically on this computer
        </label>
        <p className="muted small">Checks only look for changes. You review and apply every import or update yourself.</p>
        {watch && needsUrl && <p className="muted small">Changing the address or project clears previews already waiting.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
          <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : watch ? 'Save changes' : 'Save watch'}</button>
        </div>
      </form>
    </Modal>
  );
}
