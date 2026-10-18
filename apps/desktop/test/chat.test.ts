import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Answer, ChatResponse } from '@enve-memory/ai';
import type { EditProposal } from '@enve-memory/core';
import {
  CHAT_LIMITS, SAVED_LIMITS, type Turn, answerNote, chatMessages, chatTitle, draftProblem, replyText, savedMessages, savedTurns,
} from '../src/renderer/lib/chat.ts';

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

test('proposed actions go back as their summary, or as their count', () => {
  const actions = (summary: string, count: number) => ({ kind: 'actions', proposal: { summary, operations: Array.from({ length: count }, () => ({})) } }) as unknown as ChatResponse;
  assert.equal(replyText(actions('Three tasks and a brief.', 4)), 'Three tasks and a brief.');
  assert.equal(replyText(actions('', 1)), 'Proposed 1 action.');
  assert.equal(replyText(actions(' ', 0)), 'Proposed no actions.');
});

test('a reopened saved chat sends its saved replies as plain text', () => {
  const turns = savedTurns([{ role: 'user', content: 'tidy the garage notes' }, { role: 'assistant', content: 'Suggested 2 changes.' }]);
  assert.deepEqual(turns[1], { role: 'assistant', saved: 'Suggested 2 changes.' });
  const { messages, dropped } = chatMessages(turns, 'and the shed?');
  assert.equal(dropped, 0);
  assert.deepEqual(messages.map((m) => m.content), ['tidy the garage notes', 'Suggested 2 changes.', 'and the shed?']);
  assertWellFormed(messages);
});

test('saving keeps the newest whole exchanges within the saved limits, unclipped', () => {
  const long = Array.from({ length: 60 }, (_, i) => exchange(i)).flat();
  const kept = savedMessages(long);
  assert.equal(kept.messages.length, SAVED_LIMITS.messages);
  assert.equal(kept.dropped, 20);
  assert.match(kept.messages[0]!.content, /^q10/);
  assert.equal(kept.messages.at(-1)!.role, 'assistant');

  const big = savedMessages([...exchange(1, 90_000), ...exchange(2, 90_000), ...exchange(3, 90_000)]);
  assert.equal(big.messages.length, 2);
  assert.equal(big.messages[1]!.content.length, 90_000);
  assert.equal(big.dropped, 4);

  const roundTrip = savedTurns(savedMessages(exchange(1)).messages);
  assert.deepEqual(roundTrip.map((turn) => turn.role), ['user', 'assistant']);
});

test('a chat is titled after its first message', () => {
  assert.equal(chatTitle([{ role: 'user', content: '## What did I decide about the roof?\nmore' }, answer('x')]), 'What did I decide about the roof?');
  assert.equal(chatTitle([]), 'AI chat');
});

test('an answer saved as a note turns citations into item references and lists its sources', () => {
  const id1 = '0190a1b2-0000-7000-8000-000000000001';
  const id2 = '0190a1b2-0000-7000-8000-000000000002';
  const note = answerNote({
    answer: 'The opener uses a 433 MHz remote [1], wired as noted [2]. See also [7].',
    sources: [
      { n: 1, id: id1, title: 'Remote [spare]\nmanual', url: null, type: 'note' },
      { n: 2, id: id2, title: '', url: 'https://example.com/wiring', type: 'bookmark' },
    ],
  } as unknown as Answer);
  assert.match(note, new RegExp(`remote \\[\\[item:${id1}\\|Remote \\[spare manual\\]\\]`));
  assert.ok(note.includes(`[[item:${id2}|https://example.com/wiring]]`));
  assert.ok(note.includes('See also [7].'));
  assert.ok(note.endsWith(`## Sources\n\n- [[item:${id1}|Remote [spare manual]]\n- [[item:${id2}|https://example.com/wiring]]`));
  assert.equal(answerNote({ answer: ' Nothing saved about that. ', sources: [] } as unknown as Answer), 'Nothing saved about that.');
});

test('an over-long draft is explained before sending', () => {
  assert.equal(draftProblem('short'), null);
  assert.equal(draftProblem('x'.repeat(CHAT_LIMITS.messageChars)), null);
  assert.match(draftProblem('x'.repeat(CHAT_LIMITS.messageChars + 1)) ?? '', /4,000 characters or fewer \(it has 4,001\)/);
});
