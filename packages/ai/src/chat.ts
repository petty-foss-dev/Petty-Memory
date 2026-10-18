import { type ActionProposal, type EditProposal, type EnveMemory, MemoryError, type OrganizationProposal } from '@enve-memory/core';
import { proposeActions } from './actions.ts';
import { type Answer, ask } from './ask.ts';
import { MAX_INSTRUCTION, proposeEdit } from './edit.ts';
import { proposeOrganization } from './organize.ts';
import type { AiProvider } from './provider.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  mode: 'ask' | 'edit' | 'organize' | 'actions';
  messages: ChatMessage[];
  project?: string;
  rootId?: string;
  query?: string;
  preferences?: string[];
}

export type ChatResponse =
  | { kind: 'answer'; answer: Answer }
  | { kind: 'proposal'; proposal: EditProposal }
  | { kind: 'organization'; proposal: OrganizationProposal }
  | { kind: 'actions'; proposal: ActionProposal };

export const CHAT_MODES = ['ask', 'edit', 'organize', 'actions'] as const;
export const CHAT_LIMITS = { messages: 12, messageChars: MAX_INSTRUCTION, totalChars: 16_000 } as const;

const invalid = (message: string) => new MemoryError('invalid', message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`The chat's ${field} must be text.`);
  return value.trim() || undefined;
}

/** Checks a chat from any client before anything reaches a model; only role and content of each message are kept. */
export function parseChatRequest(raw: unknown): ChatRequest {
  if (!isObject(raw)) throw invalid('Send the chat as an object with a mode and messages.');
  const { mode, messages } = raw;
  if (!CHAT_MODES.includes(mode as ChatRequest['mode'])) throw invalid('Choose a chat mode: "ask", "edit", "organize" or "actions".');
  if (!Array.isArray(messages) || messages.length === 0) throw invalid('A chat needs at least one message from you.');
  if (messages.length > CHAT_LIMITS.messages) throw invalid(`A chat can carry at most ${CHAT_LIMITS.messages} messages; start a new chat to keep going.`);
  let total = 0;
  const parsed = messages.map((message: unknown, index): ChatMessage => {
    const n = index + 1;
    if (!isObject(message)) throw invalid(`Message ${n} must be an object with a role and content.`);
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    if (message.role !== 'user' && message.role !== 'assistant') throw invalid(`Message ${n} has role ${JSON.stringify(message.role)}; only "user" and "assistant" are allowed.`);
    if (message.role !== expected) throw invalid(`Message ${n} should be from the ${expected}: a chat starts with you and then alternates.`);
    if (typeof message.content !== 'string' || !message.content.trim()) throw invalid(`Message ${n} is empty; write something or remove it.`);
    if (message.content.length > CHAT_LIMITS.messageChars) throw invalid(`Message ${n} is longer than ${CHAT_LIMITS.messageChars.toLocaleString('en')} characters; shorten it.`);
    total += message.content.length;
    return { role: message.role, content: message.content.trim() };
  });
  if (parsed.at(-1)!.role !== 'user') throw invalid('The last message must be yours: say what you want next.');
  if (total > CHAT_LIMITS.totalChars) throw invalid(`This chat is longer than ${CHAT_LIMITS.totalChars.toLocaleString('en')} characters in total; start a new chat to keep going.`);
  const request: ChatRequest = { mode: mode as ChatRequest['mode'], messages: parsed };
  if (raw.preferences !== undefined && request.mode === 'organize') {
    if (!Array.isArray(raw.preferences) || raw.preferences.length > 10 || raw.preferences.some((id) => typeof id !== 'string' || id.length > 100)) throw invalid('Choose up to ten saved organization preferences.');
    request.preferences = raw.preferences as string[];
  }
  const project = optionalId(raw.project, 'project');
  const rootId = optionalId(raw.rootId, 'note');
  if (request.mode === 'ask' && project) request.project = project;
  if (request.mode === 'edit') {
    if (!rootId) throw invalid('Choose the note to change before asking for changes.');
    request.rootId = rootId;
  }
  if (request.mode === 'actions') {
    const query = optionalId(raw.query, 'topic');
    if (!!rootId === !!query) throw invalid('Choose either a branch or a topic for AI actions.');
    if (rootId) request.rootId = rootId;
    if (query) {
      if (query.length > 500) throw invalid('An action topic can contain at most 500 characters.');
      request.query = query;
      if (project) request.project = project;
    }
  }
  return request;
}

// Saving a conversation and applying proposals are separate, explicit operations.
export async function chat(memory: EnveMemory, provider: AiProvider, request: ChatRequest): Promise<ChatResponse> {
  const { mode, messages, project, rootId, query, preferences } = parseChatRequest(request);
  const history = messages.slice(0, -1);
  const last = messages.at(-1)!.content;
  if (mode === 'ask') return { kind: 'answer', answer: await ask(memory, provider, last, project ? { project } : {}, history) };
  if (mode === 'organize') return proposeOrganization(memory, provider, messages, preferences);
  if (mode === 'actions') return proposeActions(memory, provider, { rootId, query, project }, messages);
  return { kind: 'proposal', proposal: await proposeEdit(memory, provider, { rootId: rootId!, instruction: last, history }) };
}
