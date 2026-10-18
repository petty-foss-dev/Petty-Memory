import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiProvider } from '@enve-memory/ai';
import { EnveMemory, MemoryError } from '@enve-memory/core';
import { preferenceContext, runRecipe } from '../src/knowledge.ts';

function provider(reply: unknown, prompts: string[] = []): AiProvider {
  return { id: 'ollama', model: 'test-fixture', listModels: async () => ['test-fixture'], complete: async (request) => { prompts.push(request.prompt); return JSON.stringify(reply); } };
}
const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const instruction = (prompt: string) => prompt.split('\nInstruction: ').at(-1)!;

test('running a recipe proposes reviewed actions over a fresh scope and writes nothing', async (t) => {
  const memory = open();
  t.after(() => memory.close());
  const branch = memory.items.saveNote({ title: 'Meeting', body: 'Build the raised beds and buy seeds.' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Follow-ups', instruction: 'Create a task for each open job.', scope: { rootId: branch.id } });
  const prompts: string[] = [];
  const ai = provider({ summary: 'Follow up.', operations: [{ kind: 'task', ref: null, title: 'Build raised beds', body: '', tags: [], source: 'n1', sources: [], when: null }] }, prompts);

  const response = await runRecipe(memory, ai, recipe.id);
  assert.equal(response.kind, 'actions');
  if (response.kind !== 'actions') throw new Error('Expected actions');
  assert.equal(response.proposal.rootId, branch.id);
  assert.equal(response.proposal.operations.length, 1);
  assert.equal(instruction(prompts[0]!), 'Create a task for each open job.');
  assert.match(prompts[0]!, /Build the raised beds/);
  assert.equal(memory.tasks.list().length, 0, 'a run only proposes');

  memory.items.update(branch.id, { body: 'Build the raised beds, buy seeds and mend the fence.' });
  memory.knowledge.saveRecipe({ id: recipe.id, instruction: 'Create one task per job, including repairs.' });
  const fresh = await runRecipe(memory, ai, recipe.id);
  assert.equal(instruction(prompts[1]!), 'Create one task per job, including repairs.', 'the definition is reread');
  assert.match(prompts[1]!, /mend the fence/, 'the scope is read fresh');
  assert.throws(() => memory.actions.apply(response.proposal), (error) => error instanceof MemoryError && error.code === 'conflict', 'the earlier proposal is stale');
  if (fresh.kind !== 'actions') throw new Error('Expected actions');
  const applied = memory.actions.apply(fresh.proposal);
  assert.equal(memory.tasks.get(applied.createdIds[0]!).title, 'Build raised beds');
});

test('preferences reach a run only when chosen, and only where they apply', async (t) => {
  const memory = open();
  t.after(() => memory.close());
  memory.projects.create({ name: 'Garden' });
  memory.projects.create({ name: 'Taxes' });
  memory.items.saveNote({ title: 'Seed order', body: 'Order tomato seeds.', project: 'Garden' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Weekly', instruction: 'Tag the seed notes.', scope: { query: 'seed order', project: 'Garden' } });
  const global = memory.knowledge.savePreference({ instruction: 'Prefer short\n lowercase tags.' });
  const garden = memory.knowledge.savePreference({ instruction: 'Use season tags.', project: 'Garden' });
  const taxes = memory.knowledge.savePreference({ instruction: 'File receipts under Finance.', project: 'Taxes' });
  const prompts: string[] = [];
  const ai = provider({ summary: 'Tag it.', operations: [] }, prompts);

  await runRecipe(memory, ai, recipe.id);
  assert.doesNotMatch(prompts[0]!, /preferences|lowercase tags|season tags/, 'nothing is applied implicitly');
  await runRecipe(memory, ai, recipe.id, { preferences: [global.id, garden.id] });
  assert.equal(instruction(prompts[1]!), 'Tag the seed notes.\n\nOrganization preferences the person chose for this request:\n- Prefer short lowercase tags.\n- Use season tags.');
  await assert.rejects(runRecipe(memory, ai, recipe.id, { preferences: [taxes.id] }), /own project/);
  await assert.rejects(runRecipe(memory, ai, recipe.id, { preferences: [recipe.id] }), /No organization preference/);
  assert.equal(prompts.length, 2, 'refused preferences never reach the model');
});

test('archived or missing recipes do not run', async (t) => {
  const memory = open();
  t.after(() => memory.close());
  const recipe = memory.knowledge.saveRecipe({ name: 'Weekly', instruction: 'Propose tasks.', scope: { query: 'beds' } });
  memory.knowledge.archiveRecipe(recipe.id);
  const prompts: string[] = [];
  await assert.rejects(runRecipe(memory, provider({ summary: '', operations: [] }, prompts), recipe.id), /No AI recipe/);
  assert.equal(prompts.length, 0);
});

test('a recipe definition never appears in its own topic scope', async (t) => {
  const memory = open();
  t.after(() => memory.close());
  memory.items.saveNote({ title: 'Compost', body: 'Turn the compost weekly.' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Compost follow-up', instruction: 'Propose compost tasks.', scope: { query: 'compost' } });
  memory.knowledge.saveCollection({ name: 'Compost board' });
  const prompts: string[] = [];
  await runRecipe(memory, provider({ summary: 'None.', operations: [] }, prompts), recipe.id);
  const items = JSON.parse(prompts[0]!.split('<items>\n')[1]!.split('\n</items>')[0]!) as { title: string }[];
  assert.deepEqual(items.map((item) => item.title), ['Compost']);
});

test('preference context is empty without preferences and flattens whitespace', () => {
  assert.equal(preferenceContext([]), '');
  const at = '2026-10-17T00:00:00.000Z';
  assert.equal(
    preferenceContext([{ id: 'p', name: 'p', instruction: 'Group\n\nby   season', project: null, createdAt: at, updatedAt: at }]),
    'Organization preferences the person chose for this request:\n- Group by season',
  );
});
