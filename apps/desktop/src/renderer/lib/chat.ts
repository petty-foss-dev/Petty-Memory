import type { Answer, ChatMessage, ChatResponse } from '@enve-memory/ai';
import { firstLine } from '../../shared/text.ts';

// Mirrors packages/ai chat.ts, so a long chat is trimmed here rather than refused there.
export const CHAT_LIMITS = { messages: 12, messageChars: 4000, totalChars: 16_000 } as const;
/** What one saved conversation may hold. */
export const SAVED_LIMITS = { messages: 100, totalChars: 200_000 } as const;

export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; reply: ChatResponse }
  /** A reply reopened from a saved chat: its text only, so an old proposal can never be applied again. */
  | { role: 'assistant'; saved: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function replyText(reply: ChatResponse): string {
  if (reply.kind === 'answer') return reply.answer.answer.trim() || 'No answer.';
  if (reply.kind === 'organization') {
    const { summary, matchedCount, destination } = reply.proposal;
    return summary.trim() || `Proposed organizing ${plural(matchedCount, 'note')} into “${destination.title}”.`;
  }
  if (reply.kind === 'actions') {
    const count = reply.proposal.operations.length;
    return reply.proposal.summary.trim() || (count ? `Proposed ${plural(count, 'action')}.` : 'Proposed no actions.');
  }
  const count = reply.proposal.operations.length;
  return reply.proposal.summary.trim() || (count ? `Suggested ${plural(count, 'change')}.` : 'Suggested no changes.');
}

export const turnText = (turn: Turn): string => (turn.role === 'user' ? turn.content : 'saved' in turn ? turn.saved : replyText(turn.reply));

const clip = (text: string) => (text.length > CHAT_LIMITS.messageChars ? `${text.slice(0, CHAT_LIMITS.messageChars - 1)}…` : text);

/** The newest whole exchanges that fit, each as plain messages; `dropped` counts older turns left out. */
function newestExchanges(turns: Turn[], room: { messages: number; chars: number }, shape: (text: string) => string) {
  const messages: ChatMessage[] = [];
  let total = 0;
  let kept = turns.length;
  while (kept >= 2 && messages.length + 2 <= room.messages) {
    const user = turns[kept - 2]!;
    const assistant = turns[kept - 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant') break;
    const pair: ChatMessage[] = [{ role: 'user', content: shape(user.content) }, { role: 'assistant', content: shape(turnText(assistant)) }];
    const size = pair[0]!.content.length + pair[1]!.content.length;
    if (total + size > room.chars) break;
    messages.unshift(...pair);
    total += size;
    kept -= 2;
  }
  return { messages, dropped: kept };
}

/** The newest whole exchanges that fit the limits, then `next`; `dropped` counts older turns left out. */
export function chatMessages(turns: Turn[], next: string): { messages: ChatMessage[]; dropped: number } {
  const { messages, dropped } = newestExchanges(turns, { messages: CHAT_LIMITS.messages - 1, chars: CHAT_LIMITS.totalChars - next.length }, clip);
  return { messages: [...messages, { role: 'user', content: next }], dropped };
}

/** What a save keeps: the newest whole exchanges within a saved conversation's limits. */
export const savedMessages = (turns: Turn[]) =>
  newestExchanges(turns, { messages: SAVED_LIMITS.messages, chars: SAVED_LIMITS.totalChars }, (text) => text);

export const savedTurns = (messages: ChatMessage[]): Turn[] =>
  messages.map((message) => (message.role === 'user' ? { role: 'user', content: message.content } : { role: 'assistant', saved: message.content }));

export function chatTitle(turns: Turn[]): string {
  const first = turns.find((turn) => turn.role === 'user');
  return (first && firstLine(turnText(first), 80)) || 'AI chat';
}

const referenceLabel = (source: Answer['sources'][number]) =>
  (source.title || source.url || `Untitled ${source.type}`).replace(/[\]\n\r]+/g, ' ').trim();

/** An answer as ordinary note text: numbered citations become item references, and the sources follow. */
export function answerNote(answer: Answer): string {
  const byNumber = new Map(answer.sources.map((source) => [source.n, source]));
  const reference = (source: Answer['sources'][number]) => `[[item:${source.id}|${referenceLabel(source)}]]`;
  const body = answer.answer.trim().replace(/\[(\d+)\]/g, (match, n: string) => {
    const source = byNumber.get(Number(n));
    return source ? reference(source) : match;
  });
  if (!answer.sources.length) return body;
  return `${body}\n\n## Sources\n\n${answer.sources.map((source) => `- ${reference(source)}`).join('\n')}`;
}

export function draftProblem(draft: string): string | null {
  const length = draft.trim().length;
  if (length > CHAT_LIMITS.messageChars) {
    return `Shorten this message to ${CHAT_LIMITS.messageChars.toLocaleString('en')} characters or fewer (it has ${length.toLocaleString('en')}).`;
  }
  return null;
}
