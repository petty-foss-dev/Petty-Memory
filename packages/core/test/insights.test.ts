import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, type ItemInsights, MAX_LIMIT, MemoryError, type MergeProposal } from '@enve-memory/core';

const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const note = (memory: EnveMemory, title: string, body = '', parentId: string | null = null) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const fails = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!pattern || pattern.test(error.message));
const changes = (memory: EnveMemory) => memory.activity.recent({}, MAX_LIMIT).length;
const children = (memory: EnveMemory, parentId: string | null) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((entry) => entry.item.id);
const ids = (insights: ItemInsights) => ({
  mentions: insights.mentions.map((s) => s.id), related: insights.related.map((s) => s.id), duplicates: insights.duplicates.map((s) => s.id),
});
const suggested = (insights: ItemInsights) => new Set([...insights.mentions, ...insights.related, ...insights.duplicates].map((s) => s.id));

test('unlinked mentions are found either way, quoted from the original text, and linked items are left out', () => {
  const memory = open();
  const opener = note(memory, 'Chamberlain B970', 'Garage door opener. Wired to the Café Lights relay.');
  const lights = note(memory, 'Café lights', 'String lights over the patio');
  const mentioning = note(memory, 'Shopping', 'Batteries for the CHAMBERLAIN b970 remote, and again: chamberlain-b970!');
  const related = note(memory, 'Remote', 'The chamberlain b970 remote needs a battery');
  memory.items.relate(related, opener, 'related_to');
  const referencing = note(memory, 'Index', 'See the Chamberlain B970 notes');
  memory.references.insert(referencing, opener);
  note(memory, 'Unrelated', 'Tomatoes in June');
  const before = changes(memory);

  const insights = memory.insights.forItem(opener);
  assert.equal(changes(memory), before, 'insights only read');
  assert.equal(insights.itemId, opener);
  assert.deepEqual(ids(insights).mentions, [mentioning, lights], 'two mentions outrank one; accents and case are ignored');
  const [incoming, outgoing] = insights.mentions;
  assert.equal(incoming!.reason, 'Mentions “Chamberlain B970” without a link');
  assert.equal(incoming!.score, 0.667);
  assert.match(incoming!.snippet, /CHAMBERLAIN b970 remote/, 'the snippet quotes the original wording');
  assert.equal(outgoing!.reason, 'This note mentions “Café lights” without a link');
  assert.match(outgoing!.snippet, /Café Lights relay/);
  assert.equal(suggested(insights).has(related), false, 'explicitly connected');
  assert.equal(suggested(insights).has(referencing), false, 'already referenced');
  assert.equal(suggested(insights).has(opener), false);
  assert.deepEqual(memory.insights.forItem(opener), insights, 'deterministic');

  memory.items.relate(opener, mentioning, 'related_to');
  assert.equal(ids(memory.insights.forItem(opener)).mentions.includes(mentioning), false, 'accepting a connection removes the suggestion');
});

test('trivial titles are never matched as mentions', () => {
  const memory = open();
  for (const title of ['Notes', 'The', 'Ideas', '2026', 'Car', 'To do list']) {
    const subject = note(memory, title, 'Something to say');
    const other = note(memory, `Other ${title}`, `I wrote ${title} here and ${title} again`);
    const insights = memory.insights.forItem(subject);
    assert.equal(insights.mentions.some((s) => s.id === other), false, `“${title}” is too generic to match`);
    memory.items.archive(subject);
    memory.items.archive(other);
  }
});

test('related suggestions need meaningful shared words, and scores are finite, bounded and ranked', () => {
  const memory = open();
  const subject = note(memory, 'Tomato planting', 'Plant tomatoes in raised beds with compost and stake the seedlings.');
  const close = note(memory, 'Bed preparation', 'Fill the raised beds with compost before planting tomatoes.');
  const loose = note(memory, 'Compost heap', 'Turn the compost heap monthly; add leaves.');
  const unrelated = note(memory, 'Opener wiring', 'Terminals 1 and 2 on the garage door opener.');
  note(memory, 'Stopwords only', 'the and of with in for');
  const insights = memory.insights.forItem(subject);
  assert.equal(insights.related[0]!.id, close);
  assert.match(insights.related[0]!.reason, /^Shares “.+”, “.+”/);
  assert.equal(suggested(insights).has(unrelated), false, 'nothing in common, nothing suggested');
  for (const suggestion of insights.related) {
    assert.ok(Number.isFinite(suggestion.score) && suggestion.score > 0 && suggestion.score <= 1);
  }
  const scores = insights.related.map((s) => s.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  if (insights.related.some((s) => s.id === loose)) assert.ok(insights.related.find((s) => s.id === loose)!.score < insights.related[0]!.score);

  const lonely = open();
  const only = note(lonely, 'Tomato planting', 'Plant tomatoes');
  assert.deepEqual(lonely.insights.forItem(only), { itemId: only, mentions: [], related: [], duplicates: [], scanned: 0, total: 0 });
});

test('near-duplicate notes are reported once, not as related, with the reason', () => {
  const memory = open();
  const subject = note(memory, 'Groceries', 'Milk, eggs, bread, butter, apples and coffee for the week');
  const copy = note(memory, 'Groceries', 'Milk, eggs, bread, butter, apples and coffee for the weekend');
  const reworded = note(memory, 'Weekly shop', 'Milk eggs bread butter apples and coffee for the week');
  const different = note(memory, 'Groceries', 'Charcoal and lighter fluid');
  const insights = memory.insights.forItem(subject);
  assert.deepEqual(ids(insights).duplicates.sort(), [copy, reworded].sort());
  const same = insights.duplicates.find((s) => s.id === copy)!;
  assert.match(same.reason, /^Same title and \d+% of the same wording$/);
  assert.ok(same.score >= 0.6 && same.score <= 1);
  assert.equal(insights.related.some((s) => s.id === copy || s.id === reworded), false);
  assert.equal(insights.duplicates.some((s) => s.id === different), false, 'a shared title alone isn’t a duplicate');
  const link = memory.items.saveLink({ url: 'https://example.com/groceries', title: 'Groceries', note: 'Milk, eggs, bread, butter, apples and coffee for the week', ingest: false });
  assert.equal(memory.insights.forItem(subject).duplicates.some((s) => s.id === link.item.id), false, 'only notes are duplicates of a note');
});

test('private and definition items are never read as candidates, and the subject must be ordinary', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const subject = note(memory, 'Chamberlain opener', 'Garage door opener wiring');
  const visible = note(memory, 'Visible', 'The chamberlain opener wiring diagram for the garage door');
  memory.items.archive(note(memory, 'Archived', 'The chamberlain opener wiring diagram for the garage door'));
  const decision = memory.decisions.record({ project: 'garage', decision: 'Keep the chamberlain opener', reason: 'garage door opener wiring' }).id;
  const view = memory.views.create({ name: 'Chamberlain opener view', query: 'chamberlain opener' }).id;
  const source = note(memory, 'Chamberlain opener checklist', 'garage door opener wiring');
  const template = memory.templates.create(source, 'Chamberlain opener template').id;
  note(memory, 'Step', 'The chamberlain opener wiring for the garage door', template);
  memory.items.archive(source);
  const chat = memory.chats.save({ mode: 'ask', messages: [{ role: 'user', content: 'The chamberlain opener garage door wiring?' }] }).id;
  memory.vault.setup('correct horse battery staple');
  const secret = memory.vault.create({ title: 'Chamberlain opener code', body: 'chamberlain opener garage door wiring 4471' }).id;
  const task = memory.tasks.create({ title: 'Fix the chamberlain opener wiring', notes: 'garage door' }).id;

  const insights = memory.insights.forItem(subject);
  assert.deepEqual(insights.total, 2, 'only the visible note and the task are candidates');
  assert.equal(insights.scanned, 2);
  assert.ok(suggested(insights).has(visible));
  for (const hidden of [decision, view, template, chat, secret]) assert.equal(suggested(insights).has(hidden), false);
  assert.ok(suggested(insights).has(task), 'tasks are ordinary items');

  for (const id of [decision, view, template, chat, secret, source]) assert.throws(() => memory.insights.forItem(id), fails('invalid'));
  assert.throws(() => memory.insights.forItem('0190f1f2-0000-7000-8000-000000000000'), fails('not_found'));
});

test('discovery is bounded, and says how much it compared', () => {
  const memory = open();
  const subject = note(memory, 'Beekeeping', 'Hive inspections');
  for (let i = 0; i < 1005; i++) memory.items.saveNote({ title: `Hive log ${i}`, body: 'Checked the frames' });
  const insights = memory.insights.forItem(subject);
  assert.deepEqual([insights.scanned, insights.total], [1000, 1005]);
  assert.ok(insights.related.length <= 10 && insights.mentions.length <= 10 && insights.duplicates.length <= 10);
});

function mergeFixture(memory: EnveMemory) {
  const parent = note(memory, 'Kitchen');
  const target = note(memory, 'Groceries', 'Milk and eggs', parent);
  const between = note(memory, 'Recipes', 'Pancakes', parent);
  const source = note(memory, 'groceries', 'Bread and butter', parent);
  const first = note(memory, 'Bakery', 'Sourdough', source);
  const second = note(memory, 'Dairy', 'Butter', source);
  return { parent, target, between, source, first, second };
}

test('a merge preview is read-only and shows the merged note without repeating a shared title', () => {
  const memory = open();
  const { target, source } = mergeFixture(memory);
  const before = changes(memory);
  const proposal = memory.insights.previewMerge(source, target);
  assert.equal(changes(memory), before);
  assert.deepEqual({ ...proposal, baseHash: typeof proposal.baseHash }, {
    sourceId: source, targetId: target, baseHash: 'string', sourceTitle: 'groceries', targetTitle: 'Groceries',
    preview: { title: 'Groceries', body: 'Milk and eggs\n\nBread and butter', movedChildren: 2, retainedAttachments: 0 },
  });
  assert.equal(memory.insights.previewMerge(source, target).baseHash, proposal.baseHash, 'stable');
  const other = note(memory, 'Pantry', 'Rice');
  assert.equal(memory.insights.previewMerge(other, target).preview.title, 'Groceries Pantry', 'different titles are both kept');
});

test('merging is one undoable editor action: children move, the source is archived and everything comes back', () => {
  const memory = open();
  const { parent, target, between, source, first, second } = mergeFixture(memory);
  memory.rules.create({ name: 'Tag captures', conditions: { types: ['note'] }, actions: { tags: ['captured'] } });
  const result = memory.insights.merge(memory.insights.previewMerge(source, target));
  assert.equal(result.focusId, target);
  const merged = memory.items.get(target);
  assert.deepEqual([merged.title, merged.body], ['Groceries', 'Milk and eggs\n\nBread and butter']);
  assert.deepEqual(merged.tags, []);
  assert.deepEqual(children(memory, target), [first, second]);
  assert.notEqual(memory.items.get(source).archivedAt, null, 'archived, not deleted');
  assert.deepEqual(children(memory, parent), [target, between]);

  memory.editor.undo(result.actionId);
  const restored = memory.items.get(target);
  assert.deepEqual([restored.title, restored.body], ['Groceries', 'Milk and eggs']);
  assert.equal(memory.items.get(source).archivedAt, null);
  assert.deepEqual(children(memory, parent), [target, between, source], 'the source returns to its place');
  assert.deepEqual(children(memory, source), [first, second]);

  memory.editor.redo(result.actionId);
  assert.deepEqual(children(memory, target), [first, second]);
  assert.equal(memory.items.get(target).title, 'Groceries');
});

test('a stale or replayed merge is refused, while opening an item is not an edit', () => {
  const memory = open();
  const { target, source, first } = mergeFixture(memory);
  const proposal = memory.insights.previewMerge(source, target);
  memory.items.markOpened(target);
  memory.items.markOpened(first);
  const fresh = memory.insights.previewMerge(source, target);
  assert.equal(fresh.baseHash, proposal.baseHash, 'opening is bookkeeping');

  memory.items.update(first, { body: 'Rye' });
  assert.throws(() => memory.insights.merge(proposal), fails('conflict', /changed since the merge was previewed/));
  const again = memory.insights.previewMerge(source, target);
  memory.items.update(target, { body: 'Milk, eggs and cheese' });
  assert.throws(() => memory.insights.merge(again), fails('conflict'));
  const forged: MergeProposal = { ...memory.insights.previewMerge(source, target), baseHash: 'f'.repeat(64) };
  assert.throws(() => memory.insights.merge(forged), fails('conflict'));
  assert.throws(() => memory.insights.merge({ sourceId: source } as never), fails('invalid', /isn’t a merge proposal/));

  const done = memory.insights.previewMerge(source, target);
  memory.insights.merge(done);
  assert.throws(() => memory.insights.merge(done), fails('invalid', /Only active, ordinary notes/), 'the archived source can’t merge twice');
  assert.equal(memory.items.get(target).body, 'Milk, eggs and cheese\n\nBread and butter');
});

test('merging refuses anything but two active ordinary notes in a valid place', () => {
  const memory = open();
  memory.projects.create({ name: 'Garage' });
  const { parent, target, source, first } = mergeFixture(memory);
  const decision = memory.decisions.record({ project: 'garage', decision: 'Keep groceries' }).id;
  const task = memory.tasks.create({ title: 'Buy groceries' }).id;
  const view = memory.views.create({ name: 'Groceries view', query: 'groceries' }).id;
  const template = memory.templates.create(note(memory, 'Shopping list', 'Milk')).id;
  const chat = memory.chats.save({ mode: 'ask', messages: [{ role: 'user', content: 'Groceries?' }] }).id;
  const link = memory.items.saveLink({ url: 'https://example.com/shop', ingest: false }).item.id;
  memory.vault.setup('correct horse battery staple');
  const secret = memory.vault.create({ title: 'Card', body: '1234' }).id;
  for (const other of [decision, task, view, template, chat, link, secret]) {
    assert.throws(() => memory.insights.previewMerge(other, target), fails('invalid', /Only active, ordinary notes/));
    assert.throws(() => memory.insights.previewMerge(source, other), fails('invalid', /Only active, ordinary notes/));
  }
  assert.throws(() => memory.insights.previewMerge(source, source), fails('invalid', /two different notes/));
  assert.throws(() => memory.insights.previewMerge(source, first), fails('invalid', /inside the note being merged/));
  assert.throws(() => memory.insights.previewMerge(parent, target), fails('invalid', /inside the note being merged/));

  const holder = note(memory, 'Holder');
  const hidden = memory.vault.create({ title: 'Inner', body: 'secret', parentId: holder }).id;
  assert.ok(hidden);
  assert.throws(() => memory.insights.previewMerge(holder, target), fails('invalid', /holds a secret note/));

  const shelf = note(memory, 'Shelf');
  const archivedParentChild = note(memory, 'Under archive', 'x', shelf);
  memory.items.archive(shelf);
  assert.throws(() => memory.insights.previewMerge(source, archivedParentChild), fails('invalid', /archived or missing note/));

  const wide = note(memory, 'Wide');
  for (let i = 0; i < 500; i++) note(memory, `leaf ${i}`, '', wide);
  assert.throws(() => memory.insights.previewMerge(wide, target), fails('invalid', /more than 500 items/));
});

test('a child can merge into its ancestor, keeping its own children', () => {
  const memory = open();
  const top = note(memory, 'Garden', 'Beds');
  const child = note(memory, 'Garden extras', 'Tools', top);
  const grandchild = note(memory, 'Trowel', '', child);
  const result = memory.insights.merge(memory.insights.previewMerge(child, top));
  assert.deepEqual([memory.items.get(top).title, memory.items.get(top).body], ['Garden Garden extras', 'Beds\n\nTools']);
  assert.deepEqual(children(memory, top), [grandchild]);
  memory.editor.undo(result.actionId);
  assert.deepEqual(children(memory, top), [child]);
  assert.deepEqual(children(memory, child), [grandchild]);
});

test('a merge keeps files on the archived source and moves file children, and survives reopening and sync', () => {
  const home = mkdtempSync(join(tmpdir(), 'petty-insights-'));
  const memory = EnveMemory.open({ home, actor: 'test' });
  const target = note(memory, 'Wiring');
  const source = note(memory, 'Wiring', 'Terminals 1 and 2');
  const photo = memory.files.save({ data: new TextEncoder().encode('fictional wiring photo'), filename: 'wiring.txt' }).item;
  memory.outline.move(photo.id, { parentId: source });
  const proposal = memory.insights.previewMerge(source, target);
  assert.equal(proposal.preview.movedChildren, 1);
  memory.insights.merge(proposal);
  memory.close();

  const reopened = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(children(reopened, target), [photo.id]);
  assert.deepEqual(reopened.items.get(photo.id).attachments.map((a) => a.sha256), photo.attachments.map((a) => a.sha256));
  assert.equal(reopened.files.read(photo.id).data.toString(), 'fictional wiring photo');
  assert.notEqual(reopened.items.get(source).archivedAt, null);

  const peer = EnveMemory.open({ home: mkdtempSync(join(tmpdir(), 'petty-insights-peer-')), actor: 'peer' });
  peer.sync.applyChanges(reopened.sync.exportChanges().records);
  assert.deepEqual([peer.items.get(target).title, peer.items.get(target).body], ['Wiring', 'Terminals 1 and 2']);
  assert.notEqual(peer.items.get(source).archivedAt, null);
  assert.deepEqual(children(peer, target), [photo.id]);
  assert.deepEqual(peer.items.get(photo.id).attachments.map((a) => a.sha256), photo.attachments.map((a) => a.sha256));
  peer.close();
  reopened.close();
});
