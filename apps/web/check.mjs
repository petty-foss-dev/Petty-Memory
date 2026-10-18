import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = ['server.ts', 'build.mjs', 'research-assets.mjs', 'check.mjs', ...readdirSync(join(root, 'public'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => join('public', name))];

for (const file of files) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
}
