import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(appDir, '..', '..');
const cli = join(repo, 'packages', 'cli', 'src', 'main.ts');
// Debug captures only; the published screenshots come from scripts/screenshots.mjs.
const shots = join(appDir, 'test-results', 'screenshots');
const home = mkdtempSync(join(tmpdir(), 'enve-desktop-e2e-'));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const runCli = (...args: string[]) => execFileSync(process.execPath, [cli, '--home', home, ...args], { encoding: 'utf8' });

const ARTICLE = `<!doctype html><html><head><title>Rolling codes, explained</title>
<meta property="og:site_name" content="Garage Lab"><meta name="author" content="Ada Wrench"></head>
<body><article><h1>Rolling codes, explained</h1>
<p>Security+ 2.0 openers never send the same code twice. Each press advances a counter, and the receiver accepts a window of future codes so a missed press doesn't lock you out.</p>
<p>A replay attack records one transmission and plays it back later. Because the receiver has already moved past that counter value, the replayed code is rejected.</p>
<img src="/pixel.gif" alt="tracking pixel">
<h2>Bench testing</h2>
<p>To test a controller without the real motor, build a simulator that speaks the same serial protocol. An ESP32 with a level shifter is enough, and it lets you replay captured traffic safely on the bench.</p>
<p>Read the <a href="/protocol">full protocol notes</a> before wiring anything to the wall console.</p>
</article></body></html>`;

let app: ElectronApplication;
let appClosed = false;
let page: Page;
let server: Server;
let articleUrl = '';
let pixelHits = 0;

async function shot(name: string): Promise<void> {
  const toasts = (visibility: string) => page.evaluate((v) => {
    const el = document.querySelector<HTMLElement>('.toasts');
    if (el) el.style.visibility = v;
  }, visibility);
  await toasts('hidden');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await toasts('');
}

/** Writes through core from a separate process, the way an MCP server or the AI worker would. */
function seedSuggestion(): void {
  const core = pathToFileURL(join(repo, 'packages', 'core', 'src', 'index.ts')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { EnveMemory } from ${JSON.stringify(core)};
    const memory = EnveMemory.open({ home: ${JSON.stringify(home)}, actor: 'mcp:claude-code' });
    const project = memory.projects.resolve('garage-door');
    const note = memory.items.saveNote({ body: 'Measured the wall console: 12 V supply, and the data line idles high between presses.' });
    memory.withActor('ai', () => memory.items.suggest(note.id, {
      status: 'done', at: new Date().toISOString(), model: 'ollama:qwen2.5:1.5b',
      summary: 'Voltage measurements from the garage door wall console, useful for designing the replacement controller.',
      tags: ['wiring', 'measurements'], project: { id: project.id, name: project.name },
    }));
    memory.close();
  `]);
}

/** Replaces native dialogs in the main process so tests never block on a picker, open Finder or launch a browser. */
async function stubDialogs(folder: string): Promise<void> {
  await app.evaluate(({ dialog, shell }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    shell.showItemInFolder = () => {};
    shell.openExternal = async () => {};
  }, folder);
}

/** Sidebar entries carry a count after their label ("Inbox 3"), so match the label exactly with an optional number. */
async function nav(label: string | RegExp): Promise<void> {
  const name = typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`) : label;
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).first().click();
}

async function settings(section: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
}

const call = (method: string, ...args: unknown[]) =>
  page.evaluate(async ([m, a]) => window.enve.call(m as string, ...(a as unknown[])), [method, args] as const);

type OutlineItem = { id: string; title: string; body: string };

async function outlineChildren(parentId: string | null): Promise<OutlineItem[]> {
  const result = await call('outline.children', parentId, { limit: 200 }) as { ok: true; value: { items: { item: OutlineItem }[] } };
  return result.value.items.map((entry) => entry.item);
}

const childTitles = async (parentId: string | null) => (await outlineChildren(parentId)).map((item) => item.title);

async function childId(parentId: string | null, title: string): Promise<string> {
  const found = (await outlineChildren(parentId)).find((item) => item.title === title);
  assert.ok(found, `"${title}" is in the outline`);
  return found.id;
}

/** Waits for a write to land, then checks the stored order. */
async function expectChildren(parentId: string | null, expected: string[]): Promise<void> {
  let titles: string[] = [];
  for (let i = 0; i < 50; i++) {
    titles = await childTitles(parentId);
    if (titles.join('\n') === expected.join('\n')) return;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(titles, expected);
}

const outlineRow = (title: string) => page.getByRole('button', { name: title, exact: true });

const waitForFocus = (label: string) =>
  page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, label);

const mainWindow = (size: [number, number]) =>
  app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#capture'))!.setSize(width, height);
  }, size);

describe('Petty Memory desktop', { timeout: 180_000 }, () => {
  afterEach(async (context) => {
    if (context.passed || !page || page.isClosed()) return;
    if ('error' in context) console.error(context.error);
    await page.screenshot({ path: join(shots, 'failure.png') });
    writeFileSync(join(shots, 'failure.html'), await page.content());
    await app.evaluate(() => (globalThis as { restoreEnveCall?: () => void }).restoreEnveCall?.());
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  before(async () => {
    mkdirSync(shots, { recursive: true });
    runCli('settings', 'semanticSearch', 'false');
    runCli('settings', 'fetchLinks', 'false');
    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));

    server = createServer((req, res) => {
      if (req.url === '/pixel.gif') {
        pixelHits += 1;
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    articleUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rolling-codes`;

    app = await electron.launch({
      args: [appDir, '--use-mock-keychain'],
      colorScheme: null as never,
      env: {
        ...process.env,
        ENVE_MEMORY_HOME: home,
        ENVE_MEMORY_PORT: '0',
        ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1',
      },
    });
    app.on('close', () => { appClosed = true; });
    page = await app.firstWindow();
    page.on('pageerror', (error) => console.error('[renderer-error]', error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  });

  after(async () => {
    server?.close();
    if (app && !appClosed) await app.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('first launch teaches the product', async () => {
    await page.getByText('Save a link, jot a note, or connect Claude Code.').waitFor();
    assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
  });

  test('the local API answers on its port', async () => {
    const status = await call('api.status') as { ok: true; value: { running: boolean; url: string } };
    assert.equal(status.value.running, true);
    const response = await fetch(`${status.value.url}/api/v1/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { name: string }).name, 'enve-memory');
  });

  test('captures a note and a link from Home', async () => {
    const capture = page.getByLabel('Capture a note or link');
    await capture.fill('Bench-test rig: simulate the Security+ 2.0 rolling code so we never touch the real opener');
    await capture.press('Enter');
    await page.getByTestId('saved-chip').getByText(/Saved: Bench-test rig/).waitFor();

    await capture.fill('https://example.com/esp32-garage-library');
    await capture.press('Enter');
    await page.getByTestId('saved-chip').getByText('Saved: https://example.com/esp32-garage-library').waitFor();
    await page.getByRole('heading', { name: 'Recent' }).waitFor();
  });

  test('creates a project and files an item into it from the Inbox', async () => {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Garage Door');
    await page.getByLabel(/What is it/).fill('Replace the dead opener controller with an ESP32.');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Project name').waitFor();
    assert.equal(await page.getByLabel('Project name').inputValue(), 'Garage Door');

    await nav(/^Inbox/);
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    const note = page.locator('.inbox-entry').filter({ hasText: 'Bench-test rig' });
    await note.getByRole('combobox').selectOption({ label: 'Garage Door' });
    await page.getByText('Filed into Garage Door').waitFor();
    await note.waitFor({ state: 'detached' });
    await page.locator('.inbox-entry').filter({ hasText: 'esp32-garage-library' }).waitFor();

    seedSuggestion();
    const suggested = page.locator('.inbox-entry').filter({ hasText: 'Measured the wall console' });
    await suggested.getByText('Voltage measurements from the garage door wall console').waitFor({ timeout: 6000 });
    await shot('inbox-dark');
    await suggested.getByRole('button', { name: 'Accept' }).click();
    await page.getByText('Suggestions applied').waitFor();
    await suggested.waitFor({ state: 'detached' });
  });

  test('edits the project memory and records a decision', async () => {
    await nav('Garage Door');
    await page.getByRole('button', { name: 'Write the first version' }).click();
    await page.locator('.memory').getByRole('button', { name: 'Edit as Markdown' }).click();
    await page.getByRole('textbox', { name: 'Memory document (Markdown)' }).fill('## Goal\n\nA replacement controller that speaks **Security+ 2.0**.\n\n## Open questions\n\n- Which relay board?');
    await page.getByRole('button', { name: 'Save memory' }).click();
    await page.locator('.memory .markdown').getByRole('heading', { name: 'Goal' }).waitFor();
    await page.getByText('Earlier versions are kept.', { exact: false }).waitFor();

    await page.getByRole('button', { name: 'Record decision' }).click();
    await page.getByLabel('Decision', { exact: true }).fill('Use an ESP32-C3 for the controller');
    await page.getByLabel(/^Why/).fill('Cheap, and it has the radio we need.');
    await page.locator('form.record-decision').getByRole('button', { name: 'Record decision' }).click();
    await page.locator('.timeline').getByText('Use an ESP32-C3 for the controller').waitFor();

    await page.getByRole('button', { name: 'History' }).click();
    await page.locator('.memory-history').getByText('Current').waitFor();
  });

  test('adds and completes a task', async () => {
    await page.getByLabel('New task').fill('Build the bench simulator');
    await page.getByLabel('New task').press('Enter');
    const check = page.getByRole('checkbox', { name: 'Complete Build the bench simulator' });
    await check.waitFor();
    await page.getByLabel('New task').fill('Order a level shifter');
    await page.getByLabel('New task').press('Enter');
    await page.getByRole('checkbox', { name: 'Complete Order a level shifter' }).waitFor();
    await shot('project-dark');

    await check.click();
    await check.waitFor({ state: 'detached' });
    await nav('Tasks');
    await page.getByRole('tab', { name: 'Done' }).click();
    await page.getByRole('checkbox', { name: 'Reopen Build the bench simulator' }).waitFor();
    await page.getByRole('tab', { name: 'Active' }).click();
    await page.getByRole('checkbox', { name: 'Complete Order a level shifter' }).waitFor();
  });

  test('searches with the keyboard and opens the result', async () => {
    await nav('Home');
    await page.keyboard.press(`${mod}+K`);
    const input = page.getByLabel('Search your library');
    await input.fill('rolling');
    const hit = page.getByRole('option').filter({ hasText: 'Bench-test rig' });
    await hit.waitFor();
    assert.equal(await hit.locator('mark').first().textContent(), 'rolling');
    await shot('search-dark');
    await input.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    await drawer.waitFor();
    assert.match(await drawer.getByRole('textbox', { name: 'Note', exact: true }).textContent() ?? '', /Bench-test rig/);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  });

  test('shows a write from the CLI within a few seconds', async () => {
    await nav('Home');
    runCli('note', 'from the CLI while the app is open');
    await page.getByText('from the CLI while the app is open').first().waitFor({ timeout: 6000 });
  });

  test('archives a page and shows it as sanitized reader text', async () => {
    await settings('Search');
    await page.getByRole('switch', { name: 'Archive saved links' }).click();
    await page.getByRole('switch', { name: 'Archive saved links', checked: true }).waitFor();
    await nav('Home');
    const capture = page.getByLabel('Capture a note or link');
    await capture.fill(`${articleUrl} the clearest write-up of the replay window`);
    await capture.press('Enter');
    const chip = page.getByTestId('saved-chip').getByText('Saved: Rolling codes, explained');
    await chip.waitFor({ timeout: 20_000 });
    await shot('home-dark');
    await chip.click();
    const drawer = page.getByRole('dialog', { name: 'Link details' });
    await drawer.locator('.reader').getByText('A replay attack records one transmission').waitFor();
    await drawer.getByText(/Saved from 127\.0\.0\.1/).waitFor();
    assert.equal(await drawer.locator('.reader img').count(), 0, 'remote images are not rendered');
    assert.equal(await drawer.locator('.reader a[href^="http://127.0.0.1"]').first().getAttribute('target'), '_blank');
    await page.waitForTimeout(500);
    assert.equal(pixelHits, 0, 'opening an archived page never contacts its server');
    await shot('item-detail-dark');
    await page.keyboard.press('Escape');
  });

  test('connect screens show MCP setup and a pairing QR code', async () => {
    await settings('AI tools');
    await page.getByText('claude mcp add --scope user petty-memory -e ELECTRON_RUN_AS_NODE=1', { exact: false }).waitFor();
    await page.getByText('[mcp_servers.petty-memory]', { exact: false }).waitFor();
    await shot('settings-ai-tools-dark');

    await settings('Devices & extensions');
    await page.getByRole('button', { name: 'Pair a phone' }).click();
    await page.locator('.qr-grid img').first().waitFor();
    await page.locator('.settings-section').evaluate((el) => el.closest('.main')!.scrollTo(0, 360));
    await shot('settings-devices-dark');
    await page.getByRole('button', { name: 'Done' }).click();
  });

  test('creates an API client and shows its token once', async () => {
    await settings('Devices & extensions');
    await page.getByLabel('Client name').fill('Test extension');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = await page.getByTestId('new-token').textContent();
    assert.match(token ?? '', /^em_[\w-]{40,}$/);

    const status = await call('api.status') as { ok: true; value: { url: string } };
    const whoami = await fetch(`${status.value.url}/api/v1/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(whoami.status, 200);

    await page.getByRole('button', { name: 'I’ve saved it' }).click();
    await page.getByTestId('new-token').waitFor({ state: 'detached' });
    await page.locator('.client-list').getByText('Test extension').waitFor();
    await settings('Library');
    await settings('Devices & extensions');
    assert.equal(await page.getByTestId('new-token').count(), 0);
    assert.equal(await page.getByText(token!).count(), 0, 'the token is never shown again');
  });

  test('saves dropped links and files', async () => {
    await nav('Home');
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/uri-list', 'https://example.org/dropped-datasheet');
      const target = document.querySelector('.app')!;
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.getByText('Link saved').waitFor();

    const file = join(home, 'wiring-notes.txt');
    writeFileSync(file, 'Wall console pinout: red is 12 V, white is data, black is ground.');
    const saved = await call('files.save', [file]) as { ok: boolean };
    assert.equal(saved.ok, true);
    await nav('Files');
    await page.locator('.item-row').filter({ hasText: 'wiring-notes.txt' }).waitFor();
    await nav('Links');
    await page.locator('.item-row').filter({ hasText: 'dropped-datasheet' }).waitFor();
  });

  test('deletes only after confirmation', async () => {
    const row = page.locator('.item-row').filter({ hasText: 'dropped-datasheet' });
    await row.getByRole('button').first().click();
    const drawer = page.getByRole('dialog', { name: 'Link details' });
    await drawer.getByRole('button', { name: 'Delete…' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete permanently?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    await drawer.getByRole('button', { name: 'Delete…' }).click();
    await confirm.getByRole('button', { name: 'Delete permanently' }).click();
    await page.getByText('Deleted', { exact: true }).waitFor();
    await row.waitFor({ state: 'detached' });
  });

  test('quick capture window saves to the Inbox', async () => {
    const opened = app.waitForEvent('window', { predicate: (w) => w.url().endsWith('#capture') });
    await call('capture.open');
    const capture = await opened;
    await capture.getByLabel('Quick capture').fill('Quick thought: check the torsion spring before testing');
    await capture.getByLabel('Quick capture').press('Enter');
    await capture.getByText('Saved to Inbox').waitFor();
    await nav(/^Inbox/);
    await page.getByText('Quick thought: check the torsion spring before testing').waitFor();
  });

  test('syncs through a folder with an encryption passphrase', async () => {
    const folder = join(home, 'sync-folder');
    await stubDialogs(folder);
    await settings('Sync');
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    await page.getByText(folder).waitFor();
    await page.getByLabel('Passphrase', { exact: true }).fill('correct horse battery');
    await page.getByLabel('Repeat').fill('correct horse battery');
    await page.getByRole('button', { name: 'Start syncing' }).click();
    await page.getByText('Encrypted', { exact: true }).waitFor();
    await page.getByText(/sent \d+, received \d+/).waitFor();
    assert.ok(existsSync(join(folder, 'devices')));
    await page.getByRole('button', { name: 'Sync now' }).click();
    await page.getByRole('button', { name: 'Stop syncing' }).click();
    await page.getByRole('alertdialog', { name: 'Stop syncing?' }).getByRole('button', { name: 'Stop syncing' }).click();
    await page.getByRole('button', { name: 'Choose folder…' }).waitFor();
    assert.ok(existsSync(join(folder, 'devices')), 'stopping never deletes the folder');
  });

  test('exports everything to a chosen folder', async () => {
    const folder = join(home, 'exports');
    mkdirSync(folder);
    await stubDialogs(folder);
    await settings('Export');
    await page.getByRole('button', { name: /Choose a folder and export/ }).click();
    await page.getByText(/Exported \d+ items/).waitFor();
    const [exported] = readdirSync(folder);
    assert.ok(existsSync(join(folder, exported!, 'metadata.json')));
  });

  test('restores a snapshot after a typed confirmation and reopens the library', async () => {
    await settings('Backups');
    await page.getByRole('button', { name: 'Snapshot now' }).click();
    await page.getByText('Snapshot saved').waitFor();
    runCli('note', 'written after the snapshot');
    await nav('Home');
    await page.getByText('written after the snapshot').first().waitFor({ timeout: 6000 });

    await settings('Backups');
    await page.locator('.backup-list li').filter({ hasText: 'manual' }).first().getByRole('button', { name: 'Restore…' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Restore this snapshot?' });
    const go = confirm.getByRole('button', { name: 'Restore snapshot' });
    assert.equal(await go.isDisabled(), true);
    await confirm.getByLabel('Confirmation word').fill('restore');
    await go.click();
    await page.getByText(/Restored\. The previous state was saved as pre-restore-/).waitFor({ timeout: 15_000 });
    await page.locator('.backup-list').getByText('pre-restore').waitFor();

    await nav('Home');
    await page.getByRole('heading', { name: 'Recent' }).waitFor();
    assert.equal(await page.getByText('written after the snapshot').count(), 0);
    const status = await call('api.status') as { ok: true; value: { running: boolean; url: string } };
    assert.equal(status.value.running, true);
    assert.equal((await fetch(`${status.value.url}/api/v1/status`)).status, 200);
  });

  test('asks the library with a real model (set ENVE_E2E_OLLAMA to run)', { skip: !process.env.ENVE_E2E_OLLAMA }, async () => {
    await settings('AI');
    await page.getByLabel('Provider').selectOption('ollama');
    await page.getByLabel(/Server address/).fill(process.env.ENVE_E2E_OLLAMA!);
    await page.getByLabel('Model').fill('qwen2.5:1.5b');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('AI settings saved').waitFor();
    await page.getByRole('button', { name: 'Test' }).click();
    await page.getByText(/^Replied:/).waitFor({ timeout: 90_000 });

    await nav('Ask');
    await page.getByLabel('Question').fill('How do rolling codes stop a replay attack?');
    await page.locator('form.ask-form').getByRole('button', { name: 'Ask' }).click();
    await page.locator('.answer .cite').first().waitFor({ timeout: 120_000 });
    await shot('ask-dark');
    await page.locator('.answer .cite').first().click();
    await page.getByRole('dialog', { name: /details/ }).waitFor();
    await page.keyboard.press('Escape');
  });

  test('automations tag and file new items', async () => {
    await settings('Automations');
    await page.getByLabel('Name', { exact: true }).fill('Code links');
    await page.getByLabel(/From sites/).fill('github.com');
    await page.getByLabel('Then add tags').fill('code');
    await page.getByLabel('And file into').selectOption({ label: 'Garage Door' });
    await page.getByRole('button', { name: 'Add automation' }).click();
    await page.getByText('When anything from github.com is saved: tag #code and file into Garage Door.').waitFor();

    await nav('Home');
    const capture = page.getByLabel('Capture a note or link');
    await capture.fill('https://github.com/example/secplus2-decoder');
    await capture.press('Enter');
    await page.getByTestId('saved-chip').click();
    const drawer = page.getByRole('dialog', { name: 'Link details' });
    await drawer.getByText('#code').waitFor();
    assert.equal(await drawer.getByLabel('Project').locator('option:checked').textContent(), 'Garage Door');
    await page.keyboard.press('Escape');
  });

  test('imports browser bookmarks', async () => {
    const file = join(home, 'bookmarks.html');
    writeFileSync(file, `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
      <DT><H3>Hardware</H3><DL><p>
        <DT><A HREF="https://example.net/level-shifters">Level shifters, explained</A>
        <DT><A HREF="https://example.net/esp32-pinout">ESP32 pinout</A>
      </DL><p></DL>`);
    await stubDialogs(file);
    await settings('Import');
    await page.locator('.setting-row').filter({ hasText: 'Browser bookmarks' }).getByRole('button', { name: 'Choose file…' }).click();
    await page.getByText(/imported 2, skipped 0 already saved/).waitFor();
    await nav('Links');
    await page.locator('.item-row').filter({ hasText: 'ESP32 pinout' }).getByText('#hardware').waitFor();
  });

  test('pins, reminds and sorts items onto shelves', async () => {
    await stubDialogs(home);
    await nav('Links');
    const row = page.locator('.item-row').filter({ hasText: 'ESP32 pinout' });
    await row.hover();
    await row.getByRole('button', { name: 'Pin', exact: true }).click();
    await row.getByRole('button', { name: 'Unpin' }).waitFor();
    await nav('Pinned');
    await page.locator('.item-row').filter({ hasText: 'ESP32 pinout' }).waitFor();

    const pinned = page.locator('.item-row').filter({ hasText: 'ESP32 pinout' });
    await pinned.hover();
    await pinned.getByRole('button', { name: 'Remind me' }).click();
    await page.getByRole('menuitem', { name: 'Tomorrow' }).click();
    await page.getByText(/I’ll remind you tomorrow/).waitFor();
    await nav('Reminders');
    await page.getByRole('region', { name: 'Upcoming' }).getByText('ESP32 pinout').waitFor();

    await nav('Read');
    const level = page.locator('.item-row').filter({ hasText: 'Level shifters, explained' });
    await level.getByRole('button').first().click();
    const drawer = page.getByRole('dialog', { name: 'Link details' });
    await drawer.getByRole('group', { name: 'Intent' }).getByRole('button', { name: 'Watch' }).click();
    await drawer.getByRole('button', { name: 'Watch', pressed: true }).waitFor();
    await drawer.getByRole('button', { name: /example\.net\/level-shifters/ }).click();
    await drawer.getByText('Last opened just now').waitFor();
    await page.keyboard.press('Escape');
    await nav('Watch');
    await page.locator('.item-row').filter({ hasText: 'Level shifters, explained' }).waitFor();
    await nav('Read');
    await page.locator('.item-row').filter({ hasText: 'Rolling codes, explained' }).waitFor();
    assert.equal(await page.locator('.item-row').filter({ hasText: 'Level shifters, explained' }).count(), 0);
  });

  test('delivers a due reminder as a notification that opens the item', async () => {
    await app.evaluate(({ Notification }) => {
      const shown: unknown[] = [];
      (globalThis as { shownReminders?: unknown[] }).shownReminders = shown;
      Notification.prototype.show = function show(this: unknown) {
        shown.push(this);
      };
    });
    const list = await call('items.list', { type: 'bookmark' }, 200) as { ok: true; value: { id: string; title: string }[] };
    const target = list.value.find((item) => item.title === 'Level shifters, explained')!;
    await call('items.setReminder', target.id, new Date(Date.now() - 60_000).toISOString());

    let delivered: { title: string; body: string }[] = [];
    for (let i = 0; i < 30 && delivered.length === 0; i++) {
      delivered = await app.evaluate(() =>
        ((globalThis as { shownReminders?: { title: string; body: string }[] }).shownReminders ?? []).map((n) => ({ title: n.title, body: n.body })));
      if (!delivered.length) await page.waitForTimeout(200);
    }
    assert.deepEqual(delivered, [{ title: 'Time to watch', body: 'Level shifters, explained' }]);

    await nav('Home');
    await app.evaluate(() => (globalThis as { shownReminders?: { emit(e: string): void }[] }).shownReminders![0]!.emit('click'));
    await page.getByRole('dialog', { name: 'Link details' }).getByLabel('Title').and(page.locator('[value="Level shifters, explained"]')).waitFor();
    await page.keyboard.press('Escape');

    await nav('Reminders');
    const due = page.getByRole('region', { name: 'Due' });
    await due.getByText('Level shifters, explained').waitFor();
    await shot('reminders-dark');
    await due.getByRole('button', { name: 'Snooze' }).click();
    await page.getByRole('menuitem', { name: 'Next week' }).click();
    await page.getByRole('region', { name: 'Upcoming' }).getByText('Level shifters, explained').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Due' }).count(), 0);
    const again = await app.evaluate(() => (globalThis as { shownReminders?: unknown[] }).shownReminders!.length);
    assert.equal(again, 1, 'a delivered reminder is not shown twice');
  });

  test('pages through a large library', async () => {
    const core = pathToFileURL(join(repo, 'packages', 'core', 'src', 'index.ts')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { EnveMemory } from ${JSON.stringify(core)};
      const memory = EnveMemory.open({ home: ${JSON.stringify(home)}, actor: 'cli' });
      for (let i = 1; i <= 110; i++) memory.items.saveNote({ body: 'Bulk note ' + i });
      memory.close();
    `]);
    await nav('Notes');
    await page.getByText('Bulk note 110', { exact: true }).waitFor({ timeout: 6000 });
    const before = await page.locator('.item-row').count();
    assert.equal(before, 100);
    await page.getByRole('button', { name: 'Load more' }).click();
    await page.getByText('Bulk note 1', { exact: true }).waitFor();
    assert.ok(await page.locator('.item-row').count() > 100);
  });

  test('draws the graph and opens a project from it', async () => {
    await nav('Graph');
    await page.getByLabel('Project', { exact: true }).selectOption({ label: 'Garage Door' });
    const canvas = page.getByRole('img', { name: /Graph of \d+ nodes/ });
    await canvas.waitFor();
    await page.waitForTimeout(5000);
    await shot('graph-dark');
    const box = (await canvas.boundingBox())!;
    assert.ok(box.width > 300 && box.height > 300);
    // Sweep a pointer over the canvas until it reports the project node under it, then click there.
    const spot = await page.evaluate(() => {
      const el = document.querySelector('canvas')!;
      const rect = el.getBoundingClientRect();
      for (let y = rect.top + 4; y < rect.bottom; y += 6) {
        for (let x = rect.left + 4; x < rect.right; x += 6) {
          el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          if (el.title === 'Garage Door') return { x, y };
        }
      }
      return null;
    });
    const found = spot !== null;
    if (spot) await page.mouse.click(spot.x, spot.y);
    assert.ok(found, 'the project node is on the canvas');
    await page.getByLabel('Project name').waitFor({ timeout: 2000 });
  });

  test('Settings → Search explains when semantic search is unavailable (Intel Macs)', async () => {
    // Stand in for an Intel Mac by answering index.status as the x64 build would; everything else passes through.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('enve:call')!;
      handlers.set('enve:call', async (event: unknown, method: unknown, args: unknown) => {
        const result = await original(event, method, args) as { ok: boolean; value: Record<string, unknown> };
        return method === 'index.status' && result.ok ? { ok: true, value: { ...result.value, supported: false, enabled: false, model: null } } : result;
      });
      (globalThis as { restoreEnveCall?: () => void }).restoreEnveCall = () => handlers.set('enve:call', original);
    });
    await settings('Search');
    await page.getByText('Not available on this Mac.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('switch', { name: 'Semantic search' }).isDisabled(), true);
    assert.equal(await page.getByRole('switch', { name: 'Semantic search' }).getAttribute('aria-checked'), 'false');
    await shot('settings-search-unavailable-dark');
    await app.evaluate(() => (globalThis as { restoreEnveCall?: () => void }).restoreEnveCall!());
    await settings('Library');
    await settings('Search');
    await page.getByText('Downloads a ~23 MB model once').waitFor();
  });

  test('toggles the theme', async () => {
    await settings('Appearance');
    const dark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const inkBackground = await background();
    await page.getByRole('radio', { name: 'Light' }).click();
    await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
    assert.equal(await dark(), false);
    assert.notEqual(await background(), inkBackground);

    await nav('Home');
    await shot('home-light');
    await nav('Garage Door');
    await page.getByLabel('Project name').waitFor();
    await shot('project-light');

    await settings('Appearance');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  });

  test('outline: builds a root note, children and a grandchild inline', async () => {
    await nav('Outline');
    await page.getByRole('heading', { name: 'Outline', exact: true }).waitFor();
    await page.getByRole('list', { name: 'Outline', exact: true }).locator(':scope > li.outline-node').first().waitFor();

    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const title = page.getByLabel('Note title');
    const beforeEmpty = await childTitles(null);
    await title.press('Enter');
    await page.waitForTimeout(300);
    assert.deepEqual(await childTitles(null), beforeEmpty, 'an empty composer saves nothing');
    await title.fill('Garage outline');
    await title.press('Enter');
    await outlineRow('Garage outline').waitFor();
    assert.equal(await title.inputValue(), '', 'the composer clears for the next note');
    await title.press('Escape');
    await title.waitFor({ state: 'detached' });
    await waitForFocus('Garage outline');
    assert.equal((await childTitles(null))[0], 'Garage outline', 'a new top-level note goes first');

    await page.getByRole('button', { name: 'Actions for Garage outline', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add note inside' }).click();
    await title.fill('Wiring');
    await title.press('Enter');
    await page.getByRole('list', { name: 'Inside Garage outline' }).getByRole('button', { name: 'Wiring', exact: true }).waitFor();
    await title.fill('Firmware');
    await title.press('Enter');
    await page.getByRole('list', { name: 'Inside Garage outline' }).getByRole('button', { name: 'Firmware', exact: true }).waitFor();
    await title.press('Escape');
    const garage = await childId(null, 'Garage outline');
    await expectChildren(garage, ['Wiring', 'Firmware']);

    await page.getByRole('button', { name: 'Actions for Wiring', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add note inside' }).click();
    await title.fill('Pinout');
    await title.press('Shift+Enter');
    const details = page.getByLabel('Note details');
    await details.fill('Red is 12 V, white is data.');
    await details.press(`${mod}+Enter`);
    await page.getByRole('list', { name: 'Inside Wiring' }).getByRole('button', { name: 'Pinout', exact: true }).waitFor();
    await title.press('Escape');
    const [pinout] = await outlineChildren(await childId(garage, 'Wiring'));
    assert.equal(pinout?.title, 'Pinout');
    assert.equal(pinout?.body, 'Red is 12 V, white is data.');
    await shot('outline-dark');
  });

  test('outline: collapses a branch and reopens it as it was', async () => {
    await page.getByRole('button', { name: 'Collapse Garage outline' }).click();
    await page.getByRole('list', { name: 'Inside Garage outline' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Expand Garage outline' }).click();
    await page.getByRole('list', { name: 'Inside Wiring' }).getByRole('button', { name: 'Pinout', exact: true }).waitFor();

    await nav('Home');
    await nav('Outline');
    await page.getByRole('list', { name: 'Inside Wiring' }).getByRole('button', { name: 'Pinout', exact: true }).waitFor();
  });

  test('outline: reorders, indents and outdents from the keyboard, the menu and the row buttons', async () => {
    const garage = await childId(null, 'Garage outline');
    const wiring = await childId(garage, 'Wiring');
    await outlineRow('Firmware').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expectChildren(garage, ['Firmware', 'Wiring']);
    await waitForFocus('Firmware');
    await page.keyboard.press('Alt+ArrowDown');
    await expectChildren(garage, ['Wiring', 'Firmware']);
    await waitForFocus('Firmware');

    await page.keyboard.press('Alt+ArrowRight');
    await expectChildren(wiring, ['Pinout', 'Firmware']);
    await page.getByRole('list', { name: 'Inside Wiring' }).getByRole('button', { name: 'Firmware', exact: true }).waitFor();
    await waitForFocus('Firmware');
    await page.keyboard.press('Alt+ArrowLeft');
    await expectChildren(garage, ['Wiring', 'Firmware']);
    assert.deepEqual(await childTitles(wiring), ['Pinout'], 'outdenting keeps the old parent’s other children');
    await waitForFocus('Firmware');

    await page.getByRole('button', { name: 'Actions for Firmware', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Move up/ }).click();
    await expectChildren(garage, ['Firmware', 'Wiring']);
    const firmwareRow = page.locator('.outline-row').filter({ has: outlineRow('Firmware') });
    await firmwareRow.hover();
    await firmwareRow.getByRole('button', { name: 'Move down' }).click();
    await expectChildren(garage, ['Wiring', 'Firmware']);
    assert.deepEqual(await childTitles(wiring), ['Pinout'], 'reordering keeps the subtree');
  });

  test('outline: moves a branch to another parent with its subtree, and refuses impossible moves', async () => {
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByLabel('Note title').fill('Bench rig');
    await page.getByLabel('Note title').press('Enter');
    await outlineRow('Bench rig').waitFor();
    await page.getByLabel('Note title').press('Escape');

    await page.getByRole('button', { name: 'Actions for Wiring', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move “Wiring”' });
    await dialog.getByText('The note inside it moves too.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: /^Garage outline/ }).click();
    const inside = dialog.getByRole('list', { name: 'Inside Garage outline' });
    await inside.getByRole('button', { name: /^Firmware/ }).waitFor();
    assert.equal(await inside.getByRole('button', { name: /^Wiring/ }).count(), 0, 'an item is never offered as its own parent');
    assert.equal(await dialog.getByRole('button', { name: 'Already here' }).isDisabled(), true);
    await dialog.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Top level' }).click();
    await dialog.getByRole('button', { name: /^Bench rig/ }).click();
    await dialog.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Bench rig' }).waitFor();
    await dialog.getByRole('button', { name: 'Move here' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText('Moved into Bench rig').waitFor();

    const garage = await childId(null, 'Garage outline');
    const bench = await childId(null, 'Bench rig');
    await expectChildren(bench, ['Wiring']);
    const wiring = await childId(bench, 'Wiring');
    assert.deepEqual(await childTitles(wiring), ['Pinout'], 'the moved branch keeps its children');
    assert.deepEqual(await childTitles(garage), ['Firmware']);
    await page.getByRole('list', { name: 'Inside Bench rig' }).getByRole('button', { name: 'Wiring', exact: true }).waitFor();

    await page.getByRole('list', { name: 'Inside Garage outline' }).getByRole('button', { name: 'Wiring', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('list', { name: 'Inside Bench rig' }).getByRole('button', { name: 'Pinout', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    const crumbs = drawer.getByRole('navigation', { name: 'Inside' });
    await crumbs.waitFor();
    assert.deepEqual(await crumbs.getByRole('button').allTextContents(), ['Bench rig', 'Wiring']);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });

    const cycle = await call('outline.move', bench, { parentId: wiring }) as { ok: boolean; error?: { code: string } };
    assert.equal(cycle.ok, false, 'a note can’t move inside its own branch');
    const decisions = await call('items.list', { type: 'decision' }, 5) as { ok: true; value: { id: string; title: string }[] };
    const decision = decisions.value[0]!;
    const moved = await call('outline.move', decision.id, { parentId: bench }) as { ok: boolean };
    assert.equal(moved.ok, false, 'decisions stay where they were recorded');
    await page.getByRole('button', { name: `Actions for ${decision.title}`, exact: true }).click();
    const menu = page.getByRole('menu', { name: `Actions for ${decision.title}` });
    await menu.getByRole('menuitem', { name: /^Open details/ }).waitFor();
    assert.equal(await menu.getByRole('menuitem', { name: /^(Move|Indent|Outdent|Add note inside)/ }).count(), 0, 'decision rows are read-only');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  });

  test('outline: splits a title at the caret, joins it back, and undoes and redoes the structure', async () => {
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    const title = page.getByLabel('Note title');
    await title.fill('Relay board notes');
    await title.press('Enter');
    await outlineRow('Relay board notes').waitFor();
    await title.press('Escape');
    await waitForFocus('Relay board notes');
    const id = await childId(null, 'Relay board notes');
    const after = async () => {
      const titles = await childTitles(null);
      return titles.slice(titles.indexOf('Relay'), titles.indexOf('Relay') + 2);
    };

    await page.keyboard.press('F2');
    const rename = page.locator('input.outline-edit');
    await rename.waitFor();
    await rename.evaluate((input: HTMLInputElement) => input.setSelectionRange(6, 6));
    await rename.press('Enter');
    await page.waitForFunction(() => (document.querySelector('input.outline-edit') as HTMLInputElement | null)?.value === 'board notes');
    for (let i = 0; i < 50 && (await after()).join('|') !== 'Relay|board notes'; i++) await page.waitForTimeout(100);
    assert.deepEqual(await after(), ['Relay', 'board notes'], 'the text after the caret becomes the next note');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart), 0, 'the caret starts the new note');

    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => (document.querySelector('input.outline-edit') as HTMLInputElement | null)?.value === 'Relay board notes');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart), 6, 'the caret sits at the join');
    assert.equal((await outlineChildren(null)).filter((item) => item.id === id).length, 1, 'the merge keeps the original note');
    await page.keyboard.press('Escape');
    await waitForFocus('Relay board notes');

    await page.getByRole('button', { name: /^Undo Merge notes/ }).waitFor();
    await page.keyboard.press(`${mod}+Z`);
    await outlineRow('board notes').waitFor();
    assert.deepEqual(await after(), ['Relay', 'board notes'], 'undo brings the merged note back');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
    await outlineRow('Relay board notes').waitFor();
    await outlineRow('board notes').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /^Undo Merge notes/ }).click();
    await outlineRow('board notes').waitFor();
    await page.getByRole('button', { name: /^Undo Split note/ }).click();
    await outlineRow('Relay board notes').waitFor();
    await outlineRow('board notes').waitFor({ state: 'detached' });

    await outlineRow('Relay board notes').focus();
    await page.keyboard.press('F2');
    await rename.waitFor();
    await rename.press('End');
    await rename.press('Enter');
    const composer = page.getByLabel('Note title');
    await composer.waitFor();
    assert.equal(await composer.inputValue(), '', 'Enter at the end opens a composer instead of storing an empty note');
    await composer.press('Escape');
  });

  test('typing undo in a field stays local, and the rich body editor keeps Markdown it can’t show', async () => {
    if (!(await childTitles(null)).includes('Relay board notes')) {
      await call('items.saveNote', { title: 'Relay board notes', body: 'Kept through local typing undo' });
    }
    const body = '| Pin | Wire |\n|-----|------|\n| 1 | red |\n\n<kbd>Reset</kbd> twice.\n\n[datasheet]: https://example.com/ds.pdf\n';
    const created = await call('items.saveNote', { title: 'Relay wiring', body }) as { ok: true; value: { id: string } };
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#capture'))!.webContents.send('enve:open', id);
    }, created.value.id);
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    const editor = drawer.getByRole('textbox', { name: 'Note', exact: true });
    await editor.waitFor();
    await drawer.locator('pre.pm-raw-block[data-kind="table"]').waitFor();
    await editor.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Then wait.');
    assert.match(await editor.locator('p').last().textContent() ?? '', /twice\. Then wait\.$/, 'typing stays at the chosen paragraph');
    await page.keyboard.press(`${mod}+Z`);
    const caret = await editor.evaluate(() => {
      const node = window.getSelection()?.anchorNode;
      const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
      return { node: node?.nodeName, paragraph: element?.closest('p')?.textContent, parent: element?.outerHTML };
    });
    assert.ok(caret.paragraph?.includes('twice.'), `undo restores the paragraph caret: ${JSON.stringify(caret)}`);
    assert.ok((await childTitles(null)).includes('Relay board notes'), 'undo inside the editor never undoes outline changes');
    await page.keyboard.type(' Then wait.');
    await drawer.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('Done');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    const saved = await call('items.get', created.value.id) as { ok: true; value: { body: string } };
    assert.ok(saved.value.body.startsWith('| Pin | Wire |\n|-----|------|\n| 1 | red |\n\n'), 'the table is kept byte for byte');
    assert.ok(saved.value.body.includes('[datasheet]: https://example.com/ds.pdf'), 'link definitions survive');
    assert.match(saved.value.body, /<kbd>Reset<\/kbd> twice\. Then wait\.\*\*Done\*\*/);
    await drawer.getByRole('button', { name: 'Edit as Markdown' }).click();
    const source = drawer.getByRole('textbox', { name: 'Note (Markdown)' });
    assert.equal(await source.inputValue(), saved.value.body);
    await source.press('ControlOrMeta+End');
    await page.keyboard.type(' source edit');
    await source.press(`${mod}+Z`);
    assert.equal(await source.inputValue(), saved.value.body, 'native undo also works in a plain Markdown field');
    await source.press(process.platform === 'darwin' ? 'Meta+Shift+Z' : 'Control+Y');
    assert.ok((await source.inputValue()).endsWith(' source edit'), 'native redo stays in the focused field');
    await source.press(`${mod}+Z`);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  });

  test('outline: keeps unsaved text when saving fails', async () => {
    const bench = await childId(null, 'Bench rig');
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('enve:call')!;
      handlers.set('enve:call', async (event: unknown, method: unknown, args: unknown) => method === 'editor.apply'
        ? { ok: false, error: { code: 'internal', message: 'The library is busy. Try again.' } }
        : original(event, method, args));
      (globalThis as { restoreEnveCall?: () => void }).restoreEnveCall = () => handlers.set('enve:call', original);
    });
    await page.getByRole('button', { name: 'Actions for Bench rig', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add note inside' }).click();
    const title = page.getByLabel('Note title');
    await title.fill('Logic analyzer');
    await title.press('Enter');
    await page.getByText('The library is busy. Try again.').waitFor();
    assert.equal(await title.inputValue(), 'Logic analyzer');
    assert.deepEqual(await childTitles(bench), ['Wiring'], 'nothing half-made is left behind');

    await app.evaluate(() => (globalThis as { restoreEnveCall?: () => void }).restoreEnveCall!());
    await title.press('Enter');
    await page.getByRole('list', { name: 'Inside Bench rig' }).getByRole('button', { name: 'Logic analyzer', exact: true }).waitFor();
    await expectChildren(bench, ['Logic analyzer', 'Wiring']);
    await title.press('Escape');
    await waitForFocus('Logic analyzer');
  });

  test('outline: pages long lists of children and keeps them loaded through a refresh', async () => {
    await nav('Outline');
    const core = pathToFileURL(join(repo, 'packages', 'core', 'src', 'index.ts')).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { EnveMemory } from ${JSON.stringify(core)};
      const memory = EnveMemory.open({ home: ${JSON.stringify(home)}, actor: 'cli' });
      const bin = memory.outline.createNote({ parentId: null, title: 'Parts bin' });
      for (let i = 1; i <= 250; i++) memory.outline.createNote({ parentId: bin.item.id, title: 'Part ' + String(i).padStart(3, '0') });
      memory.close();
    `]);
    const outline = page.getByRole('list', { name: 'Outline', exact: true });
    const rootMore = outline.locator(':scope > li.outline-status').getByRole('button', { name: 'Show more' });
    await rootMore.or(outlineRow('Parts bin')).first().waitFor({ timeout: 6000 });
    if (await rootMore.isVisible()) await rootMore.click();
    await outlineRow('Parts bin').waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Expand Parts bin' }).click();

    const inside = page.getByRole('list', { name: 'Inside Parts bin' });
    const rows = inside.locator(':scope > li.outline-node');
    const more = inside.locator(':scope > li.outline-status').getByRole('button', { name: 'Show more' });
    await inside.getByRole('button', { name: 'Part 100', exact: true }).waitFor();
    assert.equal(await rows.count(), 100);
    await inside.getByText('150 not shown yet').waitFor();
    await more.click();
    await inside.getByRole('button', { name: 'Part 200', exact: true }).waitFor();
    await more.click();
    await inside.getByRole('button', { name: 'Part 250', exact: true }).waitFor();
    assert.equal(await rows.count(), 250);
    assert.equal(await more.count(), 0);

    runCli('note', 'a write elsewhere refreshes the outline');
    await outlineRow('a write elsewhere refreshes the outline').waitFor({ timeout: 6000 });
    assert.equal(await rows.count(), 250, 'a refresh reloads every loaded row, past one page');
    await page.getByRole('button', { name: 'Collapse Parts bin' }).click();
  });

  test('outline: deep, long rows fit a narrow window in the light theme', async () => {
    let parentId = await childId(await childId(await childId(null, 'Bench rig'), 'Wiring'), 'Pinout');
    const long = 'a deliberately long title that has to wrap rather than push the row off the screen';
    for (let depth = 1; depth <= 12; depth++) {
      const created = await call('outline.createNote', { parentId, title: `Level ${depth}, ${long}` }) as { ok: true; value: { item: { id: string } } };
      parentId = created.value.item.id;
    }
    await settings('Appearance');
    await page.getByRole('radio', { name: 'Light' }).click();
    await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
    await mainWindow([760, 720]);

    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('#capture'))!.webContents.send('enve:open', id);
    }, parentId);
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    await drawer.getByRole('navigation', { name: 'Inside' }).waitFor();
    assert.equal(await drawer.getByRole('navigation', { name: 'Inside' }).getByRole('button').count(), 14);
    await drawer.getByRole('button', { name: 'Show in outline' }).click();
    await drawer.waitFor({ state: 'detached' });

    const deepest = `Level 12, ${long}`;
    await waitForFocus(deepest);
    const box = (await outlineRow(deepest).boundingBox())!;
    const actions = (await page.getByRole('button', { name: `Actions for ${deepest}`, exact: true }).boundingBox())!;
    const width = await page.evaluate(() => window.innerWidth);
    assert.ok(box.width >= 120, `the deepest title keeps room to read (${box.width}px)`);
    assert.ok(actions.x + actions.width <= width, 'row actions stay on screen');
    assert.ok(await page.evaluate(() => {
      const main = document.querySelector('.main')!;
      return main.scrollWidth <= main.clientWidth + 1;
    }), 'no sideways scrolling');

    await page.keyboard.press('ArrowUp');
    await waitForFocus(`Level 11, ${long}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'solid', 'keyboard focus is visible');
    await shot('outline-light-narrow');

    await mainWindow([1280, 820]);
    await settings('Appearance');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  });

  test('vault: nested secret notes, encrypted files with recoverable removal, and a recovery kit that unlocks', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'enve-vault-e2e-'));
    const source = join(scratch, 'wiring-diagram.txt');
    writeFileSync(source, 'synthetic wiring diagram, not a real secret');
    const copy = join(scratch, 'saved-copy.txt');
    const kitPath = join(scratch, 'kit.json');
    const stub = (open: string, save: string) => app.evaluate(({ dialog }, [openPath, savePath]) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [openPath] })) as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: savePath })) as typeof dialog.showSaveDialog;
    }, [open, save] as const);
    const passphrase = 'synthetic test passphrase';

    await settings('Secret notes');
    await page.getByLabel('Vault passphrase').fill(passphrase);
    await page.getByLabel('Repeat').fill(passphrase);
    await page.getByRole('button', { name: 'Set up the vault' }).click();
    await page.getByText('Unlocked', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'New secret note' }).click();
    const create = page.getByRole('dialog', { name: 'New secret note' });
    await create.getByLabel('Title').fill('Garage codes');
    await create.getByLabel('Secret').fill('synthetic code 1234');
    await create.getByRole('button', { name: 'Save secret' }).click();
    await create.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'New secret note inside Garage codes' }).click();
    await create.getByLabel('Title').fill('Opener remote');
    await create.getByRole('button', { name: 'Save secret' }).click();
    await page.getByRole('list', { name: 'Inside Garage codes' }).getByRole('button', { name: 'Opener remote', exact: true }).waitFor();
    const outline = await call('vault.outline') as { ok: true; value: { id: string; parentId: string | null; title: string }[] };
    const parent = outline.value.find((node) => node.title === 'Garage codes')!;
    assert.equal(outline.value.find((node) => node.title === 'Opener remote')?.parentId, parent.id, 'the child is nested in the secret parent');
    const stored = await call('items.get', parent.id) as { ok: true; value: { title: string; body: string } };
    assert.deepEqual([stored.value.title, stored.value.body], ['Secret note', ''], 'the library only sees the generic label');

    await stub(source, copy);
    await page.getByRole('button', { name: 'Garage codes', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    await drawer.getByRole('button', { name: 'Add files…' }).click();
    await page.getByText('Encrypted 1 file').waitFor();
    await drawer.getByText('wiring-diagram.txt').waitFor();
    const files = await call('items.get', parent.id) as { ok: true; value: { attachments: { filename: string }[] } };
    assert.deepEqual(files.value.attachments.map((a) => a.filename), ['Encrypted attachment.pmv'], 'the row never holds the real name');
    await drawer.getByRole('button', { name: 'Save a copy…' }).click();
    await page.getByText('Saved a decrypted copy').waitFor();
    assert.equal(readFileSync(copy, 'utf8'), 'synthetic wiring diagram, not a real secret');

    await drawer.getByRole('button', { name: 'Remove…' }).click();
    await page.getByRole('alertdialog', { name: 'Remove “wiring-diagram.txt”?' }).getByRole('button', { name: 'Remove file' }).click();
    await drawer.getByText('No files yet.', { exact: false }).waitFor();
    await drawer.getByRole('button', { name: /Versions and restore/ }).click();
    await drawer.locator('.version-list li').nth(1).getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('alertdialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
    await drawer.getByText('wiring-diagram.txt').waitFor();
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });

    await stub(kitPath, kitPath);
    await page.getByRole('button', { name: 'Create a recovery kit…' }).click();
    const code = await page.getByTestId('recovery-code').textContent() ?? '';
    assert.match(code, /^pmr1_[A-Za-z0-9_-]{43}$/);
    const kit = readFileSync(kitPath, 'utf8');
    assert.equal(JSON.parse(kit).kind, 'petty-memory-vault-recovery');
    assert.ok(!kit.includes(passphrase) && !kit.includes(code), 'the kit holds neither the passphrase nor its code');
    await page.getByRole('button', { name: 'Lock now' }).click();
    await page.getByTestId('recovery-code').waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Forgot it? Use a recovery kit' }).click();
    await page.getByLabel('Recovery code').fill(`pmr1_${'A'.repeat(43)}`);
    await page.getByRole('button', { name: 'Choose the kit file and unlock…' }).click();
    await page.getByText('doesn’t open this recovery kit', { exact: false }).waitFor();
    assert.equal((await call('vault.state') as { ok: true; value: { unlocked: boolean } }).value.unlocked, false, 'a wrong code changes nothing');
    await page.getByLabel('Recovery code').fill(code);
    await page.getByRole('button', { name: 'Choose the kit file and unlock…' }).click();
    await page.getByText('Unlocked', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Recovery code').count(), 0);

    const blockedCopy = join(scratch, 'cancelled-after-lock.txt');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (() => new Promise((resolve) => {
        (globalThis as { finishVaultDialog?: () => void }).finishVaultDialog = () => resolve({ canceled: false, filePath: target });
      })) as typeof dialog.showSaveDialog;
    }, blockedCopy);
    const attached = await call('items.get', parent.id) as { ok: true; value: { attachments: { id: string }[] } };
    const pendingSave = call('vault.saveFile', parent.id, attached.value.attachments[0]!.id);
    for (let tries = 0; tries < 30; tries++) {
      if (await app.evaluate(() => Boolean((globalThis as { finishVaultDialog?: unknown }).finishVaultDialog))) break;
      await page.waitForTimeout(20);
    }
    assert.equal(await app.evaluate(() => typeof (globalThis as { finishVaultDialog?: unknown }).finishVaultDialog), 'function');
    await call('vault.lock');
    await call('vault.unlock', passphrase);
    await app.evaluate(() => {
      const state = globalThis as { finishVaultDialog?: () => void };
      state.finishVaultDialog!();
      delete state.finishVaultDialog;
    });
    const cancelled = await pendingSave as { ok: boolean; error?: { code: string } };
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error?.code, 'locked');
    assert.equal(existsSync(blockedCopy), false, 'locking and unlocking while a dialog waits never writes a late decrypted file');
    await shot('vault-encrypted-files');
    rmSync(scratch, { recursive: true, force: true });
  });

  test('browser client: unsaved edits are guarded by an in-page dialog, never window.confirm', async () => {
    const status = await call('api.status') as { ok: true; value: { url: string } };
    const created = await call('clients.create', 'E2E browser', ['read', 'write']) as { ok: true; value: { token: string } };
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, url) => {
      void new BrowserWindow({ width: 1100, height: 800 }).loadURL(url);
    }, `${status.value.url}/`);
    const web = await opened;
    let nativeDialogs = 0;
    web.on('dialog', (dialog) => {
      nativeDialogs += 1;
      void dialog.dismiss();
    });
    await web.getByPlaceholder('em_…').fill(created.value.token);
    await web.getByRole('button', { name: 'Connect' }).click();
    const tree = web.getByRole('tree', { name: 'Outline' });
    await tree.getByRole('treeitem', { name: /Relay board notes/ }).click();
    await web.getByRole('button', { name: 'Edit', exact: true }).click();
    const text = web.getByRole('textbox', { name: 'Text', exact: true });
    await text.click();
    await web.keyboard.type('A draft worth keeping.');
    await web.getByText('Unsaved changes').waitFor();

    const close = web.getByRole('button', { name: 'Close details' });
    await close.click();
    const confirm = web.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await confirm.waitFor();
    await web.screenshot({ path: join(shots, 'browser-confirmation.png') });
    assert.equal(await web.evaluate(() => document.activeElement?.textContent), 'Keep editing', 'a destructive choice is never the default');
    await web.keyboard.press('Escape');
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await web.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close details', 'focus returns to the opener');
    assert.match(await text.textContent() ?? '', /A draft worth keeping\./, 'cancelling keeps the draft');

    for (const colorScheme of ['dark', 'light'] as const) {
      await web.emulateMedia({ colorScheme });
      await web.screenshot({ path: join(shots, `browser-editor-${colorScheme}.png`) });
    }

    await close.click();
    await confirm.getByRole('button', { name: 'Discard changes' }).click();
    await text.waitFor({ state: 'detached' });
    assert.equal(nativeDialogs, 0, 'no native confirm, alert or prompt');
    await web.close();
  });

  test('quits cleanly and releases the API port', async () => {
    const status = await call('api.status') as { ok: true; value: { url: string } };
    const child = app.process();
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
    await app.close();
    assert.equal(await exited, 0);
    await assert.rejects(fetch(`${status.value.url}/api/v1/status`));
  });
});
