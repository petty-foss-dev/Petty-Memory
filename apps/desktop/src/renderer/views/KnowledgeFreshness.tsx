import type { FreshnessDates, FreshnessItem, FreshnessRef, StaleItems } from '@enve-memory/core';
import type { FreshnessEvidence, FreshnessProposal, FreshnessSuggestion } from '@enve-memory/ai';
import { useState } from 'react';
import { errorMessage } from '../lib/api.ts';
import { TYPE_LABELS, formatDate } from '../lib/format.ts';
import { knowledgeRequest } from '../lib/knowledge.ts';
import { useApp } from '../context.ts';
import { Empty, Icon, ProjectSelect, TypeIcon, useFeedback } from '../ui.tsx';
import { ItemPicker, type Picked } from './ItemPicker.tsx';
import { LiveStatus, knowledgePath, plural, useKnowledge } from './KnowledgeCommon.tsx';

const DAYS_MAX = 36_500;
const TOPIC_MAX = 500;

const ref = (item: Pick<FreshnessItem, 'id' | 'stateHash'>): FreshnessRef => ({ id: item.id, stateHash: item.stateHash });

function Dates({ dates }: { dates: FreshnessDates }) {
  return (
    <span className="muted small freshness-dates">
      {dates.publishedAt && <>Published {formatDate(dates.publishedAt)} · </>}
      Saved {formatDate(dates.capturedAt)} · Edited {formatDate(dates.editedAt)}
      {dates.checkedAt && <> · Checked {formatDate(dates.checkedAt)}</>}
    </span>
  );
}

/** Information review: what hasn’t been looked at in a while, and quoted passages that may disagree. Nothing is rewritten. */
export function Freshness() {
  return (
    <section className="knowledge-section" aria-labelledby="freshness-heading">
      <div className="panel-header">
        <h2 id="freshness-heading">Information review</h2>
      </div>
      <p className="note">
        Find notes, links and files you haven’t checked or changed in a while, and ask the AI to point out passages that may disagree.
        It shows the exact quotes and their dates; deciding which is right is up to you. Marking something checked, dismissing a pair or
        superseding an older note never changes their text.
      </p>
      <StaleReview />
      <ConflictReview />
    </section>
  );
}

function StaleReview() {
  const { projects, openItem } = useApp();
  const { toast } = useFeedback();
  const [days, setDays] = useState('90');
  const [project, setProject] = useState<string | null>(null);
  const [query, setQuery] = useState<{ days: number; project: string | null }>({ days: 90, project: null });
  const stale = useKnowledge<StaleItems>(knowledgePath('/freshness/stale', { days: query.days, project: query.project }));
  const [checking, setChecking] = useState<string | null>(null);
  const valid = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= DAYS_MAX;

  const markChecked = async (item: FreshnessItem) => {
    setChecking(item.id);
    try {
      await knowledgeRequest('/freshness/check', 'POST', { ...ref(item) });
      toast(`Marked “${item.title || 'item'}” as checked`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setChecking(null);
    }
  };

  return (
    <section className="detail-section" aria-labelledby="stale-heading">
      <h2 id="stale-heading">Not checked in a while</h2>
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); if (valid) setQuery({ days: Number(days), project }); }}>
        <label className="field inline freshness-days">
          <span>Older than (days)</span>
          <input type="number" min={1} max={DAYS_MAX} value={days} aria-invalid={!valid} onChange={(event) => setDays(event.target.value)} />
        </label>
        <label className="field inline">
          <span>Project</span>
          <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel="Whole library" />
        </label>
        <button type="submit" className="button small" disabled={!valid}>Show</button>
      </form>
      <LiveStatus live={stale} />
      {stale.data && stale.data.items.length === 0 && <Empty title="Everything is recent">Nothing here is older than {plural(stale.data.olderThanDays, 'day')}.</Empty>}
      {stale.data && stale.data.items.length > 0 && (
        <>
          <p className="muted small" role="status">
            {stale.data.total > stale.data.items.length ? `The oldest ${stale.data.items.length} of ${stale.data.total.toLocaleString()} items` : plural(stale.data.total, 'item')} not edited or checked since {formatDate(stale.data.cutoff)}.
          </p>
          <ul className="insight-list">
            {stale.data.items.map((item) => (
              <li key={item.id}>
                <div className="insight-main">
                  <button className="link-button" onClick={() => openItem(item.id)}><TypeIcon type={item.type} size={14} /> {item.title || item.url || `Untitled ${TYPE_LABELS[item.type].toLowerCase()}`}</button>
                  <span className="small">{plural(item.ageDays, 'day')} since it was {item.basis === 'checked' ? 'last checked' : 'last edited'}</span>
                  <Dates dates={item.dates} />
                </div>
                <button className="button small" disabled={checking === item.id} onClick={() => void markChecked(item)}>
                  <Icon name="check" size={14} /> {checking === item.id ? 'Saving…' : 'Mark checked'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type ScopeKind = 'topic' | 'project' | 'branch';

function ConflictReview() {
  const { projects, info, go } = useApp();
  const [kind, setKind] = useState<ScopeKind>('topic');
  const [topic, setTopic] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [branch, setBranch] = useState<Picked | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FreshnessProposal | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  const scope = kind === 'branch' ? (branch ? { rootId: branch.id } : null)
    : kind === 'project' ? (project ? { project } : null)
      : topic.trim() ? { query: topic.trim(), ...(project ? { project } : {}) } : null;

  const analyze = async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      setAnalysis(await knowledgeRequest<FreshnessProposal>('/freshness/analyze', 'POST', scope));
      setDone({});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail-section" aria-labelledby="conflicts-heading">
      <h2 id="conflicts-heading">Passages that may disagree</h2>
      {info && !info.aiEnabled && (
        <p className="warning small">This needs an AI provider. <button className="link-button" onClick={() => go({ view: 'settings', section: 'ai' })}>Set one up in AI settings</button></p>
      )}
      <form className="freshness-scope" onSubmit={(event) => { event.preventDefault(); void analyze(); }}>
        <div className="segmented small" role="radiogroup" aria-label="Review">
          {([['topic', 'A topic'], ['project', 'A project'], ['branch', 'A note and what’s inside it']] as const).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>
          ))}
        </div>
        <div className="toolbar">
          {kind === 'topic' && <input type="search" aria-label="Topic keywords" maxLength={TOPIC_MAX} placeholder="Topic, e.g. opening hours" value={topic} onChange={(event) => setTopic(event.target.value)} />}
          {kind !== 'branch' && (
            <ProjectSelect value={project} onChange={setProject} projects={projects} emptyLabel={kind === 'project' ? 'Choose a project' : 'Whole library'} label="Project" />
          )}
          {kind === 'branch' && <button type="button" className="button small" onClick={() => setPicking(true)}><Icon name="note" size={14} /> {branch ? `Note: ${branch.title}` : 'Choose a note…'}</button>}
          <button type="submit" className="button small primary" disabled={busy || !scope || !info?.aiEnabled}><Icon name="sparkle" size={14} /> {busy ? 'Reading…' : 'Look for disagreements'}</button>
        </div>
        <p className="muted small">Up to 100 matching notes, links and files are sent to your AI provider. Secret notes, decisions and templates are left out.</p>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
      {analysis && (analysis.suggestions.length === 0 ? (
        <p className="muted" role="status">{analysis.message} Compared {plural(analysis.scanned, 'item')}.</p>
      ) : (
        <>
          <p className="muted small" role="status">{plural(analysis.suggestions.length, 'possible disagreement')} among {plural(analysis.scanned, 'item')}. {analysis.message}</p>
          {analysis.rejected > 0 && <p className="muted small">{plural(analysis.rejected, 'suggestion')} omitted because its quotes or references could not be verified.</p>}
          <ul className="freshness-list">
            {analysis.suggestions.map((suggestion) => {
              const key = [suggestion.kind, ...suggestion.items.map((item) => item.id).sort()].join(':');
              return (
                <ConflictCard
                  key={key}
                  suggestion={suggestion}
                  pair={suggestion.items}
                  outcome={done[key]}
                  onDone={(outcome) => setDone((current) => ({ ...current, [key]: outcome }))}
                />
              );
            })}
          </ul>
        </>
      ))}
      {picking && (
        <ItemPicker
          title="Choose a note to review"
          filter={{ secret: false }}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false);
            setBranch(picked);
          }}
        />
      )}
    </section>
  );
}

function ConflictCard({ suggestion, pair, outcome, onDone }: {
  suggestion: FreshnessSuggestion;
  pair: [FreshnessEvidence, FreshnessEvidence];
  outcome: string | undefined;
  onDone: (outcome: string) => void;
}) {
  const { openItem } = useApp();
  const { confirm } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = (item: FreshnessEvidence) => item.title || `Untitled ${TYPE_LABELS[item.type].toLowerCase()}`;
  const notes = pair.every((item) => item.type === 'note');

  const act = async (action: () => Promise<unknown>, result: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const keep = async (newer: FreshnessEvidence, older: FreshnessEvidence) => {
    if (!(await confirm({
      title: `Keep “${title(newer)}” as current?`,
      body: (
        <p>
          “{title(older)}” is marked as superseded by “{title(newer)}”, with a permanent connection between them. Neither text is changed or
          deleted, and both keep their history. The older note stops appearing in future reviews.
        </p>
      ),
      confirmLabel: 'Mark older as superseded',
    }))) return;
    await act(() => knowledgeRequest('/freshness/supersede', 'POST', { newer: ref(newer), older: ref(older) }), `Kept “${title(newer)}”; “${title(older)}” is marked superseded.`);
  };

  return (
    <li className="knowledge-card">
      <p className="small"><span className="badge">AI’s note, not a verdict</span> {suggestion.reason}</p>
      <div className="freshness-pair">
        {pair.map((item, index) => (
          <div key={item.id} className="freshness-side">
            <button className="link-button" onClick={() => openItem(item.id)}><TypeIcon type={item.type} size={14} /> {title(item)}</button>
            <Dates dates={item.dates} />
            <blockquote className="research-quote">{suggestion.items[index]!.quote}</blockquote>
          </div>
        ))}
      </div>
      {outcome ? <p className="ok-text small" role="status">{outcome}</p> : (
        <div className="inline-actions">
          <button className="button small" disabled={busy} onClick={() => void act(() => knowledgeRequest('/freshness/dismiss', 'POST', { refs: pair.map(ref) }), 'Dismissed. This pair won’t be suggested again.')}>
            Not a conflict
          </button>
          {notes ? pair.map((item, index) => (
            <button key={item.id} className="button small" disabled={busy} onClick={() => void keep(item, pair[1 - index]!)}>Keep “{title(item)}”…</button>
          )) : <span className="muted small">Only two notes can supersede each other. Open the items to update them, or mark them checked.</span>}
        </div>
      )}
      {error && <p className="error-text small" role="alert">{error}</p>}
    </li>
  );
}
