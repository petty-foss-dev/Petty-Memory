import { can, del, enc, get, patch, post, put, query } from './api.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { isSecret } from './text.js';
import {
  MAX_FILE_BYTES, createRecoveryKit, lockVault, openFile, openNote, sealFile, sealNote, unlockVault, unlockWithRecovery, uuidv7, vaultUnlocked,
} from './crypto.js';

const NEEDS_SCOPE = 'Secret notes need a token that explicitly includes the "secrets" scope. Create one with `petty-memory clients add "Browser vault" --scope read,write,secrets` and reconnect with it.';
const SCAN_PAGE = 200;
const MAX_KIT_BYTES = 256 * 1024;
const SEALED_FILE_NAME = 'Encrypted attachment.pmv';
const SEALED_FILE_MIME = 'application/vnd.petty-memory.vault+json';
const LOOKUPS = 6;

// Decrypted file names and types, kept only while unlocked; the lock event empties it.
const fileNames = new Map();
// Bumped on lock, so a recovery kit that finishes generating afterwards is never shown.
let recoveryGeneration = 0;

const sealedFiles = (item) => item.attachments.filter((a) => a.filename === SEALED_FILE_NAME && a.mimeType === SEALED_FILE_MIME);
const sizeLabel = (size) => (size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`);
const attachmentPath = (itemId, attachmentId) => `/vault/items/${enc(itemId)}/attachments/${enc(attachmentId)}`;

function passphraseForm({ label, confirmIt, submit }) {
  const pass = h('input', { type: 'password', required: true, autocomplete: confirmIt ? 'new-password' : 'current-password' });
  const again = confirmIt ? h('input', { type: 'password', required: true, autocomplete: 'new-password' }) : null;
  const status = h('p', { class: 'hint', role: 'status' });
  return h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    if (again && pass.value !== again.value) return void (status.textContent = 'The passphrases don’t match.');
    status.textContent = 'Working…';
    try {
      await submit(pass.value);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      pass.value = '';
      if (again) again.value = '';
    }
  } },
  field('Passphrase', pass),
  again ? field('Repeat passphrase', again, 'Make a recovery kit once it’s set up: without the passphrase or a kit and its code, these notes can’t be opened.') : null,
  h('button', { type: 'submit', class: 'btn primary' }, label),
  status);
}

/** Unlocks this tab from a saved kit file and its separate code. Both stay in this tab; the passphrase they recover is never shown. */
function recoveryForm(secrets, done) {
  const file = h('input', { type: 'file', accept: 'application/json,.json', required: true });
  const code = h('input', { type: 'password', required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'pmr1_…' });
  const status = h('p', { class: 'hint', role: 'status' });
  return h('details', { class: 'vault-recover' },
    h('summary', null, 'Use a recovery kit instead'),
    h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      status.textContent = 'Opening the kit…';
      try {
        const chosen = file.files?.[0];
        if (!chosen) throw new Error('Choose the recovery kit file.');
        if (chosen.size > MAX_KIT_BYTES) throw new Error('That file is too large to be a Petty Memory recovery kit.');
        let kit;
        try { kit = JSON.parse(await chosen.text()); } catch { throw new Error('That file isn’t a Petty Memory recovery kit.'); }
        await unlockWithRecovery(kit, code.value, secrets);
        status.textContent = '';
        done();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        code.value = '';
      }
    } },
    h('p', { class: 'hint' }, 'You need both the kit file and its recovery code. They hold no notes: this library still keeps the encrypted notes.'),
    field('Recovery kit file', file),
    field('Recovery code', code),
    h('button', { type: 'submit', class: 'btn' }, 'Unlock with the kit'),
    status));
}

/** Names, downloads, uploads and removals for a secret note's encrypted files. Everything is decrypted or encrypted in this tab. */
function secretFiles(id, ctx) {
  const box = h('div', { class: 'secret-files' });
  const list = h('ul', { class: 'plain' });
  const problems = h('div', { role: 'status' });
  const picker = h('input', { type: 'file', multiple: true, 'aria-label': 'Choose files to encrypt' });

  async function describe(attachment) {
    const cacheKey = `${attachment.id}:${attachment.sha256}`;
    if (!fileNames.has(cacheKey)) {
      const { filename, mimeType, data } = await openFile(id, attachment.id, await get(attachmentPath(id, attachment.id)));
      fileNames.set(cacheKey, { filename, mimeType, size: data.byteLength });
      data.fill(0);
    }
    return fileNames.get(cacheKey);
  }

  async function download(attachment) {
    const { filename, data } = await openFile(id, attachment.id, await get(attachmentPath(id, attachment.id)));
    // Always a download, never shown in the page: decrypted HTML or scripts must not run here.
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    data.fill(0);
    const link = h('a', { href: url, download: filename, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function remove(attachment, label) {
    const ok = await confirmDialog({
      title: `Remove “${label}”?`,
      body: 'It leaves this secret note now. Its encrypted copy stays in the note’s history, so History can restore it.',
      confirmLabel: 'Remove file',
    });
    if (!ok) return;
    try {
      await del(attachmentPath(id, attachment.id));
      await render();
      ctx.notify('File removed.', 'ok');
    } catch (error) {
      ctx.notify(error.message, 'error');
    }
  }

  async function render() {
    clear(list, h('li', null, loading('Decrypting file names…')));
    const item = await get(`/items/${enc(id)}`);
    const files = sealedFiles(item);
    if (!files.length) return clear(list, h('li', null, empty('No files yet. Each file, its name and its type are encrypted in this browser.')));
    const rows = await Promise.all(files.map(async (attachment) => {
      try {
        const meta = await describe(attachment);
        return h('li', { class: 'secret-file' },
          h('span', { class: 'secret-file-name' }, meta.filename, h('span', { class: 'hint' }, ` · ${meta.mimeType} · ${sizeLabel(meta.size)}`)),
          h('button', { type: 'button', class: 'btn small', onClick: () => download(attachment).catch((error) => ctx.notify(error.message, 'error')) }, 'Download'),
          can('write') ? h('button', { type: 'button', class: 'btn small danger', onClick: () => remove(attachment, meta.filename) }, 'Remove…') : null);
      } catch (error) {
        return h('li', { class: 'secret-file' }, errorBox(error));
      }
    }));
    clear(list, rows);
  }

  // Each file is reported on its own; the rest still upload, and the note's own draft is never touched.
  picker.addEventListener('change', async () => {
    const chosen = [...(picker.files ?? [])];
    picker.value = '';
    clear(problems, chosen.length ? loading(`Encrypting ${chosen.length} file${chosen.length === 1 ? '' : 's'}…`) : null);
    const failed = [];
    let added = 0;
    for (const file of chosen) {
      try {
        if (file.size > MAX_FILE_BYTES) throw new Error('It is larger than 20 MiB, the limit for encrypted files.');
        const data = new Uint8Array(await file.arrayBuffer());
        const attachmentId = uuidv7();
        let envelope;
        try {
          envelope = await sealFile(id, attachmentId, { filename: file.name, mimeType: file.type, data });
        } finally {
          data.fill(0);
        }
        await put(attachmentPath(id, attachmentId), envelope);
        added++;
      } catch (error) {
        failed.push(h('li', null, h('strong', null, file.name), `: ${error.message}`));
      }
    }
    clear(problems, failed.length ? h('div', { class: 'error' }, h('p', null, 'Not encrypted:'), h('ul', null, failed)) : null);
    if (added) ctx.notify(`Encrypted ${added} file${added === 1 ? '' : 's'}.`, 'ok');
    render().catch((error) => clear(list, h('li', null, errorBox(error))));
  });

  clear(box,
    h('h3', null, 'Encrypted files'),
    list,
    problems,
    can('write') ? h('div', { class: 'actions' }, field('Add files (up to 20 MiB each)', picker)) : null,
    h('p', { class: 'hint' }, 'Downloads are decrypted in this browser and saved, never opened here.'));
  render().catch((error) => clear(list, h('li', null, errorBox(error))));
  return box;
}

/** Reads and edits one secret note. Decrypted text exists only in this panel's DOM until it is closed or locked. */
function secretEditor(id, ctx, onLocked) {
  const box = h('div', { class: 'secret' }, loading('Decrypting…'));
  get(`/items/${enc(id)}`).then(async (item) => {
    const note = await openNote(id, item.metadata.vault);
    const title = h('input', { type: 'text', value: note.title, 'aria-label': 'Secret title', class: 'title-input' });
    const body = h('textarea', { rows: 10, value: note.body, 'aria-label': 'Secret text' });
    const status = h('p', { class: 'hint', role: 'status' });
    const child = h('div');
    clear(box, h('form', { class: 'editor', onSubmit: async (e) => {
      e.preventDefault();
      status.textContent = 'Encrypting and saving…';
      try {
        const envelope = await sealNote(id, title.value, body.value);
        await patch(`/vault/sealed-items/${enc(id)}`, { envelope });
        status.textContent = 'Saved.';
        ctx.changed({ detail: false });
      } catch (error) {
        status.textContent = `Not saved: ${error.message}`;
      }
    } },
    title, body,
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
      item.archivedAt ? null : h('button', { type: 'button', class: 'btn', onClick: () => clear(child, newSecretForm(ctx, () => clear(child), id)) }, 'New secret note inside'),
      h('button', { type: 'button', class: 'btn', onClick: () => clear(box) }, 'Hide')),
    status),
    child,
    secretFiles(id, ctx));
  }).catch((error) => {
    if (error.status === 423 || error.code === 'locked') onLocked();
    else clear(box, errorBox(error));
  });
  return box;
}

export function secretPanel(item, ctx) {
  const section = h('section', { class: 'panel content' }, h('h1', { class: 'item-title' }, '🔒 Secret note'));
  if (!can('secrets')) {
    section.append(h('p', { class: 'hint' }, NEEDS_SCOPE));
    return section;
  }
  const body = h('div');
  const reveal = () => {
    clear(body, loading());
    findSecrets().then((secrets) => {
      if (!vaultUnlocked()) {
        return clear(body, h('p', { class: 'hint' }, 'Unlock the vault to read this note.'),
          passphraseForm({ label: 'Unlock and read', submit: async (pass) => { await unlockVault(pass, secrets); reveal(); } }),
          recoveryForm(secrets, reveal));
      }
      clear(body, secretEditor(item.id, ctx, reveal));
    }, (error) => clear(body, errorBox(error, reveal)));
  };
  section.append(h('p', { class: 'hint' }, 'The text and files are encrypted. They never appear in search, AI requests or public links.'),
    body, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: reveal }, 'Read secret'),
      h('button', { type: 'button', class: 'btn', onClick: lockVault }, 'Lock on this device')));
  return section;
}

/** Runs `task` over `items` with at most `limit` in flight, keeping order. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }));
  return results;
}

/** Secret notes as they nest in the outline, titled by decrypting each envelope in this tab. */
async function secretTree(secrets) {
  const nodes = await mapLimited(secrets, LOOKUPS, async (item) => {
    const [placement, note] = await Promise.all([get(`/outline/${enc(item.id)}`), openNote(item.id, item.metadata.vault)]);
    return { id: item.id, parentId: placement.parentId, title: note.title || 'Untitled secret', children: [] };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = [];
  for (const node of nodes) (byId.get(node.parentId)?.children ?? roots).push(node);
  const sort = (list) => {
    list.sort((a, b) => a.title.localeCompare(b.title));
    list.forEach((node) => sort(node.children));
  };
  sort(roots);
  return { roots, nodes };
}

const below = (node) => node.children.flatMap((child) => [child.id, ...below(child)]);

/** A modal list of places: focus moves in, Escape cancels, and focus returns to the opener. */
function choosePlace(title, places) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolve(value);
    };
    const dialog = h('dialog', { class: 'modal', 'aria-label': title },
      h('h2', null, title),
      h('ul', { class: 'plain picker-results' }, places.map((place) => h('li', null,
        h('button', { type: 'button', class: 'picker-option', onClick: () => finish(place) }, place.label)))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, 'Cancel')));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('button')?.focus();
  });
}

/** Makes a kit file to download and shows its code once; both vanish from the page on lock, which hiding the tab triggers. */
function recoveryPanel() {
  const out = h('div', { class: 'recovery-once', 'aria-live': 'polite' });
  const create = async (event) => {
    const mine = ++recoveryGeneration;
    event.target.disabled = true;
    try {
      const { kit, code } = await createRecoveryKit();
      if (mine !== recoveryGeneration || !vaultUnlocked()) return;
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(kit, null, 2)}\n`], { type: 'application/json' }));
      const link = h('a', { href: url, download: 'petty-memory-recovery-kit.json', hidden: true });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      const value = h('code', { class: 'recovery-code' }, code);
      clear(out,
        h('p', null, h('strong', null, 'Recovery code'), ' — shown once. The kit file was downloaded; store this code somewhere else, such as a password manager or on paper.'),
        value,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn small', onClick: async (e) => {
            try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied'; }
            catch { getSelection()?.selectAllChildren(value); e.target.textContent = 'Selected; copy it with your keyboard'; }
          } }, 'Copy code'),
          h('button', { type: 'button', class: 'btn small', onClick: () => { recoveryGeneration++; clear(out); } }, 'I’ve stored the code')));
    } catch (error) {
      if (mine === recoveryGeneration) clear(out, errorBox(error));
    } finally {
      event.target.disabled = false;
    }
  };
  return h('section', { class: 'panel recovery-kit' },
    h('h2', null, 'Recovery kit'),
    h('p', { class: 'hint' }, 'A small encrypted file plus a separate recovery code can unlock this vault if you forget the passphrase. They hold no notes or files, so you still need this library or a backup of it. Keep the two apart: anyone with both can open your secret notes.'),
    h('button', { type: 'button', class: 'btn', onClick: create }, 'Create a recovery kit'),
    out);
}

export function createVaultView(ctx) {
  const body = h('div');
  const el = h('section', { class: 'view', 'aria-labelledby': 'vault-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'vault-heading' }, 'Vault')), body);

  // A poll never replaces an open secret or a half-typed form.
  async function refresh({ poll = false } = {}) {
    if (!can('secrets')) return clear(body, h('p', null, NEEDS_SCOPE));
    if (poll && (body.querySelector('.secret form, .recovery-once code') || [...body.querySelectorAll('input, textarea')].some((el) => el.value))) return;
    clear(body, loading());
    try {
      const secrets = await findSecrets();
      if (!secrets.length && !vaultUnlocked()) {
        return clear(body,
          h('p', null, 'Set a passphrase to start keeping encrypted secret notes. Existing notes, exports and backups are not changed.'),
          passphraseForm({ label: 'Set up vault', confirmIt: true, submit: async (pass) => { await unlockVault(pass, secrets); refresh(); } }),
          recoveryForm(secrets, refresh));
      }
      if (!vaultUnlocked()) {
        return clear(body, h('p', null, 'The vault is locked.'),
          passphraseForm({ label: 'Unlock', submit: async (pass) => { await unlockVault(pass, secrets); refresh(); } }),
          recoveryForm(secrets, refresh));
      }
      const reader = h('div');
      const creator = h('div');
      const { roots, nodes } = await secretTree(secrets);
      if (!vaultUnlocked()) return refresh();
      const move = async (node) => {
        const excluded = new Set([node.id, ...below(node)]);
        const places = [
          ...(node.parentId ? [{ id: null, label: 'Top level' }] : []),
          ...nodes.filter((n) => !excluded.has(n.id) && n.id !== node.parentId).map((n) => ({ id: n.id, label: `🔒 ${n.title}` })),
        ];
        const place = await choosePlace(`Move “${node.title}” into…`, places);
        if (!place) return;
        await ctx.run(() => put(`/outline/${enc(node.id)}/parent`, { parentId: place.id, beforeId: null }), { success: 'Moved.' });
        refresh();
      };
      const branch = (list, label) => h('ul', { class: 'vault-tree', 'aria-label': label }, list.map((node) => h('li', null,
        h('div', { class: 'vault-row' },
          h('button', { type: 'button', class: 'link-btn', onClick: () => clear(reader, h('h3', null, node.title), secretEditor(node.id, ctx, refresh)) }, `🔒 ${node.title}`),
          can('write') ? h('button', { type: 'button', class: 'btn small', 'aria-label': `New secret note inside ${node.title}`, onClick: () => clear(creator, newSecretForm(ctx, refresh, node.id, node.title)) }, 'Add inside') : null,
          can('write') ? h('button', { type: 'button', class: 'btn small', 'aria-label': `Move ${node.title}`, onClick: () => move(node).catch((error) => ctx.notify(error.message, 'error')) }, 'Move…') : null),
        node.children.length ? branch(node.children, `Inside ${node.title}`) : null)));
      clear(body,
        h('div', { class: 'actions' },
          h('p', { class: 'ok' }, 'Unlocked on this device · encrypted before sending'),
          h('button', { type: 'button', class: 'btn', onClick: () => { lockVault(); refresh(); } }, 'Lock now')),
        h('div', { class: 'vault-unlocked' },
          newSecretForm(ctx, refresh),
          creator,
          h('h2', null, 'Secret notes'),
          roots.length ? branch(roots, 'Secret notes') : empty('No secret notes yet.'),
          reader),
        recoveryPanel());
    } catch (error) {
      clear(body, errorBox(error, refresh));
    }
  }

  document.addEventListener('petty:vault-locked', () => {
    if (el.isConnected && !document.hidden) refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && el.isConnected && body.querySelector('.vault-locked-note')) refresh();
  });

  return { el, refresh };
}

async function findSecrets() {
  const found = [];
  let before;
  for (;;) {
    const page = await get(`/items${query({ type: 'note', secret: true, limit: SCAN_PAGE, before })}`);
    found.push(...page.filter(isSecret));
    if (page.length < SCAN_PAGE) break;
    const last = page.at(-1);
    before = `${last.updatedAt},${last.id}`;
  }
  return found;
}

function newSecretForm(ctx, done, parentId = null, parentTitle = '') {
  const title = h('input', { type: 'text', required: true, autocomplete: 'off' });
  const text = h('textarea', { rows: 5, autocomplete: 'off' });
  const project = h('input', { type: 'text', placeholder: 'Optional project', autocomplete: 'off' });
  const tags = h('input', { type: 'text', placeholder: 'Optional, comma separated', autocomplete: 'off' });
  const status = h('p', { class: 'hint', role: 'status' });
  return h('form', { class: 'stack vault-new', onSubmit: async (e) => {
    e.preventDefault();
    status.textContent = 'Encrypting…';
    try {
      const id = uuidv7();
      const envelope = await sealNote(id, title.value, text.value);
      await post('/vault/sealed-items', {
        id, envelope, parentId,
        project: project.value.trim() || undefined,
        tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      });
      title.value = text.value = project.value = tags.value = '';
      status.textContent = 'Saved as an encrypted note.';
      ctx.changed({ detail: false });
      done();
    } catch (error) {
      status.textContent = `Not saved: ${error.message}`;
    }
  } },
  h('h2', null, parentId ? `New secret note inside ${parentTitle || 'this note'}` : 'New secret note'),
  field('Title', title, 'Encrypted too; others see only “Secret note”. Where it sits in the outline stays visible.'),
  field('Text', text),
  h('div', { class: 'grid2' }, field('Project', project), field('Tags', tags)),
  h('p', { class: 'hint' }, 'Project and tags stay visible outside the vault.'),
  h('button', { type: 'submit', class: 'btn primary' }, 'Save secret note'),
  status);
}

document.addEventListener('petty:vault-locked', () => {
  fileNames.clear();
  recoveryGeneration++;
  for (const element of document.querySelectorAll('.recovery-once')) element.replaceChildren();
  for (const element of document.querySelectorAll('.secret, .vault-new, .vault-unlocked')) {
    element.replaceChildren(h('p', { class: 'hint vault-locked-note' }, 'Locked on this device. Open Vault to unlock again.'));
  }
  for (const input of document.querySelectorAll('input[type="password"]')) input.value = '';
});
