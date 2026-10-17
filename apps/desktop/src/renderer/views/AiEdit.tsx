import type { EditOperation, EditProposal } from '@enve-memory/core';
import { useState } from 'react';
import type { EditUndoReceipt } from '../../shared/ipc.ts';
import { call, errorMessage } from '../lib/api.ts';
import { recoveryMessage } from '../lib/format.ts';
import { ATTENTION_LABELS, KIND_LABELS } from '../lib/presentation.ts';
import { Icon, Modal, useFeedback } from '../ui.tsx';

const ACTIONS = [
  { label: 'Organize', instruction: 'Organize these notes: group related ones under clear headings and order them sensibly. Keep every note.' },
  { label: 'Sort', instruction: 'Sort the notes inside into the most useful order.' },
  { label: 'Correct', instruction: 'Correct spelling, grammar and wording without changing the meaning.' },
  { label: 'Add', instruction: 'Add a few notes that are clearly missing, next to the ones they belong with.' },
];

function presentationText(patch: EditOperation & { op: 'presentation' }): string {
  const parts: string[] = [];
  const { kind, attention, review, checklist } = patch.patch;
  if (kind) parts.push(KIND_LABELS[kind]);
  if (attention) parts.push(`${ATTENTION_LABELS[attention]} attention`);
  if (review !== undefined) parts.push(review ? 'marked for review' : 'review cleared');
  if (checklist !== undefined) parts.push(checklist ? 'a checklist' : 'not a checklist');
  return parts.join(', ') || 'Style change';
}

function Operation({ operation, names }: { operation: EditOperation; names: Map<string, string> }) {
  const where = (id: string) => `inside “${names.get(id) ?? 'another note'}”`;
  switch (operation.op) {
    case 'update':
      return (
        <div className="proposal-diff">
          <strong>Edit “{operation.before.title || 'Untitled'}”</strong>
          {operation.title !== undefined && operation.title !== operation.before.title && (
            <div className="diff-pair"><del>{operation.before.title || '(no title)'}</del><ins>{operation.title}</ins></div>
          )}
          {operation.body !== undefined && operation.body !== operation.before.body && (
            <div className="diff-pair"><del>{operation.before.body || '(empty)'}</del><ins>{operation.body}</ins></div>
          )}
        </div>
      );
    case 'create':
      return (
        <div className="proposal-diff">
          <strong>Add “{operation.title || 'Untitled'}” {where(operation.parentId)}</strong>
          {operation.body && <div className="diff-pair"><ins>{operation.body}</ins></div>}
        </div>
      );
    case 'move':
      return <div className="proposal-diff"><strong>Move “{operation.before.title || 'Untitled'}” {where(operation.parentId)}</strong></div>;
    case 'presentation':
      return <div className="proposal-diff"><strong>Make “{names.get(operation.id) ?? 'a note'}” {presentationText(operation)}</strong></div>;
  }
}

/** Asks the AI for changes to one item and what's inside it, then applies only what the user keeps. `initialProposal` skips to review. */
export function AiEditDialog({ rootId, title, initialProposal, onClose }: {
  rootId: string;
  title: string;
  initialProposal?: EditProposal;
  onClose: () => void;
}) {
  const { toast } = useFeedback();
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<EditProposal | null>(initialProposal ?? null);
  const [kept, setKept] = useState<boolean[]>(() => initialProposal?.operations.map(() => true) ?? []);
  const [applied, setApplied] = useState<{ count: number; receipt: EditUndoReceipt | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const propose = (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    call('edits.propose', rootId, text.trim()).then((result) => {
      setProposal(result);
      setKept(result.operations.map(() => true));
    }, (err: unknown) => setError(errorMessage(err))).finally(() => setBusy(false));
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call('edits.apply', { ...proposal, operations: proposal.operations.filter((_, i) => kept[i]) });
      setApplied({ count: result.applied, receipt: result.undo ?? null });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Core refuses the undo if anything in this subtree changed after the edit, so newer work is never overwritten.
  const undo = async () => {
    if (!applied?.receipt) return;
    setBusy(true);
    setError(null);
    try {
      const { message, tone } = recoveryMessage('AI edit undone', await call('edits.undo', applied.receipt));
      toast(message, tone);
      onClose();
    } catch (err) {
      setError(`${errorMessage(err)} To go back anyway, open the item’s Versions and restore and choose what to keep.`);
    } finally {
      setBusy(false);
    }
  };

  const names = new Map<string, string>([[rootId, title], ...Object.entries(proposal?.titles ?? {})]);
  for (const operation of proposal?.operations ?? []) {
    if (operation.op === 'update' || operation.op === 'move') names.set(operation.id, operation.before.title || 'Untitled');
  }
  const count = kept.filter(Boolean).length;

  return (
    <Modal label={`Edit “${title}” with AI`} onClose={onClose} busy={busy} className="ai-edit-dialog">
      <h2><Icon name="sparkle" size={18} /> Edit “{title}” with AI</h2>
      {applied ? (
        <>
          <p>Applied {applied.count} change{applied.count === 1 ? '' : 's'}.</p>
          {!applied.receipt && <p className="muted small">Nothing was changed that can be undone from here.</p>}
          <div className="dialog-actions">
            {applied.receipt && <button className="button" disabled={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</button>}
            <button className="button primary" disabled={busy} onClick={onClose}>Done</button>
          </div>
        </>
      ) : !proposal ? (
        <>
          <p className="muted small">The AI sees this item and what’s inside it, never secret notes or decisions. Nothing changes until you apply.</p>
          <div className="chips" role="group" aria-label="Quick requests">
            {ACTIONS.map((action) => (
              <button key={action.label} className="chip" disabled={busy} onClick={() => {
                setInstruction(action.instruction);
                propose(action.instruction);
              }}>{action.label}</button>
            ))}
          </div>
          <form onSubmit={(event) => {
            event.preventDefault();
            propose(instruction);
          }}>
            <textarea aria-label="What should change?" rows={3} placeholder="Or say what you want, e.g. “turn this into a packing checklist”" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
            <div className="dialog-actions">
              <button type="button" className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="submit" className="button primary" disabled={busy || !instruction.trim()}>{busy ? 'Thinking…' : 'Suggest changes'}</button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p>{proposal.summary}</p>
          {proposal.operations.length === 0 ? (
            <p className="muted">The AI didn’t suggest any changes.</p>
          ) : (
            <ul className="proposal-list" aria-label="Proposed changes">
              {proposal.operations.map((operation, index) => (
                <li key={index}>
                  <label className="check">
                    <input type="checkbox" checked={kept[index] ?? false} onChange={(event) => setKept(kept.map((k, i) => (i === index ? event.target.checked : k)))} />
                    <Operation operation={operation} names={names} />
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            {initialProposal
              ? <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
              : <button className="button ghost" disabled={busy} onClick={() => setProposal(null)}>Back</button>}
            <button className="button primary" disabled={busy || count === 0} onClick={() => void apply()}>
              {busy ? 'Applying…' : `Apply ${count} change${count === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  );
}
