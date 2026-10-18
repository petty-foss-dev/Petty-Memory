import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ask, type AiProvider } from '@enve-memory/ai';
import { EnveMemory } from '@enve-memory/core';
import { ingestItem } from '@enve-memory/ingestion';
import { knowledgeAudio, knowledgePdf } from '../../../scripts/knowledge-fixtures.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'petty-citation-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  t.after(() => { memory.close(); rmSync(home, { recursive: true, force: true }); });
  const prompts: string[] = [];
  const provider: AiProvider = { id: 'ollama', model: 'fixture', listModels: async () => ['fixture'], complete: async ({ prompt }) => { prompts.push(prompt); return 'From the saved source. [1]'; } };
  return { memory, prompts, provider };
}

test('PDF answers cite only the selected supporting page and return its immutable source locator', async (t) => {
  const { memory, prompts, provider } = fixture(t);
  const pdf = memory.files.save({ data: knowledgePdf(), filename: 'field-guide.pdf' }).item;
  await ingestItem(memory, pdf.id);
  const answer = await ask(memory, provider, 'What does the Aurora rocket burn?');
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0]!.locator?.sourceId, pdf.id);
  assert.equal(answer.sources[0]!.locator?.page, 2);
  assert.equal(answer.sources[0]!.locator?.sha256, pdf.attachments[0]!.sha256);
  assert.match(prompts[0]!, /page="2"[\s\S]*burns methane/);
  assert.doesNotMatch(prompts[0]!, /Raised beds need cedar/);
});

test('transcript answers return a recording timestamp and never use a workflow definition as evidence', async (t) => {
  const { memory, prompts, provider } = fixture(t);
  const audio = memory.files.save({ data: knowledgeAudio(), filename: 'meeting.wav' }).item;
  const input = { audioId: audio.id, format: 'json', segments: [{ start: 0, end: 2, text: 'Welcome to the meeting.' }, { start: 2, end: 5, text: 'The Aurora rocket burns methane.' }] };
  const preview = memory.research.previewTranscript(input);
  const transcript = memory.research.saveTranscript({ ...input, fingerprint: preview.fingerprint }).item;
  memory.knowledge.savePreference({ name: 'Aurora', instruction: 'This workflow preference is not evidence about rocket fuel.' });
  const answer = await ask(memory, provider, 'What does the Aurora rocket burn?');
  const source = answer.sources.find((entry) => entry.id === transcript.id)!;
  assert.equal(source.locator?.kind, 'audio');
  assert.equal(source.locator?.sourceId, audio.id);
  assert.equal(source.locator?.start, 2);
  assert.doesNotMatch(prompts[0]!, /workflow preference/);
});

test('an ordinary source explicitly superseded during information review yields to its replacement in answers', async (t) => {
  const { memory, prompts, provider } = fixture(t);
  const older = memory.items.saveNote({ title: 'Aurora fuel old', body: 'Aurora uses kerosene.' });
  const newer = memory.items.saveNote({ title: 'Aurora fuel current', body: 'Aurora uses methane.' });
  const scope = memory.sources.freshnessScope({ query: 'Aurora fuel' });
  const ref = (id: string) => ({ id, stateHash: scope.items.find((item) => item.id === id)!.stateHash });
  memory.sources.supersede({ newer: ref(newer.id), older: ref(older.id) });
  const answer = await ask(memory, provider, 'What fuel does Aurora use?');
  assert.deepEqual(answer.sources.map((source) => source.id), [newer.id]);
  assert.match(prompts[0]!, /Aurora uses methane/);
  assert.doesNotMatch(prompts[0]!, /Aurora uses kerosene/);
  assert.equal(memory.items.get(older.id).body, 'Aurora uses kerosene.');
});

test('many matching workflow definitions cannot crowd ordinary evidence out of retrieval', async (t) => {
  const { memory, prompts, provider } = fixture(t);
  const note = memory.items.saveNote({ title: 'Aurora fuel', body: 'Aurora uses methane.' });
  for (let index = 0; index < 25; index++) memory.knowledge.saveRecipe({ name: `Aurora fuel ${index}`, instruction: 'Aurora fuel workflow.', scope: { rootId: note.id } });
  const answer = await ask(memory, provider, 'Aurora fuel');
  assert.deepEqual(answer.sources.map((source) => source.id), [note.id]);
  assert.match(prompts[0]!, /Aurora uses methane/);
  assert.doesNotMatch(prompts[0]!, /Aurora fuel workflow/);
});

for (const hidden of ['archived', 'secret', 'definition', 'template'] as const) {
  test(`following a replacement never includes ${hidden} source text`, async (t) => {
    const { memory, prompts, provider } = fixture(t);
    const older = memory.items.saveNote({ title: 'Aurora original', body: 'The original Aurora fuel record.' });
    const newer = memory.items.saveNote({ title: 'Private successor', body: 'Hidden successor payload.' });
    memory.items.relate(newer.id, older.id, 'supersedes');
    if (hidden === 'archived') memory.items.archive(newer.id);
    else memory.items.setSource(newer.id, { metadata: hidden === 'secret' ? { secret: true } : hidden === 'template' ? { template: true } : { knowledgeDefinition: true } });
    const answer = await ask(memory, provider, 'Aurora original');
    assert.ok(answer.sources.every((source) => source.id !== newer.id));
    assert.doesNotMatch(prompts.join('\n'), /Hidden successor payload/);
  });
}
