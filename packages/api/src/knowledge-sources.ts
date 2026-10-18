import type { FreshnessRef, FreshnessScopeInput, WatchInput, WatchPatch } from '@enve-memory/core';
import { checkWatchedSource } from '@enve-memory/ingestion';
import { proposeFreshness } from '@enve-memory/ai';
import { knowledgePath, requireKnowledgeProvider, type KnowledgeRoute } from './knowledge-common.ts';

export const sourceRoutes: KnowledgeRoute[] = [
  { method: 'GET', pattern: knowledgePath('/sources'), scope: 'read', handle: ({ memory }) => memory.sources.list() },
  { method: 'POST', pattern: knowledgePath('/sources'), scope: 'write', handle: ({ memory, body }) => memory.sources.create(body as unknown as WatchInput) },
  { method: 'GET', pattern: knowledgePath('/sources/:id'), scope: 'read', handle: ({ memory, params }) => memory.sources.get(params[0]!) },
  { method: 'PATCH', pattern: knowledgePath('/sources/:id'), scope: 'write', handle: ({ memory, params, body }) => memory.sources.update(params[0]!, body as WatchPatch) },
  { method: 'DELETE', pattern: knowledgePath('/sources/:id'), scope: 'write', handle: ({ memory, params }) => { memory.sources.remove(params[0]!); return { archived: true }; } },
  { method: 'GET', pattern: knowledgePath('/sources/:id/queue'), scope: 'read', handle: ({ memory, params }) => memory.sources.queue(params[0]!) },
  { method: 'POST', pattern: knowledgePath('/sources/:id/check'), scope: 'write', handle: ({ memory, params }) => checkWatchedSource(memory, params[0]!) },
  { method: 'POST', pattern: knowledgePath('/sources/:id/apply'), scope: 'write', handle: ({ memory, params, body }) => memory.sources.apply(params[0]!, body?.candidateIds as string[]) },
  { method: 'POST', pattern: knowledgePath('/sources/:id/revoke-folder'), scope: 'write', handle: ({ memory, params }) => memory.sources.revokeFolder(params[0]!) },
  { method: 'GET', pattern: knowledgePath('/freshness/stale'), scope: 'read', handle: ({ memory, query }) => memory.sources.staleItems({
    olderThanDays: Number(query.get('days') ?? '90'), rootId: query.get('rootId') ?? undefined, project: query.get('project') ?? undefined,
  }) },
  { method: 'POST', pattern: knowledgePath('/freshness/analyze'), scope: 'write', transient: true, handle: (context) => proposeFreshness(context.memory, requireKnowledgeProvider(context), context.body as FreshnessScopeInput) },
  { method: 'POST', pattern: knowledgePath('/freshness/check'), scope: 'write', handle: ({ memory, body }) => memory.sources.markChecked(body as unknown as FreshnessRef) },
  { method: 'POST', pattern: knowledgePath('/freshness/dismiss'), scope: 'write', handle: ({ memory, body }) => memory.sources.dismissPair(body?.refs as [FreshnessRef, FreshnessRef]) },
  { method: 'POST', pattern: knowledgePath('/freshness/supersede'), scope: 'write', handle: ({ memory, body }) => memory.sources.supersede(body as unknown as { newer: FreshnessRef; older: FreshnessRef }) },
];
