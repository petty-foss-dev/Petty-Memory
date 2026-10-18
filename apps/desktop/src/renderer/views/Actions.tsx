import { useEffect, useState } from 'react';
import type { ActionOperation, ActionProposal, ActionResult } from '../../shared/ipc.ts';
import { call, errorMessage } from '../lib/api.ts';
import { displayTitle, formatDate, formatReminder } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { Icon, Modal, useFeedback } from '../ui.tsx';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const referencedIds = (operation: ActionOperation): string[] => {
  switch (operation.kind) {
    case 'task':
      return operation.sourceId ? [operation.sourceId] : [];
    case 'tag':
    case 'reminder':
      return [operation.itemId];
    case 'note':
      return operation.sourceIds;
  }
};

/** Titles of the items a proposal or its result names, looked up once. */
function useTitles(ids: string[], initial: Record<string, string>): Map<string, string> {
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map(Object.entries(initial)));
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let current = true;
    void Promise.all(key.split(',').filter((id) => id && !initial[id]).map((id) => call('items.get', id).then((item) => [id, displayTitle(item)] as const, () => [id, 'a missing item'] as const)))
      .then((found) => current && setTitles(new Map([...Object.entries(initial), ...found])));
    return () => {
      current = false;
    };
  }, [key]);
  return titles;
}

function Operation({ operation, titles }: { operation: ActionOperation; titles: Map<string, string> }) {
  const name = (id: string) => `“${titles.get(id) ?? '…'}”`;
  switch (operation.kind) {
    case 'task':
      return (
        <div className="proposal-diff">
          <strong>Add task “{operation.title}”{operation.dueAt ? `, due ${formatDate(operation.dueAt)}` : ''}</strong>
          {operation.body && <div className="diff-pair"><ins>{operation.body}</ins></div>}
          {operation.sourceId && <span className="muted small">From {name(operation.sourceId)}</span>}
        </div>
      );
    case 'tag':
      return (
        <div className="proposal-diff">
          <strong>Tag {name(operation.itemId)}</strong>
          <span>{operation.tags.map((tag) => <span key={tag} className="tag small">#{tag}</span>)}</span>
        </div>
      );
    case 'reminder':
      return (
        <div className="proposal-diff">
          <strong>{operation.remindAt ? `Remind me about ${name(operation.itemId)} ${formatReminder(operation.remindAt)}` : `Clear the reminder on ${name(operation.itemId)}`}</strong>
        </div>
      );
    case 'note':
      return (
        <div className="proposal-diff">
          <strong>Add note “{operation.title}”</strong>
          {operation.body && <div className="diff-pair"><ins>{operation.body}</ins></div>}
          {operation.sourceIds.length > 0 && <span className="muted small">From {operation.sourceIds.map(name).join(', ')}</span>}
        </div>
      );
  }
}

/** A chat turn holding proposed actions, and what became of them. */
export function ActionsTurn({ proposal, result, onReview }: {
  proposal: ActionProposal;
  result: ActionResult | null | undefined;
  onReview: () => void;
}) {
  const count = proposal.operations.length;
  return (
    <div className="chat-proposal">
      {proposal.summary && <p className="chat-text">{proposal.summary}</p>}
      <p className="muted small">
        {result ? `Applied: ${plural(result.createdIds.length, 'new item')}, ${plural(result.updatedIds.length, 'update')}.`
          : result === null ? 'Undone. Nothing from these actions is applied.'
            : count ? `${plural(count, 'suggested action')}. Nothing has changed yet.` : 'The AI didn’t suggest any actions.'}
      </p>
      {result === undefined && count > 0 && <button className="button small" onClick={onReview}><Icon name="check" size={14} /> Review actions…</button>}
    </div>
  );
}

/** Reviews proposed tasks, tags, reminders and notes with a checkbox each; only the ticked ones are applied, together. */
export function ActionsDialog({ proposal, onApplied, onUndone, onClose }: {
  proposal: ActionProposal;
  onApplied: (result: ActionResult) => void;
  onUndone: () => void;
  onClose: () => void;
}) {
  const { projects, openItem } = useApp();
  const { toast } = useFeedback();
  const [kept, setKept] = useState(() => new Set(proposal.operations.map((operation) => operation.id)));
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titles = useTitles([
    ...(proposal.rootId ? [proposal.rootId] : []),
    ...proposal.operations.flatMap(referencedIds),
    ...(result?.createdIds ?? []),
  ], proposal.titles ?? {});
  const projectName = proposal.project ? projects.find((p) => p.id === proposal.project)?.name ?? 'a project' : null;
  const scope = proposal.rootId ? `From “${titles.get(proposal.rootId) ?? '…'}” and what’s inside it`
    : `About “${proposal.query}”${projectName ? ` in ${projectName}` : ''}`;

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

  const apply = () => run(async () => {
    const applied = await call('actions.apply', proposal, [...kept]);
    setResult(applied);
    onApplied(applied);
  });

  const undo = () => run(async () => {
    if (!result) return;
    const { restored } = await call('actions.undo', result.undo);
    toast(`Undid ${plural(restored, 'change')}`);
    onUndone();
    onClose();
  });

  return (
    <Modal label="Review suggested actions" onClose={onClose} busy={busy} className="ai-edit-dialog">
      <h2><Icon name="sparkle" size={18} /> Suggested actions</h2>
      <p className="muted small">{scope}</p>
      {result ? (
        <>
          <p>Added {plural(result.createdIds.length, 'item')} and updated {plural(result.updatedIds.length, 'item')}.</p>
          {result.createdIds.length > 0 && (
            <ul className="mini-list">
              {result.createdIds.map((id) => (
                <li key={id}>
                  <button onClick={() => {
                    onClose();
                    openItem(id);
                  }}><span>{titles.get(id) ?? 'New item'}</span><span className="muted small">Open</span></button>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</button>
            <button className="button primary" disabled={busy} onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          {proposal.summary && <p>{proposal.summary}</p>}
          <ul className="proposal-list" aria-label="Suggested actions">
            {proposal.operations.map((operation) => (
              <li key={operation.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={kept.has(operation.id)}
                    disabled={busy}
                    onChange={(event) => {
                      const next = new Set(kept);
                      if (event.target.checked) next.add(operation.id);
                      else next.delete(operation.id);
                      setKept(next);
                    }}
                  />
                  <Operation operation={operation} titles={titles} />
                </label>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={busy || kept.size === 0} onClick={() => void apply()}>
              {busy ? 'Applying…' : `Apply ${plural(kept.size, 'action')}`}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}{result ? ' Anything changed since stays as it is; edit those items directly instead.' : ''}
        </p>
      )}
    </Modal>
  );
}
