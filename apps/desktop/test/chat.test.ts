import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatResponse } from '@enve-memory/ai';
import type { EditProposal } from '@enve-memory/core';
import { CHAT_LIMITS, type Turn, chatMessages, draftProblem, replyText } from '../src/renderer/lib/chat.ts';

const answer = (text: string): Turn => ({ role: 'assistant', reply: { kind: 'answer', answer: { answer: text, sources: [] } } });
const proposal = (summary: string, operations = 0): Turn => ({
  role: 'assistant',
  reply: { kind: 'proposal', proposal: { summary, operations: Array.from({ length: operations }, () => ({})) } as unknown as EditProposal },
});
const exchange = (n: number, size = 10): Turn[] => [{ role: 'user', content: `q${n}`.padEnd(size, '.') }, answer(`a${n}`.padEnd(size, '.'))];

function assertWellFormed(messages: { role: string; content: string }[]) {
  assert.ok(messages.length <= CHAT_LIMITS.messages);
  messages.forEach((message, i) => {
    assert.equal(message.role, i % 2 === 0 ? 'user' : 'assistant');
    assert.ok(message.content.trim());
    assert.ok(message.content.length <= CHAT_LIMITS.messageChars);
  });
  assert.equal(messages.at(-1)?.role, 'user');
  assert.ok(messages.reduce((sum, m) => sum + m.content.length, 0) <= CHAT_LIMITS.totalChars);
}

test('the first message goes alone', () => {
  assert.deepEqual(chatMessages([], 'What did I decide?'), { messages: [{ role: 'user', content: 'What did I decide?' }], dropped: 0 });
});

test('earlier exchanges come first, alternating, with the new message last', () => {
  const turns = [...exchange(1), ...exchange(2)];
  const { messages, dropped } = chatMessages(turns, 'and then?');
  assert.equal(dropped, 0);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(messages.at(-1)?.content, 'and then?');
  assertWellFormed(messages);
});

test('a long chat keeps only the newest exchanges that fit the message count', () => {
  const turns = Array.from({ length: 10 }, (_, i) => exchange(i)).flat();
  const { messages, dropped } = chatMessages(turns, 'latest');
  assert.equal(messages.length, 11);
  assert.equal(dropped, 10);
  assert.match(messages[0]!.content, /^q5/);
  assertWellFormed(messages);
});

test('the total size limit drops whole older exchanges, never the new message', () => {
  const turns = Array.from({ length: 4 }, (_, i) => exchange(i, 3001)).flat();
  const next = 'x'.repeat(CHAT_LIMITS.messageChars);
  const { messages, dropped } = chatMessages(turns, next);
  assert.equal(messages.at(-1)?.content, next);
  assert.equal(dropped, 6);
  assertWellFormed(messages);
});

test('long answers are clipped and proposal turns are sent as their summary', () => {
  const turns: Turn[] = [{ role: 'user', content: 'tidy' }, proposal('Grouped by room.', 2), { role: 'user', content: 'why?' }, answer('y'.repeat(9000))];
  const { messages } = chatMessages(turns, 'ok');
  assert.equal(messages[1]!.content, 'Grouped by room.');
  assert.equal(messages[3]!.content.length, CHAT_LIMITS.messageChars);
  assert.ok(messages[3]!.content.endsWith('…'));
  assertWellFormed(messages);
});

test('an empty reply still has text to send back', () => {
  assert.equal(replyText({ kind: 'proposal', proposal: { summary: '', operations: [{}, {}, {}] } as unknown as EditProposal }), 'Suggested 3 changes.');
  assert.equal(replyText({ kind: 'proposal', proposal: { summary: ' ', operations: [] } as unknown as EditProposal }), 'Suggested no changes.');
  assert.equal(replyText({ kind: 'answer', answer: { answer: '', sources: [] } }), 'No answer.');
});

test('an organization plan goes back as its summary, or names its scope', () => {
  const plan = (summary: string) => ({ kind: 'organization', proposal: { summary, matchedCount: 3, destination: { title: 'Gardening' } } }) as unknown as ChatResponse;
  assert.equal(replyText(plan('Grouped into PARA.')), 'Grouped into PARA.');
  assert.equal(replyText(plan('')), 'Proposed organizing 3 notes into “Gardening”.');
  const { messages } = chatMessages([{ role: 'user', content: 'organize gardening' }, { role: 'assistant', reply: plan('') }], 'thanks');
  assert.equal(messages[1]!.content, 'Proposed organizing 3 notes into “Gardening”.');
});

test('an over-long draft is explained before sending', () => {
  assert.equal(draftProblem('short'), null);
  assert.equal(draftProblem('x'.repeat(CHAT_LIMITS.messageChars)), null);
  assert.match(draftProblem('x'.repeat(CHAT_LIMITS.messageChars + 1)) ?? '', /4,000 characters or fewer \(it has 4,001\)/);
});
