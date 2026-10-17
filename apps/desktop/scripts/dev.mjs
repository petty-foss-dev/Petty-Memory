import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { buildEditor } from '@enve-memory/editor/build';
import { root, targets } from './bundle.mjs';

// In development the API serves apps/web/public directly, so the browser client's editor bundle is built there.
await buildEditor(join(root, '..', 'web', 'public', 'vendor'));

const electron = createRequire(import.meta.url)('electron');
const server = await createServer({ configFile: join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];

let child = null;
let restarting = false;
let quitting = false;
let timer = null;

function launch() {
  child = spawn(electron, [root], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
  child.once('exit', (code) => {
    child = null;
    if (!restarting && !quitting) void shutdown(code ?? 0);
  });
}

// The single-instance lock means the old app must be gone before the new one starts.
function restart() {
  if (quitting) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (quitting) return;
    if (!child) return launch();
    restarting = true;
    child.once('exit', () => {
      restarting = false;
      if (!quitting) launch();
    });
    child.kill('SIGTERM');
  }, 150);
}

// Start Electron only once main and preload have both been built; after that, any rebuild restarts it.
const built = new Set();
const reload = (name) => ({
  name: 'restart-electron',
  setup: (build) => build.onEnd((result) => {
    if (result.errors.length) return;
    built.add(name);
    if (built.size === 2) restart();
  }),
});
const contexts = await Promise.all(
  Object.entries({ main: targets.main, preload: targets.preload }).map(([name, options]) => context({ ...options, plugins: [reload(name)] })),
);
await Promise.all(contexts.map((ctx) => ctx.watch()));

async function shutdown(code) {
  if (quitting) return;
  quitting = true;
  clearTimeout(timer);
  if (child) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  await server.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
