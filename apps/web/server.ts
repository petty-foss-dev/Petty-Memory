import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApiServer } from '@enve-memory/api';
import { EnveMemory } from '@enve-memory/core';
import { enrichWorker, organizeWorker, providerFor } from '@enve-memory/ai';
import { attachLocalEmbedder, indexWorker } from '@enve-memory/embeddings';

const DEFAULT_WEB_PORT = 49232;

const USAGE = `Usage: node apps/web/server.ts [--home DIR] [--port N] [--lan --origin URL] [--origin URL]

  --home DIR     Library folder (default $ENVE_MEMORY_HOME or the platform data folder)
  --port N       Port to listen on (default ${DEFAULT_WEB_PORT})
  --lan          Also accept connections from other devices; requires --origin
  --origin URL   The exact origin browsers use to reach this server, e.g. http://192.168.1.20:${DEFAULT_WEB_PORT}
  --max-upload-mb N  Maximum encrypted-file or binary upload (default200)
  --max-json-kb N    Maximum ordinary JSON request (default2048)
  --max-sync-mb N    Maximum sync JSON request (default32)
  --max-writes N     Concurrent write requests (default8)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const args = (() => {
  try {
    return parseArgs({
      options: {
        home: { type: 'string' },
        port: { type: 'string' },
        lan: { type: 'boolean', default: false },
        origin: { type: 'string' },
        'max-upload-mb': { type: 'string' },
        'max-json-kb': { type: 'string' },
        'max-sync-mb': { type: 'string' },
        'max-writes': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    fail((error as Error).message);
  }
})();
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = args.port === undefined ? DEFAULT_WEB_PORT : Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid port "${args.port}".`);

function serverLimit(name: 'max-upload-mb' | 'max-json-kb' | 'max-sync-mb' | 'max-writes', unit = 1): number | undefined {
  if (args[name] === undefined) return undefined;
  const value = Number(args[name]) * unit;
  if (!Number.isSafeInteger(value) || value < 1) fail(`--${name} must be positive.`);
  return value;
}
const maxUploadBytes = serverLimit('max-upload-mb', 1024 * 1024);
const maxJsonBytes = serverLimit('max-json-kb', 1024);
const maxSyncBytes = serverLimit('max-sync-mb', 1024 * 1024);
const maxConcurrentWrites = serverLimit('max-writes');

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`--origin must be a URL such as http://192.168.1.20:${port}.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('--origin must use http or https.');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('--origin is a scheme, host and port only, with no path.');
  return url.origin;
}

// A LAN listener without a named origin would leave the browser's Origin unverifiable.
if (args.lan && !args.origin) fail('--lan needs --origin set to the address other devices will open.');
const origin = args.origin ? normalizeOrigin(args.origin) : `http://127.0.0.1:${port}`;

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const webRoot = fileURLToPath(new URL('./public/', import.meta.url));
const home = args.home ?? process.env.ENVE_MEMORY_HOME;

const memory = EnveMemory.open({ home, actor: 'web' });
const embedder = attachLocalEmbedder(memory);
const indexer = embedder ? indexWorker(memory, embedder) : null;
const provider = () => {
  try { return providerFor(memory); }
  catch (error) { console.error('AI:', (error as Error).message); return null; }
};
const enricher = enrichWorker(memory, provider, () => indexer?.kick());
const organizer = organizeWorker(memory, provider, () => indexer?.kick());
const api = createApiServer(memory, {
  version: pkg.version, port, lan: args.lan, webRoot, webOrigins: [origin], aiProvider: provider,
  maxUploadBytes, maxJsonBytes, maxSyncBytes, maxConcurrentWrites,
  afterWrite: () => { indexer?.kick(); enricher.kick(); organizer.kick(); },
});

try {
  await api.listen();
} catch (error) {
  memory.close();
  console.error(`Couldn't listen on port ${port}: ${(error as Error).message}`);
  process.exit(1);
}
api.ingest.kick();
indexer?.kick();
enricher.kick();
organizer.kick();
const backup = () => {
  try { memory.backups.runSchedule(); }
  catch (error) { console.error('backup:', (error as Error).message); }
};
backup();
const backupTimer = setInterval(backup, 10 * 60_000);
console.error(`Petty Memory web listening on ${origin}${args.lan ? ' (also reachable from your network)' : ''}
Library: ${home ?? 'platform default'}
Open ${origin}/ and connect with a token from \`petty-memory clients add "Browser" --scope read,write\`.`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(backupTimer);
  await api.close();
  await Promise.all([indexer?.idle(), enricher.idle(), organizer.idle()]);
  memory.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
