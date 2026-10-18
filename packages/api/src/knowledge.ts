import { type EnveMemory, MemoryError, type SaveCollectionInput, type SavePreferenceInput, type SaveRecipeInput } from '@enve-memory/core';
import { runRecipe } from '@enve-memory/ai';

import { knowledgeInvalid, knowledgePath, requireKnowledgeProvider, knowledgeText, type KnowledgeDependencies, type KnowledgeRoute } from './knowledge-common.ts';
export type { AudioTranscriptionConfig, KnowledgeDependencies } from './knowledge-common.ts';
import { researchRoutes } from './knowledge-research.ts';
import { sourceRoutes } from './knowledge-sources.ts';

export const knowledgeRoutes: KnowledgeRoute[] = [
  ...researchRoutes,
  ...sourceRoutes,
  { method: 'GET', pattern: knowledgePath('/recipes'), scope: 'read', handle: ({ memory }) => memory.knowledge.listRecipes() },
  { method: 'GET', pattern: knowledgePath('/recipes/:id'), scope: 'read', handle: ({ memory, params }) => memory.knowledge.getRecipe(params[0]!) },
  { method: 'POST', pattern: knowledgePath('/recipes'), scope: 'write', handle: ({ memory, body }) => memory.knowledge.saveRecipe(body as unknown as SaveRecipeInput) },
  { method: 'DELETE', pattern: knowledgePath('/recipes/:id'), scope: 'write', handle: ({ memory, params }) => { memory.knowledge.archiveRecipe(params[0]!); return { archived: true }; } },
  { method: 'POST', pattern: knowledgePath('/recipes/:id/run'), scope: 'write', transient: true,
    handle: (context) => runRecipe(context.memory, requireKnowledgeProvider(context), context.params[0]!, { preferences: context.body?.preferences as string[] | undefined }) },
  { method: 'GET', pattern: knowledgePath('/preferences'), scope: 'read', handle: ({ memory, query }) => memory.knowledge.listPreferences({ project: query.get('project') ?? undefined }) },
  { method: 'GET', pattern: knowledgePath('/preferences/:id'), scope: 'read', handle: ({ memory, params }) => memory.knowledge.getPreference(params[0]!) },
  { method: 'POST', pattern: knowledgePath('/preferences'), scope: 'write', handle: ({ memory, body }) => memory.knowledge.savePreference(body as unknown as SavePreferenceInput) },
  { method: 'DELETE', pattern: knowledgePath('/preferences/:id'), scope: 'write', handle: ({ memory, params }) => { memory.knowledge.archivePreference(params[0]!); return { archived: true }; } },
  { method: 'GET', pattern: knowledgePath('/collections'), scope: 'read', handle: ({ memory }) => memory.knowledge.listCollections() },
  { method: 'GET', pattern: knowledgePath('/collections/:id'), scope: 'read', handle: ({ memory, params }) => memory.knowledge.getCollection(params[0]!) },
  { method: 'POST', pattern: knowledgePath('/collections'), scope: 'write', handle: ({ memory, body }) => memory.knowledge.saveCollection(body as unknown as SaveCollectionInput) },
  { method: 'DELETE', pattern: knowledgePath('/collections/:id'), scope: 'write', handle: ({ memory, params }) => { memory.knowledge.archiveCollection(params[0]!); return { archived: true }; } },
  { method: 'GET', pattern: knowledgePath('/collections/:id/rows'), scope: 'read', handle: ({ memory, params, query }) => memory.knowledge.collectionRows(params[0]!, {
    offset: query.has('offset') ? Number(query.get('offset')) : undefined,
    limit: query.has('limit') ? Number(query.get('limit')) : undefined,
    ...(query.has('group') ? { group: query.get('group') === '__unset' ? null : query.get('group')! } : {}),
  }) },
  { method: 'POST', pattern: knowledgePath('/collections/:id/values'), scope: 'write', handle: ({ memory, params, body }) => memory.knowledge.setValues(
    knowledgeText(body, 'itemId'), params[0]!, body?.values as Parameters<EnveMemory['knowledge']['setValues']>[2],
  ) },
];

export async function invokeKnowledgeRequest(memory: EnveMemory, input: { method?: string; path: string; body?: Record<string, unknown> }, dependencies: KnowledgeDependencies): Promise<unknown> {
  if (!input || typeof input !== 'object' || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//') || input.path.length > 2000) throw knowledgeInvalid('Choose a knowledge workflow route.');
  const method = input.method ?? 'GET';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw knowledgeInvalid('Unsupported knowledge request method.');
  if (input.body !== undefined && (!input.body || typeof input.body !== 'object' || Array.isArray(input.body))) throw knowledgeInvalid('The request body must be an object.');
  const url = new URL(`/api/v1/knowledge${input.path}`, 'http://localhost');
  for (const route of knowledgeRoutes) {
    if (route.method !== method) continue;
    const found = route.pattern.exec(url.pathname);
    if (!found) continue;
    let params: string[];
    try { params = found.slice(1).map(decodeURIComponent); } catch { throw knowledgeInvalid('The route contains an invalid identifier.'); }
    const result = await route.handle({ memory, params, query: url.searchParams, body: input.body, ...dependencies });
    if (route.scope === 'write' && method !== 'GET' && !route.transient) dependencies.afterWrite?.();
    return result;
  }
  throw new MemoryError('not_found', 'This knowledge workflow route does not exist.');
}
