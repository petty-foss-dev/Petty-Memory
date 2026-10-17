import { enc, get, post, query } from './api.js';
import { clear, confirmDialog, empty, errorBox, field, h, loading, when } from './dom.js';
import { displayTitle, isSecret } from './text.js';

const MAX_DESCENDANTS = 500;
const EXPIRY = [['', 'Never'], ['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['custom', 'On a date…']];

export const shareUrl = (token) => `${location.origin}/s/${encodeURIComponent(token)}`;

async function descendants(rootId) {
  const nodes = [];
  const queue = [{ id: rootId, depth: 0 }];
  while (queue.length && nodes.length < MAX_DESCENDANTS) {
    const { id, depth } = queue.shift();
    for (let offset = 0; ; offset += 200) {
      const page = await get(`/outline${query({ parent: id, offset, limit: 200 })}`);
      for (const entry of page.items) {
        nodes.push({ entry, depth: depth + 1, parentId: id });
        if (entry.childCount > 0) queue.push({ id: entry.item.id, depth: depth + 1 });
      }
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
  }
  // Depth-first order reads like the outline.
  const byParent = Map.groupBy(nodes, (n) => n.parentId);
  const ordered = [];
  const walk = (id) => {
    for (const node of byParent.get(id) ?? []) {
      ordered.push(node);
      walk(node.entry.item.id);
    }
  };
  walk(rootId);
  return { nodes: ordered, truncated: nodes.length >= MAX_DESCENDANTS };
}

export function createShareForm(item, ctx) {
  const box = h('div', { class: 'share-form' });
  const start = () => {
    const excluded = new Set();
    const expiry = h('select', { 'aria-label': 'Link expires' }, EXPIRY.map(([value, label]) => h('option', { value }, label)));
    const custom = h('input', { type: 'datetime-local', hidden: true, 'aria-label': 'Expiry date' });
    expiry.addEventListener('change', () => { custom.hidden = expiry.value !== 'custom'; });
    const tree = h('div', { class: 'exclude-tree' }, loading('Loading what’s inside…'));
    const status = h('p', { class: 'hint', role: 'status' });

    descendants(item.id).then(({ nodes, truncated }) => {
      if (!nodes.length) return clear(tree, h('p', { class: 'hint' }, 'This item has nothing inside; the link shows just this item.'));
      const boxes = new Map();
      const sync = () => {
        for (const node of nodes) {
          const hiddenByParent = node.parentId !== item.id && (excluded.has(node.parentId) || boxes.get(node.parentId)?.disabled);
          const input = boxes.get(node.entry.item.id);
          input.disabled = hiddenByParent || isSecret(node.entry.item);
        }
      };
      clear(tree,
        h('p', { class: 'hint' }, 'Tick anything to leave out. Leaving out an item also leaves out everything inside it. Secret notes are never shared.'),
        nodes.map((node) => {
          const secret = isSecret(node.entry.item);
          const input = h('input', { type: 'checkbox', checked: secret, onChange: (e) => {
            if (e.target.checked) excluded.add(node.entry.item.id);
            else excluded.delete(node.entry.item.id);
            sync();
          } });
          boxes.set(node.entry.item.id, input);
          return h('label', { class: 'check', style: { '--depth': node.depth - 1 } }, input, secret ? 'Secret note (always left out)' : displayTitle(node.entry.item));
        }),
        truncated ? h('p', { class: 'hint' }, `Only the first ${MAX_DESCENDANTS} items inside are listed.`) : null);
      sync();
    }, (error) => clear(tree, errorBox(error)));

    const create = async (e) => {
      e.preventDefault();
      let expiresAt = null;
      if (expiry.value === 'custom') {
        const at = new Date(custom.value);
        if (!custom.value || Number.isNaN(at.getTime()) || at <= new Date()) return void (status.textContent = 'Choose a future date for the link to expire.');
        expiresAt = at.toISOString();
      } else if (expiry.value) {
        expiresAt = new Date(Date.now() + Number(expiry.value) * 86_400_000).toISOString();
      }
      status.textContent = 'Creating link…';
      try {
        const { share, token } = await post('/shares', { rootId: item.id, excludedIds: [...excluded], expiresAt });
        clear(box, linkView(token, share));
        ctx.changed({ detail: false, outline: false });
      } catch (error) {
        status.textContent = error.message;
      }
    };

    clear(box, h('form', { class: 'stack', onSubmit: create },
      h('p', { class: 'hint' }, 'Anyone with the link can read this item and what’s inside it, without signing in. You can revoke it at any time under Shares.'),
      h('div', { class: 'grid2' }, field('Expires', expiry), custom),
      tree,
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: 'btn primary' }, 'Create link'),
        h('button', { type: 'button', class: 'btn', onClick: reset }, 'Cancel')),
      status));
  };
  const reset = () => clear(box, h('button', { type: 'button', class: 'btn', onClick: start }, 'Create public link…'));
  reset();
  return box;
}

function linkView(token, share) {
  const url = shareUrl(token);
  const input = h('input', { type: 'text', readOnly: true, value: url, 'aria-label': 'Public link', onFocus: (e) => e.target.select() });
  const status = h('p', { class: 'hint', role: 'status' }, 'Copy it now: the link is shown only once.');
  return h('div', { class: 'stack' },
    h('p', { class: 'ok' }, share.expiresAt ? `Link created. It expires ${when(share.expiresAt)}.` : 'Link created.'),
    input,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onClick: async () => {
      try {
        await navigator.clipboard.writeText(url);
        status.textContent = 'Copied.';
      } catch {
        input.focus();
        status.textContent = 'This browser blocked copying; the link is selected, so copy it with your keyboard.';
      }
    } }, 'Copy link')),
    status);
}

export function createSharesView(ctx) {
  const body = h('div');
  const el = h('section', { class: 'view', 'aria-labelledby': 'shares-heading' },
    h('header', { class: 'view-head' }, h('h1', { id: 'shares-heading' }, 'Shares')),
    h('p', { class: 'hint' }, 'Public read-only links you created. To share something new, open it and choose “Create public link”.'),
    body);

  async function refresh() {
    if (!body.childElementCount) body.append(loading());
    try {
      const shares = await get('/shares');
      const now = Date.now();
      const state = (s) => (s.revokedAt ? `Revoked ${when(s.revokedAt)}` : s.expiresAt && Date.parse(s.expiresAt) <= now ? `Expired ${when(s.expiresAt)}` : s.expiresAt ? `Active until ${when(s.expiresAt)}` : 'Active');
      const active = (s) => !s.revokedAt && !(s.expiresAt && Date.parse(s.expiresAt) <= now);
      clear(body, shares.length
        ? h('ul', { class: 'cards' }, shares.map((s) => {
          const title = h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.select(s.rootId) }, 'Shared item');
          get(`/items/${enc(s.rootId)}`).then((item) => { title.textContent = displayTitle(item); }, () => { title.textContent = 'Item no longer available'; });
          return h('li', { class: `card${active(s) ? '' : ' inactive'}` },
            title,
            h('p', { class: 'meta' }, `${state(s)} · created ${when(s.createdAt)}${s.excludedIds.length ? ` · ${s.excludedIds.length} part${s.excludedIds.length === 1 ? '' : 's'} left out` : ''}`),
            active(s) ? h('button', { type: 'button', class: 'btn small danger', onClick: async () => {
              const ok = await confirmDialog({
                title: 'Revoke this link?', body: 'Anyone who has it loses access immediately. This can’t be undone; you can make a new link later.',
                confirmLabel: 'Revoke link', danger: true,
              });
              if (ok) ctx.run(() => post(`/shares/${enc(s.id)}/revoke`), { success: 'Link revoked.', refreshOutline: false });
            } }, 'Revoke') : null);
        }))
        : empty('No public links yet.'));
    } catch (error) {
      clear(body, errorBox(error, refresh));
    }
  }

  return { el, refresh };
}
