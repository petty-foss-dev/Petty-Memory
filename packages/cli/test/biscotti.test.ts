import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';

test('the CLI previews by default and imports only explicitly selected meetings with --apply', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'petty-cli-biscotti-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'meetings.csv');
  writeFileSync(file, 'id,title,created,summary,notes,transcript\none,Planning,2026-10-19,Buy cedar.,,\ntwo,Check-in,2026-10-20,Check delivery.,,');
  const run = (...extra: string[]) => {
    const result = spawnSync(process.execPath, ['packages/cli/src/main.ts', '--home', home, '--json', 'import', 'biscotti', file, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run().entries.length, 2);
  let memory = EnveMemory.open({ home, actor: 'test' });
  assert.equal(memory.items.list({ importedKind: 'biscotti' }).length, 0);
  memory.close();
  assert.equal(run('--apply', '--ids', 'two').created, 1);
  assert.equal(run('--apply', '--ids', 'two').skipped, 1);
  memory = EnveMemory.open({ home, actor: 'test' });
  assert.deepEqual(memory.items.list({ importedKind: 'biscotti' }).map((item) => item.title), ['Check-in']);
  memory.close();
});
