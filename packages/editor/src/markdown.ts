import MarkdownIt, { type StateInline, type Token } from 'markdown-it';
import { Fragment, type Mark, type Node } from 'prosemirror-model';
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';
import { referenceToken, schema } from './schema.ts';

const REFERENCE = /^\[\[item:([0-9a-fA-F-]{36})(?:\|([^\]\n]*))?\]\]/;
const TASK = /^\[([ xX])\][ \t]+/;
const FRONT_MATTER_OPEN = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

function itemReference(state: StateInline, silent: boolean): boolean {
  if (!state.src.startsWith('[[item:', state.pos)) return false;
  const match = REFERENCE.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push('item_reference', '', 0);
    token.content = match[0];
    token.meta = { id: match[1], label: match[2] ?? '' };
  }
  state.pos += match[0].length;
  return true;
}

const tokenizer = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
tokenizer.inline.ruler.before('link', 'item_reference', itemReference);

const listIsTight = (tokens: Token[], i: number) => {
  while (++i < tokens.length) if (tokens[i]!.type !== 'list_item_open') return tokens[i]!.hidden;
  return false;
};

interface Env {
  tokens: Token[];
}

const parser = new MarkdownParser(schema, { parse: (_: string, env: Env) => env.tokens } as unknown as MarkdownIt, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'list_item', getAttrs: (token) => ({ checked: token.meta?.checked ?? null }) },
  bullet_list: { block: 'bullet_list', getAttrs: (token, tokens, i) => ({ tight: listIsTight(tokens, i), bullet: token.markup || '-' }) },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (token, tokens, i) => ({ order: Number(token.attrGet('start')) || 1, tight: listIsTight(tokens, i), delim: token.markup || '.' }),
  },
  heading: { block: 'heading', getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  code_block: { block: 'code_block', noCloseToken: true },
  fence: { block: 'code_block', getAttrs: (token) => ({ params: token.info || '' }), noCloseToken: true },
  html_block: { block: 'raw_block', attrs: { kind: 'html' }, noCloseToken: true },
  raw_block: { block: 'raw_block', getAttrs: (token) => ({ kind: token.info }), noCloseToken: true },
  hr: { node: 'horizontal_rule', getAttrs: (token) => ({ markup: token.markup || '---' }) },
  image: {
    node: 'image',
    getAttrs: (token) => ({ src: token.attrGet('src'), title: token.attrGet('title') || null, alt: token.content || null }),
  },
  hardbreak: { node: 'hard_break' },
  item_reference: { node: 'reference', getAttrs: (token) => ({ id: token.meta.id, label: token.meta.label, source: token.content }) },
  em: { mark: 'em', getAttrs: (token) => ({ markup: token.markup || '*' }) },
  strong: { mark: 'strong', getAttrs: (token) => ({ markup: token.markup || '**' }) },
  s: { mark: 'strike' },
  link: { mark: 'link', getAttrs: (token) => ({ href: token.attrGet('href'), title: token.attrGet('title') || null }) },
  code_inline: { mark: 'code', noCloseToken: true },
  html_inline: { mark: 'raw', noCloseToken: true },
});

const handled = new Set([
  'blockquote_open', 'blockquote_close', 'paragraph_open', 'paragraph_close', 'list_item_open', 'list_item_close', 'bullet_list_open',
  'bullet_list_close', 'ordered_list_open', 'ordered_list_close', 'heading_open', 'heading_close', 'code_block', 'fence', 'html_block', 'hr',
  'inline', 'text', 'softbreak', 'hardbreak', 'image', 'item_reference', 'em_open', 'em_close', 'strong_open', 'strong_close', 's_open',
  's_close', 'link_open', 'link_close', 'code_inline', 'html_inline',
]);

const supported = (tokens: Token[]): boolean =>
  tokens.every((token) => handled.has(token.type) && (!token.children || token.type === 'image' || supported(token.children)));

/** Softbreaks stay newlines, and `[ ]`/`[x]` at the start of a list item become its checkbox. */
function prepare(tokens: Token[]): Token[] {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === 'inline' && token.children) {
      for (const child of token.children) if (child.type === 'softbreak') Object.assign(child, { type: 'text', content: '\n' });
    }
    if (token.type !== 'list_item_open' || tokens[i + 1]?.type !== 'paragraph_open') continue;
    const first = tokens[i + 2]?.children?.[0];
    const match = first?.type === 'text' ? TASK.exec(first.content) : null;
    if (!match) continue;
    first!.content = first!.content.slice(match[0].length);
    token.meta = { ...token.meta, checked: match[1] !== ' ' };
  }
  return tokens;
}

interface Segment {
  line: number;
  tokens: Token[] | null;
  kind: string;
  /** Source lines the block itself covers, without the blank lines after it. */
  own: number;
}

/** What the document was parsed from: every top-level node maps to its exact source text. */
export interface MarkdownOrigin {
  text: string;
  doc: Node;
  blocks: { node: Node; source: string }[];
}

export interface ParsedMarkdown {
  doc: Node;
  origin: MarkdownOrigin;
}

function rawNode(source: string, kind: string): Node {
  const text = source.replace(/\n+$/, '');
  return schema.nodes.raw_block.create({ kind }, text ? schema.text(text) : null);
}

/**
 * Parses Markdown into a document whose top-level blocks each remember their source, so unchanged blocks serialize back
 * byte for byte. Anything the schema can't hold (tables, front matter, link definitions, unknown syntax) becomes a raw
 * source block rather than being dropped.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; i++) {
    starts.push(at);
    at += lines[i]!.length + 1;
  }
  const slice = (from: number, to: number) => text.slice(starts[from] ?? text.length, to < lines.length ? starts[to] : text.length);

  let front = 0;
  if (FRONT_MATTER_OPEN.test(lines[0] ?? '')) {
    const close = lines.findIndex((line, i) => i > 0 && FRONT_MATTER_CLOSE.test(line));
    if (close > 0) front = close + 1;
  }
  const masked = front ? `${'\n'.repeat(front)}${lines.slice(front).join('\n')}` : text;
  const tokens = tokenizer.parse(masked, {});

  const segments: Segment[] = front ? [{ line: 0, tokens: null, kind: 'front-matter', own: front }] : [];
  const covered = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < front; i++) covered[i] = true;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!;
    let end = i;
    if (open.nesting === 1) {
      for (let depth = 0; end < tokens.length; end++) {
        depth += tokens[end]!.nesting;
        if (depth === 0) break;
      }
    }
    const block = tokens.slice(i, end + 1);
    const [from, to] = open.map ?? [0, 0];
    for (let line = from; line < to; line++) covered[line] = true;
    segments.push({
      line: from,
      own: to,
      tokens: supported(block) ? prepare(block) : null,
      kind: block.some((t) => t.type === 'table_open') ? 'table' : 'source',
    });
    i = end;
  }
  // Lines no token covers (link reference definitions) are kept as source blocks of their own.
  for (let line = 0; line < lines.length; line++) {
    if (covered[line] || !lines[line]!.trim()) continue;
    let end = line;
    while (end < lines.length && !covered[end] && lines[end]!.trim()) end++;
    segments.push({ line, tokens: null, kind: 'source', own: end });
    line = end;
  }
  segments.sort((a, b) => a.line - b.line);

  const blocks: MarkdownOrigin['blocks'] = [];
  segments.forEach((segment, index) => {
    const source = slice(index === 0 ? 0 : segment.line, segments[index + 1]?.line ?? lines.length);
    let node: Node | null = null;
    if (segment.tokens) {
      try {
        const parsed = parser.parse('', { tokens: segment.tokens } satisfies Env);
        if (parsed.childCount === 1) node = parsed.firstChild;
      } catch {}
    }
    blocks.push({ node: node ?? rawNode(slice(segment.line, segment.own), segment.kind), source });
  });
  const doc = blocks.length
    ? schema.topNodeType.create(null, blocks.map((block) => block.node))
    : schema.topNodeType.createAndFill()!;
  return { doc, origin: { text, doc, blocks } };
}

const markup = (_: MarkdownSerializerState, mark: Mark) => mark.attrs.markup as string;

function writeText(state: MarkdownSerializerState, node: Node, parent: Node) {
  const text = parent.type === schema.nodes.heading ? node.text!.replace(/\n/g, ' ') : node.text!;
  const [first, ...rest] = text.split('\n');
  state.text(first!);
  for (const line of rest) {
    state.text('\n', false);
    // A continuation line must not start a list, heading or quote when it's read back.
    state.text(state.esc(line, true), false);
  }
}

const isPlainUrl = (mark: Mark, parent: Node, index: number) => {
  const content = parent.child(index);
  return !mark.attrs.title && /^\w+:/.test(mark.attrs.href) && content.isText && content.text === mark.attrs.href
    && (index === 0 || !mark.isInSet(parent.child(index - 1).marks))
    && (index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks));
};

const backticks = (node: Node, side: number) => {
  let longest = 0;
  for (const match of node.isText ? node.text!.matchAll(/`+/g) : []) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? (side < 0 ? `${fence} ` : ` ${fence}`) : fence;
};

const serializer = new MarkdownSerializer({
  blockquote: (state, node) => state.wrapBlock('> ', null, node, () => state.renderContent(node)),
  code_block: (state, node) => {
    const runs = node.textContent.match(/`{3,}/g);
    const fence = runs ? `${runs.sort().at(-1)}\`` : '```';
    state.write(`${fence}${node.attrs.params || ''}\n`);
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },
  raw_block: (state, node) => {
    state.text(node.textContent, false);
    state.closeBlock(node);
  },
  heading: (state, node) => {
    state.write(`${'#'.repeat(node.attrs.level)} `);
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontal_rule: (state, node) => {
    state.write(node.attrs.markup);
    state.closeBlock(node);
  },
  bullet_list: (state, node) => state.renderList(node, '  ', () => `${node.attrs.bullet} `),
  ordered_list: (state, node) => {
    const start = node.attrs.order as number;
    const width = String(start + node.childCount - 1).length;
    state.renderList(node, ' '.repeat(width + 2), (i) => {
      const n = String(start + i);
      return `${' '.repeat(width - n.length)}${n}${node.attrs.delim} `;
    });
  },
  list_item: (state, node) => {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
  paragraph: (state, node) => {
    state.renderInline(node);
    state.closeBlock(node);
  },
  image: (state, node) => {
    const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : '';
    state.write(`![${state.esc(node.attrs.alt || '')}](${node.attrs.src.replace(/[()]/g, '\\$&')}${title})`);
  },
  hard_break: (state, node, parent, index) => {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        state.write('\\\n');
        return;
      }
    }
  },
  reference: (state, node) => {
    const { id, label, source } = node.attrs;
    state.write(source ?? referenceToken(id, label));
  },
  text: writeText,
}, {
  em: { open: markup, close: markup, mixable: true, expelEnclosingWhitespace: true },
  strong: { open: markup, close: markup, mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  link: {
    open: (_, mark, parent, index) => (isPlainUrl(mark, parent, index) ? '<' : '['),
    close: (_, mark, parent, index) => {
      if (isPlainUrl(mark, parent, index - 1)) return '>';
      const title = mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : '';
      return `](${mark.attrs.href.replace(/[()"]/g, '\\$&')}${title})`;
    },
    mixable: true,
  },
  code: { open: (_, __, parent, index) => backticks(parent.child(index), -1), close: (_, __, parent, index) => backticks(parent.child(index - 1), 1), escape: false },
  raw: { open: '', close: '', escape: false },
}, {
  // Typed `<tag` or `&entity;` must stay literal text, not become HTML when read back.
  escapeExtraCharacters: /<(?=[A-Za-z/!?])|&(?=#?[A-Za-z0-9]+;)/g,
});

const serializeRun = (nodes: Node[]) => serializer.serialize(schema.topNodeType.create(null, Fragment.from(nodes)));

/**
 * Markdown for `doc`. Top-level blocks that are unchanged since `origin` keep their original source exactly; changed or
 * new ones are serialized, separated from their neighbours by a blank line.
 */
export function serializeMarkdown(doc: Node, origin?: MarkdownOrigin): string {
  if (origin && doc.eq(origin.doc)) return origin.text;
  const used = new Set<number>();
  const match = (node: Node): number => {
    if (!origin) return -1;
    const same = origin.blocks.findIndex((block, i) => !used.has(i) && block.node === node);
    const index = same >= 0 ? same : origin.blocks.findIndex((block, i) => !used.has(i) && block.node.eq(node));
    if (index >= 0) used.add(index);
    return index;
  };

  let out = '';
  let previous = -2;
  let run: Node[] = [];
  const separate = () => {
    if (!out) return;
    if (!out.endsWith('\n')) out += '\n';
    if (!out.endsWith('\n\n')) out += '\n';
  };
  const flush = () => {
    if (!run.length) return;
    separate();
    out += serializeRun(run);
    run = [];
  };
  doc.forEach((node) => {
    const index = match(node);
    if (index < 0) {
      run.push(node);
      previous = -2;
      return;
    }
    flush();
    if (index !== previous + 1) separate();
    out += origin!.blocks[index]!.source;
    previous = index;
  });
  flush();
  return out.replace(/\n+$/, '') + (origin?.text.endsWith('\n') && out.trim() ? '\n' : '');
}
