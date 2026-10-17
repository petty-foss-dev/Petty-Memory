import type { Context } from './context.ts';
import { invalid } from './errors.ts';
import type { ItemService } from './items.ts';
import type { TaskService } from './tasks.ts';
import { ATTENTION_LEVELS, type ItemDetail, type ItemMetadata, type ItemPresentation, PRESENTATION_KINDS } from './types.ts';

export const DEFAULT_PRESENTATION: ItemPresentation = {
  kind: 'text', attention: 'normal', review: false, checklist: false, hideCompleted: false, checked: false, autoOrganize: false,
};

const FLAGS = ['review', 'checklist', 'hideCompleted', 'checked', 'autoOrganize'] as const;

export function presentationOf(metadata: ItemMetadata): ItemPresentation {
  return { ...DEFAULT_PRESENTATION, ...metadata.presentation };
}

/** Untrusted input (API, AI proposals) to a validated partial presentation. */
export function validPresentationPatch(patch: unknown): Partial<ItemPresentation> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Presentation changes must be an object.');
  const input = patch as Record<string, unknown>;
  const valid: Partial<ItemPresentation> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'kind') {
      if (!(PRESENTATION_KINDS as readonly unknown[]).includes(value)) throw invalid(`kind must be one of: ${PRESENTATION_KINDS.join(', ')}.`);
      valid.kind = value as ItemPresentation['kind'];
    } else if (key === 'attention') {
      if (!(ATTENTION_LEVELS as readonly unknown[]).includes(value)) throw invalid(`attention must be one of: ${ATTENTION_LEVELS.join(', ')}.`);
      valid.attention = value as ItemPresentation['attention'];
    } else if ((FLAGS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') throw invalid(`${key} must be true or false.`);
      valid[key as (typeof FLAGS)[number]] = value;
    } else {
      throw invalid(`Unknown presentation field "${key}".`);
    }
  }
  return valid;
}

// Tasks use status as their sole completion authority; other items use the presentation flag.
export class PresentationService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly tasks: TaskService;

  constructor(ctx: Context, items: ItemService, tasks: TaskService) {
    this.ctx = ctx;
    this.items = items;
    this.tasks = tasks;
  }

  get(id: string): ItemPresentation {
    const row = this.items.row(id);
    const presentation = presentationOf(JSON.parse(row.metadata) as ItemMetadata);
    return row.task_status === null ? presentation : { ...presentation, checked: row.task_status === 'done' };
  }

  update(id: string, patch: Partial<ItemPresentation>): ItemPresentation {
    const row = this.items.row(id);
    if (row.type === 'decision') throw invalid('Decisions are append-only and keep their presentation.');
    const changes = validPresentationPatch(patch);
    this.ctx.tx(() => {
      if (row.task_status !== null && changes.checked !== undefined) {
        this.setChecked(row.id, changes.checked);
        delete changes.checked;
      }
      if (Object.keys(changes).length) {
        const metadata = JSON.parse(row.metadata) as ItemMetadata;
        const presentation = { ...metadata.presentation, ...changes };
        this.items.write(row, { metadata: JSON.stringify({ ...metadata, presentation }) }, 'present', { presentation: changes }, false);
      }
    });
    return this.get(row.id);
  }

  /** Checks or unchecks the item and every applicable item below it, in one transaction. */
  toggle(id: string, checked: boolean): ItemDetail {
    if (typeof checked !== 'boolean') throw invalid('checked must be true or false.');
    const row = this.items.row(id);
    if (row.type === 'decision') throw invalid('Decisions can’t be checked off.');
    this.ctx.tx(() => {
      for (const target of this.checklistItems(row.id).ids) this.setChecked(target, checked);
    });
    return this.items.get(row.id);
  }

  /** Unchecks everything in the checklist below and including `id`. */
  reset(id: string): { updated: number } {
    const row = this.items.row(id);
    return this.ctx.tx(() => ({
      updated: this.checklistItems(row.id).ids.filter((target) => this.setChecked(target, false)).length,
    }));
  }

  /** Counts the leaves below `id` (or `id` itself when it has none) that can be checked; archived items don't count. */
  progress(id: string): { done: number; total: number } {
    const row = this.items.row(id);
    const { leaves } = this.checklistItems(row.id);
    let done = 0;
    let total = 0;
    for (const leaf of leaves) {
      const state = this.completion(leaf);
      if (state === null) continue;
      total++;
      if (state) done++;
    }
    return { done, total };
  }

  private checklistItems(id: string): { ids: string[]; leaves: string[] } {
    const row = this.items.row(id);
    if (row.type === 'decision' || row.archived_at !== null) return { ids: [], leaves: [] };
    const ids = [id];
    const leaves: string[] = [];
    for (let index = 0; index < ids.length; index++) {
      const children = this.ctx.all<{ id: string }>(
        `SELECT id FROM items WHERE parent_id = ? AND archived_at IS NULL AND type != 'decision'`, ids[index]!,
      );
      if (children.length) ids.push(...children.map((child) => child.id));
      else leaves.push(ids[index]!);
    }
    return { ids, leaves };
  }

  /** True/false for an applicable item, null for one that isn't (decisions, archived items). */
  private completion(id: string): boolean | null {
    const row = this.items.row(id);
    if (row.type === 'decision' || row.archived_at !== null) return null;
    if (row.task_status !== null) return row.task_status === 'done';
    return presentationOf(JSON.parse(row.metadata) as ItemMetadata).checked;
  }

  /** Returns whether anything changed. */
  private setChecked(id: string, checked: boolean): boolean {
    const current = this.completion(id);
    if (current === null || current === checked) return false;
    const row = this.items.row(id);
    if (row.task_status !== null) {
      this.tasks.update(row.id, { status: checked ? 'done' : 'open' });
    } else {
      const metadata = JSON.parse(row.metadata) as ItemMetadata;
      this.items.write(row, { metadata: JSON.stringify({ ...metadata, presentation: { ...metadata.presentation, checked } }) }, 'check', { checked });
    }
    return true;
  }
}
