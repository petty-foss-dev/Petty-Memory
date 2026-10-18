import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat, type AiProvider } from '@enve-memory/ai';
import { EnveMemory } from '@enve-memory/core';

test('organization supplements complete keywords with marked semantic suggestions and keeps selective apply', async (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const keyword = memory.items.saveNote({ title: 'Gardening journal', body: 'Plan the greenhouse.' });
  const suggested = memory.items.saveNote({ title: 'Tomato seed calendar', body: 'Start seedlings in March.' });
  memory.items.saveNote({ title: 'Car maintenance', body: 'Change the engine oil.' });
  memory.search.embedder = {
    model: 'test-semantic', minScore: 0.5,
    embed: async (texts) => texts.map((text) => new Float32Array(/gardening|tomato/i.test(text) ? [1, 0] : [0, 1])),
  };
  await memory.embeddings.indexPending(memory.search.embedder);
  let calls = 0;
  const ai: AiProvider = {
    id: 'ollama', model: 'fixture', listModels: async () => ['fixture'],
    complete: async (request) => {
      calls++;
      if (calls === 1) return JSON.stringify({ ready: true, topic: 'gardening', destination: 'Garden reference', system: 'by season', question: '' });
      const lines = request.prompt.split('<notes>\n')[1]!.split('\n</notes>')[0]!.split('\n').map((line) => JSON.parse(line) as { ref: string });
      return JSON.stringify({ summary: 'Group garden work', groups: [{ ref: 'g1', title: 'Spring', parent: null }], placements: lines.map(({ ref }) => ({ note: ref, group: 'g1' })) });
    },
  };
  const response = await chat(memory, ai, { mode: 'organize', messages: [{ role: 'user', content: 'Organize gardening notes by season.' }] });
  assert.equal(response.kind, 'organization');
  if (response.kind !== 'organization') throw new Error('Expected an organization proposal');
  const proposal = response.proposal;
  assert.equal(proposal.items.find((item) => item.id === keyword.id)!.match, 'keyword');
  assert.equal(proposal.items.find((item) => item.id === suggested.id)!.match, 'semantic');
  assert.equal(proposal.items.length, 2, 'unrelated notes are not suggested');
  const result = memory.organizer.apply(proposal, [suggested.id]);
  assert.equal(result.moved, 1);
  assert.equal(memory.outline.get(keyword.id).parentId, null);
  assert.notEqual(memory.outline.get(suggested.id).parentId, null);
  memory.organizer.undo(result.undo);
  assert.equal(memory.outline.get(suggested.id).parentId, null);
});

for (const failure of ['unavailable embeddings', 'unsafe semantic branch']) {
  test(`complete keyword organization survives ${failure}`, async (t) => {
    const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
    t.after(() => memory.close());
    const keyword = memory.items.saveNote({ title: 'Gardening', body: 'Plant tomatoes in spring.' });
    const suggestion = memory.items.saveNote({ title: 'Private notebook', body: 'Seed calendar.' });
    memory.vault.setup('Fictional test vault passphrase');
    const secret = memory.vault.create({ title: 'Private data', body: 'Never send private-secret-marker to a model.' });
    memory.outline.move(secret.id, { parentId: suggestion.id });
    memory.search.hybrid = async () => {
      if (failure === 'unavailable embeddings') throw new Error('Model cache missing');
      return memory.search.query('private').map((hit) => ({ ...hit, match: 'semantic' as const }));
    };
    let calls = 0;
    const provider: AiProvider = {
      id: 'ollama', model: 'fixture', listModels: async () => ['fixture'],
      complete: async ({ prompt }) => {
        assert.ok(!prompt.includes('private-secret-marker'));
        if (++calls === 1) return JSON.stringify({ ready: true, topic: 'gardening', destination: 'Garden system', system: 'by season', question: '' });
        return JSON.stringify({ summary: 'Spring planting.', groups: [], placements: [{ note: 'c1', group: null }] });
      },
    };
    const response = await chat(memory, provider, { mode: 'organize', messages: [{ role: 'user', content: 'Organize gardening by season.' }] });
    assert.equal(response.kind, 'organization');
    if (response.kind !== 'organization') throw new Error('Expected organization');
    assert.deepEqual(response.proposal.items.map((item) => item.id), [keyword.id]);
    assert.match(response.proposal.summary, /keyword matches only/);
    memory.organizer.apply(response.proposal);
    assert.equal(memory.outline.get(secret.id).parentId, suggestion.id);
  });
}
