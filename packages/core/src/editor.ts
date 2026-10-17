import { createHash } from 'node:crypto';
import { type Context, clientId, newId } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { type ItemService, isSecret } from './items.ts';
import type { OutlineService } from './outline.ts';
import { pathToRoot, place, slots } from './placement.ts';
import { type PresentationService, presentationOf } from './presentation.ts';
import type { EditorActionResult, EditorCommand, ItemMetadata, ItemPresentation, TaskStatus } from './types.ts';

const MAX_COMMANDS = 500;

interface Snapshot {
  type: string;
  secret: boolean;
  title: string;
  body: string;
  parentId: string | null;
  sortOrder: number;
  archivedAt: string | null;
  presentation: Partial<ItemPresentation> | null;
  task: { status: TaskStatus; completedAt: string | null } | null;
}

/** `before` is null for an item the action created. */
interface Entry {
  id: string;
  before: Snapshot | null;
  after: Snapshot;
}

interface ActionRow {
  id: string;
  label: string;
  focus_id: string;
  undo_focus_id: string;
  created_ids: string;
  commands_hash: string;
  entries: string;
  undone_at: string | null;
}

interface Step {
  label: string;
  focusId: string;
  undoFocusId: string;
  created?: string;
}

interface ItemSnapshotRow {
  type: string;
  title: string;
  body: string;
  parent_id: string | null;
  sort_order: number;
  archived_at: string | null;
  metadata: string;
}

interface TaskSnapshotRow {
  status: TaskStatus;
  completed_at: string | null;
}

// Capture before-state across service calls, including sibling respacing and checklist descendants.
const CAPTURE = `
  CREATE TEMP TABLE IF NOT EXISTS editor_capture (active INTEGER);
  CREATE TEMP TABLE IF NOT EXISTS editor_items (item_id TEXT PRIMARY KEY, state TEXT);
  CREATE TEMP TABLE IF NOT EXISTS editor_tasks (item_id TEXT PRIMARY KEY, state TEXT);
  CREATE TEMP TRIGGER IF NOT EXISTS editor_items_insert AFTER INSERT ON main.items
    WHEN EXISTS (SELECT 1 FROM editor_capture)
    BEGIN INSERT OR IGNORE INTO editor_items (item_id, state) VALUES (NEW.id, NULL); END;
  CREATE TEMP TRIGGER IF NOT EXISTS editor_items_update BEFORE UPDATE ON main.items
    WHEN EXISTS (SELECT 1 FROM editor_capture)
    BEGIN
      INSERT OR IGNORE INTO editor_items (item_id, state) VALUES (OLD.id, json_object(
        'type', OLD.type, 'title', OLD.title, 'body', OLD.body, 'parent_id', OLD.parent_id, 'sort_order', OLD.sort_order,
        'archived_at', OLD.archived_at, 'metadata', OLD.metadata));
    END;
  CREATE TEMP TRIGGER IF NOT EXISTS editor_tasks_update BEFORE UPDATE ON main.tasks
    WHEN EXISTS (SELECT 1 FROM editor_capture)
    BEGIN
      INSERT OR IGNORE INTO editor_tasks (item_id, state) VALUES (OLD.item_id, json_object('status', OLD.status, 'completed_at', OLD.completed_at));
    END;
`;

export class EditorService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly outline: OutlineService;
  private readonly presentation: PresentationService;

  constructor(ctx: Context, items: ItemService, outline: OutlineService, presentation: PresentationService) {
    this.ctx = ctx;
    this.items = items;
    this.outline = outline;
    this.presentation = presentation;
    ctx.db.exec(CAPTURE);
  }

  /** Applies every command or none. Repeating an action id with the same commands returns the original result. */
  apply(commands: EditorCommand[], options: { id?: string } = {}): EditorActionResult {
    if (!Array.isArray(commands) || commands.length === 0) throw invalid('Send at least one editor command.');
    if (commands.length > MAX_COMMANDS) throw invalid(`Send at most ${MAX_COMMANDS} editor commands at once.`);
    const actionId = options?.id === undefined ? newId() : clientId(options.id, 'Action id');
    const hash = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
    return this.ctx.tx(() => {
      const existing = this.ctx.get<ActionRow>(`SELECT * FROM editor_actions WHERE id = ?`, actionId);
      if (existing) {
        if (existing.commands_hash !== hash) throw new MemoryError('conflict', 'That action id was already used for different changes. Send a new id.');
        return result(existing, false);
      }
      this.ctx.run(`DELETE FROM editor_items`);
      this.ctx.run(`DELETE FROM editor_tasks`);
      this.ctx.run(`INSERT INTO editor_capture (active) VALUES (1)`);
      let steps: Step[];
      try {
        steps = commands.map((command: unknown) => this.run(command));
      } finally {
        this.ctx.run(`DELETE FROM editor_capture`);
      }
      const row: ActionRow = {
        id: actionId,
        label: new Set(steps.map((step) => step.label)).size === 1 ? steps[0]!.label : 'Edit outline',
        focus_id: steps.at(-1)!.focusId,
        undo_focus_id: steps[0]!.undoFocusId,
        created_ids: JSON.stringify(steps.flatMap((step) => (step.created ? [step.created] : []))),
        commands_hash: hash,
        entries: JSON.stringify(this.journal()),
        undone_at: null,
      };
      this.ctx.run(
        `INSERT INTO editor_actions (id, actor, label, focus_id, undo_focus_id, created_ids, commands_hash, entries, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, this.ctx.actor, row.label, row.focus_id, row.undo_focus_id, row.created_ids, row.commands_hash, row.entries, this.ctx.now(),
      );
      return result(row, false);
    });
  }

  /** Created notes are archived so redo can retain their ids. */
  undo(actionId: string): EditorActionResult {
    return this.ctx.tx(() => {
      const row = this.action(actionId);
      if (row.undone_at === null) {
        this.restore(row, 'undo');
        this.ctx.run(`UPDATE editor_actions SET undone_at = ? WHERE id = ?`, this.ctx.now(), row.id);
      }
      return result(row, true);
    });
  }

  redo(actionId: string): EditorActionResult {
    return this.ctx.tx(() => {
      const row = this.action(actionId);
      if (row.undone_at !== null) {
        this.restore(row, 'redo');
        this.ctx.run(`UPDATE editor_actions SET undone_at = NULL WHERE id = ?`, row.id);
      }
      return result(row, false);
    });
  }

  private action(actionId: string): ActionRow {
    if (typeof actionId !== 'string' || !actionId) throw invalid('Action id is required.');
    const row = this.ctx.get<ActionRow>(`SELECT * FROM editor_actions WHERE id = ?`, actionId);
    if (!row) throw notFound(`No editor action with id "${actionId}" on this library.`);
    return row;
  }

  private run(raw: unknown): Step {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Each editor command must be an object.');
    const command = raw as Record<string, unknown>;
    switch (command.op) {
      case 'create':
        return this.create(command);
      case 'update': {
        const id = ref(command.id, 'id');
        const title = text(command.title, 'title');
        const body = text(command.body, 'body');
        if (title === undefined && body === undefined) throw invalid('An update needs a title or body.');
        this.items.update(id, { title, body, baseTitle: text(command.baseTitle, 'baseTitle'), baseBody: text(command.baseBody, 'baseBody') });
        return onItem('Edit text', id);
      }
      case 'move': {
        const id = ref(command.id, 'id');
        this.outline.move(id, {
          parentId: nullableRef(command.parentId, 'parentId'),
          beforeId: command.beforeId === undefined ? null : nullableRef(command.beforeId, 'beforeId'),
        });
        return onItem('Move', id);
      }
      case 'presentation': {
        const id = ref(command.id, 'id');
        this.presentation.update(id, command.patch as Partial<ItemPresentation>);
        return onItem('Change style', id);
      }
      case 'check': {
        const id = ref(command.id, 'id');
        if (typeof command.checked !== 'boolean') throw invalid('checked must be true or false.');
        this.presentation.toggle(id, command.checked);
        return onItem(command.checked ? 'Check off' : 'Uncheck', id);
      }
      case 'split':
        return this.split(command);
      case 'merge':
        return this.merge(command);
      default:
        throw invalid('Editor commands are create, update, move, presentation, check, split or merge.');
    }
  }

  private create(command: Record<string, unknown>): Step {
    const parentId = nullableRef(command.parentId, 'parentId');
    const beforeId = command.beforeId === undefined ? null : nullableRef(command.beforeId, 'beforeId');
    if (command.tags !== undefined && !(Array.isArray(command.tags) && command.tags.every((tag) => typeof tag === 'string'))) {
      throw invalid('tags must be a list of strings.');
    }
    const id = this.outline.createNote({
      id: command.id as string | undefined, parentId, title: text(command.title, 'title'), body: text(command.body, 'body'),
      project: text(command.project, 'project'), tags: command.tags as string[] | undefined,
    }).item.id;
    if (beforeId !== null) this.outline.move(id, { parentId, beforeId });
    return { label: 'New note', focusId: id, undoFocusId: this.neighbour(id), created: id };
  }

  // A title split leaves the body on the original; a body split leaves the title. Existing children stay on the original.
  private split(command: Record<string, unknown>): Step {
    const row = this.note(ref(command.id, 'id'), 'split');
    if (command.field !== 'title' && command.field !== 'body') throw invalid('field must be "title" or "body".');
    const field = command.field;
    if (typeof command.baseText !== 'string') throw invalid('baseText must be the text the split was made in.');
    const current = row[field];
    if (current !== command.baseText) {
      throw new MemoryError('conflict', 'This note changed since editing began. Review the latest text, then split it again.');
    }
    const offset = command.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > current.length) {
      throw invalid(`offset must be a whole number of UTF-16 code units from 0 to ${current.length}.`);
    }
    if (isHighSurrogate(current.charCodeAt(offset - 1)) && isLowSurrogate(current.charCodeAt(offset))) {
      throw invalid('That offset falls inside a character. Split at a character boundary.');
    }
    const head = current.slice(0, offset);
    const tail = current.slice(offset);
    if (!tail.trim()) throw invalid('Nothing follows the split point. Keep the new line in the editor until it has text.');
    if (!(field === 'title' ? head.trim() || row.body.trim() : row.title.trim() || head.trim())) {
      throw invalid('Nothing would be left before the split point.');
    }
    const { parent_id: parentId, sort_order: sortOrder } = this.placement(row.id);
    const next = this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE parent_id IS ? AND (sort_order, id) > (?, ?) ORDER BY sort_order, id LIMIT 1`, parentId, sortOrder, row.id,
    )?.id ?? null;
    const created = this.outline.createNote({
      id: command.newId as string | undefined, parentId, project: row.project_id ?? undefined,
      ...(field === 'title' ? { title: tail } : { body: tail }),
    }).item.id;
    if (next !== null) this.outline.move(created, { parentId, beforeId: next });
    this.items.update(row.id, field === 'title' ? { title: head } : { body: head });
    return { label: 'Split note', focusId: created, undoFocusId: row.id, created };
  }

  // The source is archived rather than deleted, so its identity and text stay recoverable.
  private merge(command: Record<string, unknown>): Step {
    const source = this.note(ref(command.id, 'id'), 'merged');
    const previous = this.note(ref(command.previousId, 'previousId'), 'merged');
    const { parent_id: parentId, sort_order: sortOrder } = this.placement(source.id);
    const adjacent = this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE parent_id IS ? AND archived_at IS NULL AND (sort_order, id) < (?, ?) ORDER BY sort_order DESC, id DESC LIMIT 1`,
      parentId, sortOrder, source.id,
    )?.id;
    if (adjacent !== previous.id) {
      throw new MemoryError('conflict', 'Those notes are no longer next to each other. Refresh the outline and merge again.');
    }
    const joined = (a: string, b: string, separator: string) => [a, b].filter((part) => part.trim()).join(separator);
    this.items.update(previous.id, { title: joined(previous.title, source.title, ' '), body: joined(previous.body, source.body, '\n\n') });
    const children = this.ctx.all<{ id: string; project_id: string | null }>(
      `SELECT id, project_id FROM items WHERE parent_id = ? ORDER BY sort_order, id`, source.id,
    );
    if (children.length) {
      const keys = slots(this.ctx, previous.id, null, children.length, children.map((child) => child.id));
      children.forEach((child, i) => place(this.ctx, child.id, child.project_id, previous.id, keys[i]!));
    }
    this.items.archive(source.id);
    return { label: 'Merge notes', focusId: previous.id, undoFocusId: source.id };
  }

  private note(id: string, verb: string) {
    const row = this.items.row(id);
    if (row.type !== 'note' || isSecret(row) || row.archived_at !== null) throw invalid(`Only active, ordinary notes can be ${verb}.`);
    return row;
  }

  private placement(id: string): { parent_id: string | null; sort_order: number } {
    return this.ctx.get<{ parent_id: string | null; sort_order: number }>(`SELECT parent_id, sort_order FROM items WHERE id = ?`, id)!;
  }

  private neighbour(id: string): string {
    const { parent_id: parentId, sort_order: sortOrder } = this.placement(id);
    const sibling = (direction: '<' | '>') => this.ctx.get<{ id: string }>(
      `SELECT id FROM items WHERE parent_id IS ? AND archived_at IS NULL AND (sort_order, id) ${direction} (?, ?)
       ORDER BY sort_order ${direction === '<' ? 'DESC' : 'ASC'}, id ${direction === '<' ? 'DESC' : 'ASC'} LIMIT 1`,
      parentId, sortOrder, id,
    )?.id;
    return sibling('<') ?? parentId ?? sibling('>') ?? id;
  }

  private journal(): Entry[] {
    const items = new Map(this.ctx.all<{ item_id: string; state: string | null }>(`SELECT item_id, state FROM editor_items`).map((r) => [r.item_id, r.state]));
    const tasks = new Map(this.ctx.all<{ item_id: string; state: string }>(`SELECT item_id, state FROM editor_tasks`).map((r) => [r.item_id, r.state]));
    const entries: Entry[] = [];
    for (const id of new Set([...items.keys(), ...tasks.keys()])) {
      const after = this.snapshot(id);
      if (!after) continue;
      const item = items.get(id);
      if (item === null) {
        entries.push({ id, before: null, after });
        continue;
      }
      const task = tasks.get(id);
      const before: Snapshot = {
        ...(item === undefined ? after : fromRow(JSON.parse(item) as ItemSnapshotRow)),
        task: task === undefined ? after.task : fromTask(JSON.parse(task) as TaskSnapshotRow),
      };
      if (!sameEdit(before, after)) entries.push({ id, before, after });
    }
    return entries;
  }

  private snapshot(id: string): Snapshot | null {
    const row = this.ctx.get<ItemSnapshotRow>(`SELECT type, title, body, parent_id, sort_order, archived_at, metadata FROM items WHERE id = ?`, id);
    if (!row) return null;
    const task = this.ctx.get<TaskSnapshotRow>(`SELECT status, completed_at FROM tasks WHERE item_id = ?`, id);
    return { ...fromRow(row), task: task ? fromTask(task) : null };
  }

  private restore(row: ActionRow, direction: 'undo' | 'redo'): void {
    const now = this.ctx.now();
    const plan = (JSON.parse(row.entries) as Entry[]).map(({ id, before, after }) => {
      const archived = { ...after, archivedAt: now };
      const expected = direction === 'undo' ? after : before ?? archived;
      const target = direction === 'undo' ? before ?? archived : after;
      const current = this.snapshot(id);
      if (!current || current.type === 'decision' || !sameEdit(current, expected)) {
        throw new MemoryError('conflict', `“${row.label}” can’t be ${direction === 'undo' ? 'undone' : 'redone'}: `
          + `${current ? 'something it changed was edited since' : 'something it changed was deleted'}. Review the current version instead.`);
      }
      return { id, current, target };
    });
    for (const { id, current, target } of plan) this.write(id, current, target, direction, row.id);
    for (const { id, current, target } of plan) {
      if (target.parentId === null || target.parentId === current.parentId) continue;
      const parent = this.ctx.get<{ type: string; secret: number | null }>(
        `SELECT type, json_extract(metadata, '$.secret') AS secret FROM items WHERE id = ?`, target.parentId,
      );
      const top = pathToRoot(this.ctx, id).at(-1)!;
      const detached = this.placement(top).parent_id !== null;
      if (!parent || parent.type === 'decision' || (parent.secret && !target.secret) || detached) {
        throw new MemoryError('conflict', `“${row.label}” can’t be ${direction === 'undo' ? 'undone' : 'redone'}: `
          + 'an item’s earlier place in the outline no longer exists. Move it by hand instead.');
      }
    }
  }

  // Fields outside the snapshot (tags, project, reminders, opened time) keep whatever they are now.
  private write(id: string, current: Snapshot, target: Snapshot, op: 'undo' | 'redo', actionId: string): void {
    const archivedAt = target.archivedAt === null ? null : current.archivedAt ?? target.archivedAt;
    const next: Snapshot = { ...target, archivedAt };
    if (sameEdit(current, next) && current.archivedAt === archivedAt && current.task?.completedAt === next.task?.completedAt) return;
    const row = this.ctx.get<{ metadata: string; project_id: string | null }>(`SELECT metadata, project_id FROM items WHERE id = ?`, id)!;
    const metadata = JSON.parse(row.metadata) as ItemMetadata;
    if (next.presentation) metadata.presentation = next.presentation;
    else delete metadata.presentation;
    this.ctx.run(
      `UPDATE items SET title = ?, body = ?, parent_id = ?, sort_order = ?, archived_at = ?, metadata = ?, updated_at = ? WHERE id = ?`,
      next.title, next.body, next.parentId, next.sortOrder, next.archivedAt, JSON.stringify(metadata), this.ctx.now(), id,
    );
    if (next.task && current.task) {
      this.ctx.run(`UPDATE tasks SET status = ?, completed_at = ? WHERE item_id = ?`, next.task.status, next.task.completedAt, id);
    }
    if (next.parentId !== current.parentId) this.ctx.run(`DELETE FROM sync_pending WHERE kind = 'item_parent' AND key = ?`, id);
    this.ctx.record('item', id, op, row.project_id, {
      actionId, title: next.title, body: next.body, parentId: next.parentId, sortOrder: next.sortOrder,
      archivedAt: next.archivedAt, presentation: next.presentation, ...(next.task && { status: next.task.status }),
    });
  }
}

const result = (row: ActionRow, undo: boolean): EditorActionResult => ({
  actionId: row.id,
  focusId: undo ? row.undo_focus_id : row.focus_id,
  createdIds: JSON.parse(row.created_ids) as string[],
  label: row.label,
});

const onItem = (label: string, id: string): Step => ({ label, focusId: id, undoFocusId: id });

const fromRow = (row: ItemSnapshotRow): Omit<Snapshot, 'task'> => ({
  type: row.type,
  secret: isSecret(row),
  title: row.title,
  body: row.body,
  parentId: row.parent_id,
  sortOrder: row.sort_order,
  archivedAt: row.archived_at,
  presentation: (JSON.parse(row.metadata) as ItemMetadata).presentation ?? null,
});

const fromTask = (row: TaskSnapshotRow): Snapshot['task'] => ({ status: row.status, completedAt: row.completed_at });

/** Equal as far as editing goes: an archive time or a sparse presentation default isn't an edit. */
function sameEdit(a: Snapshot, b: Snapshot): boolean {
  const key = (s: Snapshot) => JSON.stringify([
    s.type, s.secret, s.title, s.body, s.parentId, s.sortOrder, s.archivedAt !== null,
    presentationOf({ presentation: s.presentation ?? undefined }), s.task?.status ?? null,
  ]);
  return key(a) === key(b);
}

function ref(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw invalid(`${label} must be an item id.`);
  return value;
}

function nullableRef(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) throw invalid(`${label} must be an item id or null.`);
  return value;
}

function text(value: unknown, label: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw invalid(`${label} must be text.`);
  return value;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
