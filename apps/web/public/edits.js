import { ApiError, enc, post } from './api.js';
import { uuidv7 } from './crypto.js';

// Structural undo for journalled outline and text changes. Typing undo stays with the focused field.
const undoStack = [];
const redoStack = [];
const listeners = new Set();
let busy = false;

const notify = () => { for (const listener of listeners) listener(); };

export const editHistory = () => ({ undo: undoStack.at(-1) ?? null, redo: redoStack.at(-1) ?? null, busy });

export function onEditHistory(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies commands as one journalled action; its id lets a retried request land once. */
export async function applyEdit(commands) {
  const result = await post('/editor/actions', { commands, id: uuidv7() });
  undoStack.push({ actionId: result.actionId, label: result.label });
  redoStack.length = 0;
  notify();
  return result;
}

// A refused step (something it touched changed since, or it's gone) is dropped: retrying would only fail again.
const stale = (error) => error instanceof ApiError && (error.code === 'conflict' || error.code === 'not_found' || error.status === 404 || error.status === 409);

async function step(from, to, direction) {
  const entry = from.at(-1);
  if (!entry || busy) return null;
  busy = true;
  notify();
  try {
    const result = await post(`/editor/actions/${enc(entry.actionId)}/${direction}`);
    from.pop();
    to.push(entry);
    return result;
  } catch (error) {
    if (stale(error)) from.pop();
    throw error;
  } finally {
    busy = false;
    notify();
  }
}

export const undoEdit = () => step(undoStack, redoStack, 'undo');
export const redoEdit = () => step(redoStack, undoStack, 'redo');

export const isEditable = (target) =>
  target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]')));

export function clearEditHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  notify();
}
