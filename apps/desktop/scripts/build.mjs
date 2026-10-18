import { copyFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { buildEditor } from '@enve-memory/editor/build';
import { buildResearchAssets } from '../../web/research-assets.mjs';
import { root, targets } from './bundle.mjs';

rmSync(join(root, 'dist'), { recursive: true, force: true });
await Promise.all(Object.values(targets).map((options) => esbuild(options)));
buildResearchAssets(new URL('../../web/public/vendor/', import.meta.url));
await vite({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
copyFileSync(new URL('../../web/public/vendor/pdf-licenses.txt', import.meta.url), join(root, 'dist', 'renderer', 'pdf-licenses.txt'));
// The browser client's static files, served by the app's local API for /s/<token> share links.
cpSync(join(root, '..', 'web', 'public'), join(root, 'dist', 'web'), { recursive: true });
await buildEditor(join(root, 'dist', 'web', 'vendor'));
console.log('Built apps/desktop/dist');
