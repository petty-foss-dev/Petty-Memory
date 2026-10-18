import type { KnowledgeRequest } from '../../shared/knowledge.ts';
import { call } from './api.ts';

export async function knowledgeRequest<T>(path: string, method: KnowledgeRequest['method'] = 'GET', body?: Record<string, unknown>): Promise<T> {
  return await call('knowledge.request', { path, method, body }) as T;
}
