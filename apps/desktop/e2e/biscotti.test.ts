import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';
import type { BiscottiMeetingPage } from '@enve-memory/importers';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'petty-meetings-'));
const evidence = process.env.ENVE_EVIDENCE_DIR ?? join(tmpdir(), 'petty-biscotti-evidence');
const csvID = '3a629684-65e8-4b7a-a8a4-41ce62ce4baa';
const liveID = 'b27137d4-2bc9-454b-a3c2-64f92ad881e6';
const csv = `id,title,created,summary,notes,transcript\n${csvID},Cedar site meeting,2026-10-19T16:00:00Z,Order the cedar boards.,Keep receipts.,"[0:23] Alex\nOrder cedar boards.\n[0:42] Priya: Keep the receipts."\nsecond-meeting,Friday check-in,2026-10-16T10:00:00Z,Check delivery.,,`;
let app: ElectronApplication;
let page: Page;
let web: Page | undefined;
let fixture: Server;
let fixtureURL = '';
let importedID = '';
const problems: string[] = [];
const mcpCalls: string[] = [];
const prompts: string[] = [];

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(async ([name, values]) => window.enve.call(name as string, ...(values as unknown[])), [method, args] as const);
  assert.ok(result.ok, JSON.stringify(result));
  return (result as { value: T }).value;
}
const nav = (label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).click();
const meetings = async () => {
  await nav('Knowledge');
  await page.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Meetings', exact: true }).click();
};
async function shoot(name: string, target = page) {
  mkdirSync(evidence, { recursive: true });
  await target.screenshot({ path: join(evidence, `${name}.png`) });
}

describe('Biscotti meeting workflows', { timeout: 240_000 }, () => {
  before(async () => {
    const memory = EnveMemory.open({ home, actor: 'fixture' });
    memory.settings.set('semanticSearch', false);
    memory.settings.set('fetchLinks', false);
    memory.close();
    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));
    fixture = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/mcp') {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const rpc = JSON.parse(raw);
        if (rpc.id === undefined) { res.writeHead(202).end(); return; }
        let result: unknown;
        if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Biscotti fixture', version: '1' } };
        else if (rpc.method === 'tools/list') result = { tools: ['biscotti_query_meetings', 'biscotti_get_meeting', 'biscotti_get_transcript'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
        else {
          mcpCalls.push(rpc.params.name);
          const value = rpc.params.name === 'biscotti_query_meetings'
            ? { results: [{ id: liveID, title: 'Launch planning', date: '2026-10-20T15:00:00Z' }], results_truncated: false }
            : rpc.params.name === 'biscotti_get_meeting'
              ? { id: liveID, title: 'Launch planning', date: '2026-10-20T15:00:00Z', summary: 'Confirm the venue.', notes: 'No deadline was agreed.', participants: [{ name: 'Alex' }], tags: ['launch'], transcript: { available: true, id: 'live-transcript' } }
              : { id: liveID, transcript_id: 'live-transcript', text: '[0:15] Alex\nConfirm the venue.' };
          result = { content: [], structuredContent: value };
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        return;
      }
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'fixture' }] })); return; }
      const body = JSON.parse(raw);
      const prompt = body.messages.at(-1).content as string;
      prompts.push(prompt);
      const found = /<items>\n([\s\S]*?)\n<\/items>/.exec(prompt);
      if (!found) { res.writeHead(500).end(JSON.stringify({ error: 'Missing reviewed action scope.' })); return; }
      const sources = JSON.parse(found[1]!) as { ref: string; title: string }[];
      const result = { summary: 'A follow-up from the meeting.', operations: [{ kind: 'task', ref: null, title: 'Order cedar boards', body: '', tags: [], source: sources[0]!.ref, sources: [], when: null }] };
      res.end(JSON.stringify({ message: { content: JSON.stringify(result) } }));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    fixtureURL = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    app = await electron.launch({ args: [root, '--use-mock-keychain'], env: { ...process.env, ENVE_MEMORY_HOME: home, ENVE_MEMORY_PORT: '0', ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1' } });
    page = await app.firstWindow();
    page.on('pageerror', (error) => problems.push(error.message));
    await app.evaluate(({ BrowserWindow, shell }, address) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 860);
      shell.openExternal = async () => {};
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return original(url === 'http://127.0.0.1:8516/mcp' ? `${address}/mcp` : input, init);
      };
    }, fixtureURL);
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await call('ai.configure', { provider: 'ollama', model: 'fixture', baseUrl: fixtureURL });
    await call('ai.setEnrich', false);
  });
  afterEach(async (context) => {
    if ((context as { passed?: boolean }).passed === false) await shoot(`failure-${context.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 70)}`).catch(() => {});
  });
  after(async () => {
    await web?.close();
    await app?.close();
    fixture?.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  });

  test('desktop previews and imports a subset, keeps source text and skips repeat imports', async () => {
    await meetings();
    assert.deepEqual(mcpCalls, [], 'opening Meetings never reads Biscotti');
    await page.locator('.meetings input[type=file]').setInputFiles({ name: 'Biscotti_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    const preview = page.locator('.meetings-panel', { has: page.getByRole('heading', { name: 'Biscotti_export.csv' }) });
    await preview.getByLabel('Cedar site meeting', { exact: true }).waitFor();
    assert.equal((await call<BiscottiMeetingPage>('biscotti.list')).items.length, 0);
    await preview.getByLabel('Friday check-in', { exact: true }).uncheck();
    await preview.getByRole('button', { name: 'Details', exact: true }).first().click();
    await preview.locator('.meetings-transcript').getByText(/Keep the receipts\./).waitFor();
    await shoot('desktop-preview');
    await preview.getByRole('button', { name: 'Import 1 meeting', exact: true }).click();
    await page.getByText(/imported 1, skipped 0 already saved/).waitFor();
    const saved = (await call<BiscottiMeetingPage>('biscotti.list')).items;
    assert.equal(saved.length, 1);
    importedID = saved[0]!.id;
    const item = await call<{ body: string; createdAt: string }>('items.get', importedID);
    assert.match(item.body, /\[0:42\] Priya/);
    assert.equal(item.createdAt, '2026-10-19T16:00:00.000Z');
    await page.locator('.meetings input[type=file]').setInputFiles({ name: 'Biscotti_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByText('Already imported', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Cedar site meeting', { exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('the Mac browser reads a chosen meeting and preserves source playback moments', { skip: process.platform !== 'darwin' }, async () => {
    await page.getByRole('button', { name: 'Browse Biscotti', exact: true }).click();
    assert.deepEqual(mcpCalls, []);
    await page.getByRole('button', { name: 'Connect and search', exact: true }).click();
    await page.getByRole('button', { name: /Launch planning/ }).click();
    await page.getByLabel('Launch planning', { exact: true }).waitFor();
    assert.deepEqual(mcpCalls, ['biscotti_query_meetings', 'biscotti_get_meeting', 'biscotti_get_transcript']);
    assert.equal((await call<BiscottiMeetingPage>('biscotti.list')).items.length, 1);
    await page.getByRole('button', { name: 'Import 1 meeting', exact: true }).click();
    await page.locator('.meetings-card', { hasText: 'Launch planning' }).waitFor();
    const live = (await call<BiscottiMeetingPage>('biscotti.list')).items.find((meeting) => meeting.meetingId === liveID)!;
    assert.deepEqual(live.moments, [{ start: 15, speaker: 'Alex' }]);
    const card = page.locator('.meetings-card', { hasText: 'Launch planning' });
    await card.locator('summary').click();
    await card.getByRole('button', { name: 'Play from 0:15 in Biscotti, Alex' }).click();
    await shoot('desktop-library');
  });

  test('meeting follow-ups enter the real reviewed action flow with no automatic send or apply', async () => {
    const card = page.locator('.meetings-card', { hasText: 'Cedar site meeting' });
    await card.getByRole('button', { name: 'Find follow-ups', exact: true }).click();
    const message = page.getByLabel('Message', { exact: true });
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.value.includes('Cedar site meeting'));
    assert.equal(prompts.length, 0);
    await page.getByRole('button', { name: 'Notes: Cedar site meeting', exact: true }).waitFor();
    await page.locator('form.ask-form').getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Review actions…', exact: true }).click();
    assert.equal((await call<{ title: string }[]>('tasks.list')).some((task) => task.title === 'Order cedar boards'), false);
    assert.match(prompts[0]!, /Cedar site meeting/);
    const dialog = page.getByRole('dialog', { name: 'Review suggested actions' });
    await dialog.getByRole('button', { name: 'Apply 1 action', exact: true }).click();
    await dialog.getByText('Added 1 item and updated 0 items.').waitFor();
    assert.equal((await call<{ title: string }[]>('tasks.list')).some((task) => task.title === 'Order cedar boards'), true);
    await shoot('desktop-followups');
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal((await call<{ title: string }[]>('tasks.list')).some((task) => task.title === 'Order cedar boards'), false);
    await dialog.waitFor({ state: 'detached' });
    assert.match(await message.inputValue(), /^$/);
  });

  test('browser imports an export, filters speakers, seeds a chat and respects a read-only pairing', async () => {
    const status = await call<{ url: string }>('api.status');
    const writer = await call<{ token: string }>('clients.create', 'Fixture browser', ['read', 'write']);
    const opening = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, url) => { void new BrowserWindow({ width: 1120, height: 850 }).loadURL(url); }, `${status.url}/`);
    web = await opening;
    web.on('pageerror', (error) => problems.push(error.message));
    await web.getByPlaceholder('em_…').fill(writer.token);
    await web.getByRole('button', { name: 'Connect', exact: true }).click();
    await web.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Knowledge', exact: true }).click();
    await web.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Meetings', exact: true }).click();
    await web.getByLabel('Biscotti CSV export').setInputFiles({ name: 'Biscotti_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await web.getByText('Already imported', { exact: true }).waitFor();
    await web.getByRole('button', { name: 'Import 1 meeting', exact: true }).click();
    await web.getByRole('list', { name: 'Imported meetings' }).locator('li', { hasText: 'Friday check-in' }).waitFor();
    await web.getByLabel('Filter loaded meetings').fill('Priya');
    await web.getByText('1 of 3 loaded meetings match.', { exact: true }).waitFor();
    await shoot('browser-library', web);
    await web.getByRole('button', { name: 'Find follow-ups', exact: true }).click();
    await web.getByLabel('Message', { exact: true }).waitFor();
    assert.match(await web.getByLabel('Message', { exact: true }).inputValue(), /Cedar site meeting/);
    assert.equal(prompts.length, 1, 'the browser seed did not send a model request');
    await web.reload();
    const reader = await call<{ token: string }>('clients.create', 'Fixture reader', ['read']);
    await web.getByPlaceholder('em_…').fill(reader.token);
    await web.getByRole('button', { name: 'Connect', exact: true }).click();
    await web.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Knowledge', exact: true }).click();
    await web.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Meetings', exact: true }).click();
    await web.getByRole('list', { name: 'Imported meetings' }).waitFor();
    assert.equal(await web.getByLabel('Biscotti CSV export').isDisabled(), true);
    assert.equal(await web.getByRole('button', { name: 'Find follow-ups', exact: true }).first().isDisabled(), true);
    assert.deepEqual(problems, []);
  });
});
