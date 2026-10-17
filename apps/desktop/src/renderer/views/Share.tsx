import type { OutlineEntry } from '@enve-memory/core';
import { useState } from 'react';
import type { CreatedShare } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { displayTitle, formatDateTime } from '../lib/format.ts';
import { isSecret } from '../lib/presentation.ts';
import { CopyButton, Icon, Modal, TypeIcon, useFeedback } from '../ui.tsx';
import { loadChildren } from './OutlineMove.tsx';

const EXPIRY = [
  { label: 'Never', days: 0 },
  { label: 'In a day', days: 1 },
  { label: 'In a week', days: 7 },
  { label: 'In 30 days', days: 30 },
];

function ExcludeList({ parentId, excluded, toggle }: { parentId: string; excluded: Set<string>; toggle: (id: string) => void }) {
  const [want, setWant] = useState(100);
  const page = useLive(() => loadChildren(parentId, want), [parentId, want]);
  if (!page.data) return page.error ? <p className="error-text">{page.error.message}</p> : <p className="muted small">Loading…</p>;
  return (
    <ul className="exclude-list">
      {page.data.items.map((entry) => <ExcludeRow key={entry.item.id} entry={entry} excluded={excluded} toggle={toggle} />)}
      {page.data.items.length < page.data.total && (
        <li><button className="button small" onClick={() => setWant(want + 100)}>Show more</button></li>
      )}
    </ul>
  );
}

function ExcludeRow({ entry, excluded, toggle }: { entry: OutlineEntry; excluded: Set<string>; toggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const id = entry.item.id;
  const secret = isSecret(entry.item);
  const left = excluded.has(id);
  return (
    <li>
      <div className="exclude-row">
        {entry.childCount > 0 && !left && !secret ? (
          <button className={`outline-toggle ${open ? 'open' : ''}`} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${displayTitle(entry.item)}`} onClick={() => setOpen(!open)}>
            <Icon name="chevron" size={14} />
          </button>
        ) : <span className="outline-toggle" aria-hidden="true" />}
        <TypeIcon type={entry.item.type} size={14} />
        <span className="move-name">{displayTitle(entry.item)}</span>
        {secret ? (
          <span className="muted small"><Icon name="lock" size={12} /> Secret, never shared</span>
        ) : (
          <label className="check small">
            <input type="checkbox" checked={left} onChange={() => toggle(id)} /> Leave out
          </label>
        )}
      </div>
      {open && !left && <ExcludeList parentId={id} excluded={excluded} toggle={toggle} />}
    </li>
  );
}

/** Publishes a read-only link to one item and what's inside it, minus anything left out; revocable at any time. */
export function ShareDialog({ rootId, title, onClose }: { rootId: string; title: string; onClose: () => void }) {
  const { toast } = useFeedback();
  const shares = useLive(() => call('shares.list'), []);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [days, setDays] = useState(0);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = (shares.data ?? []).filter((share) => share.rootId === rootId);

  const toggle = (id: string) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  };

  const create = () => {
    setBusy(true);
    setError(null);
    const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    call('shares.create', rootId, { excludedIds: [...excluded], expiresAt }).then(setCreated, (err: unknown) => setError(errorMessage(err))).finally(() => setBusy(false));
  };

  const revoke = (id: string) => call('shares.revoke', id).then(() => toast('Link revoked. It stops working right away.'), (err: unknown) => toast(errorMessage(err), 'error'));

  return (
    <Modal label={`Share “${title}”`} onClose={onClose} busy={busy} className="move-dialog">
      <h2><Icon name="share" size={18} /> Share “{title}”</h2>
      {created ? (
        <div className="token-once">
          <p><strong>Copy the link now.</strong> Only a fingerprint of it is kept, so it can’t be shown again; revoke it and make a new one if it’s lost.</p>
          {created.links.map((link) => (
            <div key={link.url} className="field">
              <span>{link.label}</span>
              <div className="token-value"><code>{link.url}</code><CopyButton text={link.url} label="Copy link" /></div>
            </div>
          ))}
          <div className="field">
            <span>Share code</span>
            <div className="token-value"><code>{created.token}</code><CopyButton text={created.token} label="Copy code" /></div>
          </div>
          <p className="muted small">
            {created.links.length === 0
              ? 'This app’s local server isn’t running, so there’s no address. A Petty Memory web host you run opens the share at /s/ followed by the code.'
              : created.page
                ? 'The link opens a read-only page served by this app while it’s running. “On this computer” only works here; network links need LAN mode in Settings → Devices.'
                : 'This build has no web page bundled, so the link returns the shared text as JSON. A Petty Memory web host opens it as a page at /s/ followed by the code.'}
            {' '}Nothing is published to the internet.
          </p>
          <div className="dialog-actions"><button className="button primary" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <>
          <p className="muted small">Visitors see the title and text of this item and what’s inside it, read-only. Secret notes, files, history and links to anything outside are left out.</p>
          <h3 className="small">What’s inside</h3>
          <div className="exclude-box"><ExcludeList parentId={rootId} excluded={excluded} toggle={toggle} /></div>
          <label className="field inline">
            <span>Link expires</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {EXPIRY.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
            </select>
          </label>
          {mine.length > 0 && (
            <>
              <h3 className="small">Links already made</h3>
              <ul className="client-list">
                {mine.map((share) => (
                  <li key={share.id} className={share.revokedAt ? 'revoked' : ''}>
                    <span>
                      Made {formatDateTime(share.createdAt)}
                      {share.excludedIds.length > 0 && ` · ${share.excludedIds.length} left out`}
                      {share.revokedAt ? ' · revoked' : share.expiresAt ? ` · expires ${formatDateTime(share.expiresAt)}` : ''}
                    </span>
                    {!share.revokedAt && <button className="button small danger-ghost" onClick={() => void revoke(share.id)}>Revoke</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create link'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
