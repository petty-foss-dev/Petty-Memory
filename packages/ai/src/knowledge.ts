import type { EnveMemory, OrganizationPreference } from '@enve-memory/core';
import { proposeActions } from './actions.ts';
import type { ChatResponse } from './chat.ts';
import type { AiProvider } from './provider.ts';

export interface RunRecipeOptions {
  /** Organization preference ids the person chose for this run. Nothing is applied unless chosen. */
  preferences?: string[];
}

/** Rereads the saved recipe and proposes reviewed actions over a fresh scope; applying stays a separate, explicit step. */
export async function runRecipe(memory: EnveMemory, provider: AiProvider, id: string, { preferences }: RunRecipeOptions = {}): Promise<ChatResponse> {
  const recipe = memory.knowledge.getRecipe(id);
  const { rootId, query, project } = recipe.scope;
  const chosen = preferences === undefined ? [] : memory.knowledge.selectPreferences(preferences, {
    project: rootId ? memory.items.get(rootId).project?.id ?? null : project,
  });
  const content = [recipe.instruction, preferenceContext(chosen)].filter(Boolean).join('\n\n');
  return proposeActions(memory, provider, rootId ? { rootId } : { query: query!, ...(project ? { project } : {}) }, [{ role: 'user', content }]);
}

/** Chosen preferences as a bounded block for an AI request; empty when none were chosen. */
export function preferenceContext(preferences: OrganizationPreference[]): string {
  if (!preferences.length) return '';
  return [
    'Organization preferences the person chose for this request:',
    ...preferences.map((preference) => `- ${preference.instruction.replace(/\s+/g, ' ')}`),
  ].join('\n');
}
