// Read-only viewer for /s/<token>. It never sends credentials and only ever calls the public projection endpoint.
import { clear, empty, h, loading } from './dom.js';
import { PRESENTATION_DEFAULTS, renderText } from './text.js';

const TOKEN = /^[A-Za-z0-9._~-]{8,256}$/;

export async function mountPublic(root, rawToken) {
  document.body.classList.add('public');
  let token = null;
  try {
    token = decodeURIComponent(rawToken);
  } catch {}
  if (!token || !TOKEN.test(token)) return clear(root, unavailable('This link isn’t complete. Check that you copied all of it.'));
  clear(root, h('main', { class: 'public-page' }, loading('Opening shared page…')));
  let tree;
  try {
    const res = await fetch(`/api/v1/public/${encodeURIComponent(token)}`, {
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403) {
      return clear(root, unavailable('This link has expired, was revoked, or never existed.'));
    }
    if (!res.ok) return clear(root, unavailable(`The page couldn’t be loaded (${res.status}). Try again later.`));
    tree = await res.json();
  } catch {
    return clear(root, unavailable('The page couldn’t be reached. Check your connection and try again.'));
  }
  render(root, tree);
}

function unavailable(message) {
  return h('main', { class: 'public-page' }, h('h1', null, 'Shared page unavailable'), h('p', null, message));
}

function render(root, tree) {
  const items = Array.isArray(tree?.items) ? tree.items : [];
  const byId = new Map(items.map((n) => [n.id, n]));
  const children = Map.groupBy(items, (n) => (n.parentId && byId.has(n.parentId) ? n.parentId : null));
  const showDone = new Set();
  const title = typeof tree?.title === 'string' && tree.title.trim() ? tree.title : 'Shared page';
  document.title = `${title} · Petty Memory`;

  const content = h('div', { class: 'public-tree' });
  const reference = (id, label) => {
    const target = byId.get(id);
    // References outside the shared projection render as plain text, not links.
    return target
      ? h('a', { href: `#node-${id}`, class: 'ref' }, target.title?.trim() || label || 'Linked section')
      : h('span', { class: 'ref broken' }, label || 'private item');
  };

  const nodeView = (node, depth, inChecklist) => {
    const p = { ...PRESENTATION_DEFAULTS, ...(node.presentation ?? {}) };
    const kids = children.get(node.id) ?? [];
    const visibleKids = p.checklist && p.hideCompleted && !showDone.has(node.id) ? kids.filter((k) => !k.presentation?.checked) : kids;
    const heading = p.kind === 'heading' ? h(depth < 2 ? 'h2' : 'h3', { class: 'public-heading' }, node.title) : null;
    const done = { done: 0, total: 0 };
    if (p.checklist) countLeaves(node.id, children, done);
    return h('article', { class: `public-node kind-${p.kind} attention-${p.attention}`, id: `node-${node.id}` },
      p.kind === 'section' ? h('div', { class: 'section-break', role: 'separator' }, h('span', null, node.title)) : null,
      heading,
      p.kind === 'text' && node.title ? h('p', { class: 'public-title' },
        inChecklist ? h('span', { class: `box${p.checked ? ' checked' : ''}`, role: 'img', 'aria-label': p.checked ? 'Done' : 'Not done' }) : null,
        node.title) : null,
      node.body ? renderText(node.body, reference) : null,
      p.checklist && done.total ? h('p', { class: 'hint' }, `${done.done} of ${done.total} done`) : null,
      visibleKids.length ? h('div', { class: 'public-children' }, visibleKids.map((k) => nodeView(k, depth + 1, p.checklist))) : null,
      visibleKids.length < kids.length
        ? h('button', { type: 'button', class: 'link-btn', onClick: () => { showDone.add(node.id); draw(); } }, `Show ${kids.length - visibleKids.length} completed`)
        : null);
  };

  const draw = () => {
    const roots = children.get(null) ?? [];
    clear(content, roots.length ? roots.map((n) => nodeView(n, 0, false)) : empty('This shared page is empty.'));
  };
  draw();
  clear(root, h('main', { class: 'public-page' },
    h('header', { class: 'public-head' }, h('p', { class: 'brand' }, 'Petty Memory · shared page'), h('h1', null, title)),
    content,
    h('footer', { class: 'hint' }, 'Read-only. The owner can revoke this link at any time.')));
}

function countLeaves(id, children, acc) {
  for (const child of children.get(id) ?? []) {
    if (children.has(child.id)) countLeaves(child.id, children, acc);
    else {
      acc.total += 1;
      if (child.presentation?.checked) acc.done += 1;
    }
  }
}
