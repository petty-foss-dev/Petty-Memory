import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { EnveMemory, type Item, type ItemDetail, type SavedView, type ViewPage } from '@enve-memory/core';

async function fixture(t: import('node:test').TestContext) {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  const api = createApiServer(memory, { version: 'test', port: 0 });
  const base = await api.listen();
  t.after(async () => { await api.close(); memory.close(); });
  const tokens = {
    reader: memory.clients.create('reader', ['read']).token,
    writer: memory.clients.create('writer', ['read', 'write']).token,
    capture: memory.clients.create('capture', ['capture']).token,
  };
  async function call<T>(method: string, path: string, token: string, body?: unknown, key?: string) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T, replayed: response.headers.get('Idempotent-Replayed') };
  }
  return { memory, call, ...tokens };
}

test('saved views stay dynamic, retain project identity and page through filtered results', async (t) => {
  const { memory, call, reader, writer } = await fixture(t);
  const project = memory.projects.create({ name: 'Garage' });
  const first = memory.tasks.create({ title: 'Wire sensor', project: project.id });
  const second = memory.tasks.create({ title: 'Fit sensor', project: project.id });
  memory.tasks.create({ title: 'Buy sensor', project: project.id });
  memory.tasks.create({ title: 'Garden sensor' });
  const created = await call<SavedView>('POST', '/views', writer, {
    name: 'Open sensor work', query: 'sensor', filter: { project: 'Garage', type: 'task', taskStatus: 'open' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.filter.project, project.id);
  memory.projects.update(project.id, { name: 'Workshop' });
  const page = await call<ViewPage>('GET', `/views/${created.data.id}/items?limit=2`, reader);
  assert.equal(page.status, 200);
  assert.equal(page.data.items.length, 2);
  assert.ok(page.data.next);
  const older = await call<ViewPage>('GET', `/views/${created.data.id}/items?limit=2&before=${encodeURIComponent(page.data.next!)}`, reader);
  assert.equal(older.data.items.length, 1);
  assert.equal(new Set([...page.data.items, ...older.data.items].map((item) => item.id)).size, 3);
  memory.tasks.complete(first.id);
  const after = await call<ViewPage>('GET', `/views/${created.data.id}/items`, reader);
  assert.equal(after.data.items.length, 2);
  assert.ok(after.data.items.some((item) => item.id === second.id));
  assert.ok(after.data.items.every((item) => item.id !== first.id));
  const updated = await call<SavedView>('PATCH', `/views/${created.data.id}`, writer, { name: 'Finished work', filter: { taskStatus: 'done' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.query, '');
  assert.deepEqual((await call<ViewPage>('GET', `/views/${created.data.id}/items`, reader)).data.items.map((item) => item.id), [first.id]);
  assert.equal((await call('DELETE', `/views/${created.data.id}`, writer)).status, 200);
  assert.deepEqual((await call<SavedView[]>('GET', '/views', reader)).data, []);
  assert.equal(memory.tasks.get(first.id).task.status, 'done');
});

test('template API creates fresh trees, resets completion and safely replays retries', async (t) => {
  const { memory, call, reader, writer } = await fixture(t);
  const source = memory.outline.createNote({ parentId: null, title: 'Review {{date}}', body: 'Project {{project}}' });
  const child = memory.outline.createNote({ parentId: source.item.id, title: 'Check batteries', body: '- [x] Repeated step' });
  memory.presentation.update(source.item.id, { checklist: true });
  memory.presentation.toggle(child.item.id, true);
  const created = await call<ItemDetail>('POST', '/templates', writer, { sourceId: source.item.id, name: 'Review {{date}}' }, 'template-copy');
  assert.equal(created.status, 201);
  const replay = await call<ItemDetail>('POST', '/templates', writer, { sourceId: source.item.id }, 'template-copy');
  assert.equal(replay.data.id, created.data.id);
  assert.equal(replay.replayed, 'true');
  assert.equal((await call<Item[]>('GET', '/templates', reader)).data.length, 1);
  const project = memory.projects.create({ name: 'Workshop' });
  const input = { project: project.id, date: '2026-10-17' };
  const used = await call<ItemDetail>('POST', `/templates/${created.data.id}/use`, writer, input, 'template-use');
  const usedAgain = await call<ItemDetail>('POST', `/templates/${created.data.id}/use`, writer, input, 'template-use');
  assert.equal(used.status, 201);
  assert.equal(usedAgain.data.id, used.data.id);
  assert.equal(usedAgain.replayed, 'true');
  assert.equal(used.data.title, 'Review 2026-10-17');
  assert.equal(used.data.body, 'Project Workshop');
  assert.equal(used.data.metadata.template, undefined);
  const children = memory.outline.children(used.data.id).items;
  assert.equal(children.length, 1);
  assert.notEqual(children[0]!.item.id, child.item.id);
  assert.equal(children[0]!.item.body, '- [ ] Repeated step');
  assert.equal(memory.presentation.get(children[0]!.item.id).checked, false);
  assert.equal(memory.presentation.get(child.item.id).checked, true);
});

test('workflow routes enforce scopes and reject malformed data without modifying the library', async (t) => {
  const { memory, call, reader, writer, capture } = await fixture(t);
  const source = memory.items.saveNote({ title: 'Plan', body: 'Ordinary text' });
  const template = memory.templates.create(source.id);
  const view = memory.views.create({ name: 'All notes', filter: { type: 'note' } });
  for (const route of ['/views', `/views/${view.id}`, `/views/${view.id}/items`, '/templates']) {
    assert.equal((await call('GET', route, capture)).status, 403, route);
  }
  for (const token of [reader, capture]) {
    assert.equal((await call('POST', '/views', token, { name: 'Forbidden' })).status, 403);
    assert.equal((await call('PATCH', `/views/${view.id}`, token, { name: 'Forbidden' })).status, 403);
    assert.equal((await call('DELETE', `/views/${view.id}`, token)).status, 403);
    assert.equal((await call('POST', '/templates', token, { sourceId: source.id })).status, 403);
    assert.equal((await call('POST', `/templates/${template.id}/use`, token, {})).status, 403);
  }
  for (const body of [undefined, { name: '' }, { name: 'Bad', filter: 'sql' }, { name: 'Bad', filter: { secret: true } }, { name: 'Bad', filter: { taskStatus: 'unknown' } }]) {
    assert.equal((await call('POST', '/views', writer, body)).status, 400);
  }
  assert.equal((await call('POST', `/templates/${template.id}/use`, writer, { date: '2026-02-30' })).status, 400);
  assert.equal((await call('GET', `/views/${view.id}/items?limit=0`, reader)).status, 400);
  assert.equal(memory.views.list().length, 1);
  assert.equal(memory.templates.list().length, 1);
});
