// Checks what the browser chat (public/conversation.js) sends: always well formed, newest context first to survive.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_LIMITS, SAVED_LIMITS, answerNote, chatMessages, chatTitle, draftProblem, replyText, savedMessages, savedTurns,
} from '../public/conversation.js';

const answer = (text) => ({ role: 'assistant', reply: { kind: 'answer', answer: { answer: text, sources: [] } } });
const exchange = (n, size = 10) => [{ role: 'user', content: `q${n}`.padEnd(size, '.') }, answer(`a${n}`.padEnd(size, '.'))];

function wellFormed(messages) {
  assert.ok(messages.length <= CHAT_LIMITS.messages);
  messages.forEach((message, i) => {
    assert.equal(message.role, i % 2 === 0 ? 'user' : 'assistant');
    assert.ok(message.content.trim() && message.content.length <= CHAT_LIMITS.messageChars);
  });
  assert.equal(messages.at(-1).role, 'user');
  assert.ok(messages.reduce((sum, m) => sum + m.content.length, 0) <= CHAT_LIMITS.totalChars);
}

test('history alternates and ends with the new message', () => {
  const { messages, dropped } = chatMessages([...exchange(1), ...exchange(2)], 'next');
  assert.equal(dropped, 0);
  assert.equal(messages.length, 5);
  assert.equal(messages.at(-1).content, 'next');
  wellFormed(messages);
});

test('long chats keep the newest exchanges within both limits', () => {
  const many = chatMessages(Array.from({ length: 9 }, (_, i) => exchange(i)).flat(), 'latest');
  assert.equal(many.messages.length, CHAT_LIMITS.messages - 1);
  assert.equal(many.dropped, 8);
  wellFormed(many.messages);

  const big = chatMessages(Array.from({ length: 3 }, (_, i) => exchange(i, 3001)).flat(), 'x'.repeat(CHAT_LIMITS.messageChars));
  assert.equal(big.dropped, 4);
  wellFormed(big.messages);
});

test('proposals are sent back as their summary and long answers are clipped', () => {
  const turns = [{ role: 'user', content: 'tidy' }, { role: 'assistant', reply: { kind: 'proposal', proposal: { summary: '', operations: [{}, {}] } } },
    { role: 'user', content: 'why?' }, answer('z'.repeat(5000))];
  const { messages } = chatMessages(turns, 'ok');
  assert.equal(messages[1].content, 'Suggested 2 changes.');
  assert.equal(messages[3].content.length, CHAT_LIMITS.messageChars);
  wellFormed(messages);
  assert.equal(replyText({ kind: 'answer', answer: { answer: '  ', sources: [] } }), 'No answer.');
});

test('organization plans are sent back as their summary, or as their scope', () => {
  const plan = (summary) => ({ kind: 'organization', proposal: { summary, matchedCount: 1, destination: { title: 'Birding' } } });
  assert.equal(replyText(plan(' Sorted by season. ')), 'Sorted by season.');
  assert.equal(replyText(plan('')), 'Proposed organizing 1 note into “Birding”.');
});

test('proposed actions are sent back as their summary, or as their count', () => {
  const actions = (summary, count) => ({ kind: 'actions', proposal: { summary, operations: Array.from({ length: count }, () => ({})) } });
  assert.equal(replyText(actions('A brief and two tasks.', 3)), 'A brief and two tasks.');
  assert.equal(replyText(actions('', 2)), 'Proposed 2 actions.');
  assert.equal(replyText(actions('', 0)), 'Proposed no actions.');
});

test('a reopened saved chat continues from plain text', () => {
  const turns = savedTurns([{ role: 'user', content: 'plan the move' }, { role: 'assistant', content: 'Proposed 3 actions.' }]);
  assert.deepEqual(turns[1], { role: 'assistant', saved: 'Proposed 3 actions.' });
  const { messages } = chatMessages(turns, 'and the boxes?');
  assert.deepEqual(messages.map((m) => m.content), ['plan the move', 'Proposed 3 actions.', 'and the boxes?']);
  wellFormed(messages);
});

test('saving keeps the newest whole exchanges within the saved limits', () => {
  const kept = savedMessages(Array.from({ length: 55 }, (_, i) => exchange(i)).flat());
  assert.equal(kept.messages.length, SAVED_LIMITS.messages);
  assert.equal(kept.dropped, 10);
  assert.match(kept.messages[0].content, /^q5/);
  const big = savedMessages([...exchange(1, 120_000), ...exchange(2, 40_000)]);
  assert.equal(big.messages.length, 2);
  assert.equal(big.messages[0].content.length, 40_000);
  assert.equal(chatTitle([{ role: 'user', content: '- packing list for the trip' }]), 'packing list for the trip');
  assert.equal(chatTitle([]), 'AI chat');
});

test('an answer saved as a note uses item references for its citations', () => {
  const id = '0190a1b2-0000-7000-8000-00000000000a';
  const note = answerNote({ answer: 'Water weekly [1], not daily [3].', sources: [{ n: 1, id, title: 'Fern care]', url: null, type: 'note' }] });
  assert.equal(note, `Water weekly [[item:${id}|Fern care]], not daily [3].\n\n## Sources\n\n- [[item:${id}|Fern care]]`);
});

test('over-long drafts are explained before sending', () => {
  assert.equal(draftProblem('fine'), null);
  assert.match(draftProblem('x'.repeat(CHAT_LIMITS.messageChars + 10)), /4,000 characters or fewer/);
});
