import type { EditorActionResult, ItemDetail } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import type { ItemInsights, KnowledgeSuggestion, MergeProposal } from '../../shared/ipc.ts';
import { call, errorMessage } from '../lib/api.ts';
import { displayTitle, snippetParts } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Icon, Modal, useFeedback } from '../ui.tsx';

type Group = 'mentions' | 'related' | 'duplicates';

const GROUPS: [Group, string, string][] = [
  ['mentions', 'Unlinked mentions', 'No other notes mention this one without linking to it.'],
  ['related', 'Related notes', 'Nothing else looks closely related.'],
  ['duplicates', 'Possible duplicates', 'No likely duplicates.'],
];

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'done'; insights: ItemInsights } | { status: 'failed'; message: string };

/** Connections found without AI, offered for the user to accept one at a time. */
export function InsightsSection({ item }: { item: ItemDetail }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [merging, setMerging] = useState<KnowledgeSuggestion | null>(null);
  const connected = new Set(item.relations.map((relation) => relation.id));

  const find = () => {
    setLoad({ status: 'loading' });
    call('insights.forItem', item.id).then(
      (insights) => setLoad({ status: 'done', insights }),
      (err: unknown) => setLoad({ status: 'failed', message: errorMessage(err) }),
    );
  };

  const connect = (suggestion: KnowledgeSuggestion) => {
    setConnecting(suggestion.id);
    call('items.relate', item.id, suggestion.id, 'related_to')
      .then(() => toast(`Connected to “${suggestion.title || 'Untitled'}”`), (err: unknown) => toast(errorMessage(err), 'error'))
      .finally(() => setConnecting(null));
  };

  const insights = load.status === 'done' ? load.insights : null;
  const found = insights ? GROUPS.reduce((sum, [group]) => sum + insights[group].length, 0) : 0;

  return (
    <section className="detail-section insights" aria-labelledby={`insights-${item.id}`}>
      <div className="panel-header">
        <h2 id={`insights-${item.id}`}>Suggested connections</h2>
        <button className="button small" disabled={load.status === 'loading'} onClick={find}>
          <Icon name={insights ? 'refresh' : 'search'} size={14} /> {insights ? 'Check again' : 'Find connections'}
        </button>
      </div>
      {load.status === 'loading' && <p className="muted small" role="status">Looking through your library…</p>}
      {load.status === 'failed' && <p className="error-text small" role="alert">{load.message}</p>}
      {insights && (
        <>
          <p className="muted small" role="status">
            {found ? `Found ${found} suggestion${found === 1 ? '' : 's'}` : 'Found no suggestions'}
            {insights.scanned < insights.total
              ? ` after checking ${insights.scanned.toLocaleString()} of ${insights.total.toLocaleString()} items.`
              : ` after checking all ${insights.total.toLocaleString()} items.`}
          </p>
          {GROUPS.map(([group, title, none]) => (
            <div key={group} className="insight-group">
              <h3 className="small">{title}</h3>
              {insights[group].length === 0 ? <p className="muted small">{none}</p> : (
                <ul className="insight-list">
                  {insights[group].map((suggestion) => (
                    <li key={suggestion.id}>
                      <div className="insight-main">
                        <button className="link-button" onClick={() => openItem(suggestion.id)}>{suggestion.title || 'Untitled'}</button>
                        {suggestion.snippet && (
                          <p className="muted small insight-snippet">
                            {snippetParts(suggestion.snippet).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                          </p>
                        )}
                        <p className="muted small">{suggestion.reason}</p>
                      </div>
                      <div className="inline-actions">
                        {connected.has(suggestion.id) ? (
                          <span className="badge">Connected</span>
                        ) : (
                          <button className="button small" disabled={connecting !== null} onClick={() => connect(suggestion)}>
                            {connecting === suggestion.id ? 'Connecting…' : 'Connect'}
                          </button>
                        )}
                        {group === 'duplicates' && item.type === 'note' && !item.archivedAt && (
                          <button className="button small" onClick={() => setMerging(suggestion)}><Icon name="merge" size={14} /> Merge…</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
      {merging && <MergeDialog item={item} other={merging} onClose={() => setMerging(null)} />}
    </section>
  );
}

type Preview = { status: 'loading' } | { status: 'ready'; proposal: MergeProposal } | { status: 'failed'; message: string };

/** Previews a merge of two notes, applies it only with consent, then offers the journal's undo and redo. */
function MergeDialog({ item, other, onClose }: { item: ItemDetail; other: KnowledgeSuggestion; onClose: () => void }) {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [keepThis, setKeepThis] = useState(true);
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ result: EditorActionResult; undone: boolean; proposal: MergeProposal } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const thisTitle = displayTitle(item);
  const otherTitle = other.title || 'Untitled';
  const [sourceId, targetId] = keepThis ? [other.id, item.id] : [item.id, other.id];

  useEffect(() => {
    let current = true;
    setPreview({ status: 'loading' });
    setConsent(false);
    setError(null);
    call('insights.previewMerge', sourceId, targetId).then(
      (proposal) => current && setPreview({ status: 'ready', proposal }),
      (err: unknown) => current && setPreview({ status: 'failed', message: errorMessage(err) }),
    );
    return () => {
      current = false;
    };
  }, [sourceId, targetId, attempt]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const merge = () => run(async () => {
    if (preview.status !== 'ready') return;
    const result = await call('insights.merge', preview.proposal);
    setApplied({ result, undone: false, proposal: preview.proposal });
  });

  const undoOrRedo = () => run(async () => {
    if (!applied) return;
    await call(applied.undone ? 'editor.redo' : 'editor.undo', applied.result.actionId);
    toast(applied.undone ? 'Merge redone' : 'Merge undone; both notes are back as they were');
    setApplied({ ...applied, undone: !applied.undone });
  });

  const proposal = preview.status === 'ready' ? preview.proposal : null;

  return (
    <Modal label="Merge notes" onClose={onClose} busy={busy} className="ai-edit-dialog merge-dialog">
      <h2><Icon name="merge" size={18} /> Merge notes</h2>
      {applied ? (
        <>
          <p>
            {applied.undone
              ? `Undone. “${applied.proposal.sourceTitle}” and “${applied.proposal.targetTitle}” are separate again.`
              : `Merged “${applied.proposal.sourceTitle}” into “${applied.proposal.targetTitle}”. The original is archived with its files.`}
          </p>
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => void undoOrRedo()}>{busy ? 'Working…' : applied.undone ? 'Redo merge' : 'Undo merge'}</button>
            {!applied.undone && (
              <button className="button" disabled={busy} onClick={() => {
                onClose();
                openItem(applied.proposal.targetId);
              }}>Open “{applied.proposal.targetTitle}”</button>
            )}
            <button className="button primary" disabled={busy} onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <fieldset className="merge-direction">
            <legend className="small muted">Keep</legend>
            <label className="check">
              <input type="radio" name="merge-keep" checked={keepThis} disabled={busy} onChange={() => setKeepThis(true)} />
              <span>“{thisTitle}” (this note), and merge “{otherTitle}” into it</span>
            </label>
            <label className="check">
              <input type="radio" name="merge-keep" checked={!keepThis} disabled={busy} onChange={() => setKeepThis(false)} />
              <span>“{otherTitle}”, and merge this note into it</span>
            </label>
          </fieldset>
          {preview.status === 'loading' && <p className="muted" role="status">Preparing a preview…</p>}
          {preview.status === 'failed' && (
            <div className="error-box" role="alert">
              <p>{preview.message}</p>
              <button className="button small" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
            </div>
          )}
          {proposal && (
            <>
              <p className="small">“{proposal.sourceTitle}” goes into “{proposal.targetTitle}”, which will read:</p>
              <strong>{proposal.preview.title}</strong>
              <div className="merge-preview" tabIndex={0} aria-label="Merged text preview">{proposal.preview.body}</div>
              <p className="muted small">{proposal.preview.movedChildren} children move with it; {proposal.preview.retainedAttachments} files stay on the archived original.</p>
              <label className="check merge-consent">
                <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />
                <span>
                  Archive “{proposal.sourceTitle}” after merging. Its files stay on the archived original, and you can unarchive it or undo the
                  merge later.
                </span>
              </label>
            </>
          )}
          <div className="dialog-actions">
            {error && proposal && <button className="button ghost" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>Preview again</button>}
            <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={busy || !proposal || !consent} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge'}</button>
          </div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  );
}
