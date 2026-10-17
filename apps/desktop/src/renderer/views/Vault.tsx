import type { ItemDetail, VaultState } from '@enve-memory/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { VaultFile, VaultNode } from '../../shared/ipc.ts';
import { call, errorMessage, useLive } from '../lib/api.ts';
import { formatBytes } from '../lib/format.ts';
import { useApp } from '../context.ts';
import { CopyButton, Icon, Modal, useFeedback } from '../ui.tsx';

// Native pickers and save dialogs take focus from the window; that isn't the app going to the background.
let nativeDialogs = 0;
async function withNativeDialog<T>(run: Promise<T>): Promise<T> {
  nativeDialogs++;
  try {
    return await run;
  } finally {
    nativeDialogs--;
  }
}

/** Unlocks with a saved recovery kit and its code. The recovered passphrase stays in main and is never shown. */
function RecoverWithKit({ onChange }: { onChange: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = () => {
    setBusy(true);
    setError(null);
    withNativeDialog(call('vault.recover', code.trim())).then((state) => {
      if (!state) return;
      setCode('');
      onChange();
    }, (err: unknown) => setError(errorMessage(err))).finally(() => setBusy(false));
  };
  return (
    <form className="vault-recover" onSubmit={(event) => {
      event.preventDefault();
      if (code.trim()) recover();
    }}>
      <p className="muted small">
        Use the recovery kit file and the separate recovery code you saved. Both are needed; this library (or a backup of it) still holds the notes.
      </p>
      <label className="field">
        <span>Recovery code</span>
        <input type="password" autoComplete="off" spellCheck={false} value={code} placeholder="pmr1_…" onChange={(event) => setCode(event.target.value)} />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="submit" className="button small" disabled={!code.trim() || busy}>Choose the kit file and unlock…</button>
    </form>
  );
}

/** Shows `children` only while the vault is unlocked; otherwise the form that sets it up or unlocks it. */
export function VaultGate({ state, onChange, children }: { state: VaultState; onChange: () => void; children: ReactNode }) {
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  if (state.configured && state.unlocked) return <>{children}</>;
  const setup = !state.configured;
  const ready = setup ? passphrase.length >= 8 && passphrase === repeat : passphrase.length > 0;
  const submit = () => {
    setBusy(true);
    setError(null);
    call(setup ? 'vault.setup' : 'vault.unlock', passphrase).then(() => {
      setPassphrase('');
      setRepeat('');
      onChange();
    }, (err: unknown) => setError(errorMessage(err))).finally(() => setBusy(false));
  };
  return (
    <div className="vault-gate">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (ready) submit();
      }}>
        <p>
          <Icon name="lock" size={14} />{' '}
          {setup
            ? 'Secret notes are encrypted with a passphrase only you know. Without it, or a recovery kit and code you saved, they can’t be opened.'
            : 'The vault is locked. Enter its passphrase to open secret notes.'}
        </p>
        <div className="field-row">
          <label className="field">
            <span>Vault passphrase</span>
            <input type="password" autoFocus autoComplete={setup ? 'new-password' : 'current-password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder={setup ? 'At least 8 characters' : undefined} />
          </label>
          {setup && (
            <label className="field">
              <span>Repeat</span>
              <input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
            </label>
          )}
        </div>
        {setup && repeat.length > 0 && passphrase !== repeat && <p className="error-text">The passphrases don’t match.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="inline-actions">
          <button type="submit" className="button primary small" disabled={!ready || busy}>{setup ? 'Set up the vault' : 'Unlock'}</button>
          <button type="button" className="link-button" aria-expanded={recovering} onClick={() => setRecovering(!recovering)}>
            {setup ? 'Join with a recovery kit instead' : 'Forgot it? Use a recovery kit'}
          </button>
        </div>
      </form>
      {recovering && <RecoverWithKit onChange={onChange} />}
    </div>
  );
}

export const useVault = () => useLive(() => call('vault.state'), []);

/** Writes a new secret note, optionally inside another secret note. Its title and text are encrypted; the library only sees “Secret note”. */
export function SecretNoteDialog({ parentId, onClose }: { parentId?: string | null; onClose: (created: ItemDetail | null) => void }) {
  const { toast } = useFeedback();
  const vault = useVault();
  const [concealed, reveal] = useConcealed();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await call('vault.create', { title: title.trim(), body, parentId: parentId ?? null });
      toast('Secret note saved');
      onClose(created);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal label="New secret note" onClose={() => onClose(null)} busy={busy}>
      <h2><Icon name="lock" size={18} /> New secret note</h2>
      {vault.data && (
        <VaultGate state={vault.data} onChange={vault.reload}>
          {concealed ? <Concealed onShow={reveal} kept={Boolean(title || body)} /> : <form onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() || body.trim()) void save();
          }}>
            <label className="field">
              <span>Title</span>
              <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field">
              <span>Secret</span>
              <textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            <p className="muted small">
              Search, AI and shared links never see this text. A secret note can hold other secret notes and encrypted files, never ordinary notes.
              Where it sits in the outline stays visible.
            </p>
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="button ghost" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
              <button type="submit" className="button primary" disabled={busy || (!title.trim() && !body.trim())}>Save secret</button>
            </div>
          </form>}
        </VaultGate>
      )}
    </Modal>
  );
}

/** True once the window leaves the foreground; secret text stays off screen until the user asks for it again. */
function useConcealed(): [boolean, () => void] {
  const [concealed, setConcealed] = useState(false);
  useEffect(() => {
    const onBlur = () => {
      if (nativeDialogs === 0) setConcealed(true);
    };
    const onVisibility = () => {
      if (document.hidden) setConcealed(true);
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return [concealed, () => setConcealed(false)];
}

function Concealed({ onShow, kept }: { onShow: () => void; kept?: boolean }) {
  return (
    <div className="inline-actions">
      <span className="muted small">Hidden while Petty Memory was in the background.{kept ? ' Your unsaved changes are kept.' : ''}</span>
      <button className="button small" onClick={onShow}>Show</button>
    </div>
  );
}

type SecretText = { title: string; body: string };

const differs = (a: SecretText | null, b: SecretText | null) => Boolean(a && b && (a.title !== b.title || a.body !== b.body));

/** The drawer's view of a secret note: decrypted only while unlocked and in view, edited through the vault. */
export function SecretBody({ item }: { item: ItemDetail }) {
  const { toast } = useFeedback();
  const vault = useVault();
  const [concealed, reveal] = useConcealed();
  const [plain, setPlain] = useState<SecretText | null>(null);
  const [draft, setDraft] = useState<SecretText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const request = useRef(0);
  const plainRef = useRef(plain);
  plainRef.current = plain;
  const unlocked = vault.data?.unlocked ?? false;

  useEffect(() => {
    const id = ++request.current;
    if (!unlocked) {
      setPlain(null);
      setDraft(null);
      return;
    }
    if (concealed) {
      // Unsaved edits survive being hidden; the decrypted original doesn't.
      setDraft((current) => (differs(current, plainRef.current) ? current : null));
      setPlain(null);
      return;
    }
    call('vault.read', item.id).then((read) => {
      if (id !== request.current) return;
      setPlain(read);
      setDraft((current) => current ?? { title: read.title, body: read.body });
    }, (err: unknown) => id === request.current && setError(errorMessage(err)));
  }, [unlocked, concealed, item.id, item.updatedAt]);

  const dirty = differs(plain, draft);
  const save = () => {
    if (!draft) return;
    call('vault.update', item.id, draft).then(() => toast('Secret saved'), (err: unknown) => toast(errorMessage(err), 'error'));
  };

  return (
    <section className="detail-section secret-section">
      <h2><Icon name="lock" size={16} /> Secret</h2>
      {vault.data && (
        <VaultGate state={vault.data} onChange={vault.reload}>
          {error && <p className="error-text">{error}</p>}
          {concealed && <Concealed onShow={reveal} kept={draft !== null} />}
          {draft && !concealed && (
            <>
              <label className="field">
                <span>Title</span>
                <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </label>
              <label className="field">
                <span>Secret</span>
                <textarea rows={8} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </label>
              <div className="inline-actions">
                {dirty && <button className="button primary small" onClick={save}>Save</button>}
                {dirty && <button className="button ghost small" onClick={() => setDraft(plain)}>Discard</button>}
                {!item.archivedAt && <button className="button small" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Secret note inside</button>}
                <button className="button small" onClick={() => call('vault.lock').then(vault.reload, (err: unknown) => toast(errorMessage(err), 'error'))}>
                  <Icon name="lock" size={14} /> Lock vault
                </button>
              </div>
              <SecretFiles item={item} />
            </>
          )}
        </VaultGate>
      )}
      {creating && <SecretNoteDialog parentId={item.id} onClose={() => setCreating(false)} />}
    </section>
  );
}

const MAX_FILE_LABEL = '20 MiB';

/** Encrypted attachments: names come from inside the ciphertext and are dropped when the vault locks or the window is hidden. */
function SecretFiles({ item }: { item: ItemDetail }) {
  const { toast, confirm } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ filename: string; message: string }[]>([]);
  const files = useLive(() => call('vault.files', item.id), [item.id, item.updatedAt]);
  const fail = (error: unknown) => toast(errorMessage(error), 'error');

  const add = () => {
    setBusy(true);
    withNativeDialog(call('vault.attachFiles', item.id)).then((result) => {
      if (!result) return;
      setFailed(result.failed);
      if (result.attached) toast(`Encrypted ${result.attached} file${result.attached === 1 ? '' : 's'}`);
    }, fail).finally(() => setBusy(false));
  };
  const save = (file: VaultFile) => {
    withNativeDialog(call('vault.saveFile', item.id, file.id)).then((saved) => saved && toast(`Saved a decrypted copy as ${saved.filename}`), fail);
  };
  const remove = async (file: VaultFile) => {
    const ok = await confirm({
      title: `Remove “${file.filename}”?`,
      body: <p>It leaves this secret note now. Its encrypted copy stays in the note’s history, so Versions and restore can bring it back.</p>,
      confirmLabel: 'Remove file',
    });
    if (ok) call('vault.removeFile', item.id, file.id).then(() => toast('File removed'), fail);
  };

  return (
    <div className="secret-files">
      <h3>Encrypted files</h3>
      {files.error && <p className="error-text">{files.error.message}</p>}
      {files.data?.length === 0 && <p className="muted small">No files yet. Each file is encrypted on this computer; its name and type are encrypted too.</p>}
      <ul className="secret-file-list">
        {(files.data ?? []).map((file) => (
          <li key={file.id}>
            <Icon name="file" size={15} />
            <span className="secret-file-name">{file.filename}<span className="muted small"> · {file.mimeType} · {formatBytes(file.size)}</span></span>
            <button className="button small" onClick={() => save(file)}>Save a copy…</button>
            <button className="button small danger-ghost" onClick={() => void remove(file)}>Remove…</button>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <div className="error-box" role="alert">
          <p>Not encrypted:</p>
          <ul>{failed.map((f) => <li key={f.filename}><strong>{f.filename}</strong>: {f.message}</li>)}</ul>
        </div>
      )}
      <div className="inline-actions">
        <button className="button small" disabled={busy} onClick={add}><Icon name="plus" size={14} /> Add files…</button>
        <span className="muted small">Up to {MAX_FILE_LABEL} each. Saved copies are written where you choose and never opened by Petty Memory.</span>
      </div>
    </div>
  );
}

interface TreeNode extends VaultNode {
  children: TreeNode[];
}

function buildTree(nodes: VaultNode[]): TreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, { ...node, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.title.localeCompare(b.title));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

const descendants = (node: TreeNode): string[] => node.children.flatMap((child) => [child.id, ...descendants(child)]);

/** Secret notes nested as they are in the outline, labelled with their decrypted titles while unlocked and in view. */
function VaultTree() {
  const { openItem } = useApp();
  const { toast } = useFeedback();
  const [concealed, reveal] = useConcealed();
  const [creating, setCreating] = useState<string | null | undefined>(undefined);
  const [moving, setMoving] = useState<TreeNode | null>(null);
  const tree = useLive(async () => (concealed ? null : buildTree(await call('vault.outline'))), [concealed]);
  if (concealed) return <Concealed onShow={reveal} />;
  const all = (list: TreeNode[]): TreeNode[] => list.flatMap((node) => [node, ...all(node.children)]);

  const branch = (list: TreeNode[], label: string): ReactNode => (
    <ul className="vault-tree" aria-label={label}>
      {list.map((node) => (
        <li key={node.id}>
          <div className="vault-tree-row">
            <Icon name="lock" size={14} />
            <button className="link-button" onClick={() => openItem(node.id)}>{node.title || 'Untitled secret'}</button>
            <button className="button ghost small" aria-label={`New secret note inside ${node.title || 'Untitled secret'}`} onClick={() => setCreating(node.id)}>Add inside</button>
            <button className="button ghost small" aria-label={`Move ${node.title || 'Untitled secret'}`} onClick={() => setMoving(node)}>Move…</button>
          </div>
          {node.children.length > 0 && branch(node.children, `Inside ${node.title || 'Untitled secret'}`)}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="vault-tree-panel">
      <div className="inline-actions">
        <h3>Secret notes</h3>
        <button className="button small" onClick={() => setCreating(null)}><Icon name="plus" size={14} /> New secret note</button>
      </div>
      {tree.error && <p className="error-text">{tree.error.message}</p>}
      {tree.data?.length === 0 && <p className="muted small">No secret notes yet.</p>}
      {tree.data && tree.data.length > 0 && branch(tree.data, 'Secret notes')}
      {creating !== undefined && <SecretNoteDialog parentId={creating} onClose={() => setCreating(undefined)} />}
      {moving && tree.data && (
        <SecretMoveDialog
          node={moving}
          targets={all(tree.data).filter((node) => node.id !== moving.id && !descendants(moving).includes(node.id))}
          onClose={(moved) => {
            setMoving(null);
            if (moved) toast(moved);
          }}
        />
      )}
    </div>
  );
}

/** Moves a secret note into another secret note, or to the top level. Ordinary notes can't be chosen as a secret's parent here. */
function SecretMoveDialog({ node, targets, onClose }: { node: TreeNode; targets: TreeNode[]; onClose: (moved: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = (parentId: string | null, label: string) => {
    setBusy(true);
    setError(null);
    call('outline.move', node.id, { parentId, beforeId: null }).then(() => onClose(label), (err: unknown) => {
      setError(errorMessage(err));
      setBusy(false);
    });
  };
  return (
    <Modal label={`Move ${node.title || 'secret note'}`} onClose={() => onClose(null)} busy={busy} className="move-dialog">
      <h2>Move “{node.title || 'Untitled secret'}”</h2>
      <p className="muted small">The secret notes inside it move too. It goes to the end of the place you pick.</p>
      <ul className="move-list" aria-label="Places">
        {node.parentId !== null && (
          <li><button disabled={busy} onClick={() => move(null, 'Moved to the top level')}><span className="move-name">Top level</span></button></li>
        )}
        {targets.filter((target) => target.id !== node.parentId).map((target) => (
          <li key={target.id}>
            <button disabled={busy} onClick={() => move(target.id, `Moved into ${target.title || 'Untitled secret'}`)}>
              <Icon name="lock" size={14} /> <span className="move-name">{target.title || 'Untitled secret'}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button ghost" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * Creates a recovery kit file (saved through a native dialog) and shows its code once. The code is dropped when the vault
 * locks, the window goes to the background, or a request finishes after either happened.
 */
function RecoveryKit({ unlocked }: { unlocked: boolean }) {
  const { toast } = useFeedback();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const forget = () => {
    epoch.current++;
    setCode(null);
  };

  useEffect(() => {
    if (!unlocked) forget();
  }, [unlocked]);
  useEffect(() => {
    const onBlur = () => {
      if (nativeDialogs === 0) forget();
    };
    const onVisibility = () => {
      if (document.hidden) forget();
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      epoch.current++;
    };
  }, []);

  const create = () => {
    const mine = ++epoch.current;
    setBusy(true);
    withNativeDialog(call('vault.recoveryKit')).then((result) => {
      if (result && mine === epoch.current) setCode(result.code);
    }, (err: unknown) => toast(errorMessage(err), 'error')).finally(() => setBusy(false));
  };

  return (
    <div className="recovery-kit">
      <h3>Recovery kit</h3>
      <p className="note">
        A recovery kit is a small encrypted file, opened by a separate recovery code. Together they can unlock this vault if you forget the passphrase.
        They hold no notes or files: you still need this library or a backup of it. Keep the file and the code in different places, and anyone who has
        both can open your secret notes.
      </p>
      {code ? (
        <div className="token-once" role="alert">
          <p><strong>Recovery code</strong> — shown once. Store it separately from the kit file, for example in a password manager or on paper.</p>
          <div className="token-value">
            <code data-testid="recovery-code">{code}</code>
            <CopyButton text={code} />
          </div>
          <button className="link-button" onClick={forget}>I’ve stored the code</button>
        </div>
      ) : (
        <button className="button small" disabled={!unlocked || busy} onClick={create}>Create a recovery kit…</button>
      )}
    </div>
  );
}

export function VaultSettings() {
  const { toast } = useFeedback();
  const vault = useVault();
  if (!vault.data) return null;
  const unlocked = vault.data.configured && vault.data.unlocked;
  return (
    <>
      {unlocked ? (
        <div className="inline-actions">
          <span className="badge">Unlocked</span>
          <button className="button small" onClick={() => call('vault.lock').then(() => toast('Vault locked'), (err: unknown) => toast(errorMessage(err), 'error'))}>
            <Icon name="lock" size={14} /> Lock now
          </button>
        </div>
      ) : (
        <VaultGate state={vault.data} onChange={vault.reload}><span /></VaultGate>
      )}
      <p className="note">
        The key lives only in memory while unlocked, and quitting locks the vault. Notes saved before the vault existed aren’t made secret,
        and earlier exports and backups keep whatever they already held.
      </p>
      {unlocked && <VaultTree />}
      {vault.data.configured && <RecoveryKit unlocked={unlocked} />}
    </>
  );
}
