import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OutlineEntry } from '@enve-memory/core';
import {
  type Siblings, displayPath, enterAction, firstAnchor, insertBelow, mergeTarget, pasteCommands, planIndent, planMoveDown, planMoveUp, planOutdent,
  uuidv7,
} from '../src/renderer/lib/outline.ts';

const entry = (id: string, parentId: string | null, { type = 'note', archived = false } = {}) =>
  ({ item: { id, type, metadata: {}, archivedAt: archived ? '2026-10-01T00:00:00.000Z' : null }, parentId, position: 0, childCount: 0 }) as unknown as OutlineEntry;

const list = (parentId: string | null, ids: (string | OutlineEntry)[], total = ids.length): Siblings => ({
  parentId,
  entries: ids.map((id) => (typeof id === 'string' ? entry(id, parentId) : id)),
  total,
});

test('moving up places an item before the previous sibling', () => {
  const siblings = list('p', ['a', 'b', 'c']);
  assert.deepEqual(planMoveUp(siblings, 2), { move: { parentId: 'p', beforeId: 'b' } });
  assert.deepEqual(planMoveUp(siblings, 1), { move: { parentId: 'p', beforeId: 'a' } });
  assert.equal(planMoveUp(siblings, 0), null);
});

test('moving down places an item before the sibling after next, or appends', () => {
  const siblings = list(null, ['a', 'b', 'c']);
  assert.deepEqual(planMoveDown(siblings, 0), { move: { parentId: null, beforeId: 'c' } });
  assert.deepEqual(planMoveDown(siblings, 1), { move: { parentId: null, beforeId: null } });
  assert.equal(planMoveDown(siblings, 2), null);
});

test('moving down at the edge of the loaded rows asks for more instead of guessing', () => {
  assert.deepEqual(planMoveDown(list('p', ['a', 'b'], 5), 1), { needs: true });
  assert.deepEqual(planMoveDown(list('p', ['a', 'b'], 5), 0), { needs: true });
  assert.deepEqual(planMoveDown(list('p', ['a', 'b', 'c'], 5), 0), { move: { parentId: 'p', beforeId: 'c' } });
});

test('only active siblings stored under the same parent anchor a placement', () => {
  const projected = entry('orphan', 'archived-parent');
  const old = entry('old', null, { archived: true });
  const siblings = list(null, ['a', projected, old, 'b']);
  assert.deepEqual(planMoveUp(siblings, 3), { move: { parentId: null, beforeId: 'a' } });
  assert.deepEqual(planMoveDown(siblings, 0), { move: { parentId: null, beforeId: null } });
  assert.deepEqual(planMoveUp(siblings, 1), { move: { parentId: null, beforeId: 'a' } });
  assert.equal(firstAnchor(list(null, [old, projected, 'c'])), 'c');
  assert.equal(firstAnchor(list(null, [old])), null);
});

test('indenting nests under the nearest row above that can hold children', () => {
  const decision = entry('d', 'p', { type: 'decision' });
  const archived = entry('x', 'p', { archived: true });
  const siblings = list('p', ['a', decision, archived, 'b']);
  assert.deepEqual(planIndent(siblings, 3), { move: { parentId: 'a', beforeId: null } });
  assert.deepEqual(planIndent(siblings, 1), { move: { parentId: 'a', beforeId: null } });
  assert.equal(planIndent(siblings, 0), null);
  assert.equal(planIndent(list('p', [decision, 'b']), 1), null);
});

test('outdenting lands right after the old parent', () => {
  const grandparent = list('g', ['p', 'q', 'r']);
  assert.deepEqual(planOutdent(grandparent, 0), { move: { parentId: 'g', beforeId: 'q' } });
  assert.deepEqual(planOutdent(grandparent, 2), { move: { parentId: 'g', beforeId: null } });
  assert.deepEqual(planOutdent(list(null, ['p'], 3), 0), { needs: true });
});

test('a secret parent accepts only a secret child when indenting', () => {
  const parent = entry('secret-parent', null);
  parent.item.metadata.secret = true;
  const child = entry('secret-child', null);
  child.item.metadata.secret = true;
  assert.deepEqual(planIndent(list(null, [parent, child]), 1), { move: { parentId: parent.item.id, beforeId: null } });
  assert.equal(planIndent(list(null, [parent, 'ordinary']), 1), null);
});

test('a note added below a row goes before the next sibling', () => {
  assert.deepEqual(insertBelow(list('p', ['a', 'b']), 0), { id: 'b' });
  assert.deepEqual(insertBelow(list('p', ['a', 'b']), 1), { id: null });
  assert.deepEqual(insertBelow(list('p', ['a', 'b'], 4), 1), { needs: true });
});

test('the path to an item restarts below its last archived ancestor', () => {
  const a = { id: 'a', archivedAt: null };
  const b = { id: 'b', archivedAt: '2026-10-01T00:00:00.000Z' };
  const c = { id: 'c', archivedAt: null };
  assert.deepEqual(displayPath([a, b, c], false), ['c']);
  assert.deepEqual(displayPath([a, b, c], true), ['a', 'b', 'c']);
  assert.deepEqual(displayPath([a, c], false), ['a', 'c']);
  assert.deepEqual(displayPath([a, b], false), []);
  assert.deepEqual(displayPath([], false), []);
});

test('a row merges only into its exact previous active note sibling', () => {
  const siblings = list('p', ['a', 'b', entry('link', 'p', { type: 'bookmark' }), 'c', entry('old', 'p', { archived: true }), 'd']);
  assert.equal(mergeTarget(siblings, 1), 'a');
  assert.equal(mergeTarget(siblings, 0), null, 'the first row has nothing above it');
  assert.equal(mergeTarget(siblings, 3), null, 'a bookmark is not a note to merge into');
  assert.equal(mergeTarget(siblings, 2), null, 'only notes merge');
  assert.equal(mergeTarget(siblings, 5), null, 'an archived row in between means they are not adjacent');
  const secret = list(null, ['x', { ...entry('s', null), item: { ...entry('s', null).item, metadata: { secret: true } } } as OutlineEntry]);
  assert.equal(mergeTarget(secret, 1), null, 'secret notes never merge');
});

test('Enter splits inside a title and opens a composer at either end', () => {
  assert.equal(enterAction('Relay board', 6), 'split');
  assert.equal(enterAction('Relay board', 11), 'below');
  assert.equal(enterAction('Relay board  ', 11), 'below', 'only spaces after the caret');
  assert.equal(enterAction('Relay board', 0), 'above');
  assert.equal(enterAction('  Relay', 2), 'above');
});

test('a paste becomes one batch that nests by indentation and references its own new ids', () => {
  const { commands, ids } = pasteCommands({ parentId: 'p', beforeId: 'next', project: 'garage' }, [
    { title: 'Wiring', depth: 0, kind: 'heading' },
    { title: 'Red', depth: 1, checked: true },
    { title: 'White', depth: 1, checked: false },
    { title: 'Firmware', depth: 0 },
  ]);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  const [wiring, red, white, firmware] = ids;
  assert.deepEqual(commands, [
    { op: 'create', id: wiring, parentId: 'p', beforeId: 'next', title: 'Wiring', project: 'garage' },
    { op: 'create', id: red, parentId: wiring, beforeId: null, title: 'Red', project: 'garage' },
    { op: 'create', id: white, parentId: wiring, beforeId: null, title: 'White', project: 'garage' },
    { op: 'create', id: firmware, parentId: 'p', beforeId: 'next', title: 'Firmware', project: 'garage' },
    { op: 'presentation', id: wiring, patch: { kind: 'heading' } },
    { op: 'presentation', id: wiring, patch: { checklist: true } },
    { op: 'check', id: red, checked: true },
  ]);
});

test('pasting below a row nests deeper lines inside that row', () => {
  const { commands } = pasteCommands({ parentId: null, beforeId: null }, [{ title: 'Inside', depth: 1 }, { title: 'Beside', depth: 0 }], ['row']);
  assert.deepEqual(commands.map((c) => c.op === 'create' && [c.parentId, c.title]), [['row', 'Inside'], [null, 'Beside']]);
});

test('client ids are time-ordered UUIDv7 strings', () => {
  const first = uuidv7();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const stamp = (id: string) => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
  assert.ok(Math.abs(stamp(first) - Date.now()) < 5000);
});
