import { h } from './dom.js';
import { Marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';

export const REFERENCE = /\[\[item:([0-9a-fA-F-]{36})(?:\|([^\]\n]*))?\]\]/g;
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const markdown = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text, href }) => `<a href="${escape(href)}">${escape(text || 'Image')}</a>`,
  },
  extensions: [{
    name: 'itemReference', level: 'inline',
    start: (source) => { const index = source.indexOf('[[item:'); return index < 0 ? undefined : index; },
    tokenizer: (source) => {
      const match = /^\[\[item:([0-9a-fA-F-]{36})(?:\|([^\]\n]*))?\]\]/.exec(source);
      return match ? { type: 'itemReference', raw: match[0], id: match[1].toLowerCase(), label: match[2] ?? '' } : undefined;
    },
    renderer: (token) => `<span data-item-reference="${token.id}" data-label="${escape(token.label)}">${escape(token.label || 'Linked item')}</span>`,
  }],
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return;
  const href = node.getAttribute('href');
  if (!href || !/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href');
  else { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

export const PRESENTATION_DEFAULTS = Object.freeze({
  kind: 'text', attention: 'normal', review: false, checklist: false, hideCompleted: false, checked: false, autoOrganize: false,
});

export function presentationOf(item) {
  const stored = item?.metadata?.presentation;
  return { ...PRESENTATION_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export const isSecret = (item) => item?.metadata?.secret === true;

// Keep raw HTML inert and replace remote images with links to avoid tracking requests.
export function renderText(text, reference) {
  const out = h('div', { class: 'prose' });
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(markdown.parse(text), {
    USE_PROFILES: { html: true }, ALLOWED_URI_REGEXP: /^(https?:|mailto:)/i,
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'source', 'picture', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset', 'ping', 'background', 'poster', 'id', 'name'],
  });
  for (const node of template.content.querySelectorAll('[data-item-reference]')) {
    node.replaceWith(reference(node.dataset.itemReference, node.dataset.label || null));
  }
  out.append(template.content);
  return out;
}

export function displayTitle(item) {
  if (item.title?.trim()) return item.title;
  const firstLine = (item.body ?? '').replace(REFERENCE, (_, id, label) => label ?? 'reference').split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 120) || 'Untitled';
}
