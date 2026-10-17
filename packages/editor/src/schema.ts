import { type DOMOutputSpec, type Mark, type Node, Schema } from 'prosemirror-model';

const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SAFE_IMAGE = /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i;

/** The link target if it may be opened outside the editor; anything else (javascript:, file:, relative) is null. */
export const safeHref = (href: string): string | null => (SAFE_LINK.test(href.trim()) ? href.trim() : null);

export const referenceToken = (id: string, label: string) => {
  const clean = label.replace(/[\]|\n]/g, ' ').trim();
  return clean ? `[[item:${id}|${clean}]]` : `[[item:${id}]]`;
};

const listAttrs = (node: Node, extra: Record<string, string | null>) => ({ 'data-tight': node.attrs.tight ? 'true' : null, ...extra });

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    blockquote: {
      content: 'block+',
      group: 'block',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    horizontal_rule: {
      group: 'block',
      attrs: { markup: { default: '---' } },
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['div', { class: 'pm-rule' }, ['hr']],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
      attrs: { params: { default: '' } },
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    // Markdown the editor can't represent (tables, raw HTML, front matter, link definitions), kept and edited as source.
    raw_block: {
      content: 'text*',
      group: 'block',
      code: true,
      defining: true,
      marks: '',
      attrs: { kind: { default: 'source' } },
      toDOM: (node) => ['pre', { class: 'pm-raw-block', 'data-kind': node.attrs.kind }, ['code', 0]],
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 }, tight: { default: true }, delim: { default: '.' } },
      parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute('start') ?? 1) || 1 }) }],
      toDOM: (node) => ['ol', listAttrs(node, { start: node.attrs.order === 1 ? null : String(node.attrs.order) }), 0],
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { tight: { default: true }, bullet: { default: '-' } },
      parseDOM: [{ tag: 'ul' }],
      toDOM: (node) => ['ul', listAttrs(node, {}), 0],
    },
    list_item: {
      content: 'block+',
      defining: true,
      attrs: { checked: { default: null } },
      parseDOM: [{
        tag: 'li',
        getAttrs: (dom) => {
          const box = (dom as HTMLElement).querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null;
          return { checked: box ? box.checked : null };
        },
      }],
      toDOM: (node): DOMOutputSpec => node.attrs.checked === null
        ? ['li', 0]
        : ['li', { class: 'pm-task', 'data-checked': String(node.attrs.checked) },
            ['span', { class: 'pm-task-box', contenteditable: 'false', role: 'checkbox', 'aria-checked': String(node.attrs.checked), 'aria-label': 'Done' }],
            ['div', { class: 'pm-task-body' }, 0]],
    },
    text: { group: 'inline' },
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { src: {}, alt: { default: null }, title: { default: null } },
      parseDOM: [{
        tag: 'img[src]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const src = el.getAttribute('src') ?? '';
          return SAFE_IMAGE.test(src) ? { src, alt: el.getAttribute('alt'), title: el.getAttribute('title') } : false;
        },
      }],
      // Never an <img>: a saved remote image must not be fetched just because a note was opened.
      toDOM: (node) => ['span', { class: 'pm-image', title: node.attrs.src }, `Image${node.attrs.alt ? `: ${node.attrs.alt}` : ''}`],
    },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
    reference: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { id: {}, label: { default: '' }, source: { default: null } },
      parseDOM: [{
        tag: 'span[data-item]',
        getAttrs: (dom) => {
          const id = (dom as HTMLElement).getAttribute('data-item') ?? '';
          return /^[0-9a-fA-F-]{36}$/.test(id) ? { id, label: (dom as HTMLElement).textContent ?? '' } : false;
        },
      }],
      toDOM: (node) => ['span', { class: 'pm-ref', 'data-item': node.attrs.id }, node.attrs.label || 'Linked item'],
    },
  },
  marks: {
    em: {
      attrs: { markup: { default: '*' } },
      parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
      toDOM: () => ['em'],
    },
    strong: {
      attrs: { markup: { default: '**' } },
      parseDOM: [
        { tag: 'strong' },
        { tag: 'b', getAttrs: (node) => (node as HTMLElement).style.fontWeight !== 'normal' && null },
        { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null },
      ],
      toDOM: () => ['strong'],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
      toDOM: () => ['s'],
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = (dom as HTMLElement).getAttribute('href') ?? '';
          return safeHref(href) ? { href, title: (dom as HTMLElement).getAttribute('title') } : false;
        },
      }],
      // No href: links in the editor are opened deliberately (modifier-click), never by navigation.
      toDOM: (mark: Mark) => ['a', { class: 'pm-link', 'data-href': mark.attrs.href, title: mark.attrs.href }, 0],
    },
    code: {
      code: true,
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code'],
    },
    // Inline HTML from the Markdown, shown and saved as its literal source.
    raw: {
      inclusive: false,
      toDOM: () => ['span', { class: 'pm-raw' }, 0],
    },
  },
});

export type EditorSchema = typeof schema;
