import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory, openDatabase, pathsFor } from '@enve-memory/core';

test('old far-future log stamps cannot poison the next local writer after reopening', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-clock-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let memory = EnveMemory.open({ home, actor: 'test' });
  const note = memory.items.saveNote({ body: 'Original' });
  const device = memory.deviceId;
  memory.close();
  const db = openDatabase(pathsFor(home).database);
  db.prepare(`UPDATE changes SET hlc = ? WHERE entity_id = ?`).run(`2099-01-01T00:00:00.000Z-000000-${device}`, note.id);
  db.close();
  memory = EnveMemory.open({ home, actor: 'test' });
  try {
    memory.items.update(note.id, { body: 'Current honest edit' });
    const stamp = memory.sync.exportChanges(0).records.find((record) => record.id === note.id)!.hlc;
    assert.ok(Date.parse(stamp.slice(0, 24)) <= Date.now() + 5000);
  } finally {
    memory.close();
  }
});
