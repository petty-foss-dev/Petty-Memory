import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError } from '@enve-memory/ai';
import { MemoryError } from '@enve-memory/core';
import { DesktopError, type Handlers, dispatch, toCallError } from '../src/main/dispatch.ts';
import { EVENTS, METHOD_KINDS, type Method, isMethod } from '../src/shared/ipc.ts';

const methods = Object.keys(METHOD_KINDS) as Method[];
const echoHandlers = Object.fromEntries(methods.map((m) => [m, (...args: unknown[]) => ({ method: m, args })])) as unknown as Handlers;

test('the allow-list names every method once, each with a known kind', () => {
  assert.equal(new Set(methods).size, methods.length);
  for (const method of methods) {
    assert.match(method, /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/);
    assert.ok(METHOD_KINDS[method] === 'read' || METHOD_KINDS[method] === 'write');
  }
  assert.deepEqual([...EVENTS].sort(), ['changed', 'command', 'open']);
});

test('mutating calls are marked as writes so windows refresh and workers run', () => {
  for (const method of ['items.saveNote', 'items.saveLink', 'items.update', 'items.delete', 'projects.setMemory', 'decisions.record', 'tasks.update', 'files.save', 'clients.revoke', 'sync.now', 'items.pin', 'items.setReminder', 'items.setIntent', 'items.openUrl', 'items.openFile'] as Method[]) {
    assert.equal(METHOD_KINDS[method], 'write', method);
  }
  for (const method of ['items.get', 'items.list', 'search.hybrid', 'activity.recent', 'app.info', 'shelves.counts', 'shelves.list', 'reminders.list'] as Method[]) {
    assert.equal(METHOD_KINDS[method], 'read', method);
  }
});

test('outline placement and note creation are writes; browsing the outline is a read', () => {
  assert.equal(METHOD_KINDS['outline.move'], 'write');
  assert.equal(METHOD_KINDS['outline.createNote'], 'write');
  for (const method of ['outline.children', 'outline.get', 'outline.ancestors'] as Method[]) assert.equal(METHOD_KINDS[method], 'read', method);
});

test('journalled editor actions and their undo and redo are writes', () => {
  for (const method of ['editor.apply', 'editor.undo', 'editor.redo'] as Method[]) assert.equal(METHOD_KINDS[method], 'write', method);
  assert.equal(METHOD_KINDS['projects.memoryHistory'], 'read');
});

test('encrypted files, recovery and vault history are allow-listed with the right kinds', () => {
  for (const method of ['vault.attachFiles', 'vault.removeFile', 'vault.recover', 'vault.restoreVersion'] as Method[]) assert.equal(METHOD_KINDS[method], 'write', method);
  for (const method of ['vault.outline', 'vault.files', 'vault.saveFile', 'vault.recoveryKit'] as Method[]) assert.equal(METHOD_KINDS[method], 'read', method);
});

test('isMethod rejects inherited and made-up names', () => {
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'items', 'items.nuke', '', 42, null, undefined, {}, ['items.get']]) {
    assert.equal(isMethod(bad), false, String(bad));
  }
  assert.equal(isMethod('items.get'), true);
});

test('dispatch runs allow-listed handlers with their arguments', async () => {
  const result = await dispatch(echoHandlers, 'items.get', ['abc']);
  assert.deepEqual(result, { ok: true, value: { method: 'items.get', args: ['abc'] } });
});

test('dispatch refuses unknown methods without touching the handler map', async () => {
  for (const method of ['__proto__', 'constructor', 'items.nuke', 7]) {
    const result = await dispatch(echoHandlers, method, []);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'unknown_method');
  }
});

test('dispatch refuses a method missing from the handler map and non-list arguments', async () => {
  const partial = { 'items.get': () => 1 } as unknown as Handlers;
  const missing = await dispatch(partial, 'items.delete', ['x']);
  assert.equal(!missing.ok && missing.error.code, 'unknown_method');
  const badArgs = await dispatch(echoHandlers, 'items.get', 'abc');
  assert.equal(!badArgs.ok && badArgs.error.code, 'invalid');
});

test('failures become { code, message } for the UI', async () => {
  const failing = (error: unknown) => ({ ...echoHandlers, 'items.get': () => { throw error; } }) as Handlers;
  const cases: [unknown, string][] = [
    [new MemoryError('not_found', 'No item with id "x".'), 'not_found'],
    [new AiError('Ollama answered 500.'), 'ai'],
    [new DesktopError('invalid', 'Nope.'), 'invalid'],
    [new Error('boom'), 'internal'],
  ];
  for (const [error, code] of cases) {
    const result = await dispatch(failing(error), 'items.get', ['x']);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, code);
    assert.equal(!result.ok && result.error.message, (error as Error).message);
  }
  const rejected = await dispatch({ ...echoHandlers, 'items.get': async () => Promise.reject(new MemoryError('conflict', 'Taken.')) } as Handlers, 'items.get', []);
  assert.deepEqual(rejected, { ok: false, error: { code: 'conflict', message: 'Taken.' } });
  assert.deepEqual(toCallError('plain string'), { code: 'internal', message: 'plain string' });
});
