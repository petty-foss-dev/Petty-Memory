import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { buildEditor } from '@enve-memory/editor/build';
import { root, targets } from './bundle.mjs';

rmSync(join(root, 'dist'), { recursive: true, force: true });
await Promise.all(Object.values(targets).map((options) => esbuild(options)));
await vite({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
// The browser client's static files, served by the app's local API for /s/<token> share links.
cpSync(join(root, '..', 'web', 'public'), join(root, 'dist', 'web'), { recursive: true });
await buildEditor(join(root, 'dist', 'web', 'vendor'));
console.log('Built apps/desktop/dist');
