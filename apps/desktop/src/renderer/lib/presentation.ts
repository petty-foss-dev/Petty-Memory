import type { Item, ItemPresentation, TaskFields } from '@enve-memory/core';

export const DEFAULT_PRESENTATION: ItemPresentation = {
  kind: 'text', attention: 'normal', review: false, checklist: false, hideCompleted: false, checked: false, autoOrganize: false,
};

export const presentationOf = (item: Pick<Item, 'metadata'>): ItemPresentation => ({ ...DEFAULT_PRESENTATION, ...item.metadata.presentation });

/** Checked off: a task's status is the only authority for tasks, the presentation flag for everything else. */
export const isChecked = (item: Pick<Item, 'metadata'> & { task?: TaskFields | null }) =>
  item.task ? item.task.status === 'done' : presentationOf(item).checked;

export const isSecret =(item: Pick<Item, 'metadata'>) => item.metadata.secret === true;

export const KIND_LABELS: Record<ItemPresentation['kind'], string> = { text: 'Text', heading: 'Heading', section: 'Section break' };
export const ATTENTION_LABELS: Record<ItemPresentation['attention'], string> = { high: 'High', normal: 'Normal', low: 'Low' };

const REFERENCE = /\[\[item:([0-9a-fA-F-]{36})(?:\|([^\]\n]*))?\]\]/g;

/** Text with inline references shown as their labels, for one-line previews. */
export const readableText = (text: string) => text.replace(REFERENCE, (_, _id: string, label?: string) => label || 'linked item');

export interface PastedLine {
  title: string;
  depth: number;
  /** Inferred from the text: `# Title` or a short ALL-CAPS line is a heading; a line after `---` is a section break. */
  kind?: 'heading' | 'section';
  checked?: boolean;
}

const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/;
const LABELLED_DIVIDER = /^(?:-{2,}|={2,})\s*(.+?)\s*(?:-{2,}|={2,})$/;

const isShouting = (text: string) => text.length <= 60 && /\p{L}/u.test(text) && text === text.toUpperCase() && text !== text.toLowerCase();

// Clamp indentation jumps so every pasted child has an existing parent.
export function parsePastedOutline(text: string): PastedLine[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
  const widths: number[] = [];
  const rows: PastedLine[] = [];
  let section = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (DIVIDER.test(trimmed)) {
      section = true;
      continue;
    }
    const indent = line.match(/^[\t ]*/)![0].replace(/\t/g, '    ').length;
    while (widths.length && indent < widths[widths.length - 1]!) widths.pop();
    if (!widths.length || indent > widths[widths.length - 1]!) widths.push(indent);
    const depth = Math.min(widths.length - 1, (rows.at(-1)?.depth ?? -1) + 1);
    const labelled = LABELLED_DIVIDER.exec(trimmed);
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const box = /^(?:[-*+•]\s+)?\[([ xX])\]\s+/.exec(trimmed);
    const title = (labelled?.[1] ?? heading?.[1] ?? trimmed).replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
    if (!title) continue;
    const row: PastedLine = { title, depth };
    if (labelled || section) row.kind = 'section';
    else if (heading || (!box && isShouting(title))) row.kind = 'heading';
    if (box) row.checked = box[1] !== ' ';
    section = false;
    rows.push(row);
  }
  return rows;
}
