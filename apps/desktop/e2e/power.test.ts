import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ocrImage = resolve(appDir, '..', '..', 'packages', 'ingestion', 'test', 'fixtures', 'ocr-note.png');
const home = mkdtempSync(join(tmpdir(), 'enve-desktop-power-'));
const fixtures = mkdtempSync(join(tmpdir(), 'enve-desktop-power-fixtures-'));
// Screenshots of fictional data for review; ENVE_EVIDENCE_DIR moves them.
const evidence = process.env.ENVE_EVIDENCE_DIR ?? join(tmpdir(), 'petty-memory-power-evidence');

let app: ElectronApplication;
let page: Page;
let web: Page | undefined;
let server: Server;
let modelUrl = '';
/** What the stand-in model server was asked, in order. */
const requests: { prompt: string; step: string }[] = [];
/** Requests whose schema no fixture recognises; the suite ends by asserting there were none. */
const unexpected: string[] = [];

type Item = {
  id: string; type: string; title: string; body: string; tags: string[]; remindAt: string | null; archivedAt: string | null;
  project?: { id: string; name: string } | null; metadata: Record<string, unknown>;
};
type Detail = Item & { relations: { id: string; kind: string; direction: string }[]; attachments: { id: string; filename: string; size: number }[] };
type Entry = { item: Item; parentId: string | null };
type Conversation = { id: string; title: string; mode: string; query?: string; rootId?: string; messages: { role: string; content: string }[] };
type Schedule = { count: number; dueAt: string; history: { days: number }[] };
type Schema = { properties?: Record<string, { items?: { properties?: Record<string, { enum?: unknown[] }> } }> };

/** An action plan built from whichever items the host put in scope, using only the refs its schema allows. */
function actionPlan(prompt: string, schema: Schema): unknown {
  const listed = /<items>\n([\s\S]*?)\n<\/items>/.exec(prompt);
  assert.ok(listed, 'the actions prompt lists its scope items');
  const refs = (JSON.parse(listed[1]!) as { ref: string }[]).map((item) => item.ref);
  const allowed = schema.properties!.operations!.items!.properties!.ref!.enum!;
  assert.ok(refs.every((ref) => allowed.includes(ref)), 'the schema enumerates every listed ref');
  const [first, last] = [refs[0]!, refs.at(-1)!];
  const blank = { ref: null, title: '', body: '', tags: [], source: null, sources: [], when: null };
  return {
    summary: 'Planned the next stargazing night from your notes.',
    operations: [
      { ...blank, kind: 'task', title: 'Order a spare eyepiece', source: first, when: '2026-11-01T17:00:00Z' },
      { ...blank, kind: 'tag', ref: first, tags: ['astronomy', 'gear'] },
      { ...blank, kind: 'reminder', ref: last, when: '2026-11-05T03:00:00Z' },
      { ...blank, kind: 'note', title: 'Stargazing brief', body: 'Check the forecast, pack the red flashlight and reach the ridge after ten.', sources: refs },
    ],
  };
}

/** Actions and editor proposals share summary/operations; only the operation schema (kind vs op) tells them apart. */
function cannedReply(prompt: string, schema: Schema | undefined): { step: string; content: string } | null {
  const keys = Object.keys(schema?.properties ?? {}).sort().join();
  const operation = schema?.properties?.operations?.items?.properties ?? {};
  if (keys === 'operations,summary' && 'kind' in operation) return { step: 'actions', content: JSON.stringify(actionPlan(prompt, schema!)) };
  return null;
}

async function shoot(name: string, target: Page = page): Promise<void> {
  mkdirSync(evidence, { recursive: true });
  await target.screenshot({ path: join(evidence, `${name}.png`) });
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const envelope = await page.evaluate(async ([m, a]) => window.enve.call(m as string, ...(a as unknown[])), [method, args] as const);
  assert.ok(envelope.ok, JSON.stringify(envelope));
  return (envelope as { value: T }).value;
}

const note = async (title: string, body: string, extra: { project?: string; tags?: string[] } = {}) =>
  (await call<Item>('items.saveNote', { title, body, ...extra })).id;
const child = async (parentId: string | null, title: string, body = '') =>
  (await call<Entry>('outline.createNote', { parentId, title, body })).item.id;
const item = (id: string) => call<Detail>('items.get', id);
const parentOf = async (id: string) => (await call<Entry>('outline.get', id)).parentId;
const notesTitled = async (title: string) => (await call<Item[]>('items.list', { type: 'note' }, 200)).filter((i) => i.title === title);
const highlights = async () => (await call<Item[]>('items.list', { type: 'note' }, 200)).filter((i) => i.metadata.enveHighlight);
const scheduleOf = async (id: string) => (await item(id)).metadata.reviewSchedule as Schedule;

const nav = (label: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).first().click();
const settings = async (section: string) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
};
const openItem = (id: string) => app.evaluate(({ BrowserWindow }, [target, url]) => {
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.webContents.send('enve:open', target);
}, [id, page.url()] as const);
const message = () => page.getByLabel('Message');
const send = () => page.locator('form.ask-form').getByRole('button', { name: 'Send' });
const useFakeModel = async () => {
  await call('ai.configure', { provider: 'ollama', model: 'fixture', baseUrl: modelUrl });
  await call('ai.setEnrich', false);
};

/** Installs a scripted speech recognizer in the page; the real one (and the microphone) is never touched. */
const installFakeSpeech = (target: Page) => target.evaluate(() => {
  type Fake = Record<string, unknown> & { calls: string[] };
  const w = window as unknown as { fakeSpeech: Fake[] };
  w.fakeSpeech = [];
  const Recognition = class {
    calls: string[] = [];
    constructor() {
      w.fakeSpeech.push(this as unknown as Fake);
    }
    start() { this.calls.push('start'); }
    stop() { this.calls.push('stop'); }
    abort() { this.calls.push('abort'); }
  };
  Object.defineProperty(w, 'SpeechRecognition', { configurable: true, value: Recognition });
  Object.defineProperty(w, 'webkitSpeechRecognition', { configurable: true, value: Recognition });
});

const speech = (target: Page, script: string) => target.evaluate((body) => {
  const r = (window as unknown as { fakeSpeech: Record<string, (...a: unknown[]) => void>[] }).fakeSpeech.at(-1)!;
  const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });
  new Function('r', 'result', body)(r, result);
}, script);

const speechCalls = (target: Page) => target.evaluate(() => (window as unknown as { fakeSpeech: { calls: string[] }[] }).fakeSpeech.at(-1)!.calls);

const setHidden = (target: Page, hidden: boolean) => target.evaluate((value) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

/** The exporter's own JSON: two annotations and a bookmark from one fictional book. */
const ENVE_EXPORT = {
  bookTitle: 'The Lantern Orchard', bookAuthor: 'Mira Castell', exportDate: '2026-10-17T12:00:00Z',
  annotations: [
    { text: 'Every lantern in the orchard was lit by hand at dusk.', note: 'Try this for the garden path.', color: '#ffff00', style: 'highlight', position: 0.25, createdAt: '2026-10-15T20:00:00Z' },
    { text: 'The keeper wrote the weather on the barn door each morning.', note: '', color: '#ffff00', style: 'highlight', position: 0.52, createdAt: '2026-10-16T08:00:00Z' },
  ],
  bookmarks: [{ title: 'The barn door', chapter: 'Chapter 7', position: '40%', note: 'Return here.', createdAt: '2026-10-16T09:00:00Z' }],
};

/** The documented interchange format, with an https source link the preview may offer. */
const INTERCHANGE = {
  format: 'petty-memory-enve-highlights', version: 1,
  entries: [
    { id: 'atlas-12', bookTitle: 'A Pocket Star Atlas', author: 'Tobin Vale', text: 'Cassiopeia is the W that circles the pole.', note: 'Easy first target.', location: 'Page 12', sourceUrl: 'https://example.com/books/pocket-star-atlas#p12' },
    { id: 'atlas-31', bookTitle: 'A Pocket Star Atlas', author: 'Tobin Vale', text: 'Lyra is small but holds the bright star Vega.', note: '', location: 'Page 31', sourceUrl: null },
  ],
};

describe('Useful every day: power workflows', { timeout: 900_000 }, () => {
  before(async () => {
    // A disposable stand-in for an Ollama server: schema-aware canned replies, so the real chat and actions pipelines run offline.
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
        const body = JSON.parse(raw) as { messages: { content: string }[]; format?: Schema };
        const prompt = body.messages.at(-1)!.content;
        let reply: ReturnType<typeof cannedReply>;
        try {
          reply = cannedReply(prompt, body.format);
        } catch (error) {
          reply = null;
          unexpected.push(`fixture failed: ${(error as Error).message}`);
        }
        if (!reply) {
          unexpected.push(Object.keys(body.format?.properties ?? {}).sort().join() || 'free-text answer');
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: 'no fixture for this request' }));
        }
        requests.push({ prompt, step: reply.step });
        res.end(JSON.stringify({ message: { content: reply.content } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    modelUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));
    app = await electron.launch({
      args: [appDir, '--use-mock-keychain'],
      env: { ...process.env, ENVE_MEMORY_HOME: home, ENVE_MEMORY_PORT: '0', ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1' },
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => console.error('[renderer-error]', error.message));
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 820);
      shell.openExternal = async () => {};
    });
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await call('settings.set', 'semanticSearch', false);
  });

  afterEach(async (context) => {
    if ((context as { passed?: boolean }).passed !== false) return;
    if (page && !page.isClosed()) await shoot('power-desktop-failure').catch(() => {});
    if (web && !web.isClosed()) await shoot('power-browser-failure', web).catch(() => {});
    if (page && !page.isClosed()) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
  });

  after(async () => {
    await web?.close().catch(() => {});
    await app?.close().catch(() => {});
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  test('desktop: the first-run checklist tracks real progress, links to its workflows and stays hidden once dismissed', { timeout: 120_000 }, async () => {
    const checklist = page.getByRole('region', { name: 'Getting started' });
    await checklist.waitFor();
    await checklist.getByText('0 of 4 done').waitFor();
    const step = (label: string) => checklist.locator('li', { hasText: label });
    assert.equal(await step('Save a note or a link').getAttribute('class'), '');
    await step('Choose an AI provider (optional)').getByText('Everything else works without one.', { exact: false }).waitFor();
    await shoot('power-desktop-setup-checklist');

    await step('Review a little each day').getByRole('button', { name: 'Open Review' }).click();
    await page.getByRole('heading', { name: 'Review', exact: true }).waitFor();
    await page.getByText('Nothing is due for review').waitFor();
    await nav('Home');
    await step('Choose an AI provider (optional)').getByRole('button', { name: 'AI settings' }).click();
    await page.getByLabel('Provider').waitFor();

    await nav('Home');
    const capture = page.getByLabel('Capture a note or link');
    await capture.fill('Polar alignment: level the tripod before the first star');
    await capture.press('Enter');
    await page.getByTestId('saved-chip').getByText(/Saved: Polar alignment/).waitFor();
    await checklist.getByText('1 of 4 done').waitFor();
    assert.equal(await step('Save a note or a link').getAttribute('class'), 'done');

    await checklist.getByRole('button', { name: 'Hide' }).click();
    await checklist.waitFor({ state: 'detached' });
    await nav('Review');
    await nav('Home');
    await page.getByLabel('Capture a note or link').waitFor();
    assert.equal(await checklist.count(), 0, 'a dismissed checklist stays hidden');
  });

  test('desktop: topic actions preview every operation, change nothing until a selective apply, undo it, and refuse a stale plan', { timeout: 120_000 }, async () => {
    const observatory = await call<{ id: string }>('projects.create', { name: 'Observatory' });
    const telescope = await note('Telescope maintenance', 'Clean the stargazing scope mirror and collimate it.', { project: observatory.id, tags: ['optics'] });
    const darkSky = await note('Dark sky sites', 'The ridge road is the best stargazing spot within an hour.', { project: observatory.id });
    await call('decisions.record', { project: observatory.id, decision: 'Use the stargazing ridge only on new-moon nights', reason: 'Less glare.' });
    await useFakeModel();

    await nav('AI chat');
    await page.getByRole('radio', { name: 'Suggest actions' }).click();
    await page.getByRole('radio', { name: 'A topic' }).click();
    await message().fill('Plan the next stargazing night: a task, tags, a reminder and a short brief.');
    assert.equal(await send().isDisabled(), true, 'nothing is sent without a topic');
    await page.getByLabel('Topic keywords').fill('stargazing');
    await send().click();
    await page.getByText('4 suggested actions. Nothing has changed yet.').waitFor();
    assert.equal(requests.at(-1)!.step, 'actions');
    const asked = requests.at(-1)!.prompt;
    assert.match(asked, /Telescope maintenance/);
    assert.match(asked, /Dark sky sites/);
    assert.doesNotMatch(asked, /new-moon/, 'decisions never enter the action scope');

    assert.deepEqual((await item(telescope)).tags, ['optics'], 'a proposal changes nothing');
    assert.equal((await item(darkSky)).remindAt, null);
    assert.equal((await notesTitled('Stargazing brief')).length, 0);
    assert.ok(!JSON.stringify(await call('tasks.list', {}, 200)).includes('Order a spare eyepiece'));

    const turns = requests.length;
    await page.getByRole('button', { name: 'Review actions…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review suggested actions' });
    const list = dialog.getByRole('list', { name: 'Suggested actions' });
    await dialog.getByText('About “stargazing”').waitFor();
    await list.getByText(/^Add task “Order a spare eyepiece”, due /).waitFor();
    await list.locator('li', { hasText: 'Tag “Telescope maintenance”' }).getByText('#astronomy').waitFor();
    await list.getByText(/^Remind me about “Dark sky sites”/).waitFor();
    await list.getByText('Add note “Stargazing brief”').waitFor();
    assert.equal(await list.getByRole('checkbox', { checked: true }).count(), 4);
    assert.equal(requests.length, turns, 'reviewing doesn’t ask the model again');
    await shoot('power-desktop-actions-review');

    await list.getByRole('checkbox', { name: /Remind me about/ }).uncheck();
    await dialog.getByRole('button', { name: 'Apply 3 actions' }).click();
    await dialog.getByText('Added 2 items and updated 1 item.').waitFor();
    await dialog.getByRole('button', { name: /Order a spare eyepiece/ }).waitFor();
    const task = (await call<Item[]>('tasks.list', {}, 200)).find((t) => t.title === 'Order a spare eyepiece');
    assert.ok(task, 'the ticked task was created');
    assert.match(JSON.stringify(task), /2026-11-01T17:00:00\.000Z/);
    assert.deepEqual((await item(telescope)).tags.sort(), ['astronomy', 'gear', 'optics']);
    assert.equal((await item(darkSky)).remindAt, null, 'the unticked reminder was left out');
    const [brief] = await notesTitled('Stargazing brief');
    assert.ok(brief);
    assert.equal(brief.project?.id, observatory.id, 'the brief is filed from the reviewed scope');
    assert.deepEqual((await item(brief.id)).relations.filter((r) => r.kind === 'derived_from').map((r) => r.id).sort(), [telescope, darkSky].sort());

    await dialog.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undid 3 changes').waitFor();
    await page.getByText('Undone. Nothing from these actions is applied.').waitFor();
    assert.deepEqual((await item(telescope)).tags, ['optics']);
    assert.ok((await item(task.id)).archivedAt, 'undo archives the created task');
    assert.ok((await item(brief.id)).archivedAt, 'undo archives the created brief');

    await message().fill('Again, the same four actions please.');
    await send().click();
    await page.getByRole('button', { name: 'Review actions…' }).waitFor();
    await call('items.update', telescope, { body: 'Clean the stargazing scope mirror, collimate it, and check the finder.' });
    await page.getByRole('button', { name: 'Review actions…' }).click();
    await dialog.getByRole('button', { name: 'Apply 4 actions' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'changed while the proposal was being reviewed' }).waitFor();
    assert.deepEqual((await item(telescope)).tags, ['optics'], 'a stale plan applies nothing');
    assert.equal((await item(darkSky)).remindAt, null);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  test('desktop: a chat is saved only when asked, updated, found by search, resumed and archived reversibly', { timeout: 120_000 }, async () => {
    assert.deepEqual(await call('chats.list'), [], 'chats are not saved on their own');
    await page.getByRole('button', { name: 'Save chat' }).click();
    const naming = page.getByRole('dialog', { name: 'Save this chat' });
    await naming.getByLabel('Title').fill('Stargazing plan');
    await naming.getByRole('button', { name: 'Save chat' }).click();
    await page.getByText('Saved “Stargazing plan”').waitFor();
    await page.locator('.chat-scope-end').getByText('Saved', { exact: true }).waitFor();
    const [saved] = await call<Conversation[]>('chats.list');
    assert.ok(saved);
    assert.equal(saved.title, 'Stargazing plan');
    assert.equal(saved.mode, 'actions');
    assert.equal(saved.query, 'stargazing');
    assert.equal(saved.messages.length, 4);
    assert.equal(saved.messages[0]!.content, 'Plan the next stargazing night: a task, tags, a reminder and a short brief.');

    await message().fill('One more brief for the reminder night.');
    await send().click();
    await page.locator('.chat-turn.assistant:not(.muted)').nth(2).waitFor();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.chat-scope-end').getByText('Saved', { exact: true }).waitFor();
    const updated = await call<Conversation>('chats.get', saved.id);
    assert.equal(updated.messages.length, 6, 'saving changes updates the same conversation');
    assert.equal(updated.title, 'Stargazing plan');
    assert.equal((await call<Conversation[]>('chats.list')).length, 1);

    await page.getByRole('button', { name: 'New chat' }).click();
    assert.equal(await page.locator('.chat-turn').count(), 0);
    await page.getByRole('button', { name: 'Saved chats' }).click();
    const browser = page.getByRole('dialog', { name: 'Saved chats' });
    await browser.getByRole('list', { name: 'Saved chats' }).getByText(/Suggest actions · 6 messages/).waitFor();
    await browser.getByLabel('Search saved chats').fill('zebra');
    await browser.getByText('No matching chats').waitFor();
    await browser.getByLabel('Search saved chats').fill('reminder');
    const matches = browser.getByRole('list', { name: 'Matching saved chats' });
    await matches.waitFor();
    await shoot('power-desktop-saved-chats');
    await matches.getByRole('button', { name: /^Stargazing plan/ }).click();
    await page.getByText('Opened “Stargazing plan”.', { exact: false }).waitFor();
    assert.equal(await page.locator('.chat-turn.assistant.saved').count(), 3);
    await page.getByRole('radio', { name: 'Suggest actions', checked: true }).waitFor();
    assert.equal(await page.getByLabel('Topic keywords').inputValue(), 'stargazing');

    await page.getByRole('button', { name: 'Saved chats' }).click();
    await browser.getByRole('button', { name: 'Archive Stargazing plan' }).click();
    await page.getByText('Archived “Stargazing plan”').waitFor();
    await browser.getByText('No saved chats').waitFor();
    await page.keyboard.press('Escape');
    await browser.waitFor({ state: 'detached' });
    assert.deepEqual(await call('chats.list'), []);
    const archived = await item(saved.id);
    assert.ok(archived.archivedAt, 'archiving keeps the transcript as an archived note');
    assert.match(archived.body, /\*\*You:\*\* Plan the next stargazing night/);
    await page.getByRole('button', { name: 'Save chat' }).waitFor();
  });

  test('desktop: saved chats stay readable as ordinary notes with AI turned off', { timeout: 120_000 }, async () => {
    const moon = await call<Conversation>('chats.save', {
      title: 'Moon phase questions', mode: 'ask',
      messages: [{ role: 'user', content: 'When is the next new moon?' }, { role: 'assistant', content: 'The next new moon falls on the ninth.' }],
    });
    await call('ai.configure', { provider: 'none', model: '', baseUrl: '' });
    await nav('AI chat');
    await page.getByText('Set up an AI provider to chat').waitFor();
    assert.equal((await call<Conversation>('chats.get', moon.id)).messages.length, 2);

    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('button', { name: 'Saved chats' }).click();
    const saved = page.getByRole('dialog', { name: 'Saved chats' });
    await saved.getByRole('button', { name: /^Moon phase questions/ }).click();
    await page.locator('.chat-turn.assistant.saved', { hasText: 'The next new moon falls on the ninth.' }).waitFor();
    await message().fill('What next?');
    assert.equal(await send().isDisabled(), true, 'saved chats remain readable but cannot send with AI off');

    await nav('Notes');
    await page.locator('.item-main', { hasText: 'Moon phase questions' }).click();
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    const transcript = drawer.getByRole('textbox', { name: 'Note', exact: true });
    await transcript.getByText('When is the next new moon?', { exact: false }).waitFor();
    assert.match(await transcript.textContent() ?? '', /You:.*When is the next new moon\?.*Assistant:.*falls on the ninth/s);
    await shoot('power-desktop-saved-chat-ai-off');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  });

  test('desktop: daily review schedules due knowledge with presets and custom days, recorded in metadata', { timeout: 120_000 }, async () => {
    const shelf = await call<{ id: string }>('projects.create', { name: 'Review shelf' });
    const orion = await note('Orion notes', 'The belt points down to Sirius.', { project: shelf.id });
    const lyra = await note('Lyra notes', 'Vega is the bright star in Lyra.', { project: shelf.id });
    const wholeQueue = await call<{ item: Item }[]>('review.queue', { limit: 100 });
    assert.ok(wholeQueue.every((card) => !card.item.metadata.conversation), 'saved chats stay out of review');

    await nav('Review');
    await page.getByLabel('Review from').selectOption({ label: 'Review shelf' });
    const card = page.locator('article.review-card');
    await card.getByRole('heading', { name: 'Orion notes' }).waitFor();
    await card.getByText(/Not reviewed yet/).waitFor();
    await page.getByText('0 of 2 reviewed').waitFor();
    await shoot('power-desktop-review');

    const started = Date.now();
    await card.getByRole('button', { name: 'Next week' }).click();
    await card.getByRole('heading', { name: 'Lyra notes' }).waitFor();
    const week = await scheduleOf(orion);
    assert.equal(week.count, 1);
    assert.deepEqual(week.history.map((h) => h.days), [7]);
    assert.ok(Math.abs(Date.parse(week.dueAt) - (started + 7 * 86_400_000)) < 120_000, 'due a week from now');
    assert.equal((await item(orion)).body, 'The belt points down to Sirius.', 'scheduling leaves the note as it was');

    const days = card.getByRole('spinbutton');
    await days.fill('0');
    assert.equal(await card.getByRole('button', { name: 'Schedule' }).isDisabled(), true);
    await card.getByText('Choose a whole number of days from 1 to 3,650.').waitFor();
    await days.fill('45');
    await card.getByRole('button', { name: 'Schedule' }).click();
    await page.getByText('All caught up').waitFor();
    assert.deepEqual((await scheduleOf(lyra)).history.map((h) => h.days), [45]);
    assert.deepEqual(await call('review.queue', { project: shelf.id }), [], 'scheduled items leave the queue until due');
  });

  test('desktop: connections accept a mention, and a previewed merge refuses stale state, applies, and undoes to the original parents', { timeout: 120_000 }, async () => {
    const target = await child(null, 'Comet watching checklist', 'Bring the red flashlight, the star chart and a folding chair for the comet watch on the ridge.');
    const duplicate = await child(null, 'Comet watching checklist', 'Bring the red flashlight, the star chart and a folding chair for the comet watch on the ridge. Check the forecast first.');
    const batteries = await child(duplicate, 'Spare batteries', 'Two AA for the flashlight.');
    const saturday = await note('Saturday plans', 'Finish the comet watching checklist before Saturday.');

    await openItem(target);
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    await drawer.getByRole('button', { name: /Find connections/ }).click();
    await drawer.getByText(/^Found \d+ suggestions? after checking all \d+ items\.$/).waitFor();
    const mention = drawer.locator('.insight-group', { hasText: 'Unlinked mentions' }).locator('li', { hasText: 'Saturday plans' });
    await mention.getByText('Mentions “Comet watching checklist” without a link').waitFor();
    await mention.getByRole('button', { name: 'Connect' }).click();
    await mention.getByText('Connected', { exact: true }).waitFor();
    assert.ok((await item(target)).relations.some((r) => r.id === saturday && r.kind === 'related_to'));

    const dupRow = drawer.locator('.insight-group', { hasText: 'Possible duplicates' }).locator('li', { hasText: /Same title and \d+% of the same wording/ });
    await dupRow.getByRole('button', { name: /Merge…/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge notes' });
    const preview = dialog.locator('.merge-preview');
    await preview.getByText('Check the forecast first.', { exact: false }).waitFor();
    await dialog.getByText('1 children move with it; 0 files stay on the archived original.').waitFor();
    const merge = dialog.getByRole('button', { name: 'Merge', exact: true });
    assert.equal(await merge.isDisabled(), true, 'merging needs explicit consent');
    await shoot('power-desktop-merge-preview');

    await call('items.update', duplicate, { body: 'Bring the red flashlight, the star chart and a folding chair for the comet watch on the ridge. Check the forecast first, and the moon.' });
    await dialog.getByRole('checkbox').check();
    await merge.click();
    await dialog.getByRole('alert').filter({ hasText: 'changed since the merge was previewed' }).waitFor();
    assert.equal((await item(duplicate)).archivedAt, null, 'a stale merge changes nothing');
    assert.equal(await parentOf(batteries), duplicate);

    await dialog.getByRole('button', { name: 'Preview again' }).click();
    await preview.getByText('and the moon.', { exact: false }).waitFor();
    assert.equal(await dialog.getByRole('checkbox').isChecked(), false, 'a fresh preview asks for consent again');
    await dialog.getByRole('checkbox').check();
    await merge.click();
    await dialog.getByText('Merged “Comet watching checklist” into “Comet watching checklist”. The original is archived with its files.').waitFor();
    assert.ok((await item(duplicate)).archivedAt, 'the source is archived, not deleted');
    assert.equal(await parentOf(batteries), target, 'the source’s children move to the kept note');
    assert.match((await item(target)).body, /and the moon\./);

    await dialog.getByRole('button', { name: 'Undo merge' }).click();
    await page.getByText('Merge undone; both notes are back as they were').waitFor();
    assert.equal((await item(duplicate)).archivedAt, null);
    assert.equal(await parentOf(batteries), duplicate);
    assert.equal((await item(target)).body, 'Bring the red flashlight, the star chart and a folding chair for the comet watch on the ridge.');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
  });

  test('desktop: image text is extracted on request, discarded or reviewed, and saved as a note with the original image kept', { timeout: 300_000 }, async () => {
    const [image] = await call<Detail[]>('files.save', [ocrImage]);
    assert.ok(image);
    const before = await item(image.id);
    const notesBefore = (await call<Item[]>('items.list', { type: 'note' }, 200)).length;

    await openItem(image.id);
    const drawer = page.getByRole('dialog', { name: /details$/ });
    const section = drawer.locator('section.image-text');
    await section.getByRole('heading', { name: 'Text in the image' }).waitFor();
    await section.getByRole('button', { name: /Extract text/ }).click();
    const draft = section.locator('form.ocr-draft');
    await draft.getByText(/^Read with Tesseract/).waitFor({ timeout: 120_000 });
    assert.match(await draft.getByLabel('Text', { exact: true }).inputValue(), /MEMORY KEEPS IDEAS/i);
    await draft.getByRole('button', { name: 'Discard' }).click();
    await draft.waitFor({ state: 'detached' });
    assert.equal((await call<Item[]>('items.list', { type: 'note' }, 200)).length, notesBefore, 'nothing is saved without review');

    await section.getByRole('button', { name: /Extract text/ }).click();
    await draft.getByText(/^Read with Tesseract/).waitFor({ timeout: 120_000 });
    await draft.getByLabel('Note title', { exact: true }).fill('Garden card text');
    const text = draft.getByLabel('Text', { exact: true });
    await text.fill(`${await text.inputValue()}\nChecked against the card.`);
    await shoot('power-desktop-ocr-draft');
    await draft.getByRole('button', { name: 'Save as note' }).click();
    await section.getByText('Saved as a note. The image is unchanged.', { exact: false }).waitFor();

    const [saved] = await notesTitled('Garden card text');
    assert.ok(saved);
    assert.match(saved.body, /MEMORY KEEPS IDEAS/i);
    assert.match(saved.body, /Checked against the card\./);
    assert.ok(saved.body.includes(`[[item:${image.id}|`), 'the note links back to the image');
    const after = await item(image.id);
    assert.equal(after.archivedAt, null);
    assert.deepEqual(after.attachments.map((a) => [a.id, a.size]), before.attachments.map((a) => [a.id, a.size]), 'the original image is retained');
    await page.keyboard.press('Escape');
  });

  test('desktop: Enve highlights are previewed from the exported file, imported into a project, and never duplicated on repeat', { timeout: 120_000 }, async () => {
    await call('projects.create', { name: 'Reading room' });
    const exported = join(fixtures, 'lantern-orchard.json');
    writeFileSync(exported, JSON.stringify(ENVE_EXPORT));
    const wrong = join(fixtures, 'lantern-orchard.txt');
    writeFileSync(wrong, 'not an export');

    await settings('Import');
    await page.getByLabel('Put imported items in').selectOption({ label: 'Reading room' });
    const picker = page.locator('.enve-import input[type="file"]');
    await picker.setInputFiles(wrong);
    await page.locator('.enve-import').getByRole('alert').getByText('Choose the .json or .md file that Enve exported.').waitFor();

    await picker.setInputFiles(exported);
    const preview = page.locator('.highlight-preview');
    await preview.getByText(/: 3 highlights from 1 book/).waitFor();
    await preview.getByText('They go into Reading room.', { exact: false }).waitFor();
    await preview.getByText('Every lantern in the orchard was lit by hand at dusk.').waitFor();
    await preview.getByText('The Lantern Orchard · Mira Castell · 25%').waitFor();
    assert.equal((await highlights()).length, 0, 'previewing writes nothing');
    await preview.getByRole('button', { name: 'Import 3 highlights' }).scrollIntoViewIfNeeded();
    await shoot('power-desktop-enve-import-preview');

    await preview.getByRole('button', { name: 'Import 3 highlights' }).click();
    const result = page.locator('.enve-import [role="status"]');
    await result.getByText('imported 3, skipped 0 already saved', { exact: false }).waitFor();
    const imported = await highlights();
    assert.equal(imported.length, 3);
    assert.ok(imported.every((h) => h.project?.name === 'Reading room' && h.tags.includes('enve')));
    assert.ok(imported.some((h) => h.title === 'The Lantern Orchard · 25%' && h.body.includes('Try this for the garden path.')));

    await picker.setInputFiles(exported);
    await preview.getByRole('button', { name: 'Import 3 highlights' }).click();
    await result.getByText('imported 0, skipped 3 already saved', { exact: false }).waitFor();
    assert.equal((await highlights()).length, 3, 'a repeated import adds nothing');
  });

  test('desktop: note dictation fills the capture box, disables Save while listening, and saves only on request', { timeout: 120_000 }, async () => {
    await nav('Home');
    await installFakeSpeech(page);
    const capture = page.getByRole('region', { name: 'Quick capture' });
    const box = capture.getByLabel('Capture a note or link');
    const save = capture.getByRole('button', { name: 'Save', exact: true });
    await box.fill('Telescope night:');
    const before = (await call<Item[]>('items.list', { type: 'note' }, 200)).length;

    await capture.getByRole('button', { name: 'Dictate a note' }).click();
    await capture.getByText('Starting dictation…').waitFor();
    await speech(page, 'r.onstart()');
    await capture.getByText('Listening. Press Stop, then Save when it reads right.').waitFor();
    assert.equal(await save.isDisabled(), true, 'no saving while recording');
    await speech(page, "r.onresult({ resultIndex: 0, results: [result('clear skies after', false)] })");
    await capture.getByText('clear skies after…').waitFor();
    assert.equal(await box.inputValue(), 'Telescope night:', 'partial words stay out of the note');
    await speech(page, "r.onresult({ resultIndex: 0, results: [result('clear skies after ten', true)] })");
    assert.equal(await box.inputValue(), 'Telescope night: clear skies after ten');
    await shoot('power-desktop-note-dictation');

    await capture.getByRole('button', { name: 'Stop' }).click();
    assert.deepEqual(await speechCalls(page), ['start', 'stop']);
    await speech(page, 'r.onend()');
    await capture.getByRole('button', { name: 'Dictate a note' }).waitFor();
    assert.equal((await call<Item[]>('items.list', { type: 'note' }, 200)).length, before, 'dictation never saves on its own');
    await save.click();
    await page.getByTestId('saved-chip').getByText(/Saved: Telescope night: clear skies after ten/).waitFor();
    assert.ok((await call<Item[]>('items.list', { type: 'note' }, 200)).some((n) => n.body === 'Telescope night: clear skies after ten'));

    await capture.getByRole('button', { name: 'Dictate a note' }).click();
    await speech(page, 'r.onstart()');
    await setHidden(page, true);
    assert.deepEqual(await speechCalls(page), ['start', 'abort'], 'hiding the window releases the recognizer');
    await setHidden(page, false);
    await capture.getByRole('button', { name: 'Dictate a note' }).waitFor();
  });

  test('browser: note dictation and Enve interchange import with repeat dedup', { timeout: 120_000 }, async () => {
    await call('projects.create', { name: 'Browser shelf' });
    await useFakeModel();
    const { url } = await call<{ url: string }>('api.status');
    const full = await call<{ token: string }>('clients.create', 'E2E power browser', ['read', 'write']);
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, address) => {
      void new BrowserWindow({ width: 1100, height: 820 }).loadURL(address);
    }, `${url}/`);
    web = await opened;
    web.on('pageerror', (error) => console.error('[browser-error]', error.message));
    await web.getByPlaceholder('em_…').waitFor();
    await installFakeSpeech(web);
    await web.getByPlaceholder('em_…').fill(full.token);
    await web.getByRole('button', { name: 'Connect' }).click();
    const sections = web.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'Capture & import' }).click();

    const form = web.getByRole('form', { name: 'New note' });
    const save = form.getByRole('button', { name: 'Save note' });
    await form.getByLabel('Note title').fill('Backyard observing');
    await form.getByLabel('Note text').fill('Seeing was steady');
    await form.getByRole('button', { name: 'Dictate' }).click();
    await speech(web, 'r.onstart()');
    await form.getByText('Listening. Press Stop, then Save when it reads right.').waitFor();
    assert.equal(await save.isDisabled(), true, 'no saving while listening');
    await speech(web, "r.onresult({ resultIndex: 0, results: [result('Saturn rings at eleven', true)] })");
    assert.equal(await form.getByLabel('Note text').inputValue(), 'Seeing was steady Saturn rings at eleven');
    assert.equal(await save.isDisabled(), true);
    await shoot('power-browser-capture-dictation', web);
    await form.getByRole('button', { name: 'Stop' }).click();
    assert.deepEqual(await speechCalls(web), ['start', 'stop']);
    await speech(web, 'r.onend()');
    assert.equal((await notesTitled('Backyard observing')).length, 0, 'dictation never saves on its own');
    await form.locator('button:enabled', { hasText: 'Save note' }).waitFor();
    await save.click();
    await form.getByText(/^Note saved\./).waitFor();
    const [observing] = await notesTitled('Backyard observing');
    assert.equal(observing?.body, 'Seeing was steady Saturn rings at eleven');

    const exported = join(fixtures, 'pocket-star-atlas.json');
    writeFileSync(exported, JSON.stringify(INTERCHANGE));
    const before = (await highlights()).length;
    const importPanel = web.getByRole('region', { name: 'Enve book highlights' });
    await importPanel.getByLabel('Enve highlights export').setInputFiles(exported);
    await importPanel.getByText(/: 2 highlights from 1 book/).waitFor();
    assert.equal(await importPanel.getByRole('link', { name: 'Open source' }).getAttribute('href'), 'https://example.com/books/pocket-star-atlas#p12');
    assert.equal((await highlights()).length, before, 'previewing writes nothing');
    await importPanel.getByRole('button', { name: 'Import 2 highlights' }).scrollIntoViewIfNeeded();
    await shoot('power-browser-enve-import', web);
    await importPanel.getByRole('button', { name: 'Import 2 highlights' }).click();
    await importPanel.getByText('pocket-star-atlas.json: imported 2, skipped 0 already saved.').waitFor();
    assert.equal((await highlights()).length, before + 2);
    await importPanel.getByLabel('Enve highlights export').setInputFiles(exported);
    await importPanel.getByRole('button', { name: 'Import 2 highlights' }).click();
    await importPanel.getByText('pocket-star-atlas.json: imported 0, skipped 2 already saved.').waitFor();
    assert.equal((await highlights()).length, before + 2, 'a repeated import adds nothing');
  });

  test('browser: review schedules the chosen project’s due card', { timeout: 120_000 }, async () => {
    const shelf = (await call<{ id: string; name: string }[]>('projects.list')).find((p) => p.name === 'Browser shelf')!;
    const cassiopeia = await note('Cassiopeia notes', 'The W shape points to Andromeda.', { project: shelf.id });
    const sections = web!.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'Review' }).click();
    await web!.getByLabel('Review from').selectOption({ label: 'Browser shelf' });
    await web!.getByRole('heading', { name: 'Cassiopeia notes' }).waitFor();
    await shoot('power-browser-review', web!);
    await web!.getByRole('form', { name: 'See it again' }).getByRole('button', { name: 'Tomorrow' }).click();
    await web!.getByText('All caught up: you reviewed 1.', { exact: false }).waitFor();
    const schedule = await scheduleOf(cassiopeia);
    assert.equal(schedule.count, 1);
    assert.deepEqual(schedule.history.map((h) => h.days), [1]);
  });

  test('browser: branch actions apply only the ticked operations, undo, and the chat is saved explicitly', { timeout: 120_000 }, async () => {
    const meteor = await child(null, 'Meteor shower night', 'Plan for the meteor shower on the ridge.');
    const thermos = await child(meteor, 'Thermos and blankets', 'Hot cocoa and two wool blankets.');
    const sections = web!.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'AI chat' }).click();
    await web!.getByRole('radio', { name: 'Suggest actions' }).check();
    await web!.getByRole('button', { name: 'Choose notes to work from…' }).click();
    await web!.getByLabel('Search items').fill('Meteor shower night');
    await web!.getByRole('option', { name: /Meteor shower night/ }).click();
    await web!.getByRole('button', { name: 'Notes: Meteor shower night' }).waitFor();
    await web!.getByLabel('Message').fill('Plan the meteor night: a task, tags, a reminder and a brief.');
    await web!.locator('form.chat-form').getByRole('button', { name: 'Send' }).click();
    await web!.getByText('4 suggested actions. Nothing has changed yet.').waitFor();
    assert.match(requests.at(-1)!.prompt, /Thermos and blankets/, 'a branch scope includes what’s inside it');

    const asked = requests.length;
    await web!.getByRole('button', { name: 'Review actions' }).click();
    const choices = web!.getByRole('checkbox', { name: 'Include this action' });
    assert.equal(await choices.count(), 4);
    assert.equal(requests.length, asked);
    await shoot('power-browser-actions-review', web!);
    await choices.first().uncheck();
    await web!.getByRole('button', { name: 'Apply 3 actions' }).click();
    await web!.getByText('Added 1 item and updated 2 items.').waitFor();
    assert.deepEqual((await item(meteor)).tags.sort(), ['astronomy', 'gear']);
    assert.equal((await item(thermos)).remindAt, '2026-11-05T03:00:00.000Z');
    const briefs = (await notesTitled('Stargazing brief')).filter((n) => !n.archivedAt);
    assert.equal(briefs.length, 1);
    const activeTasks = (await call<Item[]>('tasks.list', {}, 200)).filter((t) => t.title === 'Order a spare eyepiece' && !t.archivedAt);
    assert.equal(activeTasks.length, 0, 'the unticked task was left out');

    await web!.getByRole('button', { name: 'Undo these actions' }).click();
    await web!.getByText('Undid 3 changes. Nothing from these actions is applied.').waitFor();
    assert.deepEqual((await item(meteor)).tags, []);
    assert.equal((await item(thermos)).remindAt, null);
    assert.ok((await item(briefs[0]!.id)).archivedAt);

    await web!.getByRole('button', { name: 'Save chat' }).click();
    const naming = web!.getByRole('dialog', { name: 'Save this chat' });
    await naming.getByLabel('Title').fill('Meteor night plan');
    await naming.getByRole('button', { name: 'Save chat' }).click();
    await web!.getByText('Saved “Meteor night plan”').waitFor();
    const saved = (await call<Conversation[]>('chats.list')).find((c) => c.title === 'Meteor night plan');
    assert.equal(saved?.mode, 'actions');
    assert.equal(saved?.rootId, meteor);
    assert.equal(saved?.messages.length, 2);
  });

  test('browser: with AI turned off on the server, saved chats can still be listed and read', { timeout: 120_000 }, async () => {
    await call('ai.configure', { provider: 'none', model: '', baseUrl: '' });
    const sections = web!.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'Outline' }).click();
    await sections.getByRole('button', { name: 'AI chat' }).click();
    await web!.getByText('No AI provider is set up on the server.').waitFor();
    await web!.getByRole('button', { name: 'Saved chats' }).click();
    const panel = web!.getByRole('region', { name: 'Saved chats' });
    await panel.getByRole('button', { name: 'Moon phase questions', exact: true }).click();
    await web!.getByText('Opened “Moon phase questions”.', { exact: false }).waitFor();
    await web!.locator('.chat-turn.assistant.saved', { hasText: 'The next new moon falls on the ninth.' }).waitFor();
    await web!.locator('.chat-turn.user', { hasText: 'When is the next new moon?' }).waitFor();
    await web!.getByLabel('Message').fill('Anything else?');
    assert.equal(await web!.locator('form.chat-form').getByRole('button', { name: 'Send' }).isDisabled(), true, 'nothing is sent without a provider');
    await shoot('power-browser-saved-chat-ai-off', web!);
  });

  test('browser: a duplicate is merged after preview and consent, then undone to its original parent', { timeout: 120_000 }, async () => {
    const drawing = 'Pencil drawing of the faint glow south of the belt, shaded at low power with a soft eraser for the brighter core.';
    const sketch = await child(null, 'Nebula sketch', drawing);
    const copy = await child(null, 'Nebula sketch copy', `${drawing} Redo it at higher power.`);
    const wheel = await child(copy, 'Filter wheel', 'Try the OIII filter.');
    const sections = web!.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'Search' }).click();
    await web!.getByRole('searchbox', { name: 'Search', exact: true }).fill('Nebula sketch');
    await web!.locator('ul.results li button').filter({ has: web!.locator('.row-title', { hasText: /^Nebula sketch$/ }) }).click();
    const detail = web!.getByRole('complementary', { name: 'Item details' });
    await detail.getByRole('button', { name: 'Find connections' }).click();
    const row = detail.locator('.insight-list li', { hasText: 'Nebula sketch copy' }).filter({ hasText: /Nearly the same note/ });
    await row.getByRole('button', { name: 'Merge…' }).click();
    const form = detail.locator('.merge-form');
    await form.locator('.merge-preview').getByText('Redo it at higher power.', { exact: false }).waitFor();
    assert.equal(await form.getByRole('button', { name: 'Merge', exact: true }).isDisabled(), true);
    await shoot('power-browser-merge-preview', web!);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Merge', exact: true }).click();
    await detail.getByText('Merged “Nebula sketch copy” into “Nebula sketch”. The original is archived with its files.').waitFor();
    assert.ok((await item(copy)).archivedAt);
    assert.equal(await parentOf(wheel), sketch);

    await detail.getByRole('button', { name: 'Undo merge' }).click();
    await detail.getByText('Undone. “Nebula sketch copy” and “Nebula sketch” are separate again.').waitFor();
    assert.equal((await item(copy)).archivedAt, null);
    assert.equal(await parentOf(wheel), copy);
    assert.equal((await item(sketch)).body, drawing);

    assert.deepEqual(unexpected, [], 'only the actions pipeline asked the model');
  });
});
