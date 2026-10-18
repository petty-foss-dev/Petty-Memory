import { type EnveMemory, MemoryError } from '@enve-memory/core';
import type { AiProvider } from '@enve-memory/ai';

export interface AudioTranscriptionConfig { baseUrl: string; model: string; apiKey?: string }
export interface KnowledgeDependencies {
  aiProvider: () => AiProvider | null;
  transcription: () => AudioTranscriptionConfig | null;
  afterWrite?: () => void;
}
export interface KnowledgeContext extends KnowledgeDependencies {
  memory: EnveMemory;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
export interface KnowledgeRoute {
  method: string;
  pattern: RegExp;
  scope: 'read' | 'write';
  transient?: boolean;
  status?: number;
  handle: (context: KnowledgeContext) => unknown | Promise<unknown>;
}

export const knowledgePath = (path: string) => new RegExp(`^/api/v1/knowledge${path.replaceAll(':id', '([^/]+)')}$`);
export const knowledgeInvalid = (message: string) => new MemoryError('invalid', message);
export const requireKnowledgeProvider = (context: KnowledgeContext) => {
  const provider = context.aiProvider();
  if (!provider) throw knowledgeInvalid('Configure an AI provider on the library host before running this workflow.');
  return provider;
};
export function knowledgeText(body: KnowledgeContext['body'], key: string): string {
  const value = body?.[key];
  if (typeof value !== 'string') throw knowledgeInvalid(`"${key}" must be text.`);
  return value;
}
