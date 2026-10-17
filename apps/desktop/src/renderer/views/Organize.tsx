import type { OrganizationCandidate, OrganizationProposal, OrganizationResult } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import { call, errorMessage } from '../lib/api.ts';
import { displayTitle } from '../lib/format.ts';
import { Icon, Modal, useFeedback } from '../ui.tsx';

const candidateTitle = (item: OrganizationCandidate) => displayTitle({ title: item.title, body: item.body });

/** A chat turn holding an organization plan, and what became of it. */
export function OrganizationTurn({ proposal, result, onReview, onOpen }: {
  proposal: OrganizationProposal;
  result: OrganizationResult | null | undefined;
  onReview: () => void;
  onOpen: (id: string) => void;
}) {
  const { matchedCount, affectedCount, destination } = proposal;
  return (
    <div className="chat-proposal">
      {proposal.summary && <p className="chat-text">{proposal.summary}</p>}
      <p className="muted small">
        {matchedCount} matching note{matchedCount === 1 ? '' : 's'}, {affectedCount} item{affectedCount === 1 ? '' : 's'} counting what’s inside
        them, into {destination.create ? 'a new' : 'the existing'} top-level note “{destination.title}”.
      </p>
      {result ? (
        <p className="small">
          Moved {result.moved} note{result.moved === 1 ? '' : 's'}.{' '}
          <button className="link-button" onClick={() => onOpen(result.rootId)}>Open “{destination.title}”</button>
        </p>
      ) : (
        <p className="muted small">{result === null ? 'Undone. Nothing from this plan is applied.' : 'Nothing has moved yet.'}</p>
      )}
      {result === undefined && <button className="button small" onClick={onReview}><Icon name="outline" size={14} /> Review organization…</button>}
    </div>
  );
}

/** Reviews a cross-library plan: the proposed hierarchy, with a checkbox per moved branch. */
export function OrganizeDialog({ proposal, onApplied, onUndone, onOpen, onClose }: {
  proposal: OrganizationProposal;
  onApplied: (result: OrganizationResult) => void;
  onUndone: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { toast } = useFeedback();
  const [kept, setKept] = useState(() => new Set(proposal.items.map((item) => item.id)));
  const [parents, setParents] = useState<Map<string, string>>(new Map());
  const [result, setResult] = useState<OrganizationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = new Map(proposal.items.map((item) => [item.id, item]));
  const { destination } = proposal;

  useEffect(() => {
    const ids = [...new Set(proposal.items.map((item) => item.parentId).filter((id): id is string => id !== null))];
    void Promise.all(ids.map((id) => call('items.get', id).then((item) => [id, displayTitle(item)] as const, () => [id, 'another note'] as const)))
      .then((found) => setParents(new Map(found)));
  }, [proposal]);

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
    const applied = await call('organizer.apply', proposal, [...kept]);
    setResult(applied);
    onApplied(applied);
  });

  const undo = () => run(async () => {
    if (!result) return;
    await call('organizer.undo', result.undo);
    toast('Organization undone');
    onUndone();
    onClose();
  });

  const branch = (parentId: string) => (
    <ul className="organize-tree">
      {proposal.groups.filter((group) => group.parentId === parentId).map((group) => (
        <li key={group.id}>
          <span className="organize-group"><Icon name="outline" size={14} /> <span>{group.title}</span> <span className="badge">New heading</span></span>
          {branch(group.id)}
        </li>
      ))}
      {proposal.assignments.filter((assignment) => assignment.parentId === parentId).map(({ itemId }) => {
        const item = items.get(itemId)!;
        const from = item.parentId === null ? 'the top level' : `“${parents.get(item.parentId) ?? '…'}”`;
        return (
          <li key={itemId}>
            <label className="check">
              <input
                type="checkbox"
                checked={kept.has(itemId)}
                disabled={busy || result !== null}
                onChange={(event) => {
                  const next = new Set(kept);
                  if (event.target.checked) next.add(itemId);
                  else next.delete(itemId);
                  setKept(next);
                }}
              />
              <span>
                {candidateTitle(item)}
                {item.descendantCount > 0 && <span className="muted small"> · brings {item.descendantCount} inside it</span>}
                <span className="muted small"> · from {from}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );

  return (
    <Modal label={`Organize into “${destination.title}”`} onClose={onClose} busy={busy} className="ai-edit-dialog organize-dialog">
      <h2><Icon name="sparkle" size={18} /> Organize into “{destination.title}”</h2>
      {result ? (
        <>
          <p>Moved {result.moved} note{result.moved === 1 ? '' : 's'} into “{destination.title}”.</p>
          <div className="dialog-actions">
            <button className="button" disabled={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</button>
            <button className="button" disabled={busy} onClick={() => onOpen(result.rootId)}>Open “{destination.title}”</button>
            <button className="button primary" disabled={busy} onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          {proposal.summary && <p>{proposal.summary}</p>}
          <p className="muted small">
            {proposal.matchedCount} note{proposal.matchedCount === 1 ? '' : 's'} match “{proposal.query}”; {proposal.affectedCount} item
            {proposal.affectedCount === 1 ? '' : 's'} in all, counting what’s inside them. Moving a note brings everything inside it.
            Text, tags, projects and attachments stay as they are. Untick anything that doesn’t belong.
          </p>
          <div className="organize-root" role="group" aria-label="Proposed structure">
            <span className="organize-group">
              <Icon name="note" size={14} /> {destination.title}{' '}
              <span className="badge">{destination.create ? 'New top-level note' : 'Existing note'}</span>
            </span>
            {branch(destination.id)}
          </div>
          <div className="dialog-actions">
            <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={busy || kept.size === 0} onClick={() => void apply()}>
              {busy ? 'Moving…' : `Move ${kept.size} note${kept.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  );
}
