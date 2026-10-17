// Checks what the browser chat (public/conversation.js) sends: always well formed, newest context first to survive.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_LIMITS, chatMessages, draftProblem, replyText } from '../public/conversation.js';

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

test('over-long drafts are explained before sending', () => {
  assert.equal(draftProblem('fine'), null);
  assert.match(draftProblem('x'.repeat(CHAT_LIMITS.messageChars + 10)), /4,000 characters or fewer/);
});
