import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';

test('saved-chat keyword search finds conversations beyond the newest 100 without exposing ordinary or secret notes', (t) => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  t.after(() => memory.close());
  const old = memory.chats.save({ title: 'Earlier harvest', mode: 'ask', messages: [{ role: 'user', content: 'Harvest tomatoes' }, { role: 'assistant', content: 'Keep seeds for spring.' }] });
  for (let i = 0; i < 101; i++) memory.chats.save({ title: `Newer conversation ${i}`, mode: 'ask', messages: [{ role: 'user', content: `Question ${i}` }, { role: 'assistant', content: `Answer ${i}` }] });
  assert.equal(memory.chats.list().some((chat) => chat.id === old.id), false);
  memory.items.saveNote({ title: 'Earlier harvest', body: 'An ordinary note is not a conversation.' });
  assert.deepEqual(memory.chats.list({ query: 'harvest' }).map((chat) => chat.id), [old.id]);
  assert.deepEqual(memory.chats.list({ query: 'seeds' }).map((chat) => chat.id), [old.id], 'message text is searchable');
  assert.deepEqual(memory.chats.list({ query: 'harvest OR"*' }).map((chat) => chat.id), [old.id], 'search syntax is inert');
  memory.chats.archive(old.id);
  assert.deepEqual(memory.chats.list({ query: 'harvest' }), []);
});
