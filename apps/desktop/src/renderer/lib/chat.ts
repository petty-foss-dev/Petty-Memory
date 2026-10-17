import type { ChatMessage, ChatResponse } from '@enve-memory/ai';

// Mirrors packages/ai chat.ts, so a long chat is trimmed here rather than refused there.
export const CHAT_LIMITS = { messages: 12, messageChars: 4000, totalChars: 16_000 } as const;

export type Turn = { role: 'user'; content: string } | { role: 'assistant'; reply: ChatResponse };

export function replyText(reply: ChatResponse): string {
  if (reply.kind === 'answer') return reply.answer.answer.trim() || 'No answer.';
  if (reply.kind === 'organization') {
    const { summary, matchedCount, destination } = reply.proposal;
    return summary.trim() || `Proposed organizing ${matchedCount} note${matchedCount === 1 ? '' : 's'} into “${destination.title}”.`;
  }
  const count = reply.proposal.operations.length;
  return reply.proposal.summary.trim() || (count ? `Suggested ${count} change${count === 1 ? '' : 's'}.` : 'Suggested no changes.');
}

const clip = (text: string) => (text.length > CHAT_LIMITS.messageChars ? `${text.slice(0, CHAT_LIMITS.messageChars - 1)}…` : text);

/** The newest whole exchanges that fit the limits, then `next`; `dropped` counts older turns left out. */
export function chatMessages(turns: Turn[], next: string): { messages: ChatMessage[]; dropped: number } {
  const messages: ChatMessage[] = [{ role: 'user', content: next }];
  let total = next.length;
  let kept = turns.length;
  while (kept >= 2 && messages.length + 2 <= CHAT_LIMITS.messages) {
    const user = turns[kept - 2]!;
    const assistant = turns[kept - 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant') break;
    const pair: ChatMessage[] = [{ role: 'user', content: clip(user.content) }, { role: 'assistant', content: clip(replyText(assistant.reply)) }];
    const size = pair[0]!.content.length + pair[1]!.content.length;
    if (total + size > CHAT_LIMITS.totalChars) break;
    messages.unshift(...pair);
    total += size;
    kept -= 2;
  }
  return { messages, dropped: kept };
}

export function draftProblem(draft: string): string | null {
  const length = draft.trim().length;
  if (length > CHAT_LIMITS.messageChars) {
    return `Shorten this message to ${CHAT_LIMITS.messageChars.toLocaleString('en')} characters or fewer (it has ${length.toLocaleString('en')}).`;
  }
  return null;
}
