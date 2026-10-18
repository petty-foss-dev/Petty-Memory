import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repo = resolve(root, '..', '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

// Native or model-loading packages stay out of the bundle and load from node_modules at runtime.
const external = ['electron', 'onnxruntime-node', 'onnxruntime-web', 'sharp', '@huggingface/transformers', 'tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng'];
// Bundled CommonJS dependencies still call require() for Node built-ins.
const requireShim = "import { createRequire as __enveCreateRequire } from 'node:module'; const require = __enveCreateRequire(import.meta.url);";

const node = { bundle: true, platform: 'node', target: 'node24', external, sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' };

/** esbuild options for everything outside the renderer: main, preload, and the standalone CLI the packaged app runs as its MCP server. */
export const targets = {
  main: { ...node, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(dist, 'main.js'), format: 'esm', banner: { js: requireShim } },
  preload: { ...node, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(dist, 'preload.cjs'), format: 'cjs', external: ['electron'], target: 'chrome140' },
  cli: { ...node, entryPoints: [join(repo, 'packages/cli/src/main.ts')], outfile: join(dist, 'cli.mjs'), format: 'esm', banner: { js: requireShim } },
  ocr: { ...node, entryPoints: [require.resolve('tesseract.js/src/worker-script/node/index.js')], outfile: join(dist, 'ocr-worker.cjs'), format: 'cjs', external: ['tesseract.js-core'] },
};
