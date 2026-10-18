import type { SQLInputValue } from 'node:sqlite';
import {
  type Context, ITEM_COLUMNS, ITEM_FROM, type ItemRow, PRIORITY_TO_INT, normalizeDue, oneOf, required, toItem, toTaskFields,
} from './context.ts';
import { invalid } from './errors.ts';
import { type ItemService, clampLimit } from './items.ts';
import type { ProjectService } from './projects.ts';
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskStatus } from './types.ts';

export interface CreateTaskInput {
  title: string;
  notes?: string;
  project?: string;
  due?: string;
  priority?: string;
  tags?: string[];
  /** For importers restoring an export. */
  id?: string;
  createdAt?: string;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string;
  status?: string;
  due?: string | null;
  priority?: string;
  project?: string | null;
}

/** `active` = open or in progress. */
export type TaskListStatus = TaskStatus | 'active' | 'all';

const OPEN_STATUSES: readonly TaskStatus[] = ['open', 'in_progress'];

export class TaskService {
  private readonly ctx: Context;
  private readonly items: ItemService;
  private readonly projects: ProjectService;

  constructor(ctx: Context, items: ItemService, projects: ProjectService) {
    this.ctx = ctx;
    this.items = items;
    this.projects = projects;
  }

  create(input: CreateTaskInput, { automations = true }: { automations?: boolean } = {}): Task {
    const title = required(input.title, 'Task title');
    const priority = PRIORITY_TO_INT[oneOf(input.priority ?? 'normal', TASK_PRIORITIES, 'priority')];
    const due = input.due === undefined ? null : normalizeDue(input.due);
    const id = this.ctx.tx(() => {
      const id = this.items.insert({
        type: 'task', title, body: input.notes, project: input.project, tags: input.tags, id: input.id, createdAt: input.createdAt,
      }, { automations });
      this.ctx.run(`INSERT INTO tasks (item_id, priority, due_at) VALUES (?, ?, ?)`, id, priority, due);
      return id;
    });
    return this.get(id);
  }

  get(id: string): Task {
    const row = this.items.row(id);
    if (row.type !== 'task') throw invalid(`Item "${id}" is a ${row.type}, not a task.`);
    return toTask(row);
  }

  update(id: string, input: UpdateTaskInput): Task {
    const row = this.items.row(id);
    if (row.type !== 'task') throw invalid(`Item "${id}" is a ${row.type}, not a task.`);

    const itemChanges: Record<string, SQLInputValue> = {};
    if (input.title !== undefined) itemChanges.title = required(input.title, 'Task title');
    if (input.notes !== undefined) itemChanges.body = input.notes.trim();
    if (input.project !== undefined) {
      itemChanges.project_id = input.project === null ? null : this.projects.resolve(input.project).id;
    }

    const taskChanges: Record<string, SQLInputValue> = {};
    if (input.status !== undefined) {
      const status = oneOf(input.status, TASK_STATUSES, 'task status');
      if (status !== row.task_status) {
        taskChanges.status = status;
        taskChanges.completed_at = status === 'done' ? this.ctx.now() : null;
      }
    }
    if (input.due !== undefined) taskChanges.due_at = input.due === null ? null : normalizeDue(input.due);
    if (input.priority !== undefined) {
      taskChanges.priority = PRIORITY_TO_INT[oneOf(input.priority, TASK_PRIORITIES, 'priority')];
    }

    this.ctx.tx(() => {
      const taskKeys = Object.keys(taskChanges);
      if (taskKeys.length) {
        this.ctx.run(
          `UPDATE tasks SET ${taskKeys.map((k) => `${k} = ?`).join(', ')} WHERE item_id = ?`,
          ...Object.values(taskChanges), row.id,
        );
      }
      this.items.write(row, itemChanges, 'update', { ...itemChanges, ...taskChanges });
    });
    return this.get(row.id);
  }

  complete(id: string): Task {
    return this.update(id, { status: 'done' });
  }

  list({ project, status = 'active', tag, offset = 0 }: { project?: string; status?: string; tag?: string; offset?: number } = {}, limit?: number): Task[] {
    const { where, params } = this.items.filterClauses({ project, tag, type: 'task' });
    const listStatus = oneOf<TaskListStatus>(status, [...TASK_STATUSES, 'active', 'all'], 'task status');
    if (listStatus === 'active') {
      where.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`);
      params.push(...OPEN_STATUSES);
    } else if (listStatus !== 'all') {
      where.push('t.status = ?');
      params.push(listStatus);
    }
    return this.items.withTags(this.ctx
      .all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY t.due_at IS NULL, t.due_at, t.priority, i.seq
         LIMIT ? OFFSET ?`,
        ...params, clampLimit(limit), Math.max(0, Math.trunc(offset)),
      )
      .map(toTask));
  }
}

function toTask(row: ItemRow): Task {
  return { ...toItem(row), task: toTaskFields(row)! };
}
