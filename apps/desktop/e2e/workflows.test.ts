import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { type ElectronApplication, type Page, chromium, _electron as electron } from 'playwright';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'enve-desktop-workflows-'));

let app: ElectronApplication;
let page: Page;

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const envelope = await page.evaluate(async ([m, a]) => window.enve.call(m as string, ...(a as unknown[])), [method, args] as const);
  assert.ok(envelope.ok, JSON.stringify(envelope));
  return (envelope as { value: T }).value;
}

const nav = (label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).click();

describe('saved views and templates', { timeout: 120_000 }, () => {
  before(async () => {
    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));
    app = await electron.launch({
      args: [appDir, '--use-mock-keychain'],
      env: { ...process.env, ENVE_MEMORY_HOME: home, ENVE_MEMORY_PORT: '0', ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1' },
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => console.error('[renderer-error]', error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
  });

  after(async () => {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('a saved view starts from an example, stays live, and can be edited and removed', async () => {
    const note = await call<{ id: string }>('items.saveNote', { title: 'Opener wiring', body: 'Check the 12 V line.' });
    await nav('Saved views');
    await page.getByText('No saved views yet').waitFor();
    await page.getByRole('button', { name: /To review/ }).click();
    const form = page.getByRole('dialog', { name: 'New saved view' });
    assert.equal(await form.getByLabel('Name').inputValue(), 'To review');
    assert.equal(await form.getByLabel('Marked for review only').isChecked(), true);
    await form.getByRole('button', { name: 'Create view' }).click();
    await page.getByText('Nothing matches yet').waitFor();

    await call('presentation.update', note.id, { review: true });
    await page.locator('.item-main', { hasText: 'Opener wiring' }).waitFor();

    await page.getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit saved view' });
    await edit.getByLabel('Name').fill('Review queue');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await edit.getByLabel('Name').inputValue(), 'Review queue', 'keeping the draft leaves it in the form');
    await edit.getByRole('button', { name: 'Save view' }).click();
    await page.getByRole('navigation', { name: 'Saved views' }).getByRole('button', { name: 'Review queue' }).waitFor();

    await page.getByRole('button', { name: 'Remove…' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove view' }).click();
    await page.getByText('No saved views yet').waitFor();
    assert.deepEqual(await call('views.list'), []);
    assert.equal((await call<{ archivedAt: string | null }>('items.get', note.id)).archivedAt, null, 'removing a view leaves its items alone');
  });

  test('a note tree becomes a template and makes a filled-in copy in a project', async () => {
    const project = await call<{ id: string }>('projects.create', { name: 'Garage' });
    const root = await call<{ item: { id: string } }>('outline.createNote', { parentId: null, title: 'Standup notes', body: '' });
    await call('outline.createNote', { parentId: root.item.id, title: 'Blockers for {{project}}', body: '- [x] Order relays' });

    await nav('Notes');
    await page.locator('.item-main', { hasText: 'Standup notes' }).click();
    await page.getByRole('button', { name: 'Save as template…' }).click();
    const save = page.getByRole('dialog', { name: 'Save as template' });
    await save.getByLabel('Template name').fill('Standup {{date}}');
    await save.getByRole('button', { name: 'Save template' }).click();
    await page.getByText('This is a template.').waitFor();

    await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click();
    await nav('Templates');
    await page.locator('.item-main', { hasText: 'Standup {{date}}' }).waitFor();
    await page.getByRole('button', { name: 'Use…' }).click();
    const use = page.getByRole('dialog', { name: /^Use template/ });
    await use.getByLabel('Put it in').selectOption(project.id);
    await use.getByLabel(/Date for/).fill('2026-10-17');
    await use.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForFunction(() => (document.querySelector('.drawer input[aria-label="Title"]') as HTMLInputElement | null)?.value === 'Standup 2026-10-17');

    const created = (await call<{ items: { id: string; title: string; archivedAt: string | null }[] }>('items.page', { project: project.id }, null, 50)).items;
    const copy = created.find((item) => item.title === 'Standup 2026-10-17');
    assert.ok(copy, 'the copy lands in the chosen project');
    const children = await call<{ items: { item: { title: string; body: string } }[] }>('outline.children', copy.id, { limit: 10 });
    assert.deepEqual(children.items.map((entry) => entry.item.title), ['Blockers for Garage']);
    assert.equal(children.items[0]!.item.body, '- [ ] Order relays', 'checkboxes start unchecked');
    const source = await call<{ title: string }>('items.get', root.item.id);
    assert.equal(source.title, 'Standup notes', 'the source note is unchanged');
  });

  test('the browser client manages saved views and templates and respects a read-only pairing', async () => {
    const api = await call<{ running: boolean; url: string }>('api.status');
    assert.equal(api.running, true);
    const writer = await call<{ token: string }>('clients.create', 'Browser workflow test', ['read', 'write']);
    const browser = await chromium.launch({ headless: true });
    const web = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    web.on('pageerror', (error) => errors.push(error.message));
    const shots = join(appDir, 'test-results', 'screenshots');
    mkdirSync(shots, { recursive: true });
    try {
      await web.goto(api.url);
      await web.getByRole('textbox', { name: /Token/ }).fill(writer.token);
      await web.getByRole('button', { name: 'Connect', exact: true }).click();
      await web.getByRole('button', { name: 'Saved views', exact: true }).click();
      await web.getByRole('button', { name: 'New view', exact: true }).click();
      await web.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser standups');
      await web.getByRole('searchbox', { name: /Words to match/ }).fill('standup');
      await web.getByRole('button', { name: 'Create view', exact: true }).click();
      await web.getByRole('heading', { name: 'Browser standups', exact: true }).waitFor();
      await web.getByRole('button', { name: /^Standup 2026-10-17/ }).waitFor();
      assert.equal(await web.getByRole('button', { name: /^Standup \{\{date\}\}/ }).count(), 0);
      await web.screenshot({ path: join(shots, 'workflows-browser-views.png') });

      await web.getByRole('button', { name: 'Templates', exact: true }).click();
      await web.getByRole('button', { name: 'Use…', exact: true }).click();
      await web.getByRole('textbox', { name: 'Title (optional)' }).fill('Browser daily {{date}}');
      await web.getByRole('combobox', { name: 'Put it in' }).selectOption({ label: 'Garage' });
      await web.getByLabel('Date for {{date}}').fill('2026-10-18');
      await web.getByRole('button', { name: 'Create and open', exact: true }).click();
      await web.getByRole('heading', { name: 'Browser daily 2026-10-18', exact: true }).waitFor();
      await web.screenshot({ path: join(shots, 'workflows-browser-template.png') });

      await web.getByRole('button', { name: 'Disconnect', exact: true }).click();
      const reader = await call<{ token: string }>('clients.create', 'Read-only workflow test', ['read']);
      await web.getByRole('textbox', { name: /Token/ }).fill(reader.token);
      await web.getByRole('button', { name: 'Connect', exact: true }).click();
      await web.getByRole('button', { name: 'Saved views', exact: true }).click();
      await web.getByRole('heading', { name: 'Browser standups', exact: true }).waitFor();
      assert.equal(await web.getByRole('button', { name: 'New view', exact: true }).count(), 0);
      assert.equal(await web.getByRole('button', { name: 'Remove', exact: true }).count(), 0);
      await web.getByRole('button', { name: 'Templates', exact: true }).click();
      await web.getByRole('button', { name: /^Standup \{\{date\}\}/ }).waitFor();
      assert.equal(await web.getByRole('button', { name: 'Use…', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
