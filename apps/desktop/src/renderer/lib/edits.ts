import type { EditorActionResult, EditorCommand } from '@enve-memory/core';
import { useCallback, useSyncExternalStore } from 'react';
import { useFeedback } from '../ui.tsx';
import { CallFailed, call, errorMessage } from './api.ts';

interface Entry {
  actionId: string;
  label: string;
}

export interface EditHistory {
  undo: Entry | null;
  redo: Entry | null;
  busy: boolean;
}

const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
const listeners = new Set<() => void>();
const focusListeners = new Set<(id: string) => void>();
let busy = false;
let snapshot: EditHistory = { undo: null, redo: null, busy: false };

const publish = () => {
  snapshot = { undo: undoStack.at(-1) ?? null, redo: redoStack.at(-1) ?? null, busy };
  for (const listener of listeners) listener();
};

/** Runs a journalled batch; it becomes the newest structural undo step and clears redo. */
export async function applyEdit(commands: EditorCommand[]): Promise<EditorActionResult> {
  const result = await call('editor.apply', commands);
  undoStack.push({ actionId: result.actionId, label: result.label });
  redoStack.length = 0;
  publish();
  return result;
}

// A refused step (something it touched changed since, or it's gone) is dropped: retrying would only fail again.
const stale = (error: unknown) => error instanceof CallFailed && (error.code === 'conflict' || error.code === 'not_found');

async function step(from: Entry[], to: Entry[], run: 'editor.undo' | 'editor.redo'): Promise<EditorActionResult | null> {
  const entry = from.at(-1);
  if (!entry || busy) return null;
  busy = true;
  publish();
  try {
    const result = await call(run, entry.actionId);
    from.pop();
    to.push(entry);
    for (const listener of focusListeners) listener(result.focusId);
    return result;
  } catch (error) {
    if (stale(error)) from.pop();
    throw error;
  } finally {
    busy = false;
    publish();
  }
}

export const undoEdit = () => step(undoStack, redoStack, 'editor.undo');
export const redoEdit = () => step(redoStack, undoStack, 'editor.redo');

/** Called with the item an undo or redo affected, so the outline can show it. */
export function onEditFocus(listener: (id: string) => void): () => void {
  focusListeners.add(listener);
  return () => void focusListeners.delete(listener);
}

export function useEditHistory(): EditHistory {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, () => snapshot);
}

/** Structural undo and redo with their outcome reported as a toast. */
export function useUndoRedo() {
  const { toast } = useFeedback();
  const history = useEditHistory();
  const run = useCallback((redo: boolean) => {
    (redo ? redoEdit() : undoEdit()).then(
      (result) => result && toast(`${redo ? 'Redid' : 'Undid'}: ${result.label}`),
      (error: unknown) => toast(`Couldn’t ${redo ? 'redo' : 'undo'}: ${errorMessage(error)}`, 'error'),
    );
  }, [toast]);
  return { history, undo: useCallback(() => run(false), [run]), redo: useCallback(() => run(true), [run]) };
}

/** Typing undo belongs to the focused field; structural undo only runs outside fields and dialogs. */
export const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]')));
