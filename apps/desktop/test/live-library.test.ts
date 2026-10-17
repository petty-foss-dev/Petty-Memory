import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApiServer } from '@enve-memory/api';
import { EnveMemory } from '@enve-memory/core';
import { Library } from '../src/main/library.ts';

test('live library sync switches servers and cancels before closing or restarting its database', { timeout: 15000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-live-library-'));
  const seed = EnveMemory.open({ home, actor: 'test' });
  seed.settings.set('semanticSearch', false);
  seed.settings.set('fetchLinks', false);
  seed.close();
  const servers = [0, 1].map(() => EnveMemory.open({ inMemory: true, actor: 'test' }));
  const apis = servers.map((memory) => createApiServer(memory, { version: 'test', port: 0 }));
  const urls = await Promise.all(apis.map((api) => api.listen()));
  const targets = servers.map((memory, i) => ({ url: urls[i]!, token: memory.clients.create('desktop', ['sync']).token }));
  let target: { url: string; token: string } | null = targets[0]!;
  const library = new Library({ home, version: 'test', port: 0, lan: false, webRoot: null, keys: () => undefined, remote: () => target, onChanged: () => {} });
  t.after(async () => {
    await library.stop();
    await Promise.all(apis.map((api) => api.close()));
    servers.forEach((memory) => memory.close());
    rmSync(home, { recursive: true, force: true });
  });
  await library.start();
  const note = library.memory.items.saveNote({ body: 'A live desktop edit' });
  const deadline = Date.now() + 8000;
  while (!servers[0]!.items.list().some((item) => item.id === note.id)) {
    if (Date.now() > deadline) assert.fail('Initial live desktop sync did not arrive.');
    await delay(30);
  }
  target = null;
  library.forgetRemote();
  target = targets[1]!;
  await library.remoteSync();
  assert.equal(servers[1]!.items.get(note.id).body, note.body);
  assert.equal(library.remoteRunning, false);
  const started = Date.now();
  await library.stop();
  assert.ok(Date.now() - started < 2000, 'closing cancels the live wait');
  assert.throws(() => library.memory, /closed/);
  await library.start();
  await library.stop();
  assert.throws(() => library.memory, /closed/);
});
