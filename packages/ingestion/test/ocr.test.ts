import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';
import { extractImageText } from '@enve-memory/ingestion';

const image = readFileSync(new URL('./fixtures/ocr-note.png', import.meta.url));
function fixture(t: import('node:test').TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'memory-ocr-test-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  const saved = memory.files.save({ filename: 'fictional-note.png', mimeType: 'image/png', data: image });
  return { memory, saved: saved.item, attachmentId: saved.item.attachments[0]!.id };
}

test('bundled local OCR reads a fictional image without saving or changing any notes', async (t) => {
  const { memory, saved, attachmentId } = fixture(t);
  const before = memory.items.get(saved.id);
  const result = await extractImageText(memory, attachmentId);
  assert.match(result.text, /MEMORY KEEPS IDEAS/i);
  assert.match(result.text, /garden notes tomorrow/i);
  assert.match(result.engine, /English/);
  assert.deepEqual(memory.items.get(saved.id), before);
  assert.equal(memory.items.list().length, 1, 'the user must explicitly save recognized text');
});

test('OCR refuses missing, archived, secret, non-image and oversized-dimension attachments before recognizing', async (t) => {
  const { memory, saved, attachmentId } = fixture(t);
  await assert.rejects(extractImageText(memory, 'missing'), /not in this library/);
  memory.items.archive(saved.id);
  await assert.rejects(extractImageText(memory, attachmentId), /active ordinary/);
  memory.items.unarchive(saved.id);
  memory.items.setSource(saved.id, { metadata: { secret: true } });
  await assert.rejects(extractImageText(memory, attachmentId), /active ordinary/);
  const text = memory.files.save({ filename: 'plain.txt', data: Buffer.from('Plain text is not an image') });
  await assert.rejects(extractImageText(memory, text.item.attachments[0]!.id), /Choose a PNG/);
  const bomb = Buffer.from(image);
  bomb.writeUInt32BE(50_000, 16); bomb.writeUInt32BE(50_000, 20);
  const huge = memory.files.save({ filename: 'too-many-pixels.png', data: bomb });
  await assert.rejects(extractImageText(memory, huge.item.attachments[0]!.id), (error) => error instanceof MemoryError && /25 million pixels/.test(error.message));
});
