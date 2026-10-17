import { type Context, newId, oneOf, required, slugify } from './context.ts';
import { MemoryError, invalid, notFound } from './errors.ts';
import { clampLimit } from './items.ts';
import { PROJECT_STATUSES, type Project, type ProjectMemoryVersion, type ProjectStatus } from './types.ts';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  instructions: string;
  memory: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  instructions: row.instructions,
  memory: row.memory,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface CreateProjectInput {
  name: string;
  description?: string;
  instructions?: string;
  /** For importers restoring an export. */
  id?: string;
  createdAt?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  instructions?: string;
  status?: string;
}

export class ProjectService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  create(input: CreateProjectInput): Project {
    const name = required(input.name, 'Project name');
    const slug = this.availableSlug(name);
    const now = input.createdAt ?? this.ctx.now();
    const project: Project = {
      id: input.id ?? newId(),
      name,
      slug,
      description: input.description?.trim() ?? '',
      instructions: input.instructions?.trim() ?? '',
      memory: '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.tx(() => {
      this.ctx.run(
        `INSERT INTO projects (id, name, slug, description, instructions, memory, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project.id, project.name, project.slug, project.description, project.instructions,
        project.memory, project.status, project.createdAt, project.updatedAt,
      );
      this.ctx.record('project', project.id, 'create', project.id, {
        name, description: project.description, instructions: project.instructions,
      });
    });
    return project;
  }

  list(status?: string): Project[] {
    if (status === undefined) {
      return this.ctx
        .all<ProjectRow>(`SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC`)
        .map(toProject);
    }
    oneOf(status, PROJECT_STATUSES, 'project status');
    return this.ctx
      .all<ProjectRow>(`SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC`, status)
      .map(toProject);
  }

  /** Accepts a project id, its slug, its name in any case/spacing, or an unambiguous prefix of the slug. */
  resolve(ref: string): Project {
    const key = required(ref, 'Project');
    const slug = slugify(key);
    const byId = this.ctx.get<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, key);
    if (byId) return toProject(byId);
    if (slug) {
      const bySlug = this.ctx.get<ProjectRow>(`SELECT * FROM projects WHERE slug = ?`, slug);
      if (bySlug) return toProject(bySlug);
      const prefixed = this.ctx.all<ProjectRow>(`SELECT * FROM projects WHERE slug LIKE ? ESCAPE '\\' LIMIT 2`, `${escapeLike(slug)}%`);
      if (prefixed.length === 1) return toProject(prefixed[0]!);
    }
    const names = this.ctx.all<{ name: string }>(`SELECT name FROM projects ORDER BY name`).map((r) => r.name);
    throw notFound(
      names.length
        ? `No project matches "${key}". Existing projects: ${names.join(', ')}.`
        : `No project matches "${key}". There are no projects yet.`,
    );
  }

  update(ref: string, input: UpdateProjectInput): Project {
    const project = this.resolve(ref);
    const changes: Partial<Record<'name' | 'slug' | 'description' | 'instructions' | 'status', string>> = {};
    if (input.name !== undefined) {
      const name = required(input.name, 'Project name');
      if (name !== project.name) {
        changes.name = name;
        const slug = slugify(name);
        if (slug !== project.slug) changes.slug = this.availableSlug(name);
      }
    }
    if (input.description !== undefined) changes.description = input.description.trim();
    if (input.instructions !== undefined) changes.instructions = input.instructions.trim();
    if (input.status !== undefined) changes.status = oneOf(input.status, PROJECT_STATUSES, 'project status');
    return this.write(project, changes, 'update');
  }

  /** Replaces the durable memory document. Every prior version stays in its history. */
  setMemory(ref: string, memory: string): Project {
    return this.write(this.resolve(ref), { memory }, 'set_memory');
  }

  /** Newest first, with an exact total. */
  memoryHistory(ref: string, { offset = 0, limit }: { offset?: number; limit?: number } = {}): { items: ProjectMemoryVersion[]; total: number } {
    const project = this.resolve(ref);
    if (!Number.isInteger(offset) || offset < 0) throw invalid('Offset must be a non-negative integer.');
    const { total } = this.ctx.get<{ total: number }>(`SELECT count(*) AS total FROM project_memory_versions WHERE project_id = ?`, project.id)!;
    const items = this.ctx.all<{ id: string; project_id: string; at: string; actor: string; op: string; memory: string }>(
      `SELECT id, project_id, at, actor, op, memory FROM project_memory_versions WHERE project_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`,
      project.id, clampLimit(limit), offset,
    ).map((row) => ({ id: row.id, projectId: row.project_id, at: row.at, actor: row.actor, op: row.op, memory: row.memory }));
    return { items, total };
  }

  private write(project: Project, changes: Record<string, string>, op: string): Project {
    const keys = Object.keys(changes);
    if (keys.length === 0) return project;
    const now = this.ctx.now();
    this.ctx.tx(() => {
      this.ctx.run(
        `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...Object.values(changes), now, project.id,
      );
      this.ctx.record('project', project.id, op, project.id, changes);
    });
    return this.resolve(project.id);
  }

  private availableSlug(name: string): string {
    const slug = slugify(name);
    if (!slug) throw invalid(`Project name "${name}" needs at least one letter or digit.`);
    const existing = this.ctx.get<{ name: string }>(`SELECT name FROM projects WHERE slug = ?`, slug);
    if (existing) throw new MemoryError('conflict', `A project named "${existing.name}" already exists.`);
    return slug;
  }
}

/** Called once per transaction with the projects it changed; keeps the memory text whenever it differs from the last kept. */
export function captureMemoryVersions(ctx: Context, changed: Map<string, { op: string; actor: string }>): void {
  for (const [id, { op, actor }] of changed) {
    const project = ctx.get<{ memory: string }>(`SELECT memory FROM projects WHERE id = ?`, id);
    if (!project) continue;
    const last = ctx.get<{ memory: string }>(`SELECT memory FROM project_memory_versions WHERE project_id = ? ORDER BY seq DESC LIMIT 1`, id);
    if ((last?.memory ?? '') === project.memory) continue;
    ctx.run(
      `INSERT INTO project_memory_versions (id, project_id, at, actor, op, memory) VALUES (?, ?, ?, ?, ?, ?)`,
      newId(), id, ctx.now(), actor, op, project.memory,
    );
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
