import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';

const open = () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  memory.settings.set('fetchLinks', false);
  return memory;
};
const failsWith = (code: MemoryError['code'], message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));
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

const STATUS = [{ name: 'Planned' }, { name: 'Building' }, { name: 'Done' }];
function garden(memory: EnveMemory) {
  const project = memory.projects.create({ name: 'Garden' });
  const collection = memory.knowledge.saveCollection({
    name: 'Garden beds',
    scope: { project: 'Garden' },
    layout: 'kanban',
    fields: [
      { name: 'Status', type: 'select', options: STATUS },
      { name: 'Cost', type: 'number' },
      { name: 'Due date', type: 'date' },
      { name: 'Ordered', type: 'checkbox' },
      { name: 'Supplier', type: 'text' },
    ],
    groupBy: 'status',
  });
  const option = (name: string) => collection.fields[0]!.options!.find((o) => o.name === name)!.id;
  return { project, collection, option };
}

test('recipes are versioned definition notes that keep their scope across partial edits', () => {
  const memory = open();
  const branch = memory.items.saveNote({ title: 'Raised beds', body: 'Build two beds.' });
  const recipe = memory.knowledge.saveRecipe({ name: 'Bed follow-up', instruction: 'Propose tasks for open work.', scope: { rootId: branch.id } });
  assert.match(recipe.id, UUID_V7);
  assert.deepEqual(recipe.scope, { rootId: branch.id, query: null, project: null });
  const stored = memory.items.get(recipe.id);
  assert.equal(stored.type, 'note');
  assert.equal(stored.title, 'Bed follow-up');
  assert.equal(stored.metadata.knowledgeDefinition, true);
  assert.deepEqual(stored.metadata.knowledge, { version: 1, kind: 'recipe', instruction: 'Propose tasks for open work.', scope: recipe.scope });

  const renamed = memory.knowledge.saveRecipe({ id: recipe.id, name: 'Weekly beds' });
  assert.equal(renamed.instruction, 'Propose tasks for open work.');
  assert.deepEqual(renamed.scope, recipe.scope);
  memory.projects.create({ name: 'Garden' });
  const topic = memory.knowledge.saveRecipe({ id: recipe.id, scope: { query: 'raised beds', project: 'Garden' } });
  assert.equal(topic.scope.rootId, null);
  assert.equal(topic.scope.project, memory.projects.resolve('Garden').id);
  assert.deepEqual(memory.knowledge.listRecipes().map((r) => r.name), ['Weekly beds']);

  memory.knowledge.archiveRecipe(recipe.id);
  assert.deepEqual(memory.knowledge.listRecipes(), []);
  assert.throws(() => memory.knowledge.getRecipe(recipe.id), failsWith('not_found'));
});

test('recipe scopes are exactly one ordinary branch or topic', () => {
  const memory = open();
  memory.projects.create({ name: 'Garden' });
  const branch = memory.items.saveNote({ body: 'Plant garlic.' });
  const decision = memory.decisions.record({ project: 'Garden', decision: 'Use cedar' });
  const sealed = memory.vault.createSealed({ id: uuidv7(), envelope: opaqueEnvelope() });
  const save = (scope: object, extra: object = {}) => memory.knowledge.saveRecipe({ name: 'R', instruction: 'Propose tasks.', scope, ...extra } as never);
  assert.throws(() => save({}), failsWith('invalid', /either one branch/));
  assert.throws(() => save({ rootId: branch.id, query: 'garlic' }), failsWith('invalid', /either one branch/));
  assert.throws(() => save({ rootId: branch.id, project: 'Garden' }), failsWith('invalid', /branch already determines/));
  assert.throws(() => save({ query: '!!!' }), failsWith('invalid', /word or number/));
  assert.throws(() => save({ rootId: decision.id }), failsWith('invalid', /decision/));
  assert.throws(() => save({ rootId: sealed.id }), failsWith('invalid', /secret/));
  assert.throws(() => save({ query: 'garlic' }, { surprise: true }), failsWith('invalid', /Unknown recipe field/));
  assert.throws(() => memory.knowledge.saveRecipe({ name: 'R', instruction: ' ', scope: { query: 'garlic' } }), failsWith('invalid', /instruction/));
  assert.throws(() => memory.knowledge.saveRecipe({ name: 'R', instruction: 'x'.repeat(4001), scope: { query: 'garlic' } }), failsWith('invalid', /longer than 4000/));
  const other = memory.knowledge.saveRecipe({ name: 'Other', instruction: 'Propose tasks.', scope: { query: 'garlic' } });
  assert.throws(() => save({ rootId: other.id }), failsWith('invalid', /definition/));
});

test('definitions damaged by another device are left out of lists and refused by id', () => {
  const memory = open();
  const good = memory.knowledge.saveRecipe({ name: 'Good', instruction: 'Propose tasks.', scope: { query: 'garden' } });
  const bad = memory.knowledge.saveRecipe({ name: 'Bad', instruction: 'Propose tasks.', scope: { query: 'garden' } });
  memory.items.setSource(bad.id, { metadata: { knowledge: { version: 1, kind: 'recipe', instruction: 42, scope: { query: 'garden' } } } });
  assert.deepEqual(memory.knowledge.listRecipes().map((r) => r.id), [good.id]);
  assert.throws(() => memory.knowledge.getRecipe(bad.id), failsWith('invalid'));
  assert.throws(() => memory.knowledge.getCollection(good.id), failsWith('not_found'));
  assert.throws(() => memory.knowledge.getRecipe(memory.items.saveNote({ body: 'plain' }).id), failsWith('not_found'));
});

test('organization preferences are explicit, optionally project-scoped and selected only where they apply', () => {
  const memory = open();
  const garden = memory.projects.create({ name: 'Garden' });
  memory.projects.create({ name: 'Taxes' });
  const global = memory.knowledge.savePreference({ instruction: 'Keep headings short and plain.' });
  const scoped = memory.knowledge.savePreference({ name: 'Seasons', instruction: 'Group garden notes by season.', project: 'Garden' });
  assert.equal(global.name, 'Keep headings short and plain.');
  assert.equal(global.project, null);
  assert.equal(scoped.project, garden.id);
  assert.equal(memory.items.get(scoped.id).project, null, 'the definition stays unfiled; its project lives in the definition');
  assert.deepEqual(memory.knowledge.listPreferences().map((p) => p.id).sort(), [global.id, scoped.id].sort());
  assert.deepEqual(memory.knowledge.listPreferences({ project: 'Taxes' }).map((p) => p.id), [global.id]);

  assert.deepEqual(memory.knowledge.selectPreferences([global.id, scoped.id], { project: garden.id }).map((p) => p.id), [global.id, scoped.id]);
  assert.deepEqual(memory.knowledge.selectPreferences([]), []);
  assert.throws(() => memory.knowledge.selectPreferences([scoped.id], { project: 'Taxes' }), failsWith('invalid', /own project/));
  assert.throws(() => memory.knowledge.selectPreferences([scoped.id]), failsWith('invalid', /own project/));
  assert.throws(() => memory.knowledge.selectPreferences([global.id, global.id]), failsWith('invalid', /different/));
  assert.throws(() => memory.knowledge.selectPreferences('nope' as never), failsWith('invalid'));

  const moved = memory.knowledge.savePreference({ id: scoped.id, project: null });
  assert.equal(moved.project, null);
  assert.equal(moved.name, 'Seasons', 'an omitted name is kept');
  assert.equal(moved.instruction, 'Group garden notes by season.');
  memory.knowledge.archivePreference(global.id);
  assert.throws(() => memory.knowledge.selectPreferences([global.id]), failsWith('not_found'));
});

test('collections validate typed fields, stable ids and keys, layouts and grouping', () => {
  const memory = open();
  const { collection } = garden(memory);
  assert.deepEqual(collection.fields.map((f) => [f.key, f.type]), [
    ['status', 'select'], ['cost', 'number'], ['due_date', 'date'], ['ordered', 'checkbox'], ['supplier', 'text'],
  ]);
  for (const field of collection.fields) assert.match(field.id, UUID_V7);
  assert.equal(collection.groupBy, collection.fields[0]!.id, 'groupBy is stored as the field id');
  assert.equal(collection.layout, 'kanban');
  assert.equal(memory.items.get(collection.id).metadata.knowledgeDefinition, true);

  const save = (input: object) => memory.knowledge.saveCollection({ name: 'C', ...input } as never);
  assert.throws(() => save({ layout: 'kanban', fields: [{ name: 'Cost', type: 'number' }] }), failsWith('invalid', /Kanban/));
  assert.throws(() => save({ fields: [{ name: 'Cost', type: 'number' }], groupBy: 'cost' }), failsWith('invalid', /select field/));
  assert.throws(() => save({ fields: [{ name: 'S', type: 'select' }] }), failsWith('invalid', /options/));
  assert.throws(() => save({ fields: [{ name: 'S', type: 'select', options: [{ name: 'A' }, { name: 'a' }] }] }), failsWith('invalid', /twice/));
  assert.throws(() => save({ fields: [{ name: 'N', type: 'number', options: [{ name: 'A' }] }] }), failsWith('invalid', /only select/));
  assert.throws(() => save({ fields: [{ name: 'N', type: 'money' }] }), failsWith('invalid', /field type/));
  assert.throws(() => save({ fields: Array.from({ length: 21 }, (_, i) => ({ name: `F${i}`, type: 'text' })) }), failsWith('invalid', /at most 20/));
  assert.throws(() => save({ fields: [{ name: 'A', type: 'text', key: 'same' }, { name: 'B', type: 'text', key: 'same' }] }), failsWith('invalid', /key "same"/));
  assert.throws(() => save({ fields: [{ name: 'A', type: 'text', key: 'Bad Key' }] }), failsWith('invalid', /lowercase/));
  assert.throws(() => save({ fields: [{ name: 'A', type: 'text', key: 'title' }] }), failsWith('invalid', /reserved/));
  assert.throws(() => save({ fields: [{ name: 'Cost', type: 'number' }], filters: [{ field: 'cost', op: 'contains', value: 'x' }] }), failsWith('invalid', /number field can be filtered/));
  assert.throws(() => save({ fields: [{ name: 'Cost', type: 'number' }], filters: [{ field: 'cost', op: 'gt', value: '5' }] }), failsWith('invalid', /finite number/));
  assert.throws(() => save({ fields: [{ name: 'Cost', type: 'number' }], filters: [{ field: 'cost', op: 'empty', value: 1 }] }), failsWith('invalid', /takes no value/));
  assert.throws(() => save({ fields: [{ name: 'Cost', type: 'number' }], sort: [{ field: 'price' }] }), failsWith('invalid', /Unknown field "price"/));
  assert.throws(() => save({ scope: { type: 'decision' } }), failsWith('invalid', /collection item type/));
  assert.throws(() => save({ layout: 'gallery' }), failsWith('invalid', /layout/));
  const derived = save({ fields: [{ name: 'Name', type: 'text' }, { name: 'name', type: 'text' }, { name: '2026 budget', type: 'number' }, { name: 'Title', type: 'text' }] });
  assert.deepEqual(derived.fields.map((f) => f.key), ['name', 'name_2', 'field_2026_budget', 'title_2']);
});

test('partial collection edits keep fields, ids and arrangement, and refuse type changes or dangling references', () => {
  const memory = open();
  const { collection } = garden(memory);
  const renamed = memory.knowledge.saveCollection({ id: collection.id, name: 'Beds board' });
  assert.equal(renamed.name, 'Beds board');
  assert.deepEqual(renamed.fields, collection.fields);
  assert.deepEqual(renamed.scope, collection.scope);
  assert.equal(renamed.groupBy, collection.groupBy);

  const [status, cost, ...rest] = collection.fields;
  const added = memory.knowledge.saveCollection({ id: collection.id, fields: [...collection.fields, { name: 'Notes', type: 'text' }] });
  assert.deepEqual(added.fields.slice(0, 5), collection.fields);
  assert.equal(added.fields[5]!.key, 'notes');
  assert.throws(() => memory.knowledge.saveCollection({ id: collection.id, fields: [{ ...cost!, type: 'text' }, status!, ...rest] }), failsWith('invalid', /type can’t change/));
  assert.throws(() => memory.knowledge.saveCollection({ id: collection.id, fields: [cost!, ...rest] }), failsWith('invalid', /Unknown field/), 'removing the groupBy field needs a new groupBy too');
  const table = memory.knowledge.saveCollection({ id: collection.id, layout: 'table', groupBy: null, fields: [cost!, ...rest], sort: [{ field: 'cost', direction: 'desc' }] });
  assert.equal(table.groupBy, null);
  assert.deepEqual(table.sort, [{ field: cost!.id, direction: 'desc' }]);
});

test('field values are typed, merged per collection and preserved through partial edits', () => {
  const memory = open();
  const { collection, option } = garden(memory);
  const other = memory.knowledge.saveCollection({ name: 'Shopping', fields: [{ name: 'Cost', type: 'number' }] });
  const bed = memory.items.saveNote({ title: 'North bed', body: 'Cedar boards.', project: 'Garden' });
  const [status, cost, due, ordered, supplier] = collection.fields;

  assert.deepEqual(memory.knowledge.setValues(bed.id, collection.id, { status: 'Planned', cost: 120.5, [due!.id]: '2026-11-01', ordered: false, supplier: '  Mill Co ' }), {
    [status!.id]: option('Planned'), [cost!.id]: 120.5, [due!.id]: '2026-11-01', [ordered!.id]: false, [supplier!.id]: 'Mill Co',
  });
  memory.knowledge.setValues(bed.id, other.id, { cost: 9 });
  const values = memory.knowledge.setValues(bed.id, collection.id, { status: option('Building'), supplier: '' });
  assert.equal(values[status!.id], option('Building'));
  assert.equal(values[cost!.id], 120.5, 'unmentioned fields are kept');
  assert.equal(values[supplier!.id], undefined, 'empty text clears');
  assert.deepEqual(memory.knowledge.getValues(bed.id, other.id), { [other.fields[0]!.id]: 9 });
  assert.equal(memory.items.get(bed.id).body, 'Cedar boards.');

  const set = (value: unknown, field = 'cost') => memory.knowledge.setValues(bed.id, collection.id, { [field]: value } as never);
  assert.throws(() => set(Number.NaN), failsWith('invalid', /finite/));
  assert.throws(() => set(Number.POSITIVE_INFINITY), failsWith('invalid', /finite/));
  assert.throws(() => set(1e16), failsWith('invalid', /finite/));
  assert.throws(() => set('12'), failsWith('invalid', /finite/));
  assert.throws(() => set('2026-02-30', 'due_date'), failsWith('invalid', /calendar date/));
  assert.throws(() => set('2026-11-01T10:00:00Z', 'due_date'), failsWith('invalid', /calendar date/));
  assert.throws(() => set('yes', 'ordered'), failsWith('invalid', /true or false/));
  assert.throws(() => set('Harvested', 'status'), failsWith('invalid', /options/));
  assert.throws(() => set('x'.repeat(2001), 'supplier'), failsWith('invalid', /longer than 2000/));
  assert.throws(() => set(1, 'colour'), failsWith('invalid', /Unknown field "colour"/));
  assert.throws(() => memory.knowledge.setValues(bed.id, collection.id, { cost: 1, [cost!.id]: 2 }), failsWith('invalid', /twice/));
  assert.throws(() => memory.knowledge.setValues(bed.id, collection.id, {}), failsWith('invalid', /at least one/));

  const withoutCost = collection.fields.filter((f) => f.id !== cost!.id);
  memory.knowledge.saveCollection({ id: collection.id, fields: withoutCost });
  assert.equal(memory.knowledge.getValues(bed.id, collection.id)[cost!.id], undefined);
  memory.knowledge.setValues(bed.id, collection.id, { status: 'Done' });
  const stored = memory.items.get(bed.id).metadata.fieldValues as Record<string, Record<string, unknown>>;
  assert.equal(stored[collection.id]![cost!.id], 120.5, 'values of a removed field are retained');
  memory.knowledge.saveCollection({ id: collection.id, fields: collection.fields });
  assert.equal(memory.knowledge.getValues(bed.id, collection.id)[cost!.id], 120.5, 'and return with the field');

  memory.knowledge.setValues(bed.id, other.id, { cost: null });
  assert.deepEqual(Object.keys(memory.items.get(bed.id).metadata.fieldValues as object), [collection.id]);
});

test('only ordinary items take field values', () => {
  const memory = open();
  const { collection } = garden(memory);
  const decision = memory.decisions.record({ project: 'Garden', decision: 'Use cedar' });
  const sealed = memory.vault.createSealed({ id: uuidv7(), envelope: opaqueEnvelope() });
  const archived = memory.items.saveNote({ body: 'Old bed' });
  memory.items.archive(archived.id);
  const source = memory.outline.createNote({ parentId: null, title: 'Bed checklist' }).item;
  const template = memory.templates.create(source.id);
  const inside = memory.outline.createNote({ parentId: template.id, title: 'Added under the template' }).item;
  const chat = memory.chats.save({ mode: 'ask', messages: [{ role: 'user', content: 'Which bed first?' }] });
  const recipe = memory.knowledge.saveRecipe({ name: 'R', instruction: 'Propose tasks.', scope: { query: 'bed' } });
  const set = (id: string) => memory.knowledge.setValues(id, collection.id, { cost: 1 });
  assert.throws(() => set(decision.id), failsWith('invalid', /decision/));
  assert.throws(() => set(sealed.id), failsWith('invalid', /secret/));
  assert.throws(() => set(archived.id), failsWith('invalid', /archived/));
  assert.throws(() => set(template.id), failsWith('invalid', /template/));
  assert.throws(() => set(inside.id), failsWith('invalid', /template/));
  assert.throws(() => set(chat.id), failsWith('invalid', /definition or chat/));
  assert.throws(() => set(recipe.id), failsWith('invalid', /definition/));
  assert.throws(() => set(collection.id), failsWith('invalid', /definition/));
  assert.throws(() => memory.knowledge.getValues(sealed.id, collection.id), failsWith('invalid', /secret/));
  assert.throws(() => set(uuidv7()), failsWith('not_found'));
});

test('collection rows filter, sort, group and page ordinary scope items with explicit counts', () => {
  const memory = open();
  const { collection, option } = garden(memory);
  const [status, cost, due] = collection.fields;
  const add = (title: string, values: Record<string, unknown>) => {
    const id = memory.items.saveNote({ title, body: `${title} notes`, project: 'Garden' }).id;
    if (Object.keys(values).length) memory.knowledge.setValues(id, collection.id, values as never);
    return id;
  };
  const north = add('North', { status: 'Planned', cost: 120, due_date: '2026-11-01' });
  const south = add('South', { status: 'Building', cost: 40 });
  const east = add('East', { status: 'Planned', cost: 300, due_date: '2026-10-20' });
  const west = add('West', {});
  memory.items.saveNote({ title: 'Elsewhere', body: 'Not in the garden project' });
  memory.decisions.record({ project: 'Garden', decision: 'Use cedar boards' });
  memory.vault.createSealed({ id: uuidv7(), envelope: opaqueEnvelope(), project: 'Garden' });
  memory.chats.save({ mode: 'ask', project: 'Garden', messages: [{ role: 'user', content: 'Bed order?' }] });
  const archived = add('Archived', { cost: 999 });
  memory.items.archive(archived);

  const all = memory.knowledge.collectionRows(collection.id);
  assert.deepEqual(new Set(all.rows.map((r) => r.item.id)), new Set([north, south, east, west]), 'decisions, secrets, chats, archived and other projects are left out');
  assert.equal(all.matched, 4);
  assert.equal(all.evaluated, 4);
  assert.equal(all.capped, false);
  assert.deepEqual(all.groups, [
    { option: option('Planned'), name: 'Planned', count: 2 },
    { option: option('Building'), name: 'Building', count: 1 },
    { option: option('Done'), name: 'Done', count: 0 },
    { option: null, name: 'No Status', count: 1 },
  ]);
  assert.deepEqual(memory.knowledge.collectionRows(collection.id, { group: option('Planned') }).rows.map((r) => r.item.id).sort(), [north, east].sort());
  assert.deepEqual(memory.knowledge.collectionRows(collection.id, { group: null }).rows.map((r) => r.item.id), [west]);
  assert.throws(() => memory.knowledge.collectionRows(collection.id, { group: 'Planned' }), failsWith('invalid', /group must be/));

  memory.knowledge.saveCollection({ id: collection.id, sort: [{ field: 'cost', direction: 'desc' }] });
  assert.deepEqual(memory.knowledge.collectionRows(collection.id).rows.map((r) => r.item.id), [east, north, south, west], 'rows without a value sort last');
  memory.knowledge.saveCollection({ id: collection.id, sort: [{ field: 'status' }, { field: 'title', direction: 'asc' }] });
  assert.deepEqual(memory.knowledge.collectionRows(collection.id).rows.map((r) => r.item.id), [east, north, south, west], 'select sorts by option order');

  memory.knowledge.saveCollection({ id: collection.id, filters: [{ field: 'cost', op: 'gte', value: 100 }, { field: due!.id, op: 'lt', value: '2026-11-01' }] });
  const filtered = memory.knowledge.collectionRows(collection.id);
  assert.deepEqual(filtered.rows.map((r) => r.item.id), [east]);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.matched, 4, 'matched counts the scope before filters');
  assert.deepEqual(filtered.rows[0]!.values, { [status!.id]: option('Planned'), [cost!.id]: 300, [due!.id]: '2026-10-20' });
  memory.knowledge.saveCollection({ id: collection.id, filters: [{ field: 'status', op: 'notEquals', value: 'Planned' }] });
  assert.deepEqual(memory.knowledge.collectionRows(collection.id).rows.map((r) => r.item.id), [south, west], 'notEquals includes rows without a value');
  memory.knowledge.saveCollection({ id: collection.id, filters: [{ field: 'ordered', op: 'equals', value: false }] });
  assert.equal(memory.knowledge.collectionRows(collection.id).total, 4, 'an unset checkbox counts as unchecked');

  memory.knowledge.saveCollection({ id: collection.id, filters: [] });
  const first = memory.knowledge.collectionRows(collection.id, { limit: 3 });
  assert.equal(first.rows.length, 3);
  assert.equal(first.next, 3);
  const second = memory.knowledge.collectionRows(collection.id, { limit: 3, offset: first.next! });
  assert.deepEqual(second.rows.map((r) => r.item.id), [west]);
  assert.equal(second.next, null);
  assert.throws(() => memory.knowledge.collectionRows(collection.id, { offset: -1 }), failsWith('invalid', /offset/));
  assert.throws(() => memory.knowledge.collectionRows(collection.id, { limit: 0 }), failsWith('invalid', /Limit/));
  assert.throws(() => memory.knowledge.collectionRows(collection.id, { page: 2 } as never), failsWith('invalid', /Unknown rows request field/));
});

test('collection rows leave out definitions and template notes and say when the scope was capped', () => {
  const memory = open();
  const collection = memory.knowledge.saveCollection({ name: 'Bulk compost log', scope: { query: 'compost', type: 'note' }, fields: [{ name: 'Weight', type: 'number' }] });
  memory.knowledge.saveRecipe({ name: 'Compost recipe', instruction: 'Propose compost tasks.', scope: { query: 'compost' } });
  memory.knowledge.savePreference({ name: 'Compost preference', instruction: 'File compost notes under Soil.' });
  const template = memory.templates.create(memory.outline.createNote({ parentId: null, title: 'Compost checklist' }).item.id);
  memory.outline.createNote({ parentId: template.id, title: 'Turn the compost' });
  memory.tasks.create({ title: 'Buy compost bin' });
  for (let index = 0; index < 1005; index++) memory.items.saveNote({ title: `Compost ${index}`, body: 'Compost log entry.' });
  const page = memory.knowledge.collectionRows(collection.id, { limit: 5 });
  assert.equal(page.matched, 1006, 'the source notes, including the template’s source note, but no definitions, template copies or tasks');
  assert.equal(page.evaluated, 1000);
  assert.equal(page.capped, true);
  assert.equal(page.total, 1000);
  assert.equal(page.rows.length, 5);
  assert.equal(page.groups, null);
  assert.ok(page.rows.every((row) => row.item.metadata.knowledgeDefinition === undefined && row.item.metadata.template === undefined));
});

test('stored values that no longer fit their field are left out, and task fields come with rows', () => {
  const memory = open();
  const { collection, option } = garden(memory);
  const [status, cost] = collection.fields;
  const task = memory.tasks.create({ title: 'Order boards', project: 'Garden', priority: 'high' });
  memory.knowledge.setValues(task.id, collection.id, { status: 'Done', cost: 80 });
  memory.items.setSource(task.id, { metadata: { fieldValues: { [collection.id]: { [status!.id]: 'not-an-option', [cost!.id]: 'eighty' } } } });
  assert.deepEqual(memory.knowledge.getValues(task.id, collection.id), {});
  const [row] = memory.knowledge.collectionRows(collection.id).rows;
  assert.equal(row!.item.task?.priority, 'high');
  assert.deepEqual(row!.values, {});
  memory.items.setSource(task.id, { metadata: { fieldValues: 'garbage' } });
  assert.deepEqual(memory.knowledge.setValues(task.id, collection.id, { status: 'Done' }), { [status!.id]: option('Done') });
});

test('definitions and field values round trip through sync and export, with history', () => {
  const a = open();
  const b = open();
  const { collection } = garden(a);
  const recipe = a.knowledge.saveRecipe({ name: 'Bed follow-up', instruction: 'Propose tasks.', scope: { query: 'bed', project: 'Garden' } });
  const preference = a.knowledge.savePreference({ instruction: 'Group by season.', project: 'Garden' });
  const bed = a.items.saveNote({ title: 'North bed', body: 'Raised garden bed.', project: 'Garden' });
  a.knowledge.setValues(bed.id, collection.id, { status: 'Building', cost: 75, ordered: true });

  b.sync.applyChanges(a.sync.exportChanges().records);
  assert.deepEqual(b.knowledge.getCollection(collection.id), a.knowledge.getCollection(collection.id));
  assert.deepEqual(b.knowledge.getRecipe(recipe.id), a.knowledge.getRecipe(recipe.id));
  assert.deepEqual(b.knowledge.getPreference(preference.id), a.knowledge.getPreference(preference.id));
  assert.deepEqual(b.knowledge.getValues(bed.id, collection.id), a.knowledge.getValues(bed.id, collection.id));
  assert.deepEqual(b.knowledge.collectionRows(collection.id).rows.map((r) => r.values), a.knowledge.collectionRows(collection.id).rows.map((r) => r.values));

  assert.ok(a.versions.list(bed.id).items.some((version) => version.op === 'field_values'), 'setting values records an item version');

  const out = join(mkdtempSync(join(tmpdir(), 'petty-knowledge-export-')), 'export');
  a.exports.write(out);
  const exported = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8')) as { items: { id: string; metadata: Record<string, unknown> }[] };
  const byId = new Map(exported.items.map((item) => [item.id, item.metadata]));
  assert.deepEqual(byId.get(bed.id)!.fieldValues, a.items.get(bed.id).metadata.fieldValues);
  assert.equal(byId.get(collection.id)!.knowledgeDefinition, true);
});

test('definitions are created without capture rules', () => {
  const memory = open();
  const project = memory.projects.create({ name: 'Captured' });
  memory.rules.create({ name: 'File every note', conditions: { types: ['note'] }, actions: { project: project.id, tags: ['captured'] } });
  const recipe = memory.knowledge.saveRecipe({ name: 'R', instruction: 'Propose tasks.', scope: { query: 'beds' } });
  const preference = memory.knowledge.savePreference({ instruction: 'Short headings.' });
  const collection = memory.knowledge.saveCollection({ name: 'Board' });
  for (const id of [recipe.id, preference.id, collection.id]) {
    assert.equal(memory.items.get(id).project, null);
    assert.deepEqual(memory.items.get(id).tags, []);
  }
});
