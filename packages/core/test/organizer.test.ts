import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, MAX_LIMIT, MemoryError, type OrganizationPlan, type OrganizationProposal, type OrganizationScope } from '@enve-memory/core';

const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const note = (memory: EnveMemory, title: string, parentId: string | null = null, extra: { body?: string; project?: string; tags?: string[] } = {}) =>
  memory.outline.createNote({ parentId, title, ...extra }).item.id;
const children = (memory: EnveMemory, parentId: string | null) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((entry) => entry.item.id);
const parentOf = (memory: EnveMemory, id: string) => memory.outline.get(id).parentId;
const changes = (memory: EnveMemory) => memory.activity.recent({}, MAX_LIMIT).length;
const fails = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!pattern || pattern.test(error.message));
/** Every candidate straight into the destination, or into the named groups by candidate title. */
const plan = (scope: OrganizationScope, groups: OrganizationPlan['groups'] = [], into: Record<string, string> = {}): OrganizationPlan => ({
  summary: 'Grouped the notes',
  groups,
  assignments: scope.items.map((item) => ({ itemId: item.id, groupRef: into[item.title] ?? null })),
});

function garden(memory: EnveMemory) {
  memory.projects.create({ name: 'Home' });
  memory.projects.create({ name: 'Allotment' });
  const journal = note(memory, 'Journal');
  const tomatoes = note(memory, 'Tomato gardening', journal, { body: 'Stake them in June', project: 'home', tags: ['veg'] });
  const watering = note(memory, 'Watering schedule for gardening beds', tomatoes);
  const carried = note(memory, 'Seed packets', tomatoes);
  const compost = note(memory, 'Compost', null, { body: 'gardening: turn the heap monthly', project: 'allotment' });
  const recipes = note(memory, 'Recipes', null, { body: 'nothing about it' });
  return { journal, tomatoes, watering, carried, compost, recipes };
}

test('discovery finds every matching note across roots and projects, collapses nested matches and reads nothing it shouldn’t', () => {
  const memory = open();
  const { journal, tomatoes, watering, compost } = garden(memory);
  memory.views.create({ name: 'Gardening view', query: 'gardening' });
  const source = note(memory, 'Gardening checklist');
  note(memory, 'Gardening step', source);
  memory.templates.create(source, 'Gardening template');
  memory.items.archive(note(memory, 'Old gardening plan'));
  memory.tasks.create({ title: 'Buy gardening gloves' });
  memory.items.saveLink({ url: 'https://example.com/gardening', title: 'Gardening site', ingest: false });
  memory.decisions.record({ project: 'home', decision: 'Gardening on weekends only' });
  memory.vault.setup('correct horse battery staple');
  memory.vault.create({ title: 'Gardening shed code', body: 'gardening 4471' });
  const before = changes(memory);

  const scope = memory.organizer.discover('  gardening  ', 'Gardening');
  assert.equal(scope.query, 'gardening');
  assert.deepEqual(scope.destination, { id: null, title: 'Gardening' });
  const titles = scope.items.map((item) => item.title).sort();
  assert.deepEqual(titles, ['Compost', 'Gardening checklist', 'Tomato gardening'], 'views, templates, archived, tasks, links, decisions and secrets are left out');
  assert.equal(scope.items.some((item) => item.id === watering), false, 'a nested match travels with its matching parent');
  assert.equal(scope.matchedCount, 5);
  assert.equal(scope.affectedCount, 3 + 1 + 2, 'carried children count as affected');
  const tomato = scope.items.find((item) => item.id === tomatoes)!;
  assert.deepEqual([tomato.parentId, tomato.descendantCount, tomato.body], [journal, 2, 'Stake them in June']);
  assert.equal(scope.items.find((item) => item.id === compost)!.parentId, null);
  assert.equal(changes(memory), before, 'discovery only reads');
  assert.equal(memory.organizer.discover('gardening', 'Gardening').baseHash, scope.baseHash, 'the fingerprint is stable');

  const empty = memory.organizer.discover('xylophone', 'Music');
  assert.deepEqual([empty.items, empty.matchedCount, empty.affectedCount], [[], 0, 0]);
  assert.throws(() => memory.organizer.discover('!!!', 'Gardening'), fails('invalid', /at least one word/));
  assert.throws(() => memory.organizer.discover('gardening', '  '), fails('invalid', /destination name/));
});

test('too many matches or affected items are refused, never truncated', () => {
  const memory = open();
  for (let i = 0; i < 201; i++) note(memory, `Birdwatching log ${i}`);
  assert.throws(() => memory.organizer.discover('birdwatching', 'Birds'), fails('invalid', /201 notes match “birdwatching”, more than the 150/));

  const wide = open();
  const parent = note(wide, 'Beekeeping');
  for (let i = 0; i < 500; i++) note(wide, `hive ${i}`, parent);
  assert.throws(() => wide.organizer.discover('beekeeping', 'Bees'), fails('invalid', /would move 501 items/));
  for (const id of children(wide, parent)) wide.items.archive(id);
  assert.throws(() => wide.organizer.discover('beekeeping', 'Bees'), fails('invalid', /would move 501 items/), 'archived carried children still count');
});

test('a matching branch holding a secret note is refused before anything about it is shared', () => {
  const memory = open();
  memory.vault.setup('correct horse battery staple');
  const trip = note(memory, 'Hiking trip');
  memory.vault.create({ title: 'Passport number', body: 'X123', parentId: trip });
  assert.throws(() => memory.organizer.discover('hiking', 'Hiking'), fails('invalid', /“Hiking trip” holds a secret note/));
});

test('a multi-word topic narrows discovery instead of adding unrelated matches', () => {
  const memory = open();
  const wanted = note(memory, 'Gardening budget');
  note(memory, 'Household budget');
  note(memory, 'Gardening winter plan');
  assert.deepEqual(memory.organizer.discover('gardening budget', 'Garden finances').items.map((item) => item.id), [wanted]);
  memory.close();
});

test('an existing top-level destination is reused case-insensitively, keeps its text and can have its own matches regrouped', () => {
  const memory = open();
  const { tomatoes, compost } = garden(memory);
  const home = note(memory, 'GARDENING', null, { body: 'My garden overview' });
  const inside = note(memory, 'Gardening tools', home);
  const filed = note(memory, 'Gardening', note(memory, 'Archive'));

  const scope = memory.organizer.discover('gardening', 'gardening');
  assert.deepEqual(scope.destination, { id: home, title: 'GARDENING' });
  assert.deepEqual(new Set(scope.items.map((item) => item.id)), new Set([tomatoes, compost, inside, filed]), 'only a top-level note is a destination, and never a candidate');
  const proposal = memory.organizer.prepare(scope, plan(scope));
  assert.deepEqual(proposal.destination, { id: home, title: 'GARDENING', create: false });
  memory.organizer.apply(proposal);
  assert.equal(memory.items.get(home).body, 'My garden overview');
  assert.deepEqual(new Set(children(memory, home)), new Set([tomatoes, compost, inside, filed]));

  note(memory, 'Gardening');
  assert.throws(() => memory.organizer.discover('gardening', 'Gardening'), fails('invalid', /2 top-level notes are called “Gardening”/));
});

test('plans must place every candidate once, into groups that exist and don’t loop', () => {
  const memory = open();
  garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const [first] = scope.items;
  const groups = [{ ref: 'a', title: 'Areas', parentRef: null }];
  const assignments = scope.items.map((item) => ({ itemId: item.id, groupRef: 'a' }));
  const bad: [unknown, RegExp][] = [
    [{ summary: '', groups, assignments: assignments.slice(1) }, /leaves out 1/],
    [{ summary: '', groups, assignments: [...assignments, { itemId: first!.id, groupRef: null }] }, /placed twice/],
    [{ summary: '', groups, assignments: [...assignments, { itemId: 'someone-else', groupRef: null }] }, /isn’t one of the notes found/],
    [{ summary: '', groups, assignments: assignments.map((a) => ({ ...a, groupRef: 'missing' })) }, /group that isn’t in the plan/],
    [{ summary: '', groups: [{ ref: 'a', title: 'A', parentRef: 'b' }, { ref: 'b', title: 'B', parentRef: 'a' }], assignments }, /nested under itself/],
    [{ summary: '', groups: [{ ref: 'a', title: 'A', parentRef: 'z' }], assignments }, /isn’t in the plan/],
    [{ summary: '', groups: [...groups, { ref: 'a', title: 'Again', parentRef: null }], assignments }, /share the ref/],
    [{ summary: '', groups: [{ ref: 'a', title: '  ', parentRef: null }], assignments }, /can’t be empty/],
    [{ summary: '', groups: Array.from({ length: 41 }, (_, i) => ({ ref: `g${i}`, title: `G${i}`, parentRef: null })), assignments }, /at most 40/],
    [{ summary: '' }, /needs groups and assignments/],
  ];
  for (const [candidate, pattern] of bad) {
    assert.throws(() => memory.organizer.prepare(scope, candidate as OrganizationPlan), fails('invalid', pattern), pattern.source);
  }

  const before = changes(memory);
  const nested = memory.organizer.prepare(scope, {
    summary: 'PARA',
    groups: [{ ref: 'p', title: 'Tomatoes', parentRef: 'r' }, { ref: 'r', title: 'Resources', parentRef: null }],
    assignments: assignments.map((a) => ({ ...a, groupRef: 'p' })),
  });
  assert.deepEqual(nested.groups.map((g) => g.title), ['Resources', 'Tomatoes'], 'parents come before children');
  assert.equal(nested.groups[1]!.parentId, nested.groups[0]!.id);
  assert.equal(nested.groups[0]!.parentId, nested.destination.id);
  assert.equal(changes(memory), before, 'preparing only reads');
  assert.throws(() => memory.items.get(nested.destination.id), fails('not_found'));
});

test('apply moves whole branches into new headings without touching text, projects, tags or files, and rules leave headings alone', () => {
  const memory = EnveMemory.open({ home: mkdtempSync(join(tmpdir(), 'enve-memory-organizer-')), actor: 'test' });
  const { journal, tomatoes, watering, carried, compost } = garden(memory);
  const file = memory.files.save({ data: new TextEncoder().encode('planting map'), filename: 'map.txt' }).item;
  memory.outline.move(file.id, { parentId: tomatoes });
  memory.rules.create({ name: 'Projects get filed', conditions: { keywords: ['projects', 'gardening'] }, actions: { tags: ['filed'], project: 'home' } });
  const before = new Map([tomatoes, watering, carried, compost, file.id].map((id) => [id, memory.items.get(id)]));

  const scope = memory.organizer.discover('gardening', 'Gardening');
  const proposal = memory.organizer.prepare(scope, plan(scope, [
    { ref: 'projects', title: 'Projects', parentRef: null },
    { ref: 'areas', title: 'Areas', parentRef: null },
    { ref: 'archive', title: 'Archive', parentRef: null },
  ], { 'Tomato gardening': 'projects', Compost: 'areas' }));
  const result = memory.organizer.apply(proposal);

  assert.equal(result.rootId, proposal.destination.id);
  assert.equal(result.moved, 2);
  const destination = memory.items.get(result.rootId);
  assert.deepEqual([destination.title, parentOf(memory, result.rootId)], ['Gardening', null]);
  const [projects, areas, archive] = proposal.groups.map((g) => g.id);
  assert.deepEqual(children(memory, result.rootId), [projects, areas, archive], 'group order is plan order, empty planned groups kept');
  assert.deepEqual(children(memory, projects!), [tomatoes]);
  assert.deepEqual(children(memory, areas!), [compost]);
  assert.deepEqual(children(memory, tomatoes), [watering, carried, file.id], 'the branch moves intact');
  assert.deepEqual(children(memory, journal), []);
  for (const id of [projects!, areas!, archive!, result.rootId]) {
    const heading = memory.items.get(id);
    assert.deepEqual([heading.tags, heading.project], [[], null], 'capture rules don’t file organizing headings');
  }
  assert.equal(memory.presentation.get(projects!).kind, 'heading');
  for (const [id, was] of before) {
    const now = memory.items.get(id);
    assert.deepEqual([now.title, now.body, now.tags, now.project?.id, now.attachments.map((a) => a.sha256)], [was.title, was.body, was.tags, was.project?.id, was.attachments.map((a) => a.sha256)]);
  }
  assert.equal(memory.files.read(file.id).data.toString(), 'planting map');

  const plain = memory.editor.apply([{ op: 'create', parentId: null, title: 'Projects inbox' }]);
  assert.deepEqual(memory.items.get(plain.createdIds[0]!).tags, ['filed'], 'ordinary editor creates still run capture rules');
  memory.close();
});

test('a plan goes stale when a matching note changes or a new one appears, and a failed apply changes nothing', () => {
  const memory = open();
  const { tomatoes, compost } = garden(memory);
  const fresh = () => {
    const scope = memory.organizer.discover('gardening', 'Gardening');
    return memory.organizer.prepare(scope, plan(scope));
  };

  const edited = fresh();
  memory.items.update(note(memory, 'Child added', tomatoes), { body: 'later' });
  assert.throws(() => memory.organizer.apply(edited), fails('conflict', /changed since the proposal/));

  const added = fresh();
  note(memory, 'Gardening in winter');
  assert.throws(() => memory.organizer.apply(added), fails('conflict'));

  const competing = fresh();
  note(memory, 'gardening');
  assert.throws(() => memory.organizer.apply(competing), fails('conflict'), 'a destination created meanwhile');

  const scope = memory.organizer.discover('gardening', 'Gardening (2)');
  assert.throws(() => memory.organizer.prepare({ ...scope, baseHash: 'old' }, plan(scope)), fails('conflict'));
  const proposal = memory.organizer.prepare(scope, plan(scope));
  const before = changes(memory);
  const forged: OrganizationProposal = { ...proposal, groups: [{ id: compost, title: 'Hijack', parentId: proposal.destination.id }] };
  assert.throws(() => memory.organizer.apply(forged), fails('conflict', /already exists/));
  assert.throws(() => memory.organizer.apply({ ...proposal, assignments: proposal.assignments.slice(1) }), fails('conflict'));
  assert.throws(() => memory.organizer.apply({ ...proposal, assignments: [...proposal.assignments, { itemId: tomatoes, parentId: proposal.destination.id }] }), fails('invalid', /only once/));
  assert.throws(() => memory.organizer.apply({ ...proposal, id: 'not-a-uuid' }), fails('invalid'));
  assert.throws(() => memory.organizer.apply(proposal, []), fails('invalid', /at least one/));
  assert.throws(() => memory.organizer.apply(proposal, [note(memory, 'unrelated')]), fails('invalid', /Only notes in this proposal/));
  assert.equal(changes(memory), before + 1, 'only the unrelated note was written');
  assert.throws(() => memory.items.get(proposal.destination.id), fails('not_found'));
});

test('a selected subset moves alone, retries replay, and undo restores exactly unless newer work is in the way', () => {
  const memory = open();
  const { tomatoes, compost } = garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const proposal = memory.organizer.prepare(scope, plan(scope, [
    { ref: 'veg', title: 'Vegetables', parentRef: null },
    { ref: 'soil', title: 'Soil', parentRef: null },
  ], { 'Tomato gardening': 'veg', Compost: 'soil' }));

  const result = memory.organizer.apply(proposal, [tomatoes]);
  assert.equal(result.moved, 1);
  const [veg, soil] = proposal.groups.map((g) => g.id);
  assert.deepEqual(children(memory, result.rootId), [veg], 'a group emptied by the selection isn’t created');
  assert.throws(() => memory.items.get(soil!), fails('not_found'));
  assert.equal(parentOf(memory, compost), null, 'excluded candidates stay put');
  assert.deepEqual(memory.organizer.apply(proposal, [tomatoes]), result, 'a retry returns the first result');
  assert.deepEqual(children(memory, veg!), [tomatoes]);
  assert.throws(() => memory.organizer.apply(proposal), fails('conflict'), 'the same proposal can’t be reused for another selection');

  const later = note(memory, 'New veg idea', veg!);
  assert.throws(() => memory.organizer.undo(result.undo), fails('conflict', /displace newer work/));
  memory.items.archive(later);
  assert.throws(() => memory.organizer.undo(result.undo), fails('conflict'), 'archived additions still count as newer work');

  const second = open();
  const ids = garden(second);
  const scope2 = second.organizer.discover('gardening', 'Gardening');
  const applied = second.organizer.apply(second.organizer.prepare(scope2, plan(scope2, [{ ref: 'veg', title: 'Vegetables', parentRef: null }], { 'Tomato gardening': 'veg' })));
  second.items.update(ids.compost, { body: 'edited after organizing' });
  assert.throws(() => second.organizer.undo(applied.undo), fails('conflict'), 'an edited moved note blocks undo');

  const third = open();
  const tree = garden(third);
  const before = [tree.tomatoes, tree.compost].map((id) => [parentOf(third, id), third.outline.get(id).position]);
  const scope3 = third.organizer.discover('gardening', 'Gardening');
  const done = third.organizer.apply(third.organizer.prepare(scope3, plan(scope3, [{ ref: 'veg', title: 'Vegetables', parentRef: null }], { 'Tomato gardening': 'veg' })));
  const undone = third.organizer.undo(done.undo);
  assert.equal(undone.actionId, done.actionId);
  assert.deepEqual([tree.tomatoes, tree.compost].map((id) => [parentOf(third, id), third.outline.get(id).position]), before);
  assert.deepEqual(children(third, tree.tomatoes), [tree.watering, tree.carried]);
  assert.ok(third.items.get(done.rootId).archivedAt, 'the created destination is archived, not deleted');
  assert.deepEqual(third.organizer.undo(done.undo), undone, 'undo is safe to retry');
  assert.throws(() => third.organizer.apply(third.organizer.prepare(scope3, plan(scope3))), fails('conflict'), 'the old scope is stale after undo');
  assert.throws(() => third.organizer.undo({ ...done.undo, actionId: '0190a0a0-0000-7000-8000-000000000000' }), fails('not_found'));
});

test('apply replays retain the original receipt, and receipts cannot be rebound to another destination', () => {
  const memory = open();
  garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const proposal = memory.organizer.prepare(scope, plan(scope));
  const result = memory.organizer.apply(proposal);
  note(memory, 'New idea', result.rootId);
  const revision = memory.feed.revision;
  assert.deepEqual(memory.organizer.apply(proposal), result);
  assert.equal(memory.feed.revision, revision);
  assert.throws(() => memory.organizer.undo(result.undo), fails('conflict', /newer work/));
  assert.throws(() => memory.organizer.undo({ ...result.undo, rootId: note(memory, 'Unrelated') }), fails('invalid', /does not belong/));
  assert.throws(() => memory.organizer.undo({ ...result.undo, afterHash: 'forged' }), fails('invalid', /does not belong/));
  assert.equal(memory.items.get(result.rootId).archivedAt, null);
  memory.close();
});

test('opening reviewed notes and the result does not invalidate apply or undo', () => {
  const memory = open();
  const { tomatoes, watering } = garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const proposal = memory.organizer.prepare(scope, plan(scope));
  memory.items.markOpened(tomatoes);
  const result = memory.organizer.apply(proposal);
  memory.items.markOpened(result.rootId);
  memory.items.markOpened(watering);
  memory.organizer.undo(result.undo);
  assert.ok(memory.items.get(result.rootId).archivedAt);
  memory.close();
});

test('selective apply retains ancestors needed by intentionally empty groups', () => {
  const memory = open();
  const { journal, tomatoes, compost } = garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const proposal = memory.organizer.prepare(scope, plan(scope, [
    { ref: 'veg', title: 'Vegetables', parentRef: null },
    { ref: 'later', title: 'Later', parentRef: 'veg' },
    { ref: 'soil', title: 'Soil', parentRef: null },
  ], { 'Tomato gardening': 'veg', Compost: 'soil' }));
  memory.organizer.apply(proposal, [compost]);
  assert.equal(parentOf(memory, tomatoes), journal);
  assert.equal(parentOf(memory, proposal.groups[1]!.id), proposal.groups[0]!.id);
  assert.equal(parentOf(memory, compost), proposal.groups[2]!.id);
  memory.close();
});

test('undo cannot restore notes beneath a source parent that has since been archived', () => {
  const memory = open();
  const { journal, tomatoes } = garden(memory);
  const scope = memory.organizer.discover('gardening', 'Gardening');
  const result = memory.organizer.apply(memory.organizer.prepare(scope, plan(scope)));
  memory.items.archive(journal);
  const revision = memory.feed.revision;
  assert.throws(() => memory.organizer.undo(result.undo), fails('conflict', /earlier place/));
  assert.equal(memory.feed.revision, revision, 'a refused undo rolls back its whole batch');
  assert.equal(parentOf(memory, tomatoes), result.rootId);
  assert.equal(memory.items.get(result.rootId).archivedAt, null);
  memory.close();
});

test('editor retries bind the capture-rule behavior while preserving the default replay path', () => {
  const memory = open();
  const commands = [{ op: 'create' as const, parentId: null, title: 'Organizing heading' }];
  const plain = memory.editor.apply(commands);
  assert.deepEqual(memory.editor.apply(commands, { id: plain.actionId, automations: true }), plain);
  assert.throws(() => memory.editor.apply(commands, { id: plain.actionId, automations: false }), fails('conflict'));
  const quiet = memory.editor.apply(commands, { automations: false });
  assert.deepEqual(memory.editor.apply(commands, { id: quiet.actionId, automations: false }), quiet);
  assert.throws(() => memory.editor.apply(commands, { id: quiet.actionId }), fails('conflict'));
  memory.close();
});
