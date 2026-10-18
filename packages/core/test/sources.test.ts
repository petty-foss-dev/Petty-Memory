import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { EnveMemory, MemoryError } from '@enve-memory/core';
import { SOURCE_LIMITS } from '../src/sources.ts';

function library(t: TestContext, inMemory = false) {
  const home = mkdtempSync(join(tmpdir(), 'petty-sources-'));
  const memory = inMemory ? EnveMemory.open({ inMemory: true, actor: 'test' }) : EnveMemory.open({ home, actor: 'test' });
  t.after(() => {
    memory.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { memory, home };
}

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'petty-watched-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const failsWith = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof MemoryError && error.code === code && (!message || message.test(error.message));

test('watch definitions are versioned definition notes; opt-in, validated, and free of host paths', (t) => {
  const { memory } = library(t);
  const garden = memory.projects.create({ name: 'Garden' });
  const watch = memory.sources.create({ name: 'Seed catalog', kind: 'url', url: 'https://seeds.example/catalog', project: 'garden' });
  assert.equal(watch.enabled, false);
  assert.equal(watch.folder, null);
  assert.deepEqual(watch.project, { id: garden.id, name: 'Garden' });
  const note = memory.items.get(watch.id);
  assert.equal(note.type, 'note');
  assert.equal(note.title, 'Seed catalog');
  assert.equal(note.project, null);
  assert.deepEqual(note.metadata.watchedSource, { version: 1, kind: 'url', url: 'https://seeds.example/catalog', project: garden.id, enabled: false });
  assert.equal(note.metadata.knowledgeDefinition, true);

  assert.throws(() => memory.sources.create({ name: 'Local', kind: 'url', url: 'file:///etc/passwd' }), failsWith('invalid', /http and https/));
  assert.throws(() => memory.sources.create({ name: 'Creds', kind: 'rss', url: 'https://me:pw@feeds.example/x' }), failsWith('invalid', /user name or password/));
  assert.throws(() => memory.sources.create({ name: 'Long', kind: 'url', url: `https://seeds.example/${'é'.repeat(1500)}` }), failsWith('invalid', /2048 characters once encoded/));
  assert.throws(() => memory.sources.create({ name: 'Docs', kind: 'folder', url: 'https://example.com' }), failsWith('invalid', /no URL/));
  assert.throws(() => memory.sources.create({ name: 'Docs', kind: 'folder', path: '/tmp' } as never), failsWith('invalid', /Unknown watched source field "path"/));
  assert.throws(() => memory.sources.update(watch.id, { kind: 'rss' } as never), failsWith('invalid', /Unknown/));
  assert.throws(() => memory.sources.get(memory.items.saveNote({ body: 'Just a note' }).id), failsWith('not_found'));

  const before = memory.sources.get(watch.id).hash;
  assert.equal(memory.sources.update(watch.id, { enabled: true, name: 'Seeds' }).hash, before);
  assert.notEqual(memory.sources.update(watch.id, { url: 'https://seeds.example/v2' }).hash, before);
  assert.deepEqual(memory.sources.list().map((entry) => [entry.name, entry.enabled]), [['Seeds', true]]);
  memory.sources.remove(watch.id);
  assert.deepEqual(memory.sources.list(), []);
  assert.notEqual(memory.items.get(watch.id).archivedAt, null);
});

test('folder approval is host-local, refuses unsafe paths and is never exported or synced', (t) => {
  const { memory, home } = library(t);
  const docs = folder(t);
  const watch = memory.sources.create({ name: 'Field notes', kind: 'folder' });
  assert.deepEqual(watch.folder, { approved: false, available: false });
  assert.throws(() => memory.sources.checkFolder(watch.id), failsWith('invalid', /Approve a folder/));

  const url = memory.sources.create({ name: 'Blog', kind: 'url', url: 'https://blog.example/' });
  assert.throws(() => memory.sources.approveFolder(url.id, docs), failsWith('invalid', /Only folder watches/));
  assert.throws(() => memory.sources.approveFolder(watch.id, 'relative/docs'), failsWith('invalid', /full path/));
  writeFileSync(join(docs, 'plain.txt'), 'not a folder');
  assert.throws(() => memory.sources.approveFolder(watch.id, join(docs, 'plain.txt')), failsWith('invalid', /not a file/));
  const link = join(folder(t), 'shortcut');
  symlinkSync(docs, link);
  assert.throws(() => memory.sources.approveFolder(watch.id, link), failsWith('invalid', /symbolic link/));
  assert.throws(() => memory.sources.approveFolder(watch.id, '/'), failsWith('invalid', /whole disk/));
  assert.throws(() => memory.sources.approveFolder(watch.id, homedir()), failsWith('invalid', /home folder/));
  mkdirSync(join(home, 'inside'));
  assert.throws(() => memory.sources.approveFolder(watch.id, join(home, 'inside')), failsWith('invalid', /overlaps a Petty Memory library/));
  assert.throws(() => memory.sources.approveFolder(watch.id, dirname(home)), failsWith('invalid', /overlaps a Petty Memory library/));

  const approved = memory.sources.approveFolder(watch.id, docs);
  assert.deepEqual(approved.folder, { approved: true, available: true });
  assert.notEqual(approved.hash, watch.hash);
  const leaked = (value: unknown) => JSON.stringify(value).includes(docs) || JSON.stringify(value).includes('petty-watched-');
  assert.equal(leaked(memory.sources.list()), false);
  assert.equal(leaked(memory.items.get(watch.id)), false);
  assert.equal(leaked(memory.activity.recent({}, 200)), false);
  assert.equal(leaked(memory.sync.exportChanges(0)), false);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    writeFileSync(join(docs, 'plan.md'), 'Plan');
    chmodSync(docs, 0o000);
    const locked = (() => {
      try {
        return memory.sources.checkFolder(watch.id);
      } finally {
        chmodSync(docs, 0o700);
      }
    })();
    assert.equal(locked.check?.status, 'failed');
    assert.match(locked.check!.error!, /approve it again/);
    assert.equal(leaked(locked), false);
    assert.deepEqual(memory.sources.checkFolder(watch.id).candidates.map((candidate) => candidate.key), ['plain.txt', 'plan.md']);
  }

  rmSync(docs, { recursive: true, force: true });
  assert.deepEqual(memory.sources.get(watch.id).folder, { approved: true, available: false });
  assert.equal(memory.sources.checkFolder(watch.id).check?.status, 'failed');
  assert.deepEqual(memory.sources.revokeFolder(watch.id).folder, { approved: false, available: false });
});

test('folder watches need an on-disk library', (t) => {
  const { memory } = library(t, true);
  const watch = memory.sources.create({ name: 'Docs', kind: 'folder' });
  assert.throws(() => memory.sources.approveFolder(watch.id, folder(t)), failsWith('invalid', /on disk/));
});

test('folder checks read only the bounded top level and queue previews without importing anything', (t) => {
  const { memory } = library(t);
  const docs = folder(t);
  writeFileSync(join(docs, 'plan.md'), '# Plan\nPlant garlic in October.');
  writeFileSync(join(docs, 'readme.txt'), 'Soil test results');
  writeFileSync(join(docs, 'photo.png'), 'not imported');
  writeFileSync(join(docs, '.hidden.md'), 'hidden');
  mkdirSync(join(docs, 'nested'));
  writeFileSync(join(docs, 'nested', 'deep.md'), 'never read');
  const outside = folder(t);
  writeFileSync(join(outside, 'secret.md'), 'outside the folder');
  symlinkSync(join(outside, 'secret.md'), join(docs, 'linked.md'));
  writeFileSync(join(docs, 'huge.pdf'), '');
  truncateSync(join(docs, 'huge.pdf'), SOURCE_LIMITS.fileBytes + 1);

  const watch = memory.sources.create({ name: 'Garden docs', kind: 'folder' });
  memory.sources.approveFolder(watch.id, docs);
  const before = memory.items.list({}, 200).length;
  const queue = memory.sources.checkFolder(watch.id);
  assert.deepEqual(queue.candidates.map((candidate) => candidate.key), ['plan.md', 'readme.txt']);
  assert.equal(queue.check?.skipped, 1);
  assert.equal(queue.check?.truncated, false);
  assert.equal(queue.candidates[0]!.change, 'new');
  assert.match(queue.candidates[0]!.text, /Plant garlic/);
  assert.equal(queue.candidates[0]!.file?.mimeType, 'text/markdown');
  assert.equal(memory.items.list({}, 200).length, before);
  assert.equal(memory.sources.get(watch.id).pending, 2);

  const again = memory.sources.checkFolder(watch.id);
  assert.deepEqual(again.candidates.map((candidate) => candidate.id), queue.candidates.map((candidate) => candidate.id));
});

test('folder checks cap the number of files and report truncation', (t) => {
  const { memory } = library(t);
  const docs = folder(t);
  for (let index = 0; index < SOURCE_LIMITS.folderFiles + 5; index++) writeFileSync(join(docs, `note-${String(index).padStart(3, '0')}.txt`), `Note ${index}`);
  const watch = memory.sources.create({ name: 'Many', kind: 'folder' });
  memory.sources.approveFolder(watch.id, docs);
  const queue = memory.sources.checkFolder(watch.id);
  assert.equal(queue.candidates.length, SOURCE_LIMITS.folderFiles);
  assert.equal(queue.check?.found, SOURCE_LIMITS.folderFiles);
  assert.equal(queue.check?.truncated, true);
});

test('applying folder previews re-verifies bytes, keeps originals and earlier snapshots, and repeats safely', (t) => {
  const { memory } = library(t);
  const docs = folder(t);
  const path = join(docs, 'plan.md');
  writeFileSync(path, 'Plant garlic in October.');
  const project = memory.projects.create({ name: 'Garden' });
  const watch = memory.sources.create({ name: 'Garden docs', kind: 'folder', project: 'garden' });
  memory.sources.approveFolder(watch.id, docs);

  const [first] = memory.sources.checkFolder(watch.id).candidates;
  const applied = memory.sources.apply(watch.id, [first!.id]);
  const original = memory.items.get(applied.applied[0]!.itemId);
  assert.equal(original.type, 'file');
  assert.equal(original.project?.id, project.id);
  assert.equal(original.attachments[0]!.sha256, first!.file!.sha256);
  assert.equal((original.metadata.watchedFrom as { key: string }).key, 'plan.md');
  assert.equal(readFileSync(path, 'utf8'), 'Plant garlic in October.');
  assert.deepEqual(memory.sources.apply(watch.id, [first!.id]), applied);
  assert.equal(memory.sources.queue(watch.id).candidates.length, 0);
  assert.equal(memory.sources.checkFolder(watch.id).check?.unchanged, 1);

  writeFileSync(path, 'Plant garlic in late October, after the first rain.');
  const [changed] = memory.sources.checkFolder(watch.id).candidates;
  assert.equal(changed!.change, 'changed');
  assert.equal(changed!.targetId, original.id);
  writeFileSync(path, 'Edited again before the preview was applied, so it is stale.');
  assert.throws(() => memory.sources.apply(watch.id, [changed!.id]), failsWith('conflict', /changed or moved since it was previewed/));
  assert.equal(memory.items.get(original.id).relations.length, 0);

  const [fresh] = memory.sources.checkFolder(watch.id).candidates;
  const snapshot = memory.sources.apply(watch.id, [fresh!.id]).applied[0]!;
  assert.equal(snapshot.previousId, original.id);
  assert.notEqual(snapshot.itemId, original.id);
  const earlier = memory.items.get(original.id);
  assert.equal(earlier.archivedAt, null);
  assert.equal(earlier.attachments[0]!.sha256, original.attachments[0]!.sha256);
  assert.deepEqual(memory.items.get(snapshot.itemId).relations.map((relation) => [relation.kind, relation.direction, relation.id]), [['supersedes', 'outgoing', original.id]]);
  assert.equal(readFileSync(path, 'utf8'), 'Edited again before the preview was applied, so it is stale.');

  const unknown = '01900000-0000-7000-8000-000000000000';
  assert.throws(() => memory.sources.apply(watch.id, [unknown]), failsWith('conflict', /no longer queued/));
  assert.throws(() => memory.sources.apply(watch.id, []), failsWith('invalid'));
});

test('a watched file that returns to earlier bytes becomes a new snapshot in a one-way supersedes chain', (t) => {
  const { memory } = library(t);
  const docs = folder(t);
  const path = join(docs, 'plan.md');
  const watch = memory.sources.create({ name: 'Plans', kind: 'folder' });
  memory.sources.approveFolder(watch.id, docs);
  const snapshot = (text: string) => {
    writeFileSync(path, text);
    const queue = memory.sources.checkFolder(watch.id);
    assert.equal(queue.candidates.length, 1);
    return memory.sources.apply(watch.id, [queue.candidates[0]!.id]).applied[0]!;
  };
  const a = snapshot('Plant garlic in October.');
  const b = snapshot('Plant garlic in November.');
  const back = snapshot('Plant garlic in October.');
  assert.equal(new Set([a.itemId, b.itemId, back.itemId]).size, 3);
  assert.equal(b.previousId, a.itemId);
  assert.equal(back.previousId, b.itemId);
  const links = (id: string) => memory.items.get(id).relations.map((relation) => `${relation.kind} ${relation.direction} ${relation.id}`).sort();
  assert.deepEqual(links(back.itemId), [`supersedes outgoing ${b.itemId}`]);
  assert.deepEqual(links(b.itemId), [`supersedes incoming ${back.itemId}`, `supersedes outgoing ${a.itemId}`].sort());
  assert.deepEqual(links(a.itemId), [`supersedes incoming ${b.itemId}`]);
  const first = memory.items.get(a.itemId);
  assert.equal(first.content, 'Plant garlic in October.');
  assert.equal(memory.items.get(back.itemId).attachments[0]!.sha256, first.attachments[0]!.sha256);
  assert.equal(memory.sources.checkFolder(watch.id).candidates.length, 0);
});

test('re-approving a folder invalidates its earlier previews', (t) => {
  const { memory } = library(t);
  const docs = folder(t);
  writeFileSync(join(docs, 'a.md'), 'Alpha');
  const watch = memory.sources.create({ name: 'Docs', kind: 'folder' });
  memory.sources.approveFolder(watch.id, docs);
  const [candidate] = memory.sources.checkFolder(watch.id).candidates;
  memory.sources.approveFolder(watch.id, docs);
  assert.equal(memory.sources.queue(watch.id).candidates.length, 0);
  assert.throws(() => memory.sources.apply(watch.id, [candidate!.id]), failsWith('conflict'));
});

test('URL and feed checks queue bounded previews; apply preserves the person’s note and history and refuses stale previews', (t) => {
  const { memory } = library(t, true);
  const watch = memory.sources.create({ name: 'Garden feed', kind: 'rss', url: 'https://garden.example/feed.xml' });
  const entry = { key: 'urn:entry:1', title: 'Garlic timing', url: 'https://garden.example/garlic', text: 'Plant garlic in October.', publishedAt: '2026-09-01T00:00:00Z' };

  const stale = memory.sources.recordCheck(watch.id, { sourceHash: 'f'.repeat(64), observations: [entry] });
  assert.equal(stale.check?.status, 'stale');
  assert.equal(stale.candidates.length, 0);
  assert.throws(() => memory.sources.recordCheck(watch.id, {
    sourceHash: watch.hash, observations: Array.from({ length: SOURCE_LIMITS.entries + 1 }, (_, index) => ({ ...entry, key: `k${index}` })),
  }), failsWith('invalid', /at most 50/));
  const failed = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, error: 'garden.example answered 503.' });
  assert.equal(failed.check?.status, 'failed');
  assert.equal(failed.check?.error, 'garden.example answered 503.');

  const long = { key: 'urn:entry:2', title: 'Long', url: null, text: 'x'.repeat(SOURCE_LIMITS.candidateText + 10), publishedAt: null };
  const queue = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [entry, long, { ...entry, key: 'urn:entry:dupe-url' }] });
  assert.equal(queue.candidates.length, 2);
  assert.equal(queue.candidates[1]!.text.length, SOURCE_LIMITS.candidateText);
  assert.equal(queue.candidates[1]!.truncated, true);
  assert.equal(queue.check?.truncated, true);
  assert.equal(memory.items.list({ type: 'bookmark' }).length, 0);

  const created = memory.sources.apply(watch.id, [queue.candidates[0]!.id]).applied[0]!;
  const bookmark = memory.items.get(created.itemId);
  assert.equal(bookmark.type, 'bookmark');
  assert.equal(bookmark.url, 'https://garden.example/garlic');
  assert.equal(bookmark.content, 'Plant garlic in October.');
  assert.equal(bookmark.metadata.publishedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(bookmark.metadata.ingest?.status, 'done');
  memory.items.update(bookmark.id, { body: 'My own note about garlic.' });

  const unchanged = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [entry] });
  assert.equal(unchanged.candidates.length, 0);
  assert.equal(unchanged.check?.unchanged, 1);

  const revised = { ...entry, text: 'Plant garlic in late October.' };
  const [update] = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [revised] }).candidates;
  assert.equal(update!.change, 'changed');
  assert.equal(update!.targetId, bookmark.id);
  memory.items.update(bookmark.id, { body: 'Edited after the preview.' });
  assert.throws(() => memory.sources.apply(watch.id, [update!.id]), failsWith('conflict', /changed since this was previewed/));
  assert.equal(memory.items.get(bookmark.id).content, 'Plant garlic in October.');

  const [retry] = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [revised] }).candidates;
  memory.sources.apply(watch.id, [retry!.id]);
  const updated = memory.items.get(bookmark.id);
  assert.equal(updated.content, 'Plant garlic in late October.');
  assert.equal(updated.body, 'Edited after the preview.');
  const history = memory.versions.list(bookmark.id).items.map((version) => memory.versions.get(version.id).snapshot.items[0]!.item.content);
  assert.ok(history.includes('Plant garlic in October.'));

  const [pending] = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [{ ...revised, text: 'Third revision.' }] }).candidates;
  memory.sources.update(watch.id, { url: 'https://garden.example/other.xml' });
  assert.equal(memory.sources.queue(watch.id).candidates.length, 0);
  assert.throws(() => memory.sources.apply(watch.id, [pending!.id]), failsWith('conflict'));
});

test('an existing bookmark for the same URL is updated in place instead of duplicated', (t) => {
  const { memory } = library(t, true);
  const saved = memory.items.saveLink({ url: 'https://news.example/post', note: 'Saved by hand', ingest: false });
  const watch = memory.sources.create({ name: 'Post', kind: 'url', url: 'https://news.example/post' });
  const [candidate] = memory.sources.recordCheck(watch.id, {
    sourceHash: watch.hash, observations: [{ key: 'https://news.example/post', title: 'Post', url: 'https://news.example/post', text: 'Body text', publishedAt: null }],
  }).candidates;
  assert.equal(candidate!.targetId, saved.item.id);
  memory.sources.apply(watch.id, [candidate!.id]);
  assert.equal(memory.items.list({ type: 'bookmark' }).length, 1);
  assert.equal(memory.items.get(saved.item.id).body, 'Saved by hand');
  assert.equal(memory.items.get(saved.item.id).content, 'Body text');
});

test('a feed never adopts a saved bookmark, so its short summary can’t replace the saved article', (t) => {
  const { memory } = library(t, true);
  const saved = memory.items.saveLink({ url: 'https://news.example/post', note: 'Saved by hand', ingest: false }).item;
  memory.items.setSource(saved.id, { content: 'The whole article, as it was saved.', metadata: {} });
  const before = memory.items.get(saved.id);
  const watch = memory.sources.create({ name: 'News', kind: 'rss', url: 'https://news.example/feed.xml' });
  const entry = { key: 'post-1', title: 'Post', url: 'https://news.example/post', text: 'A short summary.', publishedAt: null };
  const [candidate] = memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [entry] }).candidates;
  assert.equal(candidate!.change, 'new');
  assert.equal(candidate!.targetId, null);
  const applied = memory.sources.apply(watch.id, [candidate!.id]).applied[0]!;
  assert.notEqual(applied.itemId, saved.id);
  assert.equal(memory.items.get(applied.itemId).content, 'A short summary.');
  const after = memory.items.get(saved.id);
  assert.equal(after.content, 'The whole article, as it was saved.');
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.metadata.watchedFrom, undefined);
  assert.equal(memory.sources.recordCheck(watch.id, { sourceHash: watch.hash, observations: [entry] }).check?.unchanged, 1);
});

test('due lists only enabled, checkable watches, least recently checked first', (t) => {
  const { memory } = library(t, true);
  const off = memory.sources.create({ name: 'Off', kind: 'url', url: 'https://a.example/' });
  const on = memory.sources.create({ name: 'On', kind: 'url', url: 'https://b.example/', enabled: true });
  const unapproved = memory.sources.create({ name: 'Folder', kind: 'folder', enabled: true });
  assert.deepEqual(memory.sources.due(0), [on.id]);
  assert.deepEqual(memory.sources.due(0, SOURCE_LIMITS.watches, ['folder']), []);
  memory.sources.recordCheck(on.id, { sourceHash: on.hash, observations: [] });
  assert.deepEqual(memory.sources.due(60_000), []);
  assert.ok(![off.id, unapproved.id].some((id) => memory.sources.due(0).includes(id)));
});

test('freshness scope is bounded and leaves out decisions, secrets, chats, definitions, templates and archived items', (t) => {
  const { memory } = library(t, true);
  memory.projects.create({ name: 'Garden' });
  const note = memory.items.saveNote({ title: 'Garlic', body: 'Plant garlic in October.', project: 'garden' });
  const link = memory.items.saveLink({ url: 'https://garden.example/garlic', title: 'Garlic guide', project: 'garden', ingest: false }).item;
  memory.decisions.record({ project: 'garden', decision: 'Grow garlic', reason: 'garlic keeps' });
  memory.items.insert({ type: 'note', title: 'Secret note', body: '', project: 'garden', metadata: { secret: true } });
  memory.items.insert({ type: 'note', title: 'Garlic chat', body: 'garlic transcript', project: 'garden', metadata: { conversation: { version: 1 } } });
  const feed = memory.sources.create({ name: 'Garlic feed', kind: 'rss', url: 'https://garden.example/feed', project: 'garden' });
  memory.items.update(feed.id, { project: 'garden' });
  const template = memory.items.saveNote({ title: 'Garlic template source', body: 'garlic', project: 'garden' });
  memory.items.update(memory.templates.create(template.id, 'Garlic template').id, { project: 'garden' });
  const archived = memory.items.saveNote({ title: 'Old garlic', body: 'garlic', project: 'garden' });
  memory.items.archive(archived.id);
  memory.tasks.create({ title: 'Garlic task', project: 'garden' });

  const scope = memory.sources.freshnessScope({ project: 'garden' });
  assert.deepEqual(scope.items.map((item) => item.id).sort(), [note.id, link.id, template.id].sort());
  const item = scope.items.find((entry) => entry.id === note.id)!;
  assert.equal(item.excerpt, 'Plant garlic in October.');
  assert.deepEqual(Object.keys(item.dates), ['publishedAt', 'capturedAt', 'editedAt', 'checkedAt']);
  assert.match(scope.baseHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(memory.sources.freshnessScope({ query: 'garlic', project: 'garden' }).items.map((entry) => entry.id).sort(), [note.id, link.id, template.id].sort());
  assert.throws(() => memory.sources.freshnessScope({}), failsWith('invalid'));
  assert.throws(() => memory.sources.freshnessScope({ rootId: note.id, query: 'garlic' }), failsWith('invalid'));

  for (let index = 0; index < SOURCE_LIMITS.freshnessItems; index++) memory.items.saveNote({ body: `Bulk ${index}`, project: 'garden' });
  assert.throws(() => memory.sources.freshnessScope({ project: 'garden' }), failsWith('invalid', /More than 100/));
});

test('staleness is deterministic by the chosen age; checking, dismissing and superseding are guarded and keep content', (t) => {
  const { memory } = library(t, true);
  const old = memory.items.saveNote({ title: 'Frost date', body: 'Last frost is April 10.', createdAt: '2024-01-01T00:00:00.000Z' });
  const newer = memory.items.saveNote({ title: 'Frost date 2026', body: 'Last frost is April 20.' });
  const garden = memory.projects.create({ name: 'Garden' });
  const decision = memory.decisions.record({ project: garden.id, decision: 'Plant after frost' });

  const stale = memory.sources.staleItems({ olderThanDays: 365 });
  assert.deepEqual(stale.items.map((item) => item.id), [old.id]);
  assert.equal(stale.items[0]!.basis, 'edited');
  assert.ok(stale.items[0]!.ageDays >= 365);
  assert.throws(() => memory.sources.staleItems({ olderThanDays: 0 }), failsWith('invalid'));

  const [oldItem] = stale.items;
  memory.items.update(old.id, { body: 'Last frost is April 10 (from 2023 notes).' });
  assert.throws(() => memory.sources.markChecked({ id: old.id, stateHash: oldItem!.stateHash }), failsWith('conflict', /changed since/));
  assert.throws(() => memory.sources.markChecked({ id: decision.id, stateHash: 'x' }), failsWith('invalid', /append-only/));

  const scope = memory.sources.freshnessScope({ query: 'frost' });
  const ref = (id: string) => ({ id, stateHash: scope.items.find((item) => item.id === id)!.stateHash });
  const dismissed = memory.sources.dismissPair([ref(old.id), ref(newer.id)]);
  assert.deepEqual(dismissed.itemIds, [old.id, newer.id]);
  assert.deepEqual(memory.sources.dismissPair([ref(old.id), ref(newer.id)]), dismissed);
  const rescoped = memory.sources.freshnessScope({ query: 'frost' });
  assert.deepEqual(rescoped.items.find((item) => item.id === old.id)!.dismissed, [newer.id]);

  const live = (id: string) => ({ id, stateHash: rescoped.items.find((item) => item.id === id)!.stateHash });
  assert.throws(() => memory.sources.supersede({ newer: live(newer.id), older: { id: decision.id, stateHash: 'x' } }), failsWith('invalid', /append-only/));
  const receipt = memory.sources.supersede({ newer: live(newer.id), older: live(old.id) });
  assert.deepEqual(receipt.itemIds, [newer.id, old.id]);
  assert.deepEqual(memory.sources.supersede({ newer: live(newer.id), older: live(old.id) }), receipt);
  const kept = memory.items.get(old.id);
  assert.equal(kept.body, 'Last frost is April 10 (from 2023 notes).');
  assert.equal((kept.metadata.freshness as { supersededBy: string }).supersededBy, newer.id);
  assert.deepEqual(memory.items.get(newer.id).relations.map((relation) => [relation.kind, relation.direction, relation.id]), [['supersedes', 'outgoing', old.id]]);
  assert.deepEqual(memory.sources.freshnessScope({ query: 'frost' }).items.map((item) => item.id), [newer.id]);
  assert.equal(memory.decisions.list(garden.id)[0]!.supersededBy, null);

  const current = memory.sources.freshnessScope({ query: 'frost' }).items[0]!;
  const checked = memory.sources.markChecked({ id: newer.id, stateHash: current.stateHash });
  assert.deepEqual(memory.sources.markChecked({ id: newer.id, stateHash: current.stateHash }), checked);
  assert.equal(memory.items.get(newer.id).body, 'Last frost is April 20.');
  assert.equal(memory.sources.freshnessScope({ query: 'frost' }).items[0]!.dates.checkedAt, checked.at);
});
