import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const tempHome = () => mkdtempSync(join(tmpdir(), 'enve-memory-cli-'));

function cli(home: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [MAIN, '--home', home, ...args], { encoding: 'utf8', input });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const json = (home: string, args: string[]) => {
  const result = cli(home, [...args, '--json']);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('capture, organize and find from the command line', () => {
  const home = tempHome();
  json(home, ['project', 'new', 'Garage Door', '--instructions', 'Offline only.']);
  const note = json(home, ['note', 'Garage', 'opener', 'uses', 'Security+', '2.0', '-p', 'garage door', '-t', 'protocol']);
  assert.equal(note.body, 'Garage opener uses Security+ 2.0');
  assert.deepEqual(note.tags, ['protocol']);

  const task = json(home, ['task', 'add', 'Order', 'ESP32', '-p', 'garage', '--due', '2026-10-01']);
  assert.equal(json(home, ['task', 'done', task.id]).task.status, 'done');

  const hits = json(home, ['search', 'security', 'opener']);
  assert.deepEqual(hits.map((h: { id: string }) => h.id), [note.id]);

  const memory = cli(home, ['project', 'memory', 'garage', '--set', '-'], '# Goal\nLocal control\n');
  assert.equal(memory.code, 0, memory.stderr);
  assert.match(cli(home, ['project', 'show', 'garage']).stdout, /## Instructions\nOffline only\.[\s\S]*## Memory\n# Goal/);
});

test('saved views and templates persist and run through the real CLI', () => {
  const home = tempHome();
  const project = json(home, ['project', 'new', 'Workshop']);
  const root = json(home, ['outline', 'add', 'Review {{date}}', '--body', 'Project: {{project}}']);
  const child = json(home, ['outline', 'add', 'Check tools', '--parent', root.item.id]);
  json(home, ['check', child.item.id]);
  const template = json(home, ['templates', 'create', root.item.id, '--name', 'Review {{date}}']);
  assert.equal(json(home, ['templates'])[0].id, template.id);
  const used = json(home, ['templates', 'use', template.id, '-p', project.id, '--date', '2026-10-17']);
  assert.equal(used.title, 'Review 2026-10-17');
  assert.equal(used.body, 'Project: Workshop');
  const copied = json(home, ['outline', used.id]).items[0].item;
  assert.equal(json(home, ['presentation', copied.id]).checked, false);
  assert.equal(json(home, ['presentation', child.item.id]).checked, true);
  const view = json(home, ['views', 'create', 'Workshop reviews', '-p', project.id, '--type', 'note', '--query', 'Review']);
  assert.equal(json(home, ['views'])[0].id, view.id);
  assert.deepEqual(json(home, ['views', 'run', view.id]).items.map((item: { id: string }) => item.id), [used.id]);
  assert.equal(cli(home, ['views', 'remove', view.id]).code, 2);
  const edited = cli(home, ['views', 'edit', view.id, '--set', '-'], JSON.stringify({ name: 'All Workshop notes', filter: { project: project.id, type: 'note' } }));
  assert.equal(edited.code, 0, edited.stderr);
  assert.equal(json(home, ['views', 'show', view.id]).name, 'All Workshop notes');
  assert.equal(json(home, ['views', 'run', view.id]).items.length, 2);
  json(home, ['views', 'remove', view.id, '--yes']);
  assert.deepEqual(json(home, ['views']), []);
  assert.equal(json(home, ['show', used.id]).id, used.id);
  assert.equal(cli(home, ['templates', 'use', template.id, '--date', '2026-02-30']).code, 1);
});

test('outline commands create, navigate, reorder and move persistent nested notes', () => {
  const home = tempHome();
  const root = json(home, ['outline', 'add', 'Japan']);
  const packing = json(home, ['outline', 'add', 'Packing', '--parent', root.item.id, '--body', 'Travel essentials']);
  const passport = json(home, ['outline', 'add', 'Passport', '--parent', packing.item.id]);
  const bookings = json(home, ['outline', 'add', 'Bookings', '--parent', root.item.id]);
  const children = json(home, ['outline', root.item.id]);
  assert.equal(children.total, 2);
  assert.deepEqual(children.items.map((entry: { item: { id: string } }) => entry.item.id), [packing.item.id, bookings.item.id]);
  assert.equal(children.items[0].childCount, 1);
  assert.equal(json(home, ['show', packing.item.id]).body, 'Travel essentials');
  json(home, ['outline', 'move', bookings.item.id, '--parent', root.item.id, '--before', packing.item.id]);
  assert.equal(json(home, ['outline', root.item.id, '--limit', '1']).items[0].item.id, bookings.item.id);
  assert.equal(json(home, ['outline', root.item.id, '--limit', '1', '--offset', '1']).items[0].item.id, packing.item.id);
  assert.deepEqual(json(home, ['outline', 'show', passport.item.id]).ancestors.map((item: { id: string }) => item.id), [root.item.id, packing.item.id]);
  assert.equal(cli(home, ['outline', 'move', root.item.id, '--parent', passport.item.id]).code, 1);
  assert.equal(cli(home, ['outline', 'move', packing.item.id]).code, 2);
  assert.equal(cli(home, ['outline', 'move', packing.item.id, '--root', '--parent', root.item.id]).code, 2);
  assert.equal(cli(home, ['outline', root.item.id, '--offset=-1']).code, 1);
  json(home, ['outline', 'move', packing.item.id, '--root']);
  assert.equal(json(home, ['outline', 'show', packing.item.id]).parentId, null);
  assert.equal(json(home, ['outline', 'show', passport.item.id]).parentId, packing.item.id);
  assert.match(cli(home, ['outline', 'show', passport.item.id]).stdout, /Packing \/ Passport/);
  assert.match(cli(home, ['outline', '--limit', '1']).stdout, /continue with --offset 1/);
});

test('presentation, checklist, references and history commands work on a persistent library', () => {
  const home = tempHome();
  const list = json(home, ['outline', 'add', 'Packing']);
  const socks = json(home, ['outline', 'add', 'Socks', '--parent', list.item.id]);
  json(home, ['outline', 'add', 'Hat', '--parent', list.item.id]);
  const patched = cli(home, ['presentation', list.item.id, '--set', '-', '--json'], JSON.stringify({ checklist: true, review: true }));
  assert.equal(patched.code, 0, patched.stderr);
  assert.equal(JSON.parse(patched.stdout).checklist, true);
  assert.equal(json(home, ['presentation', list.item.id]).review, true);
  assert.deepEqual(json(home, ['list', '--review']).map((item: { id: string }) => item.id), [list.item.id]);

  json(home, ['check', socks.item.id]);
  assert.match(cli(home, ['checklist', list.item.id]).stdout, /^1 of 2 complete\.$/);
  json(home, ['check', list.item.id]);
  assert.deepEqual(json(home, ['checklist', list.item.id]), { done: 2, total: 2 });
  assert.match(cli(home, ['checklist', list.item.id, 'reset']).stdout, /^Reset 3 entries\.$/);
  json(home, ['uncheck', list.item.id]);
  assert.equal(cli(home, ['checklist', list.item.id, 'bogus']).code, 2);

  const passport = json(home, ['note', 'Passport', 'in', 'the', 'drawer']);
  const referenced = json(home, ['reference', socks.item.id, passport.id, '--title', 'ID']);
  assert.equal(referenced.body, `[[item:${passport.id}|ID]]`);
  assert.deepEqual(json(home, ['references', passport.id]).incoming.map((r: { id: string }) => r.id), [socks.item.id]);

  const history = json(home, ['history', socks.item.id]);
  assert.ok(history.total >= 2);
  const original = history.items.at(-1);
  assert.equal(json(home, ['history', 'show', original.id]).snapshot.items[0].item.body, '');
  assert.match(cli(home, ['history', 'restore', original.id]).stdout, /^Restored 1 items as a new change\.$/);
  assert.equal(json(home, ['show', socks.item.id]).body, '');
  assert.deepEqual(json(home, ['references', passport.id]).incoming, []);
});

test('editor journal survives separate CLI processes and protects newer text', () => {
  const home = tempHome();
  const note = json(home, ['outline', 'add', 'Travel', '--body', 'Socks and a hat']);
  const split = json(home, ['editor', 'split', note.item.id, 'body', '5']);
  const nextId = split.createdIds[0];
  assert.equal(json(home, ['show', nextId]).body.trim(), 'and a hat');
  json(home, ['editor', 'undo', split.actionId]);
  assert.equal(json(home, ['show', note.item.id]).body, 'Socks and a hat');
  assert.ok(json(home, ['show', nextId]).archivedAt);
  json(home, ['editor', 'redo', split.actionId]);
  const merged = json(home, ['editor', 'merge', nextId, note.item.id]);
  assert.match(json(home, ['show', note.item.id]).body, /Socks\n\n/);
  json(home, ['editor', 'undo', merged.actionId]);
  assert.equal(json(home, ['show', nextId]).archivedAt, null);
  const applied = cli(home, ['editor', 'apply', '-', '--json'], JSON.stringify([
    { op: 'update', id: nextId, body: 'Notebook', baseBody: json(home, ['show', nextId]).body },
    { op: 'presentation', id: nextId, patch: { review: true } },
  ]));
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(json(home, ['show', nextId]).body, 'Notebook');
  assert.equal(cli(home, ['editor', 'undo', split.actionId]).code, 1);
  assert.equal(json(home, ['show', nextId]).body, 'Notebook');
});

test('project memory history pages across process restarts', () => {
  const home = tempHome();
  json(home, ['project', 'new', 'History']);
  for (const memory of ['First draft', 'Second draft', 'Third draft']) {
    assert.equal(cli(home, ['project', 'memory', 'history', '--set', '-'], memory).code, 0);
  }
  const page = json(home, ['project', 'history', 'history', '--limit', '1']);
  assert.equal(page.items[0].memory, 'Third draft');
  assert.ok(page.total >= 3);
  assert.equal(json(home, ['project', 'history', 'history', '--limit', '1', '--offset', '2']).items[0].memory, 'First draft');
});

test('share, client scope and remote sync commands', () => {
  const home = tempHome();
  const root = json(home, ['outline', 'add', 'Recipes']);
  const hidden = json(home, ['outline', 'add', 'Secret sauce', '--parent', root.item.id]);
  const created = json(home, ['shares', 'create', root.item.id, '--exclude', hidden.item.id]);
  assert.match(created.token, /^ps_/);
  assert.deepEqual(created.share.excludedIds, [hidden.item.id]);
  assert.match(cli(home, ['shares', 'create', root.item.id]).stdout, /shown once\): ps_\S+\nOpen \/s\/ps_/);
  const listed = json(home, ['shares']);
  assert.equal(listed.length, 2);
  assert.equal(JSON.stringify(listed).includes(created.token), false);
  assert.ok(json(home, ['shares', 'revoke', created.share.id]).revokedAt);
  assert.match(cli(home, ['shares']).stdout, new RegExp(`${created.share.id}  ${root.item.id}  revoked`));
  assert.equal(cli(home, ['shares', 'bogus']).code, 2);

  assert.deepEqual(json(home, ['clients', 'add', 'laptop', '--scope', 'sync']).client.scopes, ['sync']);
  assert.deepEqual(json(home, ['clients', 'pair', 'phone']).client.scopes.sort(), ['read', 'write']);
  assert.match(cli(home, ['--help']).stdout, /sync remote <server-url>.*PETTY_MEMORY_SYNC_TOKEN/);

  const { PETTY_MEMORY_SYNC_TOKEN: _, ...env } = process.env;
  const remote = (extra: Record<string, string>, url: string) =>
    spawnSync(process.execPath, [MAIN, '--home', home, 'sync', 'remote', url], { encoding: 'utf8', env: { ...env, ...extra } });
  const missing = remote({}, 'http://127.0.0.1:9');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Set PETTY_MEMORY_SYNC_TOKEN/);
  const badUrl = remote({ PETTY_MEMORY_SYNC_TOKEN: 'em_test' }, 'ftp://sync.example');
  assert.equal(badUrl.status, 1);
  assert.match(badUrl.stderr, /HTTP or HTTPS/);
});

test('files are saved from paths and can be read back', () => {
  const home = tempHome();
  const path = join(home, 'wiring notes.md');
  writeFileSync(path, '# Wiring\nGPIO4 drives the relay coil.');
  const [saved] = json(home, ['file', path, '-t', 'wiring']);
  assert.equal(saved.created, true);
  assert.equal(saved.item.type, 'file');
  assert.equal(saved.item.title, 'wiring notes.md');
  assert.equal(cli(home, ['show', saved.item.id, '--content']).stdout, '# Wiring\nGPIO4 drives the relay coil.');
  assert.equal(json(home, ['search', 'relay', 'coil'])[0].id, saved.item.id);
  assert.equal(json(home, ['settings', 'fetchLinks', 'false']).fetchLinks, false);
  assert.equal(json(home, ['link', 'https://example.com/never-fetched']).item.metadata.ingest, undefined);
});

test('export, snapshot and restore round-trip from the command line', () => {
  const home = tempHome();
  const note = json(home, ['note', 'before snapshot']);
  const backup = json(home, ['backup']);
  assert.equal(backup.kind, 'manual');
  json(home, ['note', 'after snapshot']);

  assert.equal(cli(home, ['restore', 'latest']).code, 2);
  const restored = json(home, ['restore', 'latest', '--yes']);
  assert.equal(restored.restored, backup.path);
  assert.deepEqual(json(home, ['list']).map((i: { id: string }) => i.id), [note.id]);

  const out = join(home, 'out');
  assert.equal(json(home, ['export', out]).items, 1);
  assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /Petty Memory export/);
});

test('AI is off until a provider is chosen, and misconfiguration is explained', () => {
  const home = tempHome();
  assert.equal(json(home, ['ai']).provider, 'none');
  assert.equal(cli(home, ['ask', 'anything']).code, 2);
  const noKey = cli(home, ['ai', 'use', 'anthropic']);
  assert.equal(noKey.code, 1);
  assert.match(noKey.stderr, /needs an API key \(set ANTHROPIC_API_KEY\)/);
  const configured = json(home, ['ai', 'use', 'ollama', '--model', 'qwen2.5:1.5b', '--base-url', 'http://127.0.0.1:9']);
  assert.deepEqual(configured, { provider: 'ollama', model: 'qwen2.5:1.5b', baseUrl: 'http://127.0.0.1:9', enrich: false, enrichSince: null, autoApply: false });
  assert.equal(json(home, ['ai', 'auto-apply', 'on']).autoApply, true);
  assert.equal(json(home, ['ai', 'enrich', 'on']).enrich, true);
  assert.equal(json(home, ['ai', 'off']).provider, 'none');
});

test('two libraries sync through a shared folder from the command line', () => {
  const [laptop, desktop, folder] = [tempHome(), tempHome(), tempHome()];
  const note = json(laptop, ['note', 'written on the laptop']);
  assert.equal(json(laptop, ['sync', folder]).exported, 1);
  const received = json(desktop, ['sync', folder]);
  assert.equal(received.imported, 1);
  assert.equal(json(desktop, ['show', note.id]).source, 'cli');
  assert.equal(json(desktop, ['sync', 'off']).syncFolder, null);
  assert.equal(cli(desktop, ['sync']).code, 1);

  const sealed = tempHome();
  assert.equal(cli(laptop, ['sync', sealed, '--passphrase', '-', '--json'], 'a long passphrase\n').code, 0);
  const locked = cli(desktop, ['sync', sealed]);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /encrypted/);
  assert.equal(cli(desktop, ['sync', sealed, '--passphrase', '-', '--json'], 'a long passphrase\n').code, 0);
});

test('import, rules and graph from the command line', () => {
  const home = tempHome();
  json(home, ['project', 'new', 'Development']);
  const rule = json(home, ['rules', 'add', 'Code links', '--domain', 'github.com', '-t', 'code', '-p', 'development']);
  assert.deepEqual(rule.conditions, { domains: ['github.com'] });

  const bookmarks = join(home, 'bookmarks.html');
  writeFileSync(bookmarks, '<DL><p><DT><H3>Dev</H3><DL><p><DT><A HREF="https://github.com/enve/memory">repo</A></DL><p></DL>');
  assert.deepEqual(json(home, ['import', 'bookmarks', bookmarks]), { created: 1, skipped: 0, failed: [] });
  const [repo] = json(home, ['list']);
  assert.deepEqual(repo.project?.name, 'Development');

  const detail = json(home, ['show', repo.id]);
  assert.deepEqual(detail.tags, ['code', 'dev']);
  assert.equal(json(home, ['rules', 'off', rule.id]).enabled, false);
  assert.ok(json(home, ['graph']).nodes.length >= 3);
  assert.equal(cli(home, ['import', 'pocket', bookmarks]).code, 2);
});

test('shelves and reminders from the command line', () => {
  const home = tempHome();
  const video = json(home, ['link', 'https://youtube.com/watch?v=1', '--no-fetch']).item;
  assert.equal(video.intent, 'watch');
  assert.ok(json(home, ['pin', video.id]).pinnedAt);
  assert.deepEqual(json(home, ['list', '--pinned']).map((i: { id: string }) => i.id), [video.id]);
  assert.ok(json(home, ['remind', video.id, 'next', 'week']).remindAt);
  assert.deepEqual(json(home, ['reminders']).map((i: { id: string }) => i.id), [video.id]);
  assert.equal(json(home, ['remind', video.id, 'off']).remindAt, null);
  assert.equal(json(home, ['intent', video.id, 'revisit']).intent, 'revisit');
  assert.deepEqual(json(home, ['list', '--intent', 'revisit']).map((i: { id: string }) => i.id), [video.id]);
  assert.equal(cli(home, ['remind', video.id, 'someday']).code, 1);
});

test('errors are reported with distinct exit codes', () => {
  const home = tempHome();
  assert.equal(cli(home, ['show', 'nope']).code, 1);
  assert.equal(cli(home, ['frobnicate']).code, 2);
  assert.equal(cli(home, ['--nonsense']).code, 2);

  const note = json(home, ['note', 'temporary']);
  const refused = cli(home, ['delete', note.id]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--yes/);
  assert.equal(cli(home, ['show', note.id]).code, 0);
  assert.equal(cli(home, ['delete', note.id, '--yes']).code, 0);
  assert.equal(cli(home, ['show', note.id]).code, 1);
});

test('connect prints a working command for each client', () => {
  const { stdout } = cli(tempHome(), ['connect']);
  assert.match(stdout, /claude mcp add --scope user petty-memory -- /);
  assert.match(stdout, /\[mcp_servers\.petty-memory\]/);
  assert.ok(stdout.includes(JSON.stringify(MAIN)));
});

test('an MCP client over stdio shares the same library as the CLI', async () => {
  const home = tempHome();
  json(home, ['project', 'new', 'Garage Door']);
  json(home, ['link', 'https://example.com/ratgdo', '--title', 'ratgdo firmware', '-p', 'garage', '--no-fetch']);

  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', '--home', home], stderr: 'pipe' }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const briefing = await call('get_project', { project: 'Garage Door' });
    assert.equal(briefing.recentItems[0].title, 'ratgdo firmware');
    await call('create_task', { project: 'Garage Door', title: 'Build Security+ 2.0 bench simulator' });
  } finally {
    await client.close();
  }

  const [task] = json(home, ['task', 'list', '-p', 'garage']);
  assert.equal(task.title, 'Build Security+ 2.0 bench simulator');
  assert.equal(task.source, 'mcp:claude-code');
});

test('serve exposes the library over HTTP to token holders', async () => {
  const home = tempHome();
  json(home, ['settings', 'semanticSearch', 'false']);
  const { token, client } = json(home, ['clients', 'add', 'Phone', '--scope', 'read,capture']);
  assert.deepEqual(client.scopes, ['read', 'capture']);
  assert.match(cli(home, ['clients', 'list']).stdout, /Phone {2}\(read, capture\) {2}em_/);

  const server = spawn(process.execPath, [MAIN, '--home', home, 'serve', '--port', '0']);
  try {
    let log = '';
    server.stderr.setEncoding('utf8');
    while (!/listening on (\S+)/.test(log)) log += (await once(server.stderr, 'data'))[0];
    const base = /listening on (\S+)/.exec(log)![1]!;
    assert.equal((await fetch(base)).status, 200);
    assert.match(await (await fetch(`${base}/s/ps_fixture`)).text(), /Petty Memory/);
    assert.equal((await fetch(`${base}/api/v1/items`)).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const saved = await fetch(`${base}/api/v1/capture`, { method: 'POST', headers, body: JSON.stringify({ selection: 'from the phone' }) });
    assert.equal(saved.status, 201);
    const hits = (await (await fetch(`${base}/api/v1/search?q=phone`, { headers })).json()) as { snippet: string }[];
    assert.equal(hits[0]?.snippet, '> from the [phone]');
  } finally {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  assert.equal(json(home, ['list'])[0].source, 'api:Phone');
});
