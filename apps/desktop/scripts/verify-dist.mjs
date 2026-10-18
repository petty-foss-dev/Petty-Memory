// Smoke-tests a packaged macOS app against a throwaway library:
//   node scripts/verify-dist.mjs ["/path/to/Petty Memory.app"]
// 1. the bundled CLI runs under the app's own runtime (ELECTRON_RUN_AS_NODE) and serves MCP over stdio,
// 2. the app starts, answers /api/v1/status on a free port, and quits cleanly,
// 3. keyword search works from the packaged CLI; if the embedding model is already cached and the build has the runtime,
//    the app's semantic indexer (onnxruntime-node) runs in the packaged app. Intel builds must report semantic search off.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from './bundle.mjs';

const app = resolve(process.argv[2] ?? join(root, 'release', 'mac-arm64', 'Petty Memory.app'));
const executable = join(app, 'Contents', 'MacOS', 'Petty Memory');
const cli = join(app, 'Contents', 'Resources', 'cli.mjs');
const home = mkdtempSync(join(tmpdir(), 'enve-dist-'));
// Intel builds ship without onnxruntime-node (it has no darwin-x64 binary); they must degrade to keyword search.
const intel = execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim() === 'x86_64';
if (intel && process.arch === 'arm64') {
  try {
    execFileSync('arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' });
  } catch {
    console.error('This is an Intel build and Rosetta 2 is not installed, so it cannot run on this Mac.');
    process.exit(1);
  }
}
const cache = [join(root, '..', '..', '.cache'), join(homedir(), 'Library', 'Caches', 'Enve Memory')]
  .find((dir) => existsSync(join(dir, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx')));
const env = { ...process.env, ENVE_MEMORY_HOME: home, ...(cache ? { ENVE_MEMORY_CACHE: cache } : {}) };
const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
const runCli = (...args) => JSON.parse(execFileSync(executable, [cli, '--home', home, '--json', ...args], { env: nodeEnv, encoding: 'utf8' }));

const freePort = () => new Promise((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

async function waitFor(check, what, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

try {
  runCli('settings', 'fetchLinks', 'false');
  runCli('settings', 'semanticSearch', cache || intel ? 'true' : 'false');
  console.log(`library ${home}; ${intel ? 'Intel build' : 'Apple Silicon build'}; semantic search ${intel ? 'requested (must stay unavailable)' : cache ? `on (model cache ${cache})` : 'off (no cached model)'}`);

  const client = new Client({ name: 'dist-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: executable, args: [cli, 'mcp'], env: nodeEnv, stderr: 'pipe' }));
  const info = client.getServerVersion();
  assert.equal(info?.name, 'petty-memory');
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('save_note') && tools.includes('search'));
  await client.callTool({ name: 'save_note', arguments: { text: 'The garage door opener uses rolling codes so a recorded press cannot be replayed.' } });
  const found = JSON.parse((await client.callTool({ name: 'search', arguments: { query: 'rolling codes' } })).content[0].text);
  assert.ok(JSON.stringify(found).includes('garage door opener'));
  await client.close();
  console.log(`✔ packaged MCP server: initialize as ${info.name} ${info.version}, ${tools.length} tools, save_note + search`);

  const port = await freePort();
  const child = spawn(executable, [], { env: { ...env, ENVE_MEMORY_PORT: String(port), ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1' }, stdio: 'ignore' });
  const exited = new Promise((done) => child.once('exit', done));
  const status = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
    return response.ok && response.json();
  }, 'the API');
  assert.equal(status.name, 'enve-memory');
  console.log(`✔ packaged app: /api/v1/status on port ${port} → ${JSON.stringify(status)}`);

  const keyword = runCli('search', 'rolling', 'codes');
  assert.ok(keyword.some((hit) => hit.snippet.includes('[rolling]')));
  console.log(`✔ packaged CLI keyword search: ${keyword.length} hit`);

  if (intel) {
    assert.equal(runCli('info').semanticIndex, 'off');
    console.log('✔ Intel build: semantic search reports itself unavailable; nothing tried to load onnxruntime');
  } else if (cache) {
    const indexed = await waitFor(async () => {
      const { semanticIndex } = runCli('info');
      return /^[1-9]\d* indexed/.test(semanticIndex) && semanticIndex;
    }, 'the app to index the note', 60_000);
    console.log(`✔ packaged app loaded onnxruntime-node and indexed: ${indexed}`);
    const hits = runCli('search', 'replaying', 'a', 'captured', 'remote', 'signal');
    assert.ok(hits.some((hit) => hit.match !== 'keyword'), 'a paraphrase matches on meaning');
    console.log(`✔ packaged CLI semantic search: ${hits.map((h) => `${h.match}`).join(', ')}`);
  }

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/status`));
  console.log('✔ packaged app quit cleanly and released its port');
} finally {
  rmSync(home, { recursive: true, force: true });
}
