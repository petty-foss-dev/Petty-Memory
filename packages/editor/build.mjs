import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

/** Writes editor.js (a self-contained ES module), editor.css and editor-licenses.txt into `outdir`. */
export async function buildEditor(outdir) {
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    entryPoints: [join(here, 'src/index.ts')],
    outfile: join(outdir, 'editor.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120', 'safari17', 'firefox120'],
    minify: true,
    legalComments: 'none',
    metafile: true,
    absWorkingDir: here,
    logLevel: 'warning',
  });
  copyFileSync(join(here, 'src/editor.css'), join(outdir, 'editor.css'));
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (match) packages.set(match[2], resolve(here, match[1]));
  }
  const notices = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
    const { version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => join(dir, f)).find((f) => { try { readFileSync(f); return true; } catch { return false; } });
    return `## ${name} ${version} (${license})\n\n${file ? readFileSync(file, 'utf8').trim() : license}`;
  });
  writeFileSync(join(outdir, 'editor-licenses.txt'), `# Petty Memory editor: bundled packages\n\n${notices.join('\n\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildEditor(process.argv[2] ?? join(here, 'dist'));
