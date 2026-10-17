import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MAX_LIMIT, MemoryError, type SavedViewInput, referencedIds } from '@enve-memory/core';

const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
const note = (memory: EnveMemory, title: string, parentId: string | null = null, body?: string) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const children = (memory: EnveMemory, parentId: string) => memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((e) => e.item);
const itemCount = (memory: EnveMemory) => memory.items.list({ includeArchived: true }, MAX_LIMIT).length;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidv7 = () => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const opaqueEnvelope = () => ({
  v: 1, kdf: { name: 'pbkdf2', hash: 'sha256', iterations: 600_000 },
  salt: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64'),
  tag: randomBytes(16).toString('base64'), data: randomBytes(48).toString('base64'),
});

/** Weekly review › Inbox zero (checked, with a fenced block), Plan › Pick three; references inside and outside the tree. */
function weeklyReview(memory: EnveMemory) {
  const outside = note(memory, 'Goals 2026');
  const root = note(memory, 'Weekly review', null, 'Week of {{date}} in {{project}} by {{author}}');
  const inbox = note(memory, 'Inbox zero', root, [
    '- [x] Empty email',
    '* [X] Empty desk',
    '```',
    '- [x] literal in code',
    '```',
  ].join('\n'));
  const plan = note(memory, 'Plan', root, `See [[item:${inbox}|inbox step]] and [[item:${outside}|goals]]`);
  const pick = note(memory, 'Pick three', plan);
  memory.items.tag(inbox, { add: ['weekly'] });
  memory.presentation.update(inbox, { kind: 'heading', attention: 'high', checklist: true, hideCompleted: true, checked: true, review: true, autoOrganize: true });
  memory.items.pin(root, true);
  memory.items.setReminder(root, '2030-01-01T09:00:00Z');
  return { outside, root, inbox, plan, pick };
}

test('saving a template deep-copies the note tree into fresh notes and leaves the source as it was', () => {
  const memory = open();
  const src = weeklyReview(memory);
  const before = [src.root, src.inbox, src.plan, src.pick].map((id) => memory.items.get(id));

  const template = memory.templates.create(src.root);

  assert.equal(template.title, 'Weekly review template');
  assert.match(template.id, UUID_V7);
  assert.deepEqual(template.metadata.template, { version: 1, rootId: template.id });
  assert.equal(template.body, 'Week of {{date}} in {{project}} by {{author}}', 'placeholders stay literal in the template');
  assert.equal(template.pinnedAt, null);
  assert.equal(template.remindAt, null);
  assert.equal(template.project, null);

  const [inbox, plan] = children(memory, template.id);
  assert.deepEqual([inbox!.title, plan!.title], ['Inbox zero', 'Plan'], 'sibling order is kept');
  const [pick] = children(memory, plan!.id);
  assert.equal(pick!.title, 'Pick three');
  const copies = [template.id, inbox!.id, plan!.id, pick!.id];
  assert.equal(new Set(copies).size, 4);
  for (const id of copies) {
    assert.match(id, UUID_V7);
    assert.ok(![src.root, src.inbox, src.plan, src.pick].includes(id));
    assert.deepEqual(memory.items.get(id).metadata.template, { version: 1, rootId: template.id });
  }

  assert.deepEqual(inbox!.tags, ['weekly']);
  assert.equal(inbox!.body, ['- [ ] Empty email', '* [ ] Empty desk', '```', '- [x] literal in code', '```'].join('\n'));
  assert.deepEqual(memory.presentation.get(inbox!.id), {
    kind: 'heading', attention: 'high', checklist: true, hideCompleted: true, checked: false, review: false, autoOrganize: false,
  });
  assert.deepEqual(Object.keys(inbox!.metadata).sort(), ['presentation', 'template']);

  assert.deepEqual(referencedIds(plan!.body), [inbox!.id, src.outside], 'internal references point at the copy, external ones stay');
  assert.match(plan!.body, /\[\[item:[0-9a-f-]+\|inbox step\]\]/);

  const after = [src.root, src.inbox, src.plan, src.pick].map((id) => memory.items.get(id));
  assert.deepEqual(after, before, 'the source is untouched');
  assert.equal(memory.versions.list(template.id).total, 1, 'copies get ordinary history');
  assert.deepEqual(memory.templates.list().map((t) => t.id), [template.id]);

  assert.equal(memory.templates.create(src.root, '  Friday reset ').title, 'Friday reset');
});

test('an unsupported tree is refused whole, before anything is written', () => {
  const memory = open();
  const root = note(memory, 'Trip');
  const leg = note(memory, 'Leg one', root);
  const assertRefused = (message: RegExp) => {
    const count = itemCount(memory);
    assert.throws(() => memory.templates.create(root), failsWith('invalid', message));
    assert.equal(itemCount(memory), count);
    assert.deepEqual(memory.templates.list(), []);
  };

  const task = memory.tasks.create({ title: 'Book train' });
  memory.outline.move(task.id, { parentId: leg });
  assertRefused(/task; templates copy only notes/);
  memory.outline.move(task.id, { parentId: null });

  const link = memory.items.saveLink({ url: 'https://example.com/hotel', ingest: false }).item;
  memory.outline.move(link.id, { parentId: leg });
  assertRefused(/bookmark/);
  memory.outline.move(link.id, { parentId: null });

  const secret = uuidv7();
  memory.vault.createSealed({ id: secret, envelope: opaqueEnvelope(), parentId: leg });
  assertRefused(/secret note/);
  memory.outline.move(secret, { parentId: null });

  const old = note(memory, 'Old idea', leg);
  memory.items.archive(old);
  assertRefused(/archived/);
  memory.items.unarchive(old);

  const view = memory.views.create({ name: 'Trip notes', query: 'trip' });
  memory.outline.move(view.id, { parentId: leg });
  assertRefused(/saved view/);
  memory.outline.move(view.id, { parentId: null });

  const wide = note(memory, 'Wide');
  for (let i = 0; i < 200; i++) note(memory, `Row ${i}`, wide);
  const count = itemCount(memory);
  assert.throws(() => memory.templates.create(wide), failsWith('invalid', /at most 200 notes/));
  assert.equal(memory.items.list({ includeArchived: true }, MAX_LIMIT).length, count);

  assert.throws(() => memory.templates.create(task.id), failsWith('invalid', /task/));
  assert.throws(() => memory.templates.create(root, 42 as unknown as string), failsWith('invalid'));
  assert.throws(() => memory.templates.create(root, 'x'.repeat(121)), failsWith('invalid'));
  assert.equal(memory.templates.create(root).title, 'Trip template', 'once the tree is clean it saves');
});

test('using a template makes an ordinary tree with fresh state, filled-in placeholders and remapped references', () => {
  const memory = open();
  const src = weeklyReview(memory);
  const garage = memory.projects.create({ name: 'Garage' });
  const template = memory.templates.create(src.root);
  const [tInbox, tPlan] = children(memory, template.id);
  memory.presentation.toggle(tInbox!.id, true);
  memory.items.update(tInbox!.id, { body: `${tInbox!.body}\n- [x] Ticked while editing the template` });
  const scrapped = note(memory, 'Scrapped step', template.id);
  memory.items.archive(scrapped);
  const added = note(memory, 'Added later with {{project}}', tPlan!.id);

  const made = memory.templates.instantiate(template.id, { project: 'garage', date: '2026-10-05' });

  assert.equal(made.title, 'Weekly review template');
  assert.equal(made.body, 'Week of 2026-10-05 in Garage by {{author}}');
  assert.equal(made.metadata.template, undefined);
  assert.equal(made.metadata.savedView, undefined);
  assert.deepEqual(made.project, { id: garage.id, name: 'Garage' });
  const [inbox, plan] = children(memory, made.id);
  assert.deepEqual(children(memory, made.id).map((i) => i.title), ['Inbox zero', 'Plan'], 'archived template notes are left out');
  assert.deepEqual(children(memory, plan!.id).map((i) => i.title), ['Pick three', 'Added later with Garage']);
  const tree = [made, inbox!, plan!, ...children(memory, plan!.id)];
  for (const item of tree) {
    assert.deepEqual(item.project, { id: garage.id, name: 'Garage' });
    assert.equal(memory.items.get(item.id).metadata.template, undefined);
  }
  assert.equal(memory.presentation.get(inbox!.id).checked, false, 'completion starts fresh');
  assert.equal(memory.presentation.get(inbox!.id).kind, 'heading');
  assert.match(inbox!.body, /^- \[ \] Empty email$/m);
  assert.match(inbox!.body, /^- \[ \] Ticked while editing the template$/m);
  assert.match(inbox!.body, /^- \[x\] literal in code$/m);
  assert.deepEqual(referencedIds(plan!.body), [inbox!.id, src.outside]);

  const inInbox = memory.templates.instantiate(template.id, { title: 'This week' });
  assert.equal(inInbox.title, 'This week');
  assert.equal(inInbox.project, null);
  assert.equal(inInbox.body, `Week of ${new Date().toISOString().slice(0, 10)} in Inbox by {{author}}`);
  assert.equal(memory.items.get(template.id).body, 'Week of {{date}} in {{project}} by {{author}}', 'the template keeps its placeholders');
  assert.deepEqual(memory.templates.list().map((t) => t.id), [template.id]);

  for (const date of ['2026-02-30', '2026-13-01', '05/10/2026', '2026-10-5', 20261005]) {
    assert.throws(() => memory.templates.instantiate(template.id, { date } as never), failsWith('invalid', /YYYY-MM-DD/));
  }
  assert.equal(memory.templates.instantiate(template.id, { date: '2028-02-29' }).body.slice(8, 18), '2028-02-29');
  assert.throws(() => memory.templates.instantiate(template.id, { script: 'x' } as never), failsWith('invalid', /Unknown template use field "script"/));
  assert.throws(() => memory.templates.instantiate(template.id, { project: 'nowhere' }), failsWith('not_found'));
  assert.throws(() => memory.templates.instantiate(src.root), failsWith('not_found', /No template/));
  assert.throws(() => memory.templates.instantiate(tPlan!.id), failsWith('not_found', /No template/), 'a member is not a template root');
  memory.items.archive(template.id);
  assert.deepEqual(memory.templates.list(), []);
  assert.throws(() => memory.templates.instantiate(template.id), failsWith('not_found'));
});

test('saved views validate strictly and store a project as its stable id', () => {
  const memory = open();
  const garage = memory.projects.create({ name: 'Garage door' });
  const rejects = (input: unknown, message?: RegExp) =>
    assert.throws(() => memory.views.create(input as SavedViewInput), failsWith('invalid', message));
  rejects(null);
  rejects({ query: 'relay' }, /must be text/);
  rejects({ name: '   ' }, /needs a name/);
  rejects({ name: 'x'.repeat(121) }, /120/);
  rejects({ name: 'Long', query: 'q'.repeat(501) }, /500/);
  rejects({ name: 'Punctuation', query: '!!! ???' }, /at least one word/);
  rejects({ name: 'Sql', sql: 'DROP TABLE items' }, /Unknown saved view field "sql"/);
  rejects({ name: 'Extra', filter: { where: '1=1' } }, /Unknown saved view filter field "where"/);
  rejects({ name: 'Array', filter: [] });
  rejects({ name: 'Status', filter: { taskStatus: 'blocked' } }, /task status/);
  rejects({ name: 'Type', filter: { type: 'folder' } }, /item type/);
  rejects({ name: 'Flag', filter: { pinned: 'yes' } }, /true or false/);
  rejects({ name: 'Days', filter: { unopenedDays: 1.5 } }, /whole number/);
  rejects({ name: 'Both', filter: { project: 'garage', inbox: true } }, /not both/);
  assert.throws(() => memory.views.create({ name: 'Nowhere', filter: { project: 'nowhere' } }), failsWith('not_found'));
  assert.deepEqual(memory.views.list(), []);

  const view = memory.views.create({ name: ' Open garage tasks ', query: ' relay ', filter: { project: 'garage', taskStatus: 'open', pinned: false, tag: '#Hardware' } });
  assert.match(view.id, UUID_V7);
  assert.deepEqual({ name: view.name, query: view.query, filter: view.filter }, {
    name: 'Open garage tasks', query: 'relay', filter: { project: garage.id, taskStatus: 'open', tag: 'hardware' },
  });
  const stored = memory.items.get(view.id);
  assert.equal(stored.type, 'note');
  assert.equal(stored.body, '');
  assert.deepEqual(stored.metadata.savedView, { version: 1, query: 'relay', filter: { project: garage.id, taskStatus: 'open', tag: 'hardware' } });
  assert.deepEqual(memory.views.get(view.id), view);
  assert.throws(() => memory.views.get(note(memory, 'Plain note')), failsWith('not_found', /No saved view/));

  memory.projects.update(garage.id, { name: 'Workshop' });
  memory.tasks.create({ title: 'Wire the relay', project: garage.id, tags: ['hardware'] });
  assert.deepEqual(memory.views.results(view.id).items.map((i) => i.title), ['Wire the relay'], 'a renamed project keeps its view');
  assert.equal(memory.views.get(view.id).filter.project, garage.id);
});

test('view results are live, keyword-only, ANDed, and never include secrets, archives, definitions or templates', () => {
  const memory = open();
  const garage = memory.projects.create({ name: 'Garage' });
  const view = memory.views.create({ name: 'Relay notes', query: 'relay' });
  const titles = () => memory.views.results(view.id).items.map((i) => i.title);
  assert.deepEqual(titles(), [], 'the definition does not match its own name');

  const first = memory.items.saveNote({ title: 'Relay wiring', body: 'Use the 5V relay', project: 'garage' });
  const second = memory.items.saveNote({ body: 'Relay board arrived' });
  memory.items.saveNote({ body: 'Unrelated shopping list' });
  const newestFirst = [first, second].sort((x, y) => `${y.updatedAt},${y.id}`.localeCompare(`${x.updatedAt},${x.id}`)).map((i) => i.id);
  assert.deepEqual(memory.views.results(view.id).items.map((i) => i.id), newestFirst, 'newest first');

  const secret = uuidv7();
  memory.vault.createSealed({ id: secret, envelope: opaqueEnvelope() });
  memory.items.archive(second.id);
  const source = note(memory, 'Relay checklist', null, 'Test each relay');
  const template = memory.templates.create(source);
  note(memory, 'Relay spare added in the template editor', template.id);
  memory.views.create({ name: 'Another relay view', query: 'relay' });
  assert.deepEqual(memory.views.results(view.id).items.map((i) => i.id).sort(), [first.id, source].sort(), 'the source stays ordinary; the template does not');
  assert.ok(memory.views.results(view.id).items.every((i) => i.metadata.secret !== true));

  memory.views.update(view.id, { name: 'Garage tasks', filter: { project: garage.id, type: 'task', taskStatus: 'done' } });
  const mount = memory.tasks.create({ title: 'Mount bracket', project: 'garage' });
  const done = memory.tasks.create({ title: 'Buy screws', project: 'garage' });
  memory.tasks.update(done.id, { status: 'done' });
  memory.tasks.update(memory.tasks.create({ title: 'Done elsewhere' }).id, { status: 'done' });
  assert.deepEqual(memory.views.results(view.id).items.map((i) => i.id), [done.id]);
  memory.tasks.update(mount.id, { status: 'done' });
  assert.deepEqual(memory.views.results(view.id).items.map((i) => i.id).sort(), [done.id, mount.id].sort(), 'results follow the library');
  assert.equal(memory.views.get(view.id).name, 'Garage tasks');

  assert.equal(memory.items.list({ taskStatus: 'done' }).length, 3, 'taskStatus is an ordinary list filter too');
  assert.equal(memory.search.query('relay').some((hit) => hit.id === first.id), true, 'ordinary search is unchanged');

  memory.views.remove(view.id);
  assert.ok(memory.items.get(view.id).archivedAt, 'removing archives the definition');
  assert.ok(memory.views.list().every((v) => v.id !== view.id));
  assert.throws(() => memory.views.results(view.id), failsWith('not_found'));
  assert.equal(memory.items.get(done.id).archivedAt, null, 'matched items are untouched');
});

test('view results page through more than 200 matches with a stable cursor', () => {
  const memory = open();
  for (let i = 0; i < 250; i++) memory.items.saveNote({ title: `Sensor log ${i}`, body: 'sensor reading' });
  memory.items.saveNote({ body: 'nothing to see' });
  const view = memory.views.create({ name: 'Sensors', query: 'sensor' });

  const first = memory.views.results(view.id, { limit: 1000 });
  assert.equal(first.items.length, MAX_LIMIT);
  assert.ok(first.next);
  const second = memory.views.results(view.id, { before: first.next!, limit: 1000 });
  assert.equal(second.items.length, 50);
  assert.equal(second.next, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map((i) => i.id)).size, 250);
  const keys = all.map((i) => `${i.updatedAt},${i.id}`);
  assert.deepEqual(keys, [...keys].sort().reverse(), 'updatedAt DESC, id DESC across pages');

  const small = memory.views.results(view.id);
  assert.equal(small.items.length, 50, 'default page size');
  assert.throws(() => memory.views.results(view.id, { limit: 0 }), failsWith('invalid'));
  assert.throws(() => memory.views.results(view.id, { before: 'garbage' }), failsWith('invalid'));
});

test('view and template metadata survive sync and export', () => {
  const a = open();
  const b = open();
  const garage = a.projects.create({ name: 'Garage' });
  const view = a.views.create({ name: 'Garage notes', query: 'door', filter: { project: garage.id, type: 'note' } });
  const template = a.templates.create(note(a, 'Install', null, 'Install on {{date}}'));
  note(a, 'Step one', template.id);

  b.sync.applyChanges(a.sync.exportChanges().records);
  assert.deepEqual(b.views.get(view.id), a.views.get(view.id));
  assert.deepEqual(b.templates.list().map((t) => t.id), [template.id]);
  b.items.saveNote({ title: 'Door sensor', body: 'reed switch', project: garage.id });
  assert.deepEqual(b.views.results(view.id).items.map((i) => i.title), ['Door sensor']);
  const made = b.templates.instantiate(template.id, { date: '2026-10-17' });
  assert.equal(made.body, 'Install on 2026-10-17');
  assert.deepEqual(children(b, made.id).map((i) => i.title), ['Step one']);

  const out = join(mkdtempSync(join(tmpdir(), 'petty-workflows-export-')), 'export');
  a.exports.write(out);
  const exported = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8')) as { items: { id: string; metadata: Record<string, unknown> }[] };
  const byId = new Map(exported.items.map((item) => [item.id, item.metadata]));
  assert.deepEqual(byId.get(view.id)!.savedView, { version: 1, query: 'door', filter: { project: garage.id, type: 'note' } });
  assert.deepEqual(byId.get(template.id)!.template, { version: 1, rootId: template.id });
});

test('capture rules cannot refile or retag workflow definitions and template copies', () => {
  const memory = open();
  const source = weeklyReview(memory);
  const project = memory.projects.create({ name: 'Captured notes' });
  memory.rules.create({ name: 'File every capture', conditions: { types: ['note'] }, actions: { project: project.id, tags: ['captured'] } });
  const template = memory.templates.create(source.root);
  const copy = memory.templates.instantiate(template.id, { title: 'Review {{date}} for {{project}}', date: '2026-10-17' });
  assert.equal(copy.title, 'Review 2026-10-17 for Inbox');
  for (const item of [template, ...children(memory, template.id), copy, ...children(memory, copy.id)]) {
    assert.equal(item.project, null);
    assert.equal(item.tags.includes('captured'), false);
  }
  const view = memory.views.create({ name: 'Notes' });
  assert.equal(memory.items.get(view.id).project, null);
  assert.deepEqual(memory.items.get(view.id).tags, []);
  assert.equal(memory.items.saveNote({ body: 'A normal capture still runs rules.' }).project?.id, project.id);
});

test('checkbox reset preserves fenced and indented code while resetting nested tasks', () => {
  const memory = open();
  const markdown = [
    'Code example:', '', '    - [x] indented literal', '',
    '- [x] root task', '    - [X] nested task', '        - [x] deeper task', '',
    '- code example', '', '      - [x] list-indented literal', '',
    '- ```markdown', '  - [x] fenced inside a list', '  ```', '',
    '```text', '```not-a-closing-fence', '- [x] still fenced', '```', '',
    '- [x] final task',
  ].join('\n');
  const source = memory.items.saveNote({ body: markdown });
  const template = memory.templates.create(source.id);
  const copy = memory.templates.instantiate(template.id);
  for (const body of [template.body, copy.body]) {
    for (const literal of ['    - [x] indented literal', '      - [x] list-indented literal', '  - [x] fenced inside a list', '- [x] still fenced']) assert.ok(body.includes(literal), literal);
    for (const task of ['- [ ] root task', '    - [ ] nested task', '        - [ ] deeper task', '- [ ] final task']) assert.ok(body.includes(task), task);
  }
  assert.equal(memory.items.get(source.id).body, markdown);
});

test('imported view filters cannot bypass active-item visibility and unknown versions stay ordinary notes', () => {
  const memory = open();
  const malformed = memory.items.insert({ type: 'note', title: 'Imported view', metadata: {
    savedView: { version: 1, query: '', filter: { includeArchived: true } },
  } });
  assert.throws(() => memory.views.results(malformed), failsWith('invalid', /Unknown saved view filter/));
  memory.items.archive(malformed);
  const future = memory.items.insert({ type: 'note', title: 'Future view', metadata: { savedView: { version: 2, query: '', filter: {} } } });
  assert.deepEqual(memory.views.list(), []);
  assert.throws(() => memory.views.get(future), failsWith('not_found'));
  const template = memory.items.insert({ type: 'note', title: 'Future template' });
  const row = memory.items.row(template);
  memory.items.write(row, { metadata: JSON.stringify({ template: { version: 2, rootId: template } }) }, 'update');
  assert.deepEqual(memory.templates.list(), []);
  assert.throws(() => memory.templates.instantiate(template), failsWith('not_found'));
});
