import type { ItemVersion, ItemVersionSummary, VersionNode } from '@enve-memory/core';
import { useEffect, useState } from 'react';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { actorInfo, displayTitle, formatDateTime, recoveryMessage } from '../lib/format.ts';
import { isChecked, isSecret, presentationOf } from '../lib/presentation.ts';
import { useFeedback } from '../ui.tsx';

const PAGE = 20;

const opLabel = (op: string) => (op === 'baseline' ? 'State when history began' : op.replace(/_/g, ' '));

interface NodeChange {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  before?: VersionNode;
  after?: VersionNode;
}

// Secret states differ only in ciphertext and encrypted attachments; neither is shown, only that they changed.
const sealedText = (node: VersionNode) => JSON.stringify(node.item.metadata.vault ?? null);
const fileIds = (node: VersionNode) => node.item.attachments.map((a) => `${a.id}:${a.sha256}`).sort().join(',');

function compare(older: ItemVersion, newer: ItemVersion): NodeChange[] {
  const before = new Map(older.snapshot.items.map((node) => [node.item.id, node]));
  const after = new Map(newer.snapshot.items.map((node) => [node.item.id, node]));
  const changes: NodeChange[] = [];
  for (const [id, node] of after) {
    const old = before.get(id);
    if (!old) changes.push({ id, title: displayTitle(node.item), kind: 'added', after: node });
    else if (old.item.title !== node.item.title || old.item.body !== node.item.body || old.parentId !== node.parentId || old.position !== node.position || old.item.archivedAt !== node.item.archivedAt || JSON.stringify(presentationOf(old.item)) !== JSON.stringify(presentationOf(node.item)) || old.item.task?.status !== node.item.task?.status
      || sealedText(old) !== sealedText(node) || fileIds(old) !== fileIds(node)) {
      changes.push({ id, title: displayTitle(node.item), kind: 'changed', before: old, after: node });
    }
  }
  for (const [id, node] of before) if (!after.has(id)) changes.push({ id, title: displayTitle(node.item), kind: 'removed', before: node });
  return changes;
}

function Change({ change }: { change: NodeChange }) {
  const { before, after } = change;
  return (
    <li className={`version-change ${change.kind}`}>
      <strong>{change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Not there' : 'Changed'}: {change.title}</strong>
      {before && after && before.item.title !== after.item.title && (
        <div className="diff-pair"><del>{before.item.title || '(no title)'}</del><ins>{after.item.title || '(no title)'}</ins></div>
      )}
      {before && after && before.item.body !== after.item.body && (
        <div className="diff-pair"><del>{before.item.body || '(empty)'}</del><ins>{after.item.body || '(empty)'}</ins></div>
      )}
      {before && after && (before.parentId !== after.parentId || before.position !== after.position) && <div className="muted small">Moved</div>}
      {before && after && before.item.archivedAt !== after.item.archivedAt && <div className="muted small">{after.item.archivedAt ? 'Archived' : 'Unarchived'}</div>}
      {before && after && isChecked(before.item) !== isChecked(after.item) && <div className="muted small">{isChecked(after.item) ? 'Checked off' : 'Reopened'}</div>}
      {before && after && JSON.stringify(presentationOf(before.item)) !== JSON.stringify(presentationOf(after.item)) && <div className="muted small">Formatting or presentation changed</div>}
      {before && after && sealedText(before) !== sealedText(after) && <div className="muted small">Encrypted text changed</div>}
      {before && after && fileIds(before) !== fileIds(after) && (
        <div className="muted small">
          {before.item.attachments.length === after.item.attachments.length
            ? 'Files changed'
            : `${after.item.attachments.length > before.item.attachments.length ? 'Files added' : 'Files removed'} (${before.item.attachments.length} → ${after.item.attachments.length})`}
        </div>
      )}
    </li>
  );
}

export function VersionsPanel({ itemId }: { itemId: string }) {
  const { toast, confirm } = useFeedback();
  const item = useLive(() => call('items.get', itemId), [itemId]);
  // A secret note's history is restored through the vault, which only ever writes ciphertext back.
  const secret = item.data ? isSecret(item.data) : false;
  const [want, setWant] = useState(PAGE);
  const list = useLive(async () => {
    const items: ItemVersionSummary[] = [];
    let total = 0;
    do {
      const page = await call('versions.list', itemId, { limit: Math.min(PAGE, want - items.length), offset: items.length });
      total = page.total;
      items.push(...page.items);
      if (!page.items.length) break;
    } while (items.length < Math.min(want, total));
    return { items, total };
  }, [itemId, want]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{ older: ItemVersion; newer: ItemVersion } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versions = list.data?.items ?? [];
  const latest = versions[0];

  useEffect(() => {
    if (!selected || !latest || selected === latest.id) {
      setPair(null);
      return;
    }
    Promise.all([call('versions.get', selected), call('versions.get', latest.id)]).then(
      ([older, newer]) => setPair({ older, newer }),
      (err: unknown) => setError(errorMessage(err)),
    );
  }, [selected, latest?.id]);

  const restore = async (version: ItemVersionSummary) => {
    const ok = await confirm({
      title: 'Restore this version?',
      body: secret
        ? <p>This secret note, its encrypted files and the secret notes inside it go back to how they were on {formatDateTime(version.at)}. Only encrypted content is restored. This is saved as a new change, so you can restore the current state again.</p>
        : <p>The item and what was inside it go back to how they were on {formatDateTime(version.at)}. This is saved as a new change, so the current state stays in history and you can restore it again.</p>,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    call(secret ? 'vault.restoreVersion' : 'versions.restore', version.id).then((result) => {
      const { message, tone } = recoveryMessage(`Restored ${result.restored} item${result.restored === 1 ? '' : 's'}`, result);
      toast(message, tone);
      setSelected(null);
    }, (err: unknown) => toast(errorMessage(err), 'error'));
  };

  if (list.error) return <p className="error-text">{list.error.message}</p>;
  if (!list.data) return <p className="muted small">Loading…</p>;
  const changes = pair ? compare(pair.older, pair.newer) : [];
  return (
    <div className="versions">
      <ol className="history version-list">
        {versions.map((version, index) => (
          <li key={version.id} className={selected === version.id ? 'selected' : ''}>
            <button className="link-button" aria-pressed={selected === version.id} onClick={() => setSelected(selected === version.id ? null : version.id)}>
              {index === 0 ? 'Now' : formatDateTime(version.at)}
            </button>
            <span>{opLabel(version.op)}</span>
            <span className={`actor ${actorInfo(version.actor).kind}`}>{actorInfo(version.actor).label}</span>
            {index > 0 && <button className="button small" onClick={() => void restore(version)}>Restore</button>}
          </li>
        ))}
      </ol>
      {versions.length < list.data.total && <button className="button small" onClick={() => setWant(want + PAGE)}>Show older</button>}
      {versions.at(-1)?.op === 'baseline' && versions.length === list.data.total && (
        <p className="muted small">History starts when this library began keeping versions. Earlier changes weren’t recorded, so they can’t be shown.</p>
      )}
      {error && <p className="error-text">{error}</p>}
      {pair && (
        <div className="version-compare" aria-label="Differences from now">
          <p className="muted small">From {formatDateTime(pair.older.at)} to now:</p>
          {changes.length ? <ul>{changes.map((change) => <Change key={change.id} change={change} />)}</ul> : <p className="muted small">No differences in text, placement, or presentation.</p>}
        </div>
      )}
    </div>
  );
}
