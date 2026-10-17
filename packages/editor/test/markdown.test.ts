import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Node, Slice } from 'prosemirror-model';
import { parseMarkdown, serializeMarkdown } from '../src/markdown.ts';
import { schema } from '../src/schema.ts';

const REF = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const FIXTURES: Record<string, string> = {
  empty: '',
  whitespace: '\n\n  \n',
  plain: 'Just a line',
  styles: 'Setext heading\n==============\n\n*star* _under_ __double__ **stars** ~~gone~~ `co`de`\n\nhard  \nbreak and\\\nbackslash\n',
  lists: '* star bullet\n* second\n\n+ plus list\n\n3) paren ordered\n4) next\n\n- loose\n\n- items\n',
  nested: '- one\n  - two\n    1. three\n\n> quote\n> > nested quote\n',
  tasks: '- [ ] open\n- [x] done\n  - [X] nested capital\n',
  table: '| a | b |\n|:--|--:|\n| 1 | 2 |\n',
  html: '<details>\n<summary>More</summary>\n\nhidden *markdown*\n\n</details>\n\nInline <kbd>Ctrl</kbd> and <!-- comment -->.\n',
  front: '---\ntitle: Note\ntags: [a, b]\n---\n# Body\n',
  definitions: 'See [the docs][docs] and [other].\n\n[docs]: https://example.com/docs "Docs"\n[other]: <https://example.com/o>\n',
  references: `Read [[item:${REF}|the plan]] and [[item:${REF.toUpperCase()}]] today.\n`,
  code: '```js\nconst a = `x`;\n```\n\n    indented code\n\n~~~\ntilde\n~~~\n',
  escapes: 'Not \\*emphasis\\*, a \\# hash, 1\\. not a list, snake_case_name, a < b & c, &amp; and &copy;\n',
  images: '![remote](https://example.com/p.png "t") and ![data](data:image/png;base64,iVBORw0KGgo=)\n',
  footnote: 'Text with a note[^1].\n\n[^1]: The note.\n',
  math: '$$\nx^2\n$$\n',
  gaps: 'line one  \nline two\n\n\n\nafter gaps',
  links: 'An <https://auto.example> and [t](https://x.example/a(b) "T") and *[em link](http://e.example)*\n',
};

const blocks = (doc: Node) => doc.content.content.map((node) => node.type.name + (node.attrs.kind ? `:${node.attrs.kind}` : ''));

/** Replaces the text of the first paragraph, as typing would, keeping every other block's node object. */
function editFirstParagraph(doc: Node, text: string): Node {
  let index = -1;
  doc.forEach((node, _, i) => {
    if (index < 0 && node.type === schema.nodes.paragraph) index = i;
  });
  assert.ok(index >= 0, 'fixture has a paragraph');
  return doc.replace(
    doc.resolve(0).posAtIndex(index) + 1,
    doc.resolve(0).posAtIndex(index) + doc.child(index).nodeSize - 1,
    new Slice(schema.nodes.paragraph.create(null, schema.text(text)).content, 0, 0),
  );
}

for (const [name, text] of Object.entries(FIXTURES)) {
  test(`unchanged ${name} round-trips byte for byte`, () => {
    const { doc, origin } = parseMarkdown(text);
    assert.equal(serializeMarkdown(doc, origin), text);
  });

  test(`${name} reads back as the same document after a full re-serialization`, () => {
    const { doc } = parseMarkdown(text);
    assert.ok(parseMarkdown(serializeMarkdown(doc)).doc.eq(doc));
  });
}

test('unsupported constructs become editable source blocks instead of being dropped', () => {
  assert.deepEqual(blocks(parseMarkdown(FIXTURES.table!).doc), ['raw_block:table']);
  assert.deepEqual(blocks(parseMarkdown(FIXTURES.front!).doc), ['raw_block:front-matter', 'heading']);
  assert.deepEqual(blocks(parseMarkdown(FIXTURES.definitions!).doc), ['paragraph', 'raw_block:source']);
  assert.ok(blocks(parseMarkdown(FIXTURES.html!).doc).includes('raw_block:html'));
  const { doc } = parseMarkdown(FIXTURES.table!);
  assert.equal(doc.firstChild!.textContent, FIXTURES.table!.trimEnd());
});

test('editing one block keeps every other block exactly as written', () => {
  const text = [
    FIXTURES.front, '# Heading\n\nFirst paragraph.\n', FIXTURES.table, FIXTURES.html, FIXTURES.tasks, FIXTURES.definitions, '* star list\n',
  ].join('\n');
  const { doc, origin } = parseMarkdown(text);
  const edited = editFirstParagraph(doc, 'Changed paragraph.');
  const out = serializeMarkdown(edited, origin);
  assert.equal(out, text.replace('First paragraph.', 'Changed paragraph.'));
});

test('a deleted block leaves its neighbours intact and separated', () => {
  const text = 'one\n\n| t |\n|---|\n\nthree\n';
  const { doc, origin } = parseMarkdown(text);
  const withoutTable = doc.replace(doc.child(0).nodeSize, doc.child(0).nodeSize + doc.child(1).nodeSize, doc.slice(0, 0));
  assert.equal(serializeMarkdown(withoutTable, origin), 'one\n\nthree\n');
});

test('an undone edit restores the original source even with new node objects', () => {
  const text = 'Keep *this* _style_\n\n+ plus\n';
  const { doc, origin } = parseMarkdown(text);
  const changed = editFirstParagraph(doc, 'x');
  assert.notEqual(serializeMarkdown(changed, origin), text);
  const restored = parseMarkdown(text).doc;
  assert.equal(serializeMarkdown(restored, origin), text);
});

test('typed characters that would change meaning are escaped', () => {
  const doc = schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text('<b>not html</b> &amp; *stars* [x](y) # not heading')),
    schema.nodes.paragraph.create(null, schema.text('- not a list\n# not a heading either')),
  ]);
  const out = serializeMarkdown(doc);
  const back = parseMarkdown(out).doc;
  assert.deepEqual(blocks(back), ['paragraph', 'paragraph']);
  assert.equal(back.textContent, doc.textContent);
  assert.ok(!back.firstChild!.firstChild!.marks.length, 'no raw HTML or emphasis created');
});

test('task items keep their checkbox state and markers', () => {
  const { doc } = parseMarkdown(FIXTURES.tasks!);
  const list = doc.firstChild!;
  assert.equal(list.child(0).attrs.checked, false);
  assert.equal(list.child(1).attrs.checked, true);
  assert.equal(list.child(0).textContent, 'open');
  assert.equal(serializeMarkdown(doc), '- [ ] open\n- [x] done\n  - [x] nested capital');
});

test('stable item references are atoms that keep their token', () => {
  const { doc } = parseMarkdown(FIXTURES.references!);
  const refs: Node[] = [];
  doc.descendants((node) => {
    if (node.type === schema.nodes.reference) refs.push(node);
  });
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.attrs.label, 'the plan');
  assert.equal(serializeMarkdown(doc), FIXTURES.references!.trimEnd());
  const fresh = schema.topNodeType.create(null, schema.nodes.paragraph.create(null, [
    schema.text('see '), schema.nodes.reference.create({ id: REF, label: 'A | b]' }),
  ]));
  assert.equal(serializeMarkdown(fresh), `see [[item:${REF}|A   b]]`);
});

test('raw HTML is kept as literal text marks, never as elements', () => {
  const { doc } = parseMarkdown('a <img src=x onerror=alert(1)> b <script>alert(1)</script>');
  const raw: string[] = [];
  doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type === schema.marks.raw)) raw.push(node.text!);
  });
  assert.deepEqual(raw, ['<img src=x onerror=alert(1)>', '<script>', '</script>']);
});

test('unsafe link targets are not turned into links', () => {
  const { doc } = parseMarkdown('[x](javascript:alert(1)) [y](https://ok.example)');
  const hrefs: string[] = [];
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type === schema.marks.link) hrefs.push(mark.attrs.href);
  });
  assert.deepEqual(hrefs, ['https://ok.example']);
});
