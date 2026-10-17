import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, openDatabase, pathsFor } from '@enve-memory/core';

test('public references cannot reintroduce an excluded reference through another visible title', () => {
  const memory = EnveMemory.open({ inMemory: true, actor: 'test' });
  try {
    const root = memory.outline.createNote({ parentId: null, title: 'Party planning' }).item;
    const hidden = memory.outline.createNote({ parentId: root.id, title: 'Surprise present' }).item;
    const visible = memory.outline.createNote({ parentId: root.id, title: `Plan [[item:${hidden.id}|Unpublished surprise]]` }).item;
    memory.outline.createNote({ parentId: root.id, title: 'Link', body: `[[item:${visible.id}]]` });
    const { token } = memory.shares.create(root.id, { excludedIds: [hidden.id] });
    const projection = JSON.stringify(memory.shares.view(token));
    for (const marker of [hidden.id, 'Unpublished surprise', 'Surprise present']) assert.equal(projection.includes(marker), false, marker);
    assert.ok(projection.includes(visible.id));
  } finally {
    memory.close();
  }
});

test('public projection bounds a wide subtree and refuses partial publication', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-share-cap-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let memory = EnveMemory.open({ home, actor: 'test' });
  const root = memory.outline.createNote({ parentId: null, title: 'Large outline' }).item;
  const { token } = memory.shares.create(root.id);
  memory.close();
  const db = openDatabase(pathsFor(home).database);
  // Bulk ordinary rows keep this boundary fixture independent of journal and snapshot costs.
  db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 5000)
    INSERT INTO items (id, type, title, body, metadata, source, created_at, updated_at, parent_id, sort_order)
    SELECT printf('019d0000-0000-7000-8000-%012x', x), 'note', 'Visible child', '', '{}', 'test', ?, ?, ?, x FROM n`).run(
    root.createdAt, root.updatedAt, root.id,
  );
  db.close();
  memory = EnveMemory.open({ home, actor: 'test' });
  try {
    assert.throws(() => memory.shares.view(token), /too large/);
    memory.items.archive('019d0000-0000-7000-8000-000000000001');
    assert.equal(memory.shares.view(token).items.length, 5000);
  } finally {
    memory.close();
  }
});
