import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';
import { importEnveHighlights, previewEnveHighlights } from '@enve-memory/importers';

const original = {
  bookTitle: 'A Garden of Ideas', bookAuthor: 'Ada Wren', exportDate: '2026-10-17T12:00:00Z',
  annotations: [{ text: 'Save a seed for next season.', note: 'Try this in the greenhouse.', color: '#ffff00', style: 'highlight', position: 0.25, createdAt: '2026-10-16T12:00:00Z' }],
  bookmarks: [{ title: 'Seeds', chapter: 'Chapter 3', position: '25%', note: 'Return here.', createdAt: '2026-10-16T12:00:00Z' }],
};

test('real Enve JSON annotations and bookmarks preview without writes, import with provenance and skip repeated passages', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  memory.projects.create({ name: 'Reading' });
  const preview = previewEnveHighlights(JSON.stringify(original));
  assert.equal(preview.entries.length, 2);
  assert.equal(preview.entries[0]!.location, '25%');
  assert.equal(preview.entries[0]!.sourceUrl, null, 'the original exporter has no deep link; do not invent one');
  assert.equal(memory.items.list().length, 0);
  assert.deepEqual(importEnveHighlights(memory, original, { project: 'reading' }), { created: 2, skipped: 0, failed: [] });
  const notes = memory.items.list();
  assert.ok(notes.every((item) => item.project?.name === 'Reading'));
  assert.ok(notes.some((item) => item.body.includes('Try this in the greenhouse.') && item.body.includes('Ada Wren')));
  assert.ok(notes.every((item) => item.metadata.enveHighlight));
  assert.deepEqual(importEnveHighlights(memory, original), { created: 0, skipped: 2, failed: [] });
  memory.items.archive(notes[0]!.id);
  assert.equal(importEnveHighlights(memory, original).created, 0, 'archived passages are not resurrected');
});

test('Enve Markdown matches JSON passage identity and retains multiline annotations', (t) => {
  const markdown = `# A Garden of Ideas\n**Ada Wren**\n\n---\n\n## Highlights & Annotations\n\n### Highlight at 25%\n\n> Save a seed for next season.\n\n**Annotation:**\n\n> Try this in the greenhouse.\n\n*October 16, 2026*\n\n---\n\n## Bookmarks\n\n- **Chapter 3** (25%)\n  - Return here.\n\n*Exported from Enve on October 17, 2026*\n`;
  const json = previewEnveHighlights(original);
  const md = previewEnveHighlights(markdown);
  assert.equal(md.entries.length, 2);
  assert.equal(md.entries[0]!.text, original.annotations[0]!.text);
  assert.equal(md.entries[0]!.note, original.annotations[0]!.note);
  assert.equal(md.entries[0]!.id, json.entries[0]!.id);
  assert.equal(md.entries[1]!.id, json.entries[1]!.id);
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  importEnveHighlights(memory, original);
  assert.equal(importEnveHighlights(memory, markdown).created, 0);
});

test('interchange accepts source links, counts file duplicates and refuses unsafe links and invalid exports', () => {
  const passage = { id: 'passage-42', bookTitle: 'A Book', author: 'An Author', text: 'A useful idea.', note: '', location: 'Chapter 2', sourceUrl: 'enve://book/fictional?position=0.2' };
  const data = { format: 'petty-memory-enve-highlights', version: 1, entries: [passage, passage] };
  const preview = previewEnveHighlights(data);
  assert.equal(preview.entries.length, 1);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.entries[0]!.sourceUrl, passage.sourceUrl);
  for (const sourceUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com/book']) {
    assert.throws(() => previewEnveHighlights({ ...data, entries: [{ ...passage, sourceUrl }] }), /Source links/);
  }
  assert.throws(() => previewEnveHighlights('{broken'), /valid JSON/);
  assert.throws(() => previewEnveHighlights('# Unrelated markdown'), /Export sheet/);
  assert.throws(() => previewEnveHighlights({ ...original, annotations: [{ ...original.annotations[0], position: 3 }] }), /position/);
  assert.throws(() => previewEnveHighlights('x'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});

test('different annotations on the same passage are preserved, and percentage truncation matches Enve exports', () => {
  const data = { ...original, annotations: [
    { ...original.annotations[0]!, position: 0.29, note: 'First annotation' },
    { ...original.annotations[0]!, position: 0.29, note: 'A separate annotation' },
  ], bookmarks: [] };
  const preview = previewEnveHighlights(data);
  assert.equal(preview.entries.length, 2);
  const percentage = Math.trunc(0.29 * 100);
  const markdown = `# ${original.bookTitle}\n**${original.bookAuthor}**\n\n---\n\n## Highlights & Annotations\n\n### Highlight at ${percentage}%\n\n> ${original.annotations[0]!.text}\n\n**Annotation:**\n\n> First annotation\n\n*October 16, 2026*\n\n---\n`;
  assert.equal(previewEnveHighlights(markdown).entries[0]!.id, preview.entries[0]!.id);
});
