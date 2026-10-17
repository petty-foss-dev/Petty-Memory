import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { type Attrs, type MarkType, type Node, type NodeType, type ResolvedPos, Slice } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { type Command, EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type MarkdownOrigin, parseMarkdown, serializeMarkdown } from './markdown.ts';
import { referenceToken, safeHref, schema } from './schema.ts';

export const FORMAT_COMMANDS = [
  'bold', 'italic', 'strike', 'code', 'paragraph', 'heading1', 'heading2', 'heading3', 'bulletList', 'orderedList', 'checkList', 'blockquote',
  'codeBlock', 'horizontalRule', 'undo', 'redo',
] as const;
export type FormatCommand = (typeof FORMAT_COMMANDS)[number];

export type EditorMode = 'rich' | 'source';

export interface EditorOptions {
  markdown: string;
  /** Accessible name of the text area. */
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  mode?: EditorMode;
  /** Current title of a referenced item, shown instead of the label saved in the token. */
  referenceTitle?: (id: string) => string | null | undefined;
  /** Asked for a link target when the toolbar or Mod-K adds a link; resolve null to cancel. */
  requestLink?: (current: string | null) => Promise<string | null>;
  /** Asked for an item to reference when the toolbar's reference button is used. */
  requestReference?: () => Promise<{ id: string; label: string } | null>;
  onChange?: (markdown: string) => void;
  /** Any state change, including selection moves, so a host can refresh its own controls. */
  onUpdate?: () => void;
  onModeChange?: (mode: EditorMode) => void;
  onSubmit?: () => void;
  onOpenReference?: (id: string) => void;
  onOpenLink?: (href: string) => void;
}

export interface MarkdownEditor {
  readonly element: HTMLElement;
  readonly mode: EditorMode;
  getMarkdown(): string;
  /** Replaces the content and the local undo history; the new text becomes the baseline kept byte for byte. */
  setMarkdown(markdown: string): void;
  focus(): void;
  destroy(): void;
  setMode(mode: EditorMode): void;
  setReadOnly(readOnly: boolean): void;
  insertReference(id: string, label: string): void;
  run(command: FormatCommand): boolean;
  isActive(command: FormatCommand): boolean;
  canRun(command: FormatCommand): boolean;
  /** Adds, changes or (with null) removes the link on the selection. Returns false for an unsafe or empty target. */
  setLink(href: string | null): boolean;
  linkAt(): string | null;
  /** Re-reads reference titles after the host's title source changed. */
  refreshReferences(): void;
}

const { nodes, marks } = schema;
const isMac = typeof navigator !== 'undefined' && /Mac|iP(?:hone|ad|od)/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

const ancestor = ($pos: ResolvedPos, test: (node: Node) => boolean): { node: Node; pos: number; depth: number } | null => {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (test(node)) return { node, pos: $pos.before(depth), depth };
  }
  return null;
};
const isList = (node: Node) => node.type === nodes.bullet_list || node.type === nodes.ordered_list;

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

const setItems = (tr: Transaction, list: { node: Node; pos: number }, checked: boolean | null) => {
  list.node.forEach((item, offset) => {
    if (item.attrs.checked !== checked) tr.setNodeMarkup(list.pos + 1 + offset, null, { ...item.attrs, checked });
  });
};

/** Toggles a bullet, numbered or checkbox list: switching kinds keeps the items, the same kind again lifts them out. */
function toggleList(kind: 'bulletList' | 'orderedList' | 'checkList'): Command {
  const type = kind === 'orderedList' ? nodes.ordered_list : nodes.bullet_list;
  const checked = kind === 'checkList' ? false : null;
  return (state, dispatch) => {
    const list = ancestor(state.selection.$from, isList);
    if (list) {
      const sameType = list.node.type === type;
      const isTask = list.node.firstChild!.attrs.checked !== null;
      if (sameType && isTask === (kind === 'checkList')) return liftListItem(nodes.list_item)(state, dispatch);
      if (dispatch) {
        const tr = state.tr;
        if (!sameType) tr.setNodeMarkup(list.pos, type, type === nodes.ordered_list ? { order: 1, tight: list.node.attrs.tight } : { tight: list.node.attrs.tight });
        setItems(tr, { node: tr.doc.nodeAt(list.pos)!, pos: list.pos }, checked);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    if (checked === null) return wrapInList(type)(state, dispatch);
    return wrapInList(type)(state, dispatch && ((tr) => {
      const created = ancestor(tr.selection.$from, isList);
      if (created) setItems(tr, created, false);
      dispatch(tr);
    }));
  };
}

function toggleBlock(type: NodeType, attrs: Attrs | null = null): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const active = $from.parent.type === type && (!attrs || Object.entries(attrs).every(([k, v]) => $from.parent.attrs[k] === v));
    return setBlockType(active ? nodes.paragraph : type, active ? null : attrs)(state, dispatch);
  };
}

const toggleQuote: Command = (state, dispatch) =>
  ancestor(state.selection.$from, (node) => node.type === nodes.blockquote) ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch);

const insertRule: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.horizontal_rule.create()).scrollIntoView());
  return true;
};

const COMMANDS: Record<FormatCommand, Command> = {
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  strike: toggleMark(marks.strike),
  code: toggleMark(marks.code),
  paragraph: setBlockType(nodes.paragraph),
  heading1: toggleBlock(nodes.heading, { level: 1 }),
  heading2: toggleBlock(nodes.heading, { level: 2 }),
  heading3: toggleBlock(nodes.heading, { level: 3 }),
  bulletList: toggleList('bulletList'),
  orderedList: toggleList('orderedList'),
  checkList: toggleList('checkList'),
  blockquote: toggleQuote,
  codeBlock: toggleBlock(nodes.code_block),
  horizontalRule: insertRule,
  undo,
  redo,
};

function isActive(state: EditorState, command: FormatCommand): boolean {
  const { $from } = state.selection;
  const list = ancestor($from, isList);
  switch (command) {
    case 'bold': return markActive(state, marks.strong);
    case 'italic': return markActive(state, marks.em);
    case 'strike': return markActive(state, marks.strike);
    case 'code': return markActive(state, marks.code);
    case 'paragraph': return $from.parent.type === nodes.paragraph;
    case 'heading1': case 'heading2': case 'heading3':
      return $from.parent.type === nodes.heading && $from.parent.attrs.level === Number(command.slice(-1));
    case 'bulletList': return list?.node.type === nodes.bullet_list && list.node.firstChild!.attrs.checked === null;
    case 'orderedList': return list?.node.type === nodes.ordered_list;
    case 'checkList': return Boolean(list && list.node.firstChild!.attrs.checked !== null);
    case 'blockquote': return Boolean(ancestor($from, (node) => node.type === nodes.blockquote));
    case 'codeBlock': return $from.parent.type === nodes.code_block;
    default: return false;
  }
}

/** `[ ] ` or `[x] ` typed at the start of a list item (or a paragraph) makes it a checkbox item. */
const taskRule = new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== nodes.paragraph) return null;
  const checked = match[1] !== ' ';
  const item = $start.depth >= 2 ? $start.node(-1) : null;
  if (item?.type === nodes.list_item && $start.index(-1) === 0) {
    return state.tr.delete(start, end).setNodeMarkup($start.before(-1), null, { ...item.attrs, checked });
  }
  const tr = state.tr.delete(start, end);
  const range = tr.doc.resolve(start).blockRange();
  if (!range) return null;
  tr.wrap(range, [{ type: nodes.bullet_list }, { type: nodes.list_item, attrs: { checked } }]);
  return tr;
});

const rules = inputRules({
  rules: [
    wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
    wrappingInputRule(/^(\d+)([.)])\s$/, nodes.ordered_list, (match) => ({ order: Number(match[1]), delim: match[2] }),
      (match, node) => node.childCount + node.attrs.order === Number(match[1])),
    taskRule,
    wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list, (match) => ({ bullet: match[1] })),
    textblockTypeInputRule(/^```$/, nodes.code_block),
    textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1]!.length })),
  ],
});

function toggleTaskAt(view: EditorView, inside: number): boolean {
  const item = ancestor(view.state.doc.resolve(inside), (node) => node.type === nodes.list_item && node.attrs.checked !== null);
  if (!item) return false;
  view.dispatch(view.state.tr.setNodeMarkup(item.pos, null, { ...item.node.attrs, checked: !item.node.attrs.checked }));
  return true;
}

const toggleTask: Command = (state, dispatch, view) => {
  const item = ancestor(state.selection.$from, (node) => node.type === nodes.list_item && node.attrs.checked !== null);
  if (!item) return false;
  if (dispatch && view) toggleTaskAt(view, state.selection.from);
  return true;
};

/** A link target from what someone typed: http(s) and mailto as given, bare domains and addresses completed; null if unsafe. */
export const normalizeLink = (input: string): string | null => {
  const text = input.trim();
  if (!text) return null;
  if (safeHref(text)) return text;
  if (/^[^\s:/]+@[^\s@]+\.[^\s@]+$/.test(text)) return `mailto:${text}`;
  if (/^[^\s:/]+\.[^\s]+$/.test(text)) return `https://${text}`;
  return null;
};

interface ToolSpec {
  id: FormatCommand | 'link' | 'reference' | 'source';
  label: string;
  text: string;
  keys?: string;
  group?: boolean;
}

const TOOLS: ToolSpec[] = [
  { id: 'bold', label: 'Bold', text: 'B', keys: `${MOD}B` },
  { id: 'italic', label: 'Italic', text: 'I', keys: `${MOD}I` },
  { id: 'strike', label: 'Strikethrough', text: 'S', keys: `${MOD}⇧X` },
  { id: 'code', label: 'Inline code', text: '<>', keys: `${MOD}E`, group: true },
  { id: 'heading1', label: 'Heading 1', text: 'H1', keys: `${MOD}⌥1` },
  { id: 'heading2', label: 'Heading 2', text: 'H2', keys: `${MOD}⌥2` },
  { id: 'heading3', label: 'Heading 3', text: 'H3', keys: `${MOD}⌥3`, group: true },
  { id: 'bulletList', label: 'Bulleted list', text: '•', keys: `${MOD}⇧8` },
  { id: 'orderedList', label: 'Numbered list', text: '1.', keys: `${MOD}⇧7` },
  { id: 'checkList', label: 'Checkbox list', text: '☐', keys: `${MOD}⇧9` },
  { id: 'blockquote', label: 'Quote', text: '❝', keys: `${MOD}⇧.` },
  { id: 'codeBlock', label: 'Code block', text: '{ }', keys: `${MOD}⌥C`, group: true },
  { id: 'link', label: 'Link', text: 'Link', keys: `${MOD}K` },
  { id: 'reference', label: 'Link to an item', text: '[[ ]]', group: true },
  { id: 'undo', label: 'Undo typing', text: '↶', keys: `${MOD}Z` },
  { id: 'redo', label: 'Redo typing', text: '↷', keys: isMac ? '⌘⇧Z' : 'Ctrl+Y', group: true },
  { id: 'source', label: 'Edit as Markdown', text: 'Markdown' },
];

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}) => {
  const el = document.createElement(tag);
  el.className = className;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
};

/**
 * Mounts a formatted Markdown editor (toolbar, rich surface, and a Markdown source mode) into `container`.
 * Saved text stays Markdown; nothing in it is executed, fetched or navigated to.
 */
export function createMarkdownEditor(container: HTMLElement, options: EditorOptions): MarkdownEditor {
  let origin: MarkdownOrigin;
  let mode: EditorMode = options.mode ?? 'rich';
  let readOnly = options.readOnly ?? false;
  let last = options.markdown;
  const references = new Set<() => void>();

  const root = element('div', 'pm-editor');
  const toolbar = element('div', 'pm-toolbar', { role: 'toolbar', 'aria-label': `Format ${options.label.toLowerCase()}` });
  const surface = element('div', 'pm-surface');
  const source = element('textarea', 'pm-source', { 'aria-label': `${options.label} (Markdown)`, spellcheck: 'true' });
  source.placeholder = options.placeholder ?? '';
  source.hidden = true;
  root.append(toolbar, surface, source);
  container.append(root);

  const changed = (markdown: string) => {
    if (markdown === last) return;
    last = markdown;
    options.onChange?.(markdown);
  };

  const askLink = async () => {
    if (!options.requestLink) return;
    const current = linkAt();
    const answer = await options.requestLink(current);
    view.focus();
    if (answer !== null) setLink(answer || null);
  };

  const plugins = [
    rules,
    keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      ...(isMac ? {} : { 'Mod-y': redo }),
      'Mod-b': COMMANDS.bold,
      'Mod-i': COMMANDS.italic,
      'Mod-e': COMMANDS.code,
      'Shift-Mod-x': COMMANDS.strike,
      'Mod-Alt-0': COMMANDS.paragraph,
      'Mod-Alt-1': COMMANDS.heading1,
      'Mod-Alt-2': COMMANDS.heading2,
      'Mod-Alt-3': COMMANDS.heading3,
      'Mod-Alt-c': COMMANDS.codeBlock,
      'Shift-Mod-7': COMMANDS.orderedList,
      'Shift-Mod-8': COMMANDS.bulletList,
      'Shift-Mod-9': COMMANDS.checkList,
      'Shift-Mod-.': COMMANDS.blockquote,
      'Shift-Mod-Enter': toggleTask,
      'Mod-k': () => {
        void askLink();
        return Boolean(options.requestLink);
      },
      'Mod-Enter': () => {
        options.onSubmit?.();
        return Boolean(options.onSubmit);
      },
      Enter: (state, dispatch) => {
        const item = ancestor(state.selection.$from, (node) => node.type === nodes.list_item);
        return splitListItem(nodes.list_item, item && item.node.attrs.checked !== null ? { checked: false } : undefined)(state, dispatch);
      },
      Tab: sinkListItem(nodes.list_item),
      'Shift-Tab': liftListItem(nodes.list_item),
      Backspace: undoInputRule,
      'Shift-Enter': (state, dispatch) => {
        if (state.selection.$from.parent.type.spec.code) return false;
        dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
        return true;
      },
    }),
    keymap(baseKeymap),
    history(),
    dropCursor(),
    gapCursor(),
  ];

  const createState = (markdown: string) => {
    const parsed = parseMarkdown(markdown);
    origin = parsed.origin;
    return EditorState.create({ doc: parsed.doc, plugins });
  };

  const view: EditorView = new EditorView(surface, {
    state: createState(options.markdown),
    editable: () => !readOnly,
    attributes: (state) => ({
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': options.label,
      'data-placeholder': options.placeholder ?? '',
      class: state.doc.childCount === 1 && state.doc.firstChild!.isTextblock && state.doc.firstChild!.content.size === 0 ? 'pm-empty' : '',
    }),
    nodeViews: {
      reference: (node) => {
        const dom = element('span', 'pm-ref', { 'data-item': node.attrs.id, title: `Linked item. ${MOD}click to open.` });
        const render = () => {
          dom.textContent = options.referenceTitle?.(node.attrs.id) || node.attrs.label || 'Linked item';
        };
        render();
        references.add(render);
        return { dom, ignoreMutation: () => true, destroy: () => void references.delete(render) };
      },
    },
    handleClick: (_, __, event) => {
      const target = event.target as HTMLElement;
      if (!(isMac ? event.metaKey : event.ctrlKey)) return false;
      const reference = target.closest<HTMLElement>('.pm-ref');
      if (reference?.dataset.item) {
        options.onOpenReference?.(reference.dataset.item);
        return true;
      }
      const href = target.closest<HTMLElement>('.pm-link')?.dataset.href;
      const safe = href ? safeHref(href) : null;
      if (safe) options.onOpenLink?.(safe);
      return Boolean(safe);
    },
    handleDOMEvents: {
      beforeinput: (v, event) => {
        const input = event as InputEvent;
        if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
          event.preventDefault();
          (input.inputType === 'historyUndo' ? undo : redo)(v.state, v.dispatch, v);
          return true;
        }
        // A first keystroke can arrive before the browser's selectionchange event; history must start at the visible caret.
        const selection = v.dom.ownerDocument.getSelection();
        if (!input.isComposing && v.state.selection instanceof TextSelection && selection?.anchorNode && selection.focusNode
          && v.dom.contains(selection.anchorNode) && v.dom.contains(selection.focusNode)) {
          const anchor = v.state.doc.resolve(v.posAtDOM(selection.anchorNode, selection.anchorOffset));
          const head = v.state.doc.resolve(v.posAtDOM(selection.focusNode, selection.focusOffset));
          const next = TextSelection.between(anchor, head);
          if (!v.state.selection.eq(next)) v.dispatch(v.state.tr.setSelection(next));
        }
        return false;
      },
      mousedown: (v, event) => {
        const box = (event.target as HTMLElement).closest('.pm-task-box');
        const body = box?.nextElementSibling;
        if (!body || readOnly) return false;
        event.preventDefault();
        return toggleTaskAt(v, v.posAtDOM(body, 0));
      },
    },
    clipboardTextParser: (text, $context, plain) => {
      if (plain) return null as unknown as Slice;
      const parsed = parseMarkdown(text.replace(/\r\n?/g, '\n')).doc;
      const slice = Slice.maxOpen(parsed.content);
      return $context.parent.inlineContent && parsed.childCount === 1 && parsed.firstChild!.type === nodes.paragraph
        ? new Slice(parsed.firstChild!.content, 0, 0)
        : slice;
    },
    clipboardTextSerializer: (slice) => {
      const first = slice.content.firstChild;
      return first?.isBlock ? serializeMarkdown(schema.topNodeType.create(null, slice.content)) : slice.content.textBetween(0, slice.content.size, '\n\n');
    },
    dispatchTransaction: (tr) => {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) changed(serializeMarkdown(view.state.doc, origin));
      updateToolbar();
      options.onUpdate?.();
    },
  });

  const buttons = new Map<ToolSpec['id'], HTMLButtonElement>();
  for (const tool of TOOLS) {
    if (tool.id === 'link' && !options.requestLink) continue;
    if (tool.id === 'reference' && !options.requestReference) continue;
    const button = element('button', `pm-tool pm-tool-${tool.id}`, { type: 'button', 'aria-label': tool.label, title: tool.keys ? `${tool.label} (${tool.keys})` : tool.label });
    button.textContent = tool.text;
    button.tabIndex = buttons.size === 0 ? 0 : -1;
    if (tool.group) button.dataset.group = 'end';
    // Keeps the text selection while a button is clicked.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => void press(tool.id));
    buttons.set(tool.id, button);
    toolbar.append(button);
  }
  toolbar.addEventListener('keydown', (event) => {
    const list = [...buttons.values()].filter((b) => !b.disabled);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null;
    if (next === null || at < 0) return;
    event.preventDefault();
    const target = list[(next + list.length) % list.length]!;
    for (const b of buttons.values()) b.tabIndex = b === target ? 0 : -1;
    target.focus();
  });

  async function press(id: ToolSpec['id']) {
    if (id === 'source') {
      setMode(mode === 'rich' ? 'source' : 'rich');
      return;
    }
    if (id === 'link') return askLink();
    if (id === 'reference') {
      const picked = await options.requestReference!();
      if (picked) insertReference(picked.id, picked.label);
      else focus();
      return;
    }
    COMMANDS[id](view.state, view.dispatch, view);
    view.focus();
  }

  function updateToolbar() {
    const rich = mode === 'rich';
    const roving = [...buttons.values()];
    for (const [id, button] of buttons) {
      if (id === 'source') {
        button.setAttribute('aria-pressed', String(!rich));
        button.disabled = readOnly && rich;
        continue;
      }
      button.disabled = !rich || readOnly || (id !== 'link' && id !== 'reference' && !canRun(id));
      if (id === 'link') button.setAttribute('aria-pressed', String(rich && linkAt() !== null));
      else if (id !== 'reference' && id !== 'undo' && id !== 'redo' && id !== 'horizontalRule') button.setAttribute('aria-pressed', String(rich && isActive(view.state, id)));
    }
    // The toolbar stays one tab stop even when the button holding it becomes disabled.
    if (!roving.some((b) => b.tabIndex === 0 && !b.disabled)) {
      const first = roving.find((b) => !b.disabled);
      for (const b of roving) b.tabIndex = b === first ? 0 : -1;
    }
  }

  source.addEventListener('input', () => changed(source.value));
  source.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey) && options.onSubmit && !event.isComposing) {
      event.preventDefault();
      options.onSubmit();
    }
  });

  function getMarkdown() {
    return mode === 'source' ? source.value : serializeMarkdown(view.state.doc, origin);
  }

  function setMarkdown(markdown: string) {
    last = markdown;
    view.updateState(createState(markdown));
    source.value = markdown;
    updateToolbar();
  }

  function setMode(next: EditorMode) {
    if (next === mode) return;
    if (next === 'source') {
      source.value = getMarkdown();
      mode = 'source';
    } else {
      const text = source.value;
      mode = 'rich';
      // Text edited as source is the new baseline, so it round-trips as written.
      if (text !== serializeMarkdown(view.state.doc, origin)) setMarkdown(text);
    }
    surface.hidden = mode === 'source';
    source.hidden = mode === 'rich';
    updateToolbar();
    focus();
    options.onModeChange?.(mode);
  }

  function focus() {
    if (mode === 'source') source.focus();
    else view.focus();
  }

  function insertReference(id: string, label: string) {
    if (mode === 'source') {
      source.setRangeText(referenceToken(id, label), source.selectionStart, source.selectionEnd, 'end');
      changed(source.value);
      source.focus();
      return;
    }
    const node = nodes.reference.create({ id, label: label.replace(/[\]|\n]/g, ' ').trim() });
    view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
    view.focus();
  }

  function setLink(href: string | null): boolean {
    const { state } = view;
    const { from, to, empty } = state.selection;
    const range = empty ? markRange(state, from) : { from, to };
    if (href === null) {
      if (range) view.dispatch(state.tr.removeMark(range.from, range.to, marks.link));
      return true;
    }
    const target = normalizeLink(href);
    if (!target) return false;
    const mark = marks.link.create({ href: target });
    if (range) view.dispatch(state.tr.removeMark(range.from, range.to, marks.link).addMark(range.from, range.to, mark));
    else view.dispatch(state.tr.replaceSelectionWith(schema.text(target, [mark]), false));
    return true;
  }

  function linkAt(): string | null {
    const { $from, from, to, empty } = view.state.selection;
    if (empty) return marks.link.isInSet($from.marks())?.attrs.href ?? null;
    let href: string | null = null;
    view.state.doc.nodesBetween(from, to, (node) => {
      href ??= marks.link.isInSet(node.marks)?.attrs.href ?? null;
    });
    return href;
  }

  function canRun(command: FormatCommand): boolean {
    if (command === 'undo') return undoDepth(view.state) > 0;
    if (command === 'redo') return redoDepth(view.state) > 0;
    return COMMANDS[command](view.state, undefined, view);
  }

  updateToolbar();

  return {
    element: root,
    get mode() {
      return mode;
    },
    getMarkdown,
    setMarkdown,
    focus,
    destroy: () => {
      view.destroy();
      root.remove();
    },
    setMode,
    setReadOnly: (next) => {
      readOnly = next;
      source.readOnly = next;
      view.setProps({});
      updateToolbar();
    },
    insertReference,
    run: (command) => {
      const done = COMMANDS[command](view.state, view.dispatch, view);
      view.focus();
      return done;
    },
    isActive: (command) => isActive(view.state, command),
    canRun,
    setLink,
    linkAt,
    refreshReferences: () => {
      for (const render of references) render();
    },
  };
}

/** The extent of the link around `pos`, for editing a link with nothing selected. */
function markRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const $pos = state.doc.resolve(pos);
  const link = marks.link.isInSet($pos.marks());
  if (!link) return null;
  const { parent } = $pos;
  const offsets: number[] = [];
  parent.forEach((_, offset) => offsets.push($pos.start() + offset));
  const linked = (i: number) => Boolean(link.isInSet(parent.child(i).marks));
  const index = offsets.findIndex((from, i) => from <= pos && pos <= from + parent.child(i).nodeSize && linked(i));
  if (index < 0) return null;
  let first = index;
  let last = index;
  while (first > 0 && linked(first - 1)) first--;
  while (last < parent.childCount - 1 && linked(last + 1)) last++;
  return { from: offsets[first]!, to: offsets[last]! + parent.child(last).nodeSize };
}
