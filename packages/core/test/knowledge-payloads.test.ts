import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';

test('PDF list and collection rows omit page text while details and export retain it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-page-payload-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  const pdf = memory.files.save({ filename: 'guide.pdf', data: Buffer.from('%PDF-fictional') }).item;
  const pages = { version: 1, pageCount: 1, pages: ['Fictional field guide.'], clipped: [], truncated: false };
  memory.items.setSource(pdf.id, { content: pages.pages[0], metadata: { pdfPages: pages } });
  const collection = memory.knowledge.saveCollection({ name: 'PDFs', scope: { type: 'file' }, fields: [] });
  assert.equal(memory.items.list({ type: 'file' })[0]!.metadata.pdfPages, undefined);
  assert.equal(memory.outline.children(null).items.find((entry) => entry.item.id === pdf.id)!.item.metadata.pdfPages, undefined);
  assert.equal(memory.knowledge.collectionRows(collection.id).rows[0]!.item.metadata.pdfPages, undefined);
  assert.deepEqual(memory.items.get(pdf.id).metadata.pdfPages, pages);
  const destination = join(home, 'export');
  memory.exports.write(destination);
  const exported = JSON.parse(readFileSync(join(destination, 'metadata.json'), 'utf8'));
  assert.deepEqual(exported.items.find((item: { id: string }) => item.id === pdf.id).metadata.pdfPages, pages);
});

test('the offline feed bounds batches of full PDF states and resumes without losing any items', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const ids: string[] = [];
  const text = 'x'.repeat(1_000_000);
  for (let index = 0; index < 8; index++) {
    const id = memory.items.insert({ type: 'file', title: `Guide ${index}`, content: text, metadata: { pdfPages: { version: 1, pageCount: 10, pages: Array(10).fill('y'.repeat(100_000)), clipped: [], truncated: false } } });
    ids.push(id);
  }
  memory.items.update(ids[0]!, { title: 'Updated first guide' });
  const found = new Map<string, string>();
  let cursor = 0;
  let batches = 0;
  for (;;) {
    const page = memory.feed.page(cursor);
    assert.ok(page.cursor > cursor, 'every full batch advances the cursor');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 8 * 1024 * 1024 + 100_000);
    for (const { item } of page.items) {
      assert.ok(item.metadata.pdfPages);
      found.set(item.id, item.title);
    }
    batches++;
    cursor = page.cursor;
    if (!page.hasMore) break;
    assert.ok(batches < 10);
  }
  assert.ok(batches > 1);
  assert.deepEqual(new Set(found.keys()), new Set(ids));
  assert.equal(found.get(ids[0]!), 'Updated first guide');
  assert.equal(cursor, memory.feed.revision);
});
