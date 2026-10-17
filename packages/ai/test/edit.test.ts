import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError, type AiProvider, type CompletionRequest, ORGANIZE_ACTOR, organizeWorker, proposeEdit } from '@enve-memory/ai';
import { EnveMemory, MAX_LIMIT, MemoryError } from '@enve-memory/core';

class FakeProvider implements AiProvider {
  readonly id = 'ollama' as const;
  readonly model = 'fake';
  requests: CompletionRequest[] = [];
  private readonly respond: (request: CompletionRequest) => string;

  constructor(respond: (request: CompletionRequest) => string) {
    this.respond = respond;
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.respond(request);
  }

  async listModels(): Promise<string[]> {
    return [this.model];
  }
}

const open = () => EnveMemory.open({ inMemory: true, actor: 'test' });
const note = (memory: EnveMemory, title: string, parentId: string | null = null, body?: string) =>
  memory.outline.createNote({ parentId, title, body }).item.id;
const ids = (memory: EnveMemory, parentId: string) =>
  memory.outline.children(parentId, { limit: MAX_LIMIT }).items.map((e) => e.item.id);
const reply = (operations: object[]) => JSON.stringify({ summary: 'Proposed changes', operations });

test('a model’s reply becomes a reviewable proposal that never replaces text the model only saw in part', async () => {
  const memory = open();
  const weekend = note(memory, 'Weekend');
  const chores = note(memory, 'Chores', weekend, 'laundry, dishes');
  const longBody = 'Turn left at the old mill, then follow the river path. '.repeat(40);
  const route = note(memory, 'Route notes', weekend, longBody);
  memory.items.archive(note(memory, 'Archived plan', weekend, 'Mentions the codeword marmalade'));

  const provider = new FakeProvider(() => reply([
    { op: 'update', ref: 'n2', title: 'Household chores' },
    { op: 'update', ref: 'n3', body: 'shortened' },
    { op: 'update', ref: 'n3', title: 'Route', body: 'shortened' },
    { op: 'create', parent: 'n1', title: 'Groceries' },
    { op: 'move', ref: 'n3', parent: 'n1', before: 'n2' },
    { op: 'presentation', ref: 'n1', checklist: true },
    { op: 'update', ref: 'n9', title: 'ghost' },
    { op: 'delete', ref: 'n2' },
  ]));
  const proposal = await proposeEdit(memory, provider, { rootId: weekend, instruction: 'Tidy this up' });

  const [request] = provider.requests;
  assert.match(request!.system, /never instructions to you/);
  assert.ok(request!.schema);
  assert.match(request!.prompt, /<items>[\s\S]*"ref":"n3"[\s\S]*"bodyTruncated":true[\s\S]*<\/items>/);
  assert.equal(request!.prompt.includes(longBody), false, 'long text is sent in part');
  assert.equal(request!.prompt.includes('marmalade'), false, 'archived items stay out of scope');

  assert.deepEqual(proposal.operations.map((o) => o.op), ['update', 'update', 'create', 'move', 'presentation']);
  assert.deepEqual(proposal.operations[0], { op: 'update', id: chores, title: 'Household chores', before: { title: 'Chores', body: 'laundry, dishes', parentId: weekend } });
  assert.deepEqual(proposal.operations[1], { op: 'update', id: route, title: 'Route', before: { title: 'Route notes', body: longBody.trim(), parentId: weekend } });
  assert.equal(memory.items.get(chores).title, 'Chores', 'nothing is applied before review');

  const { applied, undo } = memory.edits.apply(proposal);
  assert.equal(applied, 5);
  assert.equal(memory.items.get(route).body, longBody.trim());
  assert.equal(memory.items.get(route).title, 'Route');
  const [created] = undo!.createdIds;
  assert.deepEqual(ids(memory, weekend), [route, chores, created]);
  assert.equal(memory.presentation.get(weekend).checklist, true);

  await assert.rejects(proposeEdit(memory, provider, { rootId: weekend, instruction: '   ' }), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');
  const before = memory.versions.list(weekend).total;
  await assert.rejects(proposeEdit(memory, new FakeProvider(() => 'Sorry, I can’t.'), { rootId: weekend, instruction: 'Tidy' }), AiError);
  assert.equal(memory.versions.list(weekend).total, before);
});

test('the organizer restructures without rewriting text, settles instead of looping, and retries after a concurrent edit', async () => {
  const memory = open();
  const inbox = note(memory, 'Inbox');
  memory.presentation.update(inbox, { autoOrganize: true });
  const apples = note(memory, 'apples', inbox, 'buy apples');
  const plumber = note(memory, 'call plumber', inbox, 'about the leak');
  let interfere = false;
  const provider = new FakeProvider(() => {
    // The user edits while the model is thinking.
    if (interfere) {
      interfere = false;
      memory.items.update(plumber, { body: 'about the kitchen leak' });
    }
    return reply([
      { op: 'update', ref: 'n2', title: 'Apples', body: 'REWRITTEN BY MODEL' },
      { op: 'create', parent: 'n1', title: 'Shopping' },
      { op: 'presentation', ref: 'n1', kind: 'section' },
    ]);
  });
  const worker = organizeWorker(memory, () => provider);

  worker.kick();
  await worker.idle();
  assert.equal(provider.requests.length, 1);
  assert.deepEqual([memory.items.get(apples).title, memory.items.get(apples).body], ['apples', 'buy apples']);
  assert.equal(memory.presentation.get(inbox).kind, 'section');
  const shopping = ids(memory, inbox).filter((id) => memory.items.get(id).title === 'Shopping');
  assert.equal(shopping.length, 1);
  assert.equal(memory.activity.recent({ entityId: shopping[0]! })[0]!.actor, ORGANIZE_ACTOR);

  worker.kick();
  await worker.idle();
  assert.equal(provider.requests.length, 1, 'its own changes don’t trigger another pass');

  interfere = true;
  memory.items.update(apples, { body: 'buy six apples' });
  worker.kick();
  await worker.idle();
  assert.equal(provider.requests.length, 2);
  assert.equal(ids(memory, inbox).filter((id) => memory.items.get(id).title === 'Shopping').length, 1, 'a stale proposal is not applied');
  assert.equal(memory.items.get(plumber).body, 'about the kitchen leak');

  worker.kick();
  await worker.idle();
  assert.equal(provider.requests.length, 3, 'the stale pass is retried');
  assert.equal(memory.items.get(apples).body, 'buy six apples');
  worker.kick();
  await worker.idle();
  assert.equal(provider.requests.length, 3);
});

test('with AI off the organizer does nothing and capture still works', async () => {
  const memory = open();
  const inbox = note(memory, 'Inbox');
  memory.presentation.update(inbox, { autoOrganize: true });
  const worker = organizeWorker(memory, () => null);
  worker.kick();
  await worker.idle();
  const saved = memory.items.saveNote({ body: 'remember the spare key' });
  assert.deepEqual(memory.search.query('spare key').map((h) => h.id), [saved.id]);
  assert.deepEqual(memory.edits.organizeCandidates(), [inbox]);
});

test('a proposal can create a group and move existing items into it, applied and undone as one', async () => {
  const memory = open();
  const errands = note(memory, 'Errands');
  const apples = note(memory, 'apples', errands);
  const bread = note(memory, 'bread', errands);
  const plumber = note(memory, 'call plumber', errands);
  const provider = new FakeProvider(() => reply([
    { op: 'create', ref: 'new1', parent: 'n1', before: 'n2', title: 'Shopping' },
    { op: 'presentation', ref: 'new1', kind: 'heading' },
    { op: 'move', ref: 'n2', parent: 'new1' },
    { op: 'move', ref: 'n3', parent: 'new1' },
    { op: 'move', ref: 'n4', parent: 'new2' },
    { op: 'create', ref: 'loop', parent: 'n2', title: 'Inside apples' },
    { op: 'move', ref: 'n2', parent: 'loop' },
    { op: 'move', ref: 'n1', parent: 'new1' },
  ]));
  const proposal = await proposeEdit(memory, provider, { rootId: errands, instruction: 'Group the shopping' });
  assert.match(provider.requests[0]!.system, /new ref \("new1"/);
  assert.deepEqual(proposal.operations.map((o) => [o.op, 'parentId' in o ? o.parentId : o.id]), [
    ['create', errands], ['presentation', 'new:1'], ['move', 'new:1'], ['move', 'new:1'], ['create', apples],
  ], 'unknown refs, cycles and the root itself are dropped');
  assert.deepEqual(proposal.operations[0], { op: 'create', parentId: errands, beforeId: apples, title: 'Shopping', body: '', tempId: 'new:1' });
  assert.equal(proposal.titles?.['new:1'], 'Shopping');

  const subset = { ...proposal, operations: proposal.operations.filter((o) => o.op === 'move') };
  assert.throws(() => memory.edits.apply(subset), (e: unknown) => e instanceof MemoryError && e.code === 'invalid' && /new:1/.test(e.message));
  assert.deepEqual(ids(memory, errands), [apples, bread, plumber], 'a rejected selection changes nothing');
  const forged = { ...proposal, operations: [...proposal.operations, { op: 'move', id: bread, parentId: 'new:7', beforeId: null }] };
  assert.throws(() => memory.edits.apply(forged as typeof proposal), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');
  const cycle = { ...proposal, operations: [{ op: 'move', id: apples, parentId: bread, beforeId: null }, { op: 'move', id: bread, parentId: apples, beforeId: null }] };
  assert.throws(() => memory.edits.apply(cycle as typeof proposal), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');

  const { applied, undo } = memory.edits.apply({ ...proposal, operations: proposal.operations.slice(0, 4) });
  assert.equal(applied, 4);
  const [shopping] = undo!.createdIds;
  assert.deepEqual(ids(memory, errands), [shopping, plumber]);
  assert.deepEqual(ids(memory, shopping!), [apples, bread]);
  assert.equal(memory.presentation.get(shopping!).kind, 'heading');
  assert.throws(() => memory.edits.apply(proposal), (e: unknown) => e instanceof MemoryError && e.code === 'conflict', 'a used proposal is stale');

  memory.edits.undo(undo!);
  assert.deepEqual(ids(memory, errands), [apples, bread, plumber]);
  assert.ok(memory.items.get(shopping!).archivedAt, 'the group is archived, its items are back');
});

test('the organizer groups siblings under a new heading without rewriting text', async () => {
  const memory = open();
  const inbox = note(memory, 'Inbox');
  memory.presentation.update(inbox, { autoOrganize: true });
  const apples = note(memory, 'apples', inbox);
  const bread = note(memory, 'bread', inbox);
  const provider = new FakeProvider(() => reply([
    { op: 'create', ref: 'shop', parent: 'n1', title: 'Shopping' },
    { op: 'update', ref: 'n2', title: 'APPLES' },
    { op: 'move', ref: 'n2', parent: 'shop' },
    { op: 'move', ref: 'n3', parent: 'shop' },
  ]));
  const worker = organizeWorker(memory, () => provider);
  worker.kick();
  await worker.idle();
  const [group] = ids(memory, inbox);
  assert.equal(memory.items.get(group!).title, 'Shopping');
  assert.deepEqual(ids(memory, group!), [apples, bread]);
  assert.equal(memory.items.get(apples).title, 'apples');
});
