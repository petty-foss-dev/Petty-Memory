import type { MarkdownEditor } from './editor.ts';

// Far more than a host can lag; only bounds memory for a host that never feeds values back.
const MAX_PENDING = 256;

export interface ControlledValue {
  /** Call with every Markdown string the editor reports through onChange. */
  emitted(markdown: string): void;
  /** Call when the host's controlled value changes. Returns true when it replaced the editor's content. */
  receive(value: string): boolean;
}

// Ignore delayed echoes without resetting the caret or typing history; external changes replace the document.
export function controlledValue(editor: Pick<MarkdownEditor, 'getMarkdown' | 'setMarkdown'>): ControlledValue {
  let pending: string[] = [];
  return {
    emitted(markdown) {
      pending.push(markdown);
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    },
    receive(value) {
      const echo = pending.lastIndexOf(value);
      if (echo >= 0) {
        // Host state advances in order, so emissions up to this one can no longer come back.
        pending = pending.slice(echo + 1);
        return false;
      }
      pending = [];
      if (value === editor.getMarkdown()) return false;
      editor.setMarkdown(value);
      return true;
    },
  };
}
