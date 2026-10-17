import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const globals = dom.window as unknown as Record<string, unknown>;
for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : globals[name], configurable: true, writable: true });
}
(dom.window.document as unknown as { getSelection: () => Selection | null }).getSelection = () => dom.window.getSelection();
dom.window.HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

const { createMarkdownEditor } = await import('../src/editor.ts');
const { controlledValue } = await import('../src/controlled.ts');

const REF = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const mount = (markdown: string, extra: Partial<Parameters<typeof createMarkdownEditor>[1]> = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const changes: string[] = [];
  const editor = createMarkdownEditor(host, { markdown, label: 'Note', onChange: (m) => changes.push(m), ...extra });
  return { host, editor, changes };
};
const surface = (host: HTMLElement) => host.querySelector('.ProseMirror') as HTMLElement;

test('mounting keeps the original Markdown exactly until something changes', () => {
  const text = '| a |\n|---|\n\n*kept* _as is_\n';
  const { host, editor, changes } = mount(text);
  assert.equal(editor.getMarkdown(), text);
  assert.equal(changes.length, 0);
  assert.equal(surface(host).getAttribute('role'), 'textbox');
  assert.equal(surface(host).getAttribute('aria-label'), 'Note');
  assert.ok(host.querySelector('pre.pm-raw-block[data-kind="table"]'));
  editor.destroy();
  assert.equal(host.childElementCount, 0);
});

test('toolbar commands produce Markdown and report active state', () => {
  const { host, editor, changes } = mount('word');
  editor.focus();
  editor.run('heading2');
  assert.equal(editor.getMarkdown(), '## word');
  assert.ok(editor.isActive('heading2'));
  editor.run('heading2');
  editor.run('checkList');
  assert.equal(editor.getMarkdown(), '- [ ] word');
  assert.ok(editor.isActive('checkList'));
  editor.run('bulletList');
  assert.equal(editor.getMarkdown(), '- word');
  editor.run('orderedList');
  assert.equal(editor.getMarkdown(), '1. word');
  assert.equal(changes.at(-1), '1. word');
  const pressed = host.querySelector('.pm-tool-orderedList')!.getAttribute('aria-pressed');
  assert.equal(pressed, 'true');
  editor.run('undo');
  assert.notEqual(editor.getMarkdown(), '1. word');
  assert.ok(editor.canRun('redo'));
  editor.run('redo');
  assert.equal(editor.getMarkdown(), '1. word');
  editor.destroy();
});

test('references are inserted as stable tokens and show the current title', () => {
  let title = 'Old title';
  const { host, editor } = mount('See ', { referenceTitle: () => title });
  editor.insertReference(REF, 'Saved | label');
  assert.match(editor.getMarkdown(), new RegExp(`\\[\\[item:${REF}\\|Saved   label\\]\\]`));
  assert.equal(host.querySelector('.pm-ref')!.textContent, 'Old title');
  title = 'New title';
  editor.refreshReferences();
  assert.equal(host.querySelector('.pm-ref')!.textContent, 'New title');
  assert.equal(host.querySelector('.pm-ref')!.getAttribute('href'), null);
  editor.destroy();
});

test('native history input uses the editor history rather than the browser DOM history', () => {
  const { host, editor } = mount('word');
  editor.run('heading2');
  const input = (inputType: string) => {
    const event = new dom.window.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    surface(host).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  input('historyUndo');
  assert.equal(editor.getMarkdown(), 'word');
  input('historyRedo');
  assert.equal(editor.getMarkdown(), '## word');
  editor.destroy();
});

test('links only accept safe targets and render without an href', () => {
  const { host, editor } = mount('');
  assert.equal(editor.setLink('javascript:alert(1)'), false);
  assert.equal(editor.setLink('example.com'), true);
  assert.equal(editor.getMarkdown(), '<https://example.com>');
  const anchor = host.querySelector('a.pm-link')!;
  assert.equal(anchor.getAttribute('href'), null);
  assert.equal(anchor.getAttribute('data-href'), 'https://example.com');
  editor.destroy();
});

test('source mode edits the Markdown directly and becomes the new exact baseline', () => {
  const { host, editor, changes } = mount('**a**');
  editor.setMode('source');
  const source = host.querySelector('textarea.pm-source') as HTMLTextAreaElement;
  assert.equal(source.hidden, false);
  assert.equal(source.value, '**a**');
  source.value = '| t |\n|---|\n\n__b__';
  source.dispatchEvent(new dom.window.Event('input'));
  assert.equal(changes.at(-1), '| t |\n|---|\n\n__b__');
  editor.setMode('rich');
  assert.equal(editor.getMarkdown(), '| t |\n|---|\n\n__b__');
  assert.ok(host.querySelector('pre.pm-raw-block'));
  editor.destroy();
});

test('setMarkdown replaces content and local history', () => {
  const { editor } = mount('one');
  editor.run('bold');
  editor.setMarkdown('two');
  assert.equal(editor.getMarkdown(), 'two');
  assert.equal(editor.canRun('undo'), false);
  editor.destroy();
});

test('read-only editors refuse formatting', () => {
  const { host, editor } = mount('x', { readOnly: true });
  assert.equal(surface(host).getAttribute('contenteditable'), 'false');
  assert.ok((host.querySelector('.pm-tool-bold') as HTMLButtonElement).disabled);
  editor.destroy();
});

test('remote images never become <img> elements', () => {
  const { host, editor } = mount('![pixel](https://tracker.example/p.gif)');
  assert.equal(host.querySelectorAll('img:not(.ProseMirror-separator)').length, 0);
  assert.equal(host.querySelector('.pm-image')!.textContent, 'Image: pixel');
  editor.destroy();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Types the way a browser does: it edits the DOM text and moves the caret, and ProseMirror reads both back. */
async function typeAtEnd(host: HTMLElement, text: string) {
  const paragraph = [...surface(host).querySelectorAll('p')].at(-1)!;
  const node = [...paragraph.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).at(-1) as Text;
  const selection = window.getSelection()!;
  selection.collapse(node, node.data.length);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
  await tick();
  node.data += text;
  selection.collapse(node, node.data.length);
  await tick();
}

const caretParagraph = () => {
  const node = window.getSelection()?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  return { paragraph: element?.closest('p')?.textContent ?? null, inCode: Boolean(element?.closest('pre')) };
};

const TABLE_NOTE = '| Pin | Wire |\n|-----|------|\n| 1 | red |\n\n<kbd>Reset</kbd> twice.\n\n[datasheet]: https://example.com/ds.pdf';

/** A host whose controlled value lags: it hands the editor its own onChange values back only when told to. */
function laggingHost(markdown: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const emitted: string[] = [];
  let sync: ReturnType<typeof controlledValue> | null = null;
  const editor = createMarkdownEditor(host, {
    markdown,
    label: 'Note',
    onChange: (value) => {
      sync?.emitted(value);
      emitted.push(value);
    },
  });
  sync = controlledValue(editor);
  editor.focus();
  return { host, editor, emitted, receive: (value: string) => sync!.receive(value) };
}

test('a late echo of an earlier keystroke keeps the caret, the text and local undo', async () => {
  const { host, editor, emitted, receive } = laggingHost(TABLE_NOTE);
  await typeAtEnd(host, ' Then');
  await typeAtEnd(host, ' wait.');
  assert.equal(emitted.length, 2);
  // The host renders the first keystroke only after the second one landed, then catches up.
  assert.equal(receive(emitted[0]!), false);
  assert.equal(receive(emitted[1]!), false);
  assert.match(editor.getMarkdown(), /<kbd>Reset<\/kbd> twice\. Then wait\.\n\n\[datasheet\]/);
  assert.deepEqual(caretParagraph(), { paragraph: '<kbd>Reset</kbd> twice. Then wait.', inCode: false });
  assert.ok(editor.canRun('undo'), 'typing history survives the echoes');
  assert.ok(editor.canRun('bold'), 'formatting stays available at the caret');

  editor.run('undo');
  assert.equal(editor.getMarkdown(), TABLE_NOTE, 'undo restores the exact original, table included');
  assert.equal(caretParagraph().paragraph, '<kbd>Reset</kbd> twice.', 'undo puts the caret back in the paragraph, not the table');
  assert.equal(receive(emitted.at(-1)!), false, 'the undo’s own echo is ignored too');
  await typeAtEnd(host, ' Again');
  assert.match(editor.getMarkdown(), /twice\. Again\n/);
  editor.destroy();
});

test('replacing the content with a stale value is what loses the caret and history', async () => {
  const { host, editor, emitted } = laggingHost(TABLE_NOTE);
  await typeAtEnd(host, ' Then');
  await typeAtEnd(host, ' wait.');
  editor.setMarkdown(emitted[0]!);
  editor.setMarkdown(emitted[1]!);
  assert.equal(editor.getMarkdown(), emitted[1], 'the text looks right again');
  assert.equal(caretParagraph().inCode, true, 'but the caret is at the start, inside the raw table');
  assert.equal(editor.canRun('undo'), false, 'and typing history is gone');
  editor.destroy();
});

test('values the editor didn’t emit still replace it: discard and a clean server update', async () => {
  const { host, editor, emitted, receive } = laggingHost(TABLE_NOTE);
  await typeAtEnd(host, ' draft');
  assert.equal(receive(emitted[0]!), false);
  assert.equal(receive(TABLE_NOTE), true, 'discarding back to the saved text replaces the draft');
  assert.equal(editor.getMarkdown(), TABLE_NOTE);
  assert.equal(editor.canRun('undo'), false);
  const server = `${TABLE_NOTE}\n\nAdded on another device.`;
  assert.equal(receive(server), true);
  assert.equal(editor.getMarkdown(), server, 'unsupported blocks stay byte for byte');
  assert.equal(receive(server), false, 'the same value again changes nothing');
  editor.destroy();
});

test('a coalesced repeated echo acknowledges all earlier values before an external replacement', () => {
  const { editor } = mount('AB');
  const sync = controlledValue(editor);
  sync.emitted('AB');
  sync.emitted('ABC');
  sync.emitted('AB');
  assert.equal(sync.receive('AB'), false);
  assert.equal(sync.receive('ABC'), true, 'an older coalesced emission cannot mask a later external update');
  assert.equal(editor.getMarkdown(), 'ABC');
  editor.destroy();
});

test('the first input before selectionchange keeps undo at the visible caret', async () => {
  const { host, editor } = mount(TABLE_NOTE);
  editor.focus();
  const paragraph = surface(host).querySelector('p')!;
  const node = paragraph.lastChild as Text;
  const selection = window.getSelection()!;
  selection.collapse(node, node.data.length);
  surface(host).dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: ' Soon', bubbles: true, cancelable: true }));
  node.data += ' Soon';
  selection.collapse(node, node.data.length);
  await tick();
  assert.match(editor.getMarkdown(), /twice\. Soon/);
  editor.run('undo');
  assert.equal(editor.getMarkdown(), TABLE_NOTE);
  assert.equal(caretParagraph().paragraph, '<kbd>Reset</kbd> twice.');
  assert.equal(caretParagraph().inCode, false);
  editor.destroy();
});
