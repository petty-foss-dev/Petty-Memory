// What of the on-screen chat is sent, within the server's limits; mirrors the desktop renderer/lib/chat.ts.

export const CHAT_LIMITS = { messages: 12, messageChars: 4000, totalChars: 16_000 };

export function replyText(reply) {
  if (reply.kind === 'answer') return reply.answer.answer.trim() || 'No answer.';
  if (reply.kind === 'organization') {
    const { summary, matchedCount, destination } = reply.proposal;
    return summary.trim() || `Proposed organizing ${matchedCount} note${matchedCount === 1 ? '' : 's'} into “${destination.title}”.`;
  }
  const count = reply.proposal.operations.length;
  return reply.proposal.summary.trim() || (count ? `Suggested ${count} change${count === 1 ? '' : 's'}.` : 'Suggested no changes.');
}

const clip = (text) => (text.length > CHAT_LIMITS.messageChars ? `${text.slice(0, CHAT_LIMITS.messageChars - 1)}…` : text);

/** The newest whole exchanges that fit the limits, then `next`; `dropped` counts older turns left out. */
export function chatMessages(turns, next) {
  const messages = [{ role: 'user', content: next }];
  let total = next.length;
  let kept = turns.length;
  while (kept >= 2 && messages.length + 2 <= CHAT_LIMITS.messages) {
    const user = turns[kept - 2];
    const assistant = turns[kept - 1];
    if (user.role !== 'user' || assistant.role !== 'assistant') break;
    const pair = [{ role: 'user', content: clip(user.content) }, { role: 'assistant', content: clip(replyText(assistant.reply)) }];
    const size = pair[0].content.length + pair[1].content.length;
    if (total + size > CHAT_LIMITS.totalChars) break;
    messages.unshift(...pair);
    total += size;
    kept -= 2;
  }
  return { messages, dropped: kept };
}

export function draftProblem(draft) {
  const length = draft.trim().length;
  if (length > CHAT_LIMITS.messageChars) {
    return `Shorten this message to ${CHAT_LIMITS.messageChars.toLocaleString('en')} characters or fewer (it has ${length.toLocaleString('en')}).`;
  }
  return null;
}
