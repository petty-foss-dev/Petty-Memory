import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { EnveMemory } from '@enve-memory/core';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';
import { knowledgeAudio, knowledgePdf, knowledgeScanPdf } from '../../../scripts/knowledge-fixtures.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagedExecutable = process.env.ENVE_KNOWLEDGE_EXECUTABLE;
const home = mkdtempSync(join(tmpdir(), 'enve-desktop-knowledge-'));
const cache = mkdtempSync(join(tmpdir(), 'enve-desktop-knowledge-cache-'));
const fixtures = mkdtempSync(join(tmpdir(), 'enve-desktop-knowledge-fixtures-'));
// The watched folder lives outside the library, as a person's own documents folder would.
const watched = realpathSync(mkdtempSync(join(tmpdir(), 'enve-desktop-knowledge-watched-')));
// Screenshots of fictional data for review; ENVE_EVIDENCE_DIR moves them.
const evidence = process.env.ENVE_EVIDENCE_DIR ?? join(tmpdir(), 'petty-memory-knowledge-e2e-evidence');

let app: ElectronApplication;
let page: Page;
let web: Page | undefined;
let server: Server;
let fixtureUrl = '';
let apiUrl = '';
let writerToken = '';
let readerToken = '';

/** Ids of what was seeded before the app started. */
const seeded = {
  garden: '', reading: '', town: '', raisedBed: '', seedSwap: '', folderWatch: '',
  libraryOld: '', libraryNew: '', poolOld: '', poolNew: '', ferryOld: '', ferryNew: '',
};
/** Ids created during the journeys and used by later tests. */
const made = { pdf: '', pdfTitle: '', audio: '', audioTitle: '', transcript: '', collection: '' };

/** What the stand-in model server was asked, in order. */
const requests: { prompt: string; step: string }[] = [];
/** Requests no fixture recognises; the suite ends by asserting there were none. */
const unexpected: string[] = [];
/** Renderer errors from the desktop window and the browser client. */
const problems: string[] = [];
/** Refs and titles each fake action plan was built from. */
const plans: { titles: string[]; first: string; last: string }[] = [];
const transcriptionRequests: string[] = [];
let feedRequests = 0;
let feedEntries = [
  { guid: 'tools', title: 'Tool library opens Saturdays', text: 'The tool library opens at the allotment shed every Saturday morning.' },
  { guid: 'barrels', title: 'Rain barrels back in stock', text: 'Rain barrels are back in stock at the allotment office.' },
];

type Item = {
  id: string; type: string; title: string; body: string; url: string | null; tags: string[]; remindAt: string | null; archivedAt: string | null;
  project?: { id: string; name: string } | null; metadata: Record<string, unknown>; updatedAt: string;
};
type Detail = Item & { content: string; relations: { id: string; kind: string; direction: string }[]; attachments: { id: string; sha256: string; filename: string; mimeType: string; size: number }[] };
type Field = { id: string; key: string; name: string; type: string; options?: { id: string; name: string }[] };
type Collection = { id: string; name: string; layout: string; groupBy: string | null; fields: Field[]; sort: { field: string; direction: string }[]; filters: { field: string; op: string; value?: unknown }[] };
type Rows = { rows: { item: Item; values: Record<string, unknown> }[]; total: number };
type Recipe = { id: string; name: string; instruction: string; scope: { rootId: string | null; query: string | null; project: string | null } };
type Preference = { id: string; name: string; instruction: string; project: string | null };
type PdfSource = { id: string; sha256: string; status: string; pageCount: number; ocrPages: { page: number; id: string }[]; annotations: number };
type PdfPages = { pages: { page: number; text: string; ocr: { id: string; text: string } | null }[] };
type Annotation = { id: string; page: number; quote: string; textSource: string; status: string; body: string };
type Passage = { id: string; start: number; end: number; quote: string };
type Watch = { id: string; name: string; kind: string; pending: number; folder: { approved: boolean; available: boolean } | null };
type Schema = { properties?: Record<string, { items?: { properties?: Record<string, { enum?: unknown[] }> } }> };

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** An action plan built from whichever items the host put in scope, using only the refs its schema allows. */
function actionPlan(prompt: string, schema: Schema): unknown {
  const listed = /<items>\n([\s\S]*?)\n<\/items>/.exec(prompt);
  assert.ok(listed, 'the actions prompt lists its scope items');
  const items = JSON.parse(listed[1]!) as { ref: string; title: string }[];
  const allowed = schema.properties!.operations!.items!.properties!.ref!.enum!;
  assert.ok(items.every((item) => allowed.includes(item.ref)), 'the schema enumerates every listed ref');
  const [first, last] = [items[0]!, items.at(-1)!];
  plans.push({ titles: items.map((item) => item.title), first: first.title, last: last.title });
  const blank = { ref: null, title: '', body: '', tags: [], source: null, sources: [], when: null };
  return {
    summary: 'Planned the next garden work from your notes.',
    operations: [
      { ...blank, kind: 'task', title: 'Order cedar boards', source: first.ref, when: '2026-11-01T17:00:00Z' },
      { ...blank, kind: 'tag', ref: first.ref, tags: ['garden', 'beds'] },
      { ...blank, kind: 'reminder', ref: last.ref, when: '2026-11-05T17:00:00Z' },
      { ...blank, kind: 'note', title: 'Garden brief', body: 'Build the cedar beds before spring and swap seeds in March.', sources: items.map((item) => item.ref) },
    ],
  };
}

/** A FreshnessProposal raw reply: the first two sources, each quoted exactly from its own text. */
function freshnessReply(prompt: string): unknown {
  const listed = /<sources>\n([\s\S]*?)\n<\/sources>/.exec(prompt);
  assert.ok(listed, 'the freshness prompt lists its sources');
  const sources = JSON.parse(listed[1]!) as { ref: string; title: string; text: string }[];
  if (sources.length < 2) return { suggestions: [] };
  const [first, second] = sources as [typeof sources[0], typeof sources[0]];
  const quote = (text: string) => text.split(/(?<=\.)\s/)[0]!.trim();
  return {
    suggestions: [{
      kind: 'conflict', first: first.ref, second: second.ref, firstQuote: quote(first.text), secondQuote: quote(second.text),
      reason: 'The two notes give different times for the same thing.',
    }],
  };
}

function cannedReply(prompt: string, schema: Schema | undefined): { step: string; content: string } | null {
  const keys = Object.keys(schema?.properties ?? {}).sort().join();
  const operation = schema?.properties?.operations?.items?.properties ?? {};
  if (keys === 'operations,summary' && 'kind' in operation) return { step: 'actions', content: JSON.stringify(actionPlan(prompt, schema!)) };
  if (keys === 'suggestions') return { step: 'freshness', content: JSON.stringify(freshnessReply(prompt)) };
  return null;
}

const feedXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Allotment newsletter</title><link>${fixtureUrl}/</link>
${feedEntries.map((entry) => `<item><guid isPermaLink="false">${entry.guid}</guid><title>${entry.title}</title><link>${fixtureUrl}/posts/${entry.guid}</link><pubDate>Fri, 16 Oct 2026 08:00:00 GMT</pubDate><description>${entry.text}</description></item>`).join('\n')}
</channel></rss>`;

async function shoot(name: string, target: Page = page): Promise<void> {
  mkdirSync(evidence, { recursive: true });
  await target.screenshot({ path: join(evidence, `${name}.png`) });
}

function watchErrors(target: Page, label: string): void {
  target.on('pageerror', (error) => problems.push(`[${label} pageerror] ${error.message}`));
  target.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label} console] ${message.text()}`);
  });
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const envelope = await page.evaluate(async ([m, a]) => window.enve.call(m as string, ...(a as unknown[])), [method, args] as const);
  assert.ok(envelope.ok, JSON.stringify(envelope));
  return (envelope as { value: T }).value;
}

const k = <T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: Record<string, unknown>) =>
  call<T>('knowledge.request', { method, path, ...(body ? { body } : {}) });
const item = (id: string) => call<Detail>('items.get', id);
const notes = () => call<Item[]>('items.list', { type: 'note' }, 200);
const research = async (kind: string) => (await notes()).filter((n) => (n.metadata.research as { kind?: string } | undefined)?.kind === kind);
const activeTasks = async (title: string) => (await call<Item[]>('tasks.list', {}, 200)).filter((t) => t.title === title && !t.archivedAt);
const byTitle = async (type: string, title: string) => (await call<Item[]>('items.list', { type }, 200)).filter((i) => i.title === title && !i.archivedAt);
const fieldValues = async (id: string, collectionId: string) =>
  (((await item(id)).metadata.fieldValues ?? {}) as Record<string, Record<string, unknown>>)[collectionId] ?? {};

/** The attachment's bytes as the desktop reads them for Research. */
const fileBytes = async (id: string) => Buffer.from(await page.evaluate(async (sourceId) => {
  const envelope = await window.enve.call('research.file', sourceId);
  if (!envelope.ok) throw new Error(JSON.stringify(envelope));
  return Array.from((envelope as unknown as { value: { data: Uint8Array } }).value.data);
}, id));

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** Selects `quote` inside the element, as a person dragging over the page text would. */
const selectText = (target: Page, selector: string, quote: string) => target.evaluate(([css, text]) => {
  const root = document.querySelector(css);
  if (!root) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(text);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}, [selector, quote] as const);

const nav = (label: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).first().click();
const knowledge = async (section: string) => {
  await nav('Knowledge');
  await page.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: section, exact: true }).click();
};
const openItem = (id: string) => app.evaluate(({ BrowserWindow }, [target, url]) => {
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.webContents.send('enve:open', target);
}, [id, page.url()] as const);
const card = (name: string) => page.locator('li.knowledge-card', { hasText: name });
const openSource = (title: string) =>
  page.getByRole('navigation', { name: 'Research sources' }).getByRole('button', { name: new RegExp(`^${esc(title)}`) }).click();

const webKnowledge = async (section: string) => {
  await web!.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Knowledge', exact: true }).click();
  await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: section, exact: true }).click();
};
const connectWeb = async (token: string) => {
  await web!.getByPlaceholder('em_…').fill(token);
  await web!.getByRole('button', { name: 'Connect', exact: true }).click();
  await web!.getByRole('navigation', { name: 'Sections' }).waitFor();
};
const api = (path: string, init: { method?: string; body?: unknown; token: string }) => fetch(`${apiUrl}/api/v1${path}`, {
  method: init.method ?? 'GET',
  headers: { Authorization: `Bearer ${init.token}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
});

describe('Knowledge workflows on desktop and in the browser', { timeout: 1_800_000 }, () => {
  before(async () => {
    // One disposable stand-in serves an Ollama-compatible chat API, a transcription endpoint and an RSS feed, all offline.
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (req.url === '/feed.xml') {
          feedRequests++;
          res.setHeader('Content-Type', 'application/rss+xml');
          return res.end(feedXml());
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
        if (req.url === '/v1/audio/transcriptions') {
          transcriptionRequests.push(raw.toString('latin1'));
          return res.end(JSON.stringify({
            text: 'Welcome to the garden club meeting. We agreed to order cedar boards by Friday.',
            segments: [
              { start: 0, end: 2, text: 'Welcome to the garden club meeting.' },
              { start: 2, end: 5, text: 'We agreed to order cedar boards by Friday.' },
            ],
          }));
        }
        if (req.url !== '/api/chat') {
          unexpected.push(`${req.method} ${req.url}`);
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: 'no fixture for this address' }));
        }
        const body = JSON.parse(raw.toString('utf8')) as { messages: { content: string }[]; format?: Schema };
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
    fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Every library path in this process resolves to the disposable home.
    process.env.ENVE_MEMORY_HOME = home;
    process.env.ENVE_MEMORY_CACHE = cache;
    writeFileSync(join(watched, 'bed-layout.md'), '# Bed layout\n\nTwo cedar beds along the south fence.\n');
    writeFileSync(join(watched, 'soil-test.txt'), 'Soil pH 6.5 at the north bed.\n');

    const seed = EnveMemory.open({ home, actor: 'e2e-seed' });
    try {
      seed.settings.set('semanticSearch', false);
      seed.settings.set('fetchLinks', false);
      seeded.garden = seed.projects.create({ name: 'Community garden' }).id;
      seeded.reading = seed.projects.create({ name: 'Reading nook' }).id;
      seeded.town = seed.projects.create({ name: 'Around town' }).id;
      seeded.raisedBed = seed.items.saveNote({ title: 'Raised bed plan', body: 'Build two cedar raised beds for the garden before spring planting.', project: seeded.garden }).id;
      seeded.seedSwap = seed.items.saveNote({ title: 'Seed swap notes', body: 'Swap tomato seeds at the garden club in March.', project: seeded.garden }).id;
      seed.decisions.record({ project: seeded.garden, decision: 'Water the garden only before nine in the morning', reason: 'Less evaporation.' });
      for (const title of ['The Lantern Orchard', 'A Pocket Star Atlas', 'Moss and Stone']) {
        seed.items.saveNote({ title, body: `Reading notes for ${title}.`, project: seeded.reading });
      }
      seeded.libraryOld = seed.items.saveNote({ title: 'Library hours (2025)', body: 'The Maple Street library opens at 9 am on Saturdays.', project: seeded.town, createdAt: '2025-03-01T09:00:00.000Z' }).id;
      seeded.libraryNew = seed.items.saveNote({ title: 'Library hours update', body: 'The Maple Street library now opens at 10 am on Saturdays.', project: seeded.town }).id;
      seeded.poolOld = seed.items.saveNote({ title: 'Pool schedule (2025)', body: 'The Lakeside pool closes at 8 pm in summer.', project: seeded.town, createdAt: '2025-06-01T09:00:00.000Z' }).id;
      seeded.poolNew = seed.items.saveNote({ title: 'Pool schedule update', body: 'The Lakeside pool now closes at 9 pm in summer.', project: seeded.town }).id;
      seed.decisions.record({ project: seeded.town, decision: 'Swim lessons start in June at the Lakeside pool', reason: 'Warmer water.' });
      seeded.ferryOld = seed.items.saveNote({ title: 'Ferry timetable (2025)', body: 'The harbor ferry leaves at 7:15 each weekday.', project: seeded.town, createdAt: '2025-04-01T09:00:00.000Z' }).id;
      seeded.ferryNew = seed.items.saveNote({ title: 'Ferry timetable update', body: 'The harbor ferry now leaves at 7:45 each weekday.', project: seeded.town }).id;
      seed.items.saveNote({ title: 'Shed key location (2025)', body: 'The shed key hangs behind the blue door.', project: seeded.town, createdAt: '2025-01-10T09:00:00.000Z' });
      // Folder approval is host-only: done here, before startup, against the fixture folder and never a live path.
      seeded.folderWatch = seed.sources.create({ name: 'Field notes folder', kind: 'folder', enabled: false }).id;
      seed.sources.approveFolder(seeded.folderWatch, watched);
    } finally {
      seed.close();
    }

    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));
    app = await electron.launch({
      ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      args: [...(packagedExecutable ? [] : [appDir]), '--use-mock-keychain'],
      env: { ...process.env, ENVE_MEMORY_HOME: home, ENVE_MEMORY_CACHE: cache, ENVE_MEMORY_PORT: '0', ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1' },
    });
    page = await app.firstWindow();
    watchErrors(page, 'desktop');
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1360, 900);
      shell.openExternal = async () => {};
    });
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await call('ai.configure', { provider: 'ollama', model: 'fixture', baseUrl: fixtureUrl });
    await call('ai.setEnrich', false);
  });

  afterEach(async (context) => {
    if ((context as { passed?: boolean }).passed !== false) return;
    const name = (context as { name?: string }).name?.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) ?? 'unknown';
    if (page && !page.isClosed()) await shoot(`knowledge-desktop-failure-${name}`).catch(() => {});
    if (web && !web.isClosed()) await shoot(`knowledge-browser-failure-${name}`, web).catch(() => {});
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
    for (const dir of [home, cache, fixtures, watched]) rmSync(dir, { recursive: true, force: true });
  });

  test('desktop: a saved workflow with a chosen preference proposes reviewed actions, applies only ticked ones, undoes, and reruns fresh', { timeout: 180_000 }, async () => {
    await knowledge('Organization preferences');
    await page.getByRole('button', { name: 'New preference' }).click();
    const prefForm = page.getByRole('dialog', { name: 'New preference' });
    await prefForm.getByRole('textbox', { name: /^Preference/ }).fill('File garden plans under Community garden, one note per bed.');
    await prefForm.getByLabel('Name (optional)').fill('Garden filing');
    await prefForm.getByLabel('Applies to').selectOption({ label: 'Community garden' });
    await prefForm.getByRole('button', { name: 'Save preference' }).click();
    await prefForm.waitFor({ state: 'detached' });
    await card('Garden filing').getByText('Community garden', { exact: true }).waitFor();
    const [preference] = await k<Preference[]>('/preferences');
    assert.equal(preference?.name, 'Garden filing');
    assert.equal(preference?.project, seeded.garden, 'the preference is scoped to its project');

    await knowledge('Workflows');
    await page.getByText('No workflows yet').waitFor();
    await page.getByRole('button', { name: 'New workflow' }).click();
    const form = page.getByRole('dialog', { name: 'New workflow' });
    await form.getByLabel('Name', { exact: true }).fill('Garden next steps');
    await form.getByLabel('Instruction').fill('Suggest a task, tags, a reminder and a short brief for the garden notes.');
    await form.getByRole('radio', { name: 'Notes about a topic' }).check();
    await form.getByLabel('Topic keywords').fill('garden');
    await form.getByLabel('Project').selectOption({ label: 'Community garden' });
    await form.getByRole('button', { name: 'Save workflow' }).click();
    await form.waitFor({ state: 'detached' });
    await card('Garden next steps').getByText('Topic: garden in Community garden').waitFor();
    const [created] = await k<Recipe[]>('/recipes');
    assert.deepEqual(created?.scope, { rootId: null, query: 'garden', project: seeded.garden });

    await card('Garden next steps').getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit workflow' });
    await edit.getByLabel('Name', { exact: true }).fill('Garden weekly plan');
    await edit.getByRole('button', { name: 'Save workflow' }).click();
    await page.getByText('Workflow updated').waitFor();
    const recipes = await k<Recipe[]>('/recipes');
    assert.equal(recipes.length, 1);
    assert.equal(recipes[0]!.id, created!.id, 'editing keeps the same definition');
    assert.equal(recipes[0]!.name, 'Garden weekly plan');

    const asked = requests.length;
    await card('Garden weekly plan').getByRole('button', { name: 'Run…' }).click();
    const run = page.getByRole('dialog', { name: 'Run Garden weekly plan' });
    const chosen = run.getByRole('checkbox', { name: /^Garden filing/ });
    assert.equal(await chosen.isChecked(), false, 'no preference is chosen for the person');
    await chosen.check();
    await run.getByRole('button', { name: 'Suggest actions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review suggested actions' });
    const list = dialog.getByRole('list', { name: 'Suggested actions' });
    await dialog.getByText('About “garden” in Community garden').waitFor();
    assert.equal(requests.length, asked + 1);
    const prompt = requests.at(-1)!.prompt;
    assert.match(prompt, /Organization preferences the person chose for this request:\n- File garden plans under Community garden/);
    assert.doesNotMatch(prompt, /before nine in the morning/, 'decisions stay out of the scope');
    const plan = plans.at(-1)!;
    assert.deepEqual([...plan.titles].sort(), ['Raised bed plan', 'Seed swap notes'], 'only ordinary notes in scope, never definitions');

    await list.getByText(/^Add task “Order cedar boards”, due /).waitFor();
    await list.locator('li', { hasText: `Tag “${plan.first}”` }).getByText('#garden').waitFor();
    await list.getByText(new RegExp(`^Remind me about “${esc(plan.last)}”`)).waitFor();
    await list.getByText('Add note “Garden brief”').waitFor();
    assert.equal(await list.getByRole('checkbox', { checked: true }).count(), 4);
    const firstId = plan.first === 'Raised bed plan' ? seeded.raisedBed : seeded.seedSwap;
    const lastId = plan.last === 'Raised bed plan' ? seeded.raisedBed : seeded.seedSwap;
    assert.deepEqual((await item(firstId)).tags, [], 'a proposal changes nothing');
    assert.equal((await item(lastId)).remindAt, null);
    assert.equal((await activeTasks('Order cedar boards')).length, 0);
    assert.equal((await byTitle('note', 'Garden brief')).length, 0);

    await list.getByRole('checkbox', { name: /Remind me about/ }).uncheck();
    await dialog.getByRole('button', { name: 'Apply 3 actions' }).click();
    await dialog.getByText('Added 2 items and updated 1 item.').waitFor();
    assert.deepEqual((await item(firstId)).tags.sort(), ['beds', 'garden']);
    assert.equal((await item(lastId)).remindAt, null, 'the unticked reminder was left out');
    const [task] = await activeTasks('Order cedar boards');
    assert.ok(task);
    const [brief] = await byTitle('note', 'Garden brief');
    assert.equal(brief?.project?.id, seeded.garden);
    assert.deepEqual((await item(brief!.id)).relations.filter((r) => r.kind === 'derived_from').map((r) => r.id).sort(), [seeded.raisedBed, seeded.seedSwap].sort());

    await dialog.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undid 3 changes').waitFor();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual((await item(firstId)).tags, []);
    assert.ok((await item(task.id)).archivedAt, 'undo archives the created task');
    assert.ok((await item(brief!.id)).archivedAt, 'undo archives the created brief');

    const definition = await item(created!.id);
    assert.equal(definition.metadata.knowledgeDefinition, true);
    assert.deepEqual(Object.keys(definition.metadata.knowledge as object).sort(), ['instruction', 'kind', 'scope', 'version'], 'a recipe stores no proposal');

    await call('items.saveNote', { title: 'Compost bin notes', body: 'Turn the garden compost every two weeks.', project: seeded.garden });
    await card('Garden weekly plan').getByRole('button', { name: 'Run…' }).click();
    await run.getByRole('button', { name: 'Suggest actions' }).click();
    await dialog.getByText('Add note “Garden brief”').waitFor();
    assert.equal(requests.length, asked + 2);
    assert.ok(plans.at(-1)!.titles.includes('Compost bin notes'), 'each run reads the scope as it is now');
    assert.doesNotMatch(requests.at(-1)!.prompt, /Organization preferences the person chose/, 'an unticked preference is not sent');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await activeTasks('Order cedar boards')).length, 0, 'cancelling applies nothing');
  });

  test('desktop: a collection defines typed fields with native controls, edits values, shows table, cards and Kanban, filters, sorts and reopens intact', { timeout: 180_000 }, async () => {
    await knowledge('Collections');
    await page.getByText('No collections yet').waitFor();
    await page.getByRole('button', { name: 'New collection' }).click();
    const dialog = page.getByRole('dialog', { name: 'New collection' });
    await dialog.getByLabel('Name', { exact: true }).fill('Reading tracker');
    const scope = dialog.getByRole('group', { name: 'Which items' });
    await scope.getByLabel('Project').selectOption({ label: 'Reading nook' });
    await scope.getByLabel('Type').selectOption('note');
    const addField = async (index: number, name: string, type: string, options: string[] = []) => {
      await dialog.getByRole('button', { name: 'Add field' }).click();
      const row = dialog.locator('ol.collection-fields > li').nth(index);
      await row.getByLabel(`Field ${index + 1}`, { exact: true }).fill(name);
      await row.getByLabel('Type').selectOption(type);
      for (const [n, option] of options.entries()) {
        if (n) await row.getByRole('button', { name: 'Option', exact: true }).click();
        await row.getByLabel(`${name} option ${n + 1}`, { exact: true }).fill(option);
      }
    };
    await addField(0, 'Status', 'select', ['To read', 'Reading', 'Finished']);
    await addField(1, 'Rating', 'number');
    await addField(2, 'Started', 'date');
    await addField(3, 'Notes', 'text');
    await addField(4, 'Owned', 'checkbox');
    await dialog.getByRole('button', { name: 'Save collection' }).click();
    await dialog.waitFor({ state: 'detached' });
    const view = page.getByRole('region', { name: 'Reading tracker' });
    await view.getByRole('columnheader', { name: 'Owned' }).waitFor();

    const collection = (await k<Collection[]>('/collections')).find((c) => c.name === 'Reading tracker')!;
    made.collection = collection.id;
    assert.deepEqual(collection.fields.map((f) => [f.name, f.type]), [['Status', 'select'], ['Rating', 'number'], ['Started', 'date'], ['Notes', 'text'], ['Owned', 'checkbox']]);
    const field = (name: string) => collection.fields.find((f) => f.name === name)!;
    const option = (name: string) => field('Status').options!.find((o) => o.name === name)!.id;
    const rows = await k<Rows>(`/collections/${collection.id}/rows`);
    const idOf = (title: string) => rows.rows.find((r) => r.item.title === title)!.item.id;
    const lantern = idOf('The Lantern Orchard');
    const atlas = idOf('A Pocket Star Atlas');
    const moss = idOf('Moss and Stone');
    const settled = (id: string, expected: Record<string, unknown>) =>
      until(() => fieldValues(id, collection.id), (values) => Object.entries(expected).every(([key, value]) => values[field(key).id] === value), `values on ${id}`);

    await view.getByLabel('Status for The Lantern Orchard').selectOption({ label: 'Reading' });
    await settled(lantern, { Status: option('Reading') });
    const rating = view.getByLabel('Rating for The Lantern Orchard');
    await rating.fill('4.5');
    await rating.press('Enter');
    await settled(lantern, { Rating: 4.5 });
    await view.getByLabel('Started for The Lantern Orchard').fill('2026-10-01');
    await settled(lantern, { Started: '2026-10-01' });
    const text = view.getByLabel('Notes for The Lantern Orchard');
    await text.fill('Lovely prose about orchards');
    await text.press('Enter');
    await settled(lantern, { Notes: 'Lovely prose about orchards' });
    await view.getByLabel('Owned for The Lantern Orchard').click();
    await settled(lantern, { Owned: true });
    await view.getByLabel('Status for A Pocket Star Atlas').selectOption({ label: 'To read' });
    await settled(atlas, { Status: option('To read') });
    const atlasRating = view.getByLabel('Rating for A Pocket Star Atlas');
    await atlasRating.fill('3');
    await atlasRating.press('Enter');
    await settled(atlas, { Rating: 3 });
    await view.getByLabel('Status for Moss and Stone').selectOption({ label: 'Finished' });
    await settled(moss, { Status: option('Finished') });

    await view.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Cards' }).click();
    await until(() => k<Collection>(`/collections/${collection.id}`), (c) => c.layout === 'cards', 'cards layout saved');
    const mossRating = view.locator('ul.collection-cards').getByLabel('Rating for Moss and Stone');
    await mossRating.fill('5');
    await mossRating.press('Enter');
    await settled(moss, { Rating: 5 });

    await view.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Kanban' }).click();
    const board = view.getByRole('list', { name: 'Reading tracker by Status' });
    await board.getByRole('listitem', { name: 'To read, 1 card' }).waitFor();
    const saved = await k<Collection>(`/collections/${collection.id}`);
    assert.equal(saved.layout, 'kanban');
    assert.equal(saved.groupBy, field('Status').id, 'Kanban groups by the select field');
    await board.getByLabel('Move A Pocket Star Atlas to').selectOption({ label: 'Reading' });
    await board.getByRole('listitem', { name: 'Reading, 2 cards' }).waitFor();
    await settled(atlas, { Status: option('Reading') });

    await view.getByRole('button', { name: 'Sort and filter…' }).click();
    const rules = page.getByRole('dialog', { name: 'Sort and filter' });
    await rules.getByRole('button', { name: 'Add sort' }).click();
    await rules.getByLabel('Sort 1 field').selectOption({ label: 'Rating' });
    await rules.getByLabel('Sort 1 direction').selectOption('desc');
    await rules.getByRole('button', { name: 'Add filter' }).click();
    await rules.getByLabel('Filter field').selectOption({ label: 'Rating' });
    await rules.getByLabel('Filter condition').selectOption('gte');
    await rules.getByLabel('Filter value for Rating').fill('4');
    await rules.getByRole('button', { name: 'Save', exact: true }).click();
    await rules.waitFor({ state: 'detached' });
    await view.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Table' }).click();
    await until(() => view.locator('tbody th').allTextContents(), (titles) => titles.map((t) => t.trim()).join('|') === 'Moss and Stone|The Lantern Orchard', 'filtered, sorted rows');
    const filtered = await k<Rows>(`/collections/${collection.id}/rows`);
    assert.deepEqual(filtered.rows.map((r) => r.item.title), ['Moss and Stone', 'The Lantern Orchard'], 'core sorts by rating and drops ratings under 4');
    await shoot('knowledge-desktop-collections');

    await nav('Home');
    await knowledge('Collections');
    const again = page.getByRole('region', { name: 'Reading tracker' });
    assert.equal(await again.getByLabel('Rating for Moss and Stone').inputValue(), '5');
    assert.equal(await again.getByLabel('Started for The Lantern Orchard').inputValue(), '2026-10-01');
    assert.equal(await again.getByLabel('Status for The Lantern Orchard').inputValue(), option('Reading'));
    assert.equal(await again.getByLabel('Notes for The Lantern Orchard').inputValue(), 'Lovely prose about orchards');
    assert.equal(await again.getByLabel('Owned for The Lantern Orchard').isChecked(), true);
    await again.getByRole('button', { name: 'Edit fields…' }).click();
    const editing = page.getByRole('dialog', { name: 'Edit collection' });
    assert.equal(await editing.locator('ol.collection-fields > li').nth(1).getByLabel('Type').isDisabled(), true, 'a saved field’s type is fixed');
    await editing.getByRole('button', { name: 'Cancel' }).click();
    await editing.waitFor({ state: 'detached' });
    const reopened = await k<Collection>(`/collections/${collection.id}`);
    assert.deepEqual(reopened.fields.map((f) => [f.id, f.type]), collection.fields.map((f) => [f.id, f.type]), 'field ids and types are stable');
    assert.deepEqual(await fieldValues(lantern, collection.id), {
      [field('Status').id]: option('Reading'), [field('Rating').id]: 4.5, [field('Started').id]: '2026-10-01',
      [field('Notes').id]: 'Lovely prose about orchards', [field('Owned').id]: true,
    });
  });

  test('desktop: a two-page PDF renders, turns to page 2, saves an exact quote with a note, cites back to page 2 and keeps the original byte-identical', { timeout: 180_000 }, async () => {
    const original = knowledgePdf(['Raised beds need cedar boards and a sunny spot.', 'Water the seedlings at dawn and mulch with straw.']);
    const path = join(fixtures, 'garden-guide.pdf');
    writeFileSync(path, original);
    const [saved] = await call<Detail[]>('files.save', [path]);
    made.pdf = saved!.id;
    made.pdfTitle = 'Garden field guide';
    await call('items.update', made.pdf, { title: made.pdfTitle });
    const source = await until(() => k<PdfSource>(`/research/pdf/${made.pdf}`), (s) => s.status === 'ready', 'PDF page text', 60_000);
    assert.equal(source.pageCount, 2);
    assert.equal(source.sha256, sha(original));
    const page2 = (await k<PdfPages>(`/research/pdf/${made.pdf}/pages?from=2&limit=1`)).pages[0]!;
    const quote = 'mulch with straw';
    assert.ok(page2.text.includes(quote), `page 2 keeps its text: ${page2.text}`);

    await knowledge('Research');
    await openSource(made.pdfTitle);
    await page.getByLabel('Page 1 as rendered').waitFor();
    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByLabel('Page 2 as rendered').waitFor();
    assert.equal(await page.getByLabel('Page number (press Enter to go)').inputValue(), '2');
    const textBox = page.getByLabel('Page text. Select a passage to quote it.');
    await textBox.getByText(quote, { exact: false }).waitFor();
    assert.ok(await selectText(page, '[aria-label="Page text. Select a passage to quote it."]', quote));
    await page.getByText(`Selected “${quote}”`).waitFor();
    await page.getByRole('button', { name: 'Quote with a note…' }).click();
    const draft = page.locator('form.ocr-draft', { has: page.locator('blockquote.research-quote') });
    await draft.getByLabel('Your note (optional)').fill('Straw keeps the beds damp through June.');
    await draft.getByText('Saved as a note linked to page 2.').waitFor();
    assert.equal((await research('pdfAnnotation')).length, 0, 'nothing is saved before Save quote');
    await draft.getByRole('button', { name: 'Save quote' }).click();
    await page.getByText('Quote saved as a note').waitFor();

    const annotationsSection = page.locator('section.detail-section', { has: page.getByRole('heading', { name: 'Annotations' }) });
    const entry = annotationsSection.locator('li', { hasText: quote });
    await entry.getByText('Quote in place').waitFor();
    const [annotation] = await k<Annotation[]>(`/research/pdf/${made.pdf}/annotations`);
    assert.equal(annotation?.page, 2);
    assert.equal(annotation?.quote, quote);
    assert.equal(annotation?.textSource, 'pdf');
    assert.equal(annotation?.status, 'current');
    assert.ok(annotation!.body.includes(`[[item:${made.pdf}|`) && annotation!.body.includes('page 2'), 'the note cites the PDF and page');
    assert.ok((await fileBytes(made.pdf)).equals(original), 'the PDF stays byte-identical');
    assert.equal((await item(made.pdf)).attachments[0]!.sha256, sha(original));

    await page.getByRole('button', { name: 'Previous page' }).click();
    await page.getByLabel('Page 1 as rendered').waitFor();
    await entry.getByRole('button', { name: 'Open note' }).click();
    const drawer = page.getByRole('dialog', { name: 'Note details' });
    await drawer.getByRole('button', { name: 'Show page 2 in Research' }).click();
    await page.getByLabel('Page 2 as rendered').waitFor();
    if (await drawer.isVisible()) await page.keyboard.press('Escape');
    await page.getByLabel('Page text. Select a passage to quote it.').locator('mark', { hasText: quote }).waitFor();
    assert.equal(await page.getByLabel('Page number (press Enter to go)').inputValue(), '2');
    await shoot('knowledge-desktop-pdf');
  });

  test('desktop: a scanned PDF page is recognized on the host into an editable draft, saved only on request, and the original is kept', { timeout: 300_000 }, async () => {
    const original = knowledgeScanPdf();
    const path = join(fixtures, 'scanned-card.pdf');
    writeFileSync(path, original);
    const [saved] = await call<Detail[]>('files.save', [path]);
    await call('items.update', saved!.id, { title: 'Scanned seed card' });
    await until(() => k<PdfSource>(`/research/pdf/${saved!.id}`), (s) => s.status === 'ready', 'scanned PDF', 60_000);

    await knowledge('Research');
    await openSource('Scanned seed card');
    await page.getByLabel('Page 1 as rendered').waitFor();
    await page.getByText(/This page has no text\. If it’s a scan|The library didn’t keep text for this page/).waitFor();
    await page.getByRole('button', { name: 'Recognize text on this page' }).click({ timeout: 60_000 });
    const draft = page.getByLabel('Recognized text for page 1');
    await draft.waitFor({ timeout: 120_000 });
    assert.match(await draft.inputValue(), /MEMORY KEEPS IDEAS/i);
    assert.equal((await research('pdfOcrPage')).length, 0, 'recognition alone saves nothing');
    assert.deepEqual((await k<PdfSource>(`/research/pdf/${saved!.id}`)).ocrPages, []);
    await draft.fill(`${await draft.inputValue()}\nChecked against the paper card.`);
    await page.getByRole('button', { name: 'Save recognized page' }).click();
    await page.getByText('Saved reviewed text for page 1').waitFor();

    const source = await k<PdfSource>(`/research/pdf/${saved!.id}`);
    assert.equal(source.ocrPages.length, 1);
    assert.equal(source.ocrPages[0]!.page, 1);
    const [ocrNote] = await research('pdfOcrPage');
    assert.match(ocrNote!.body, /MEMORY KEEPS IDEAS/i);
    assert.match(ocrNote!.body, /Checked against the paper card\./);
    assert.ok((await fileBytes(saved!.id)).equals(original), 'the scanned original is unchanged');
    await page.getByLabel('Page text. Select a passage to quote it.').getByText('Checked against the paper card.', { exact: false }).waitFor();
  });

  test('desktop: a WAV recording plays, a VTT preview saves nothing, the saved transcript seeks to 2 s, a passage keeps its note, and transcription asks first', { timeout: 180_000 }, async () => {
    const wav = knowledgeAudio(10);
    const audioPath = join(fixtures, 'garden-club-meeting.wav');
    writeFileSync(audioPath, wav);
    await knowledge('Research');
    await page.locator('section[aria-labelledby="research-heading"] input[type="file"][accept^="audio/"]').setInputFiles(audioPath);
    await page.getByText('Recording saved').waitFor();
    const { items } = await k<{ items: Detail[] }>('/research/sources');
    const audio = items.find((i) => i.attachments.some((a) => a.mimeType.startsWith('audio/')))!;
    made.audio = audio.id;
    made.audioTitle = 'Garden club meeting';
    assert.equal(audio.attachments[0]!.sha256, sha(wav));
    await call('items.update', made.audio, { title: made.audioTitle });
    const player = page.locator('.research-audio audio');
    await until(() => player.evaluate((a: HTMLAudioElement) => a.readyState), (state) => state >= 1, 'audio metadata');
    assert.ok(Math.abs(await player.evaluate((a: HTMLAudioElement) => a.duration) - 10) < 0.5, 'the WAV plays at its full length');

    await page.getByText('No transcript yet. Import captions or transcribe the recording below.').waitFor();
    await page.getByRole('button', { name: 'Set up a transcription server…' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Transcribe with/ }).count(), 0, 'transcription is off until configured');

    const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the garden club meeting.\n\n00:00:02.000 --> 00:00:05.000\nWe agreed to order cedar boards by Friday.\n\n00:00:05.000 --> 00:00:09.000\nPriya will bring the seed catalogue next week.\n';
    const vttPath = join(fixtures, 'garden-club.vtt');
    writeFileSync(vttPath, vtt);
    await page.locator('.research-import input[type="file"]').setInputFiles(vttPath);
    assert.equal(await page.getByLabel('Caption text').inputValue(), vtt);
    assert.equal(await page.getByLabel('Caption format').inputValue(), 'vtt');
    await page.getByRole('button', { name: 'Preview transcript' }).click();
    const preview = page.locator('[aria-label="Transcript preview"]');
    await preview.getByText(/WebVTT: 3 cues, 0:09 long/).waitFor();
    assert.deepEqual((await k<{ transcripts: unknown[] }>(`/research/audio/${made.audio}`)).transcripts, [], 'a preview saves nothing');
    assert.equal((await research('transcript')).length, 0);
    await preview.getByLabel('Title (optional)').fill('Garden club meeting transcript');
    await preview.getByRole('button', { name: 'Save transcript' }).click();
    await page.getByText('Transcript saved').waitFor();
    await page.getByRole('group', { name: 'Saved transcripts' }).getByRole('button', { name: /^Garden club meeting transcript/ }).waitFor();
    const [transcript] = (await k<{ transcripts: { id: string; segmentCount: number }[] }>(`/research/audio/${made.audio}`)).transcripts;
    assert.equal(transcript?.segmentCount, 3);
    made.transcript = transcript!.id;

    const cues = page.getByRole('list', { name: 'Transcript' });
    await cues.getByRole('button', { name: 'Play from 0:02' }).click();
    await until(() => player.evaluate((a: HTMLAudioElement) => a.currentTime), (time) => time >= 2 && time < 4.5, 'seek to 0:02');
    await player.evaluate((a: HTMLAudioElement) => a.pause());

    await cues.getByRole('checkbox', { name: 'Include cue at 0:02 in a passage' }).check();
    const passageForm = page.locator('form.research-selection-form');
    await passageForm.getByText('Passage 0:02–0:05, 1 cue.').waitFor();
    await passageForm.getByLabel('Your note (optional)').fill('Order the boards from the timber yard.');
    await passageForm.getByRole('button', { name: 'Save passage' }).click();
    await page.getByText('Passage saved as a note').waitFor();
    const [passage] = await k<Passage[]>(`/research/transcripts/${made.transcript}/passages`);
    assert.equal(passage?.start, 2);
    assert.equal(passage?.end, 5);
    assert.equal(passage?.quote, 'We agreed to order cedar boards by Friday.');
    const passageNote = await item(passage!.id);
    assert.match(passageNote.body, /Order the boards from the timber yard\./);
    assert.ok(passageNote.body.includes(`[[item:${made.transcript}|`), 'the passage cites its transcript');
    assert.equal((await item(made.audio)).attachments[0]!.sha256, sha(wav), 'the recording is unchanged');

    await page.getByRole('button', { name: 'Set up a transcription server…' }).click();
    await page.getByLabel('Server address').fill(`${fixtureUrl}/v1`);
    await page.getByLabel('Model', { exact: true }).fill('fixture-whisper');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Transcription settings saved').waitFor();
    const transcribe = page.getByRole('button', { name: 'Transcribe with fixture-whisper…' });
    await transcribe.click();
    const consent = page.getByRole('alertdialog');
    await consent.getByText('Send this recording for transcription?').waitFor();
    await consent.getByText(`${fixtureUrl}/v1`).waitFor();
    await consent.getByRole('button', { name: 'Cancel' }).click();
    await consent.waitFor({ state: 'detached' });
    assert.equal(transcriptionRequests.length, 0, 'nothing is sent without consent');
    await transcribe.click();
    await consent.getByRole('button', { name: 'Send recording' }).click();
    await preview.getByText(/^Transcription from fixture-whisper · 127\.0\.0\.1:\d+: 2 cues/).waitFor();
    assert.equal(transcriptionRequests.length, 1);
    assert.match(transcriptionRequests[0]!, /fixture-whisper/);
    await preview.getByRole('button', { name: 'Discard preview' }).click();
    assert.equal((await k<{ transcripts: unknown[] }>(`/research/audio/${made.audio}`)).transcripts.length, 1, 'a transcription preview is never saved by itself');
    await page.getByRole('button', { name: 'Server settings' }).click();
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByText('Transcription turned off').waitFor();
  });

  test('desktop: an approved folder is checked on request, only ticked previews import, a file changed after preview is refused, and a changed file becomes a linked snapshot', { timeout: 180_000 }, async () => {
    await knowledge('Watched sources');
    const folder = card('Field notes folder');
    await folder.getByText('Folder approved on this computer.', { exact: false }).waitFor();
    await folder.getByText('Checked only when you ask').waitFor();
    assert.equal(await folder.getByRole('switch', { name: 'Check Field notes folder periodically' }).getAttribute('aria-checked'), 'false');
    assert.ok(!(await page.content()).includes(watched), 'the folder path never reaches the window');

    await folder.getByRole('button', { name: 'Check now' }).click();
    await page.getByText('2 items to review').waitFor();
    await folder.getByRole('button', { name: 'Review 2' }).click();
    const queue = folder.getByRole('list', { name: 'Previews waiting for review' });
    await queue.getByText('bed-layout.md').waitFor();
    const apply = folder.getByRole('button', { name: /^Apply \d+ selected previews?$/ });
    assert.equal(await apply.isDisabled(), true, 'applying needs a selection');
    assert.equal((await byTitle('file', 'bed-layout.md')).length, 0, 'checking imports nothing');

    await queue.locator('li', { hasText: 'bed-layout.md' }).getByRole('checkbox').check();
    await folder.getByRole('button', { name: 'Apply 1 selected preview' }).click();
    await page.getByText('Applied 1 item').last().waitFor();
    const [bed] = await until(() => byTitle('file', 'bed-layout.md'), (found) => found.length === 1, 'imported folder file');
    assert.ok(bed);
    const bedFirst = await item(bed.id);
    assert.equal(bedFirst.attachments[0]!.sha256, sha(readFileSync(join(watched, 'bed-layout.md'))));
    assert.equal((bedFirst.metadata.watchedFrom as { watchId: string }).watchId, seeded.folderWatch);
    await queue.getByText('soil-test.txt').waitFor();

    writeFileSync(join(watched, 'soil-test.txt'), 'Soil pH 6.8 at the north bed after adding lime.\n');
    await queue.locator('li', { hasText: 'soil-test.txt' }).getByRole('checkbox').check();
    await folder.getByRole('button', { name: 'Apply 1 selected preview' }).click();
    await folder.getByRole('alert').filter({ hasText: 'changed or moved since it was previewed' }).waitFor();
    assert.equal((await byTitle('file', 'soil-test.txt')).length, 0, 'a stale preview imports nothing');

    await folder.getByRole('button', { name: 'Check now' }).click();
    await page.getByText('1 item to review').last().waitFor();
    await queue.locator('li', { hasText: 'soil-test.txt' }).getByRole('checkbox').check();
    await folder.getByRole('button', { name: 'Apply 1 selected preview' }).click();
    await until(() => byTitle('file', 'soil-test.txt'), (found) => found.length === 1, 'refreshed soil test import');
    const [soil] = await byTitle('file', 'soil-test.txt');
    assert.equal((await item(soil!.id)).attachments[0]!.sha256, sha(readFileSync(join(watched, 'soil-test.txt'))), 'the fresh preview imports the current bytes');

    writeFileSync(join(watched, 'bed-layout.md'), '# Bed layout\n\nThree cedar beds along the south fence, one for herbs.\n');
    await folder.getByRole('button', { name: 'Check now' }).click();
    const changed = queue.locator('li', { hasText: 'bed-layout.md' });
    await changed.getByText('Changed', { exact: true }).waitFor();
    await changed.getByText('Saved as a new file that supersedes', { exact: false }).waitFor();
    await changed.getByRole('checkbox').check();
    await folder.getByRole('button', { name: 'Apply 1 selected preview' }).click();
    await folder.getByRole('list', { name: 'Just applied' }).getByText('Updated (earlier file kept and linked)').waitFor();
    const snapshots = await until(() => byTitle('file', 'bed-layout.md'), (found) => found.length === 2, 'new snapshot');
    const next = snapshots.find((s) => s.id !== bed.id)!;
    const nextDetail = await item(next.id);
    assert.equal(nextDetail.attachments[0]!.sha256, sha(readFileSync(join(watched, 'bed-layout.md'))));
    assert.ok(nextDetail.relations.some((r) => r.id === bed.id && r.kind === 'supersedes'), 'the snapshot supersedes the earlier file');
    const earlier = await item(bed.id);
    assert.equal(earlier.archivedAt, null);
    assert.equal(earlier.attachments[0]!.sha256, bedFirst.attachments[0]!.sha256, 'the earlier snapshot is immutable');
  });

  test('desktop: a feed watch needs link fetching turned on, previews entries, imports one, and updates it from a changed entry', { timeout: 120_000 }, async () => {
    await knowledge('Watched sources');
    await page.getByRole('button', { name: 'Watch a source' }).click();
    const form = page.getByRole('dialog', { name: 'Watch a source' });
    assert.equal(await form.getByRole('radio', { name: /^Feed/ }).isChecked(), true);
    await form.getByLabel('Name', { exact: true }).fill('Allotment newsletter');
    await form.getByLabel('Feed address').fill(`${fixtureUrl}/feed.xml`);
    assert.equal(await form.getByRole('switch', { name: 'Check periodically' }).getAttribute('aria-checked'), 'false', 'periodic checks are opt-in');
    await form.getByRole('button', { name: 'Save watch' }).click();
    await form.waitFor({ state: 'detached' });
    const feed = card('Allotment newsletter');
    await feed.getByRole('button', { name: 'Check now' }).click();
    await page.getByText('Link fetching is turned off in Settings', { exact: false }).waitFor();
    assert.equal(feedRequests, 0, 'nothing is fetched while link fetching is off');

    await call('settings.set', 'fetchLinks', true);
    try {
      await feed.getByRole('button', { name: 'Check now' }).click();
      await page.getByText('2 items to review').waitFor();
      assert.equal(feedRequests, 1);
      await feed.getByRole('button', { name: 'Review 2' }).click();
      const queue = feed.getByRole('list', { name: 'Previews waiting for review' });
      await queue.locator('li', { hasText: 'Tool library opens Saturdays' }).getByRole('checkbox').check();
      await feed.getByRole('button', { name: 'Apply 1 selected preview' }).click();
      await page.getByText('Applied 1 item').last().waitFor();
      const [bookmark] = await until(() => byTitle('bookmark', 'Tool library opens Saturdays'), (found) => found.length === 1, 'imported feed entry');
      assert.ok(bookmark);
      assert.equal(bookmark.url, `${fixtureUrl}/posts/tools`);
      assert.equal((await item(bookmark.id)).content, feedEntries[0]!.text);
      assert.equal((await byTitle('bookmark', 'Rain barrels back in stock')).length, 0, 'the unticked entry waits');

      feedEntries = [{ ...feedEntries[0]!, text: 'The tool library now opens on Saturday and Sunday mornings.' }, feedEntries[1]!];
      await feed.getByRole('button', { name: 'Check now' }).click();
      const changed = queue.locator('li', { hasText: 'Tool library opens Saturdays' });
      await changed.getByText('Changed', { exact: true }).waitFor();
      await changed.getByRole('checkbox').check();
      await feed.getByRole('button', { name: 'Apply 1 selected preview' }).click();
      await until(async () => (await item(bookmark.id)).content, (content) => content === 'The tool library now opens on Saturday and Sunday mornings.', 'updated source text');
      assert.equal((await byTitle('bookmark', 'Tool library opens Saturdays')).length, 1, 'a changed entry updates the same bookmark');
    } finally {
      await call('settings.set', 'fetchLinks', false);
    }
  });

  test('desktop: information review lists an old note, marks it checked without editing, shows quoted conflicts, dismisses one pair and supersedes another', { timeout: 120_000 }, async () => {
    await knowledge('Information review');
    const stale = page.locator('section[aria-labelledby="stale-heading"]');
    const oldRow = stale.locator('li', { hasText: 'Library hours (2025)' });
    await oldRow.getByText(/days since it was last edited/).waitFor();
    await oldRow.getByRole('button', { name: 'Mark checked' }).click();
    await page.getByText('Marked “Library hours (2025)” as checked').waitFor();
    await oldRow.waitFor({ state: 'detached' });
    const checked = await item(seeded.libraryOld);
    assert.equal(checked.body, 'The Maple Street library opens at 9 am on Saturdays.', 'checking leaves the text');
    assert.ok((checked.metadata.freshness as { checkedAt?: string }).checkedAt);

    const conflicts = page.locator('section[aria-labelledby="conflicts-heading"]');
    await conflicts.getByLabel('Topic keywords').fill('Maple Street library');
    await conflicts.getByRole('button', { name: 'Look for disagreements' }).click();
    const pair = conflicts.locator('li.knowledge-card');
    await pair.getByText('The two notes give different times for the same thing.').waitFor();
    assert.equal(requests.at(-1)!.step, 'freshness');
    const quotes = await pair.locator('blockquote.research-quote').allTextContents();
    assert.deepEqual(quotes, ['The Maple Street library opens at 9 am on Saturdays.', 'The Maple Street library now opens at 10 am on Saturdays.']);
    assert.match(await pair.locator('.freshness-side').first().textContent() ?? '', /2025/, 'the older note shows its date');
    await pair.getByRole('button', { name: 'Not a conflict' }).click();
    await pair.getByText('Dismissed. This pair won’t be suggested again.').waitFor();
    const [a, b] = [await item(seeded.libraryOld), await item(seeded.libraryNew)];
    assert.ok((a.metadata.freshness as { dismissed: string[] }).dismissed.includes(seeded.libraryNew));
    assert.ok((b.metadata.freshness as { dismissed: string[] }).dismissed.includes(seeded.libraryOld));
    assert.equal(a.body, checked.body);
    assert.equal(b.body, 'The Maple Street library now opens at 10 am on Saturdays.');
    assert.equal(b.title, 'Library hours update', 'dismissing changes only review metadata');
    await conflicts.getByRole('button', { name: 'Look for disagreements' }).click();
    await conflicts.getByText(/^No conflicting or outdated statements backed by exact quotes were found/).waitFor();

    await conflicts.getByLabel('Topic keywords').fill('Lakeside pool');
    await conflicts.getByRole('button', { name: 'Look for disagreements' }).click();
    const pool = conflicts.locator('li.knowledge-card', { hasText: 'Pool schedule update' });
    await pool.getByText('The Lakeside pool now closes at 9 pm in summer.').waitFor();
    assert.doesNotMatch(requests.at(-1)!.prompt, /Swim lessons/, 'decisions are never reviewed');
    await pool.getByRole('button', { name: 'Keep “Pool schedule update”…' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByText('Keep “Pool schedule update” as current?').waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await item(seeded.poolOld)).metadata.freshness, undefined, 'cancelling supersedes nothing');
    await pool.getByRole('button', { name: 'Keep “Pool schedule update”…' }).click();
    await confirm.getByRole('button', { name: 'Mark older as superseded' }).click();
    await pool.getByText('Kept “Pool schedule update”; “Pool schedule (2025)” is marked superseded.').waitFor();
    const [older, newer] = [await item(seeded.poolOld), await item(seeded.poolNew)];
    assert.equal((older.metadata.freshness as { supersededBy: string }).supersededBy, seeded.poolNew);
    assert.ok(newer.relations.some((r) => r.id === seeded.poolOld && r.kind === 'supersedes'));
    assert.equal(older.body, 'The Lakeside pool closes at 8 pm in summer.', 'the older note keeps its text');
    assert.equal(older.archivedAt, null);
    assert.equal(newer.body, 'The Lakeside pool now closes at 9 pm in summer.');
  });

  test('browser: a workflow is created, run with a chosen preference, applied selectively and undone', { timeout: 180_000 }, async () => {
    const status = await call<{ url: string }>('api.status');
    apiUrl = status.url.replace(/\/$/, '');
    writerToken = (await call<{ token: string }>('clients.create', 'E2E knowledge browser', ['read', 'write'])).token;
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, address) => {
      void new BrowserWindow({ width: 1280, height: 900 }).loadURL(address);
    }, `${apiUrl}/`);
    web = await opened;
    watchErrors(web, 'browser');
    await web.getByPlaceholder('em_…').waitFor();
    await connectWeb(writerToken);

    await webKnowledge('Workflows');
    await web.getByRole('heading', { name: 'Garden weekly plan' }).waitFor();
    await web.getByRole('button', { name: 'New workflow' }).click();
    const form = web.getByRole('form', { name: 'New workflow' });
    await form.getByLabel('Name', { exact: true }).fill('Browser garden sweep');
    await form.getByLabel('Instruction').fill('Suggest a task, tags, a reminder and a short brief for the garden notes.');
    await form.getByLabel('Topic keywords').fill('garden');
    await form.getByLabel('Project').selectOption({ label: 'Community garden' });
    await form.getByRole('button', { name: 'Create workflow' }).click();
    await web.getByText('Workflow created').waitFor();
    const recipe = (await k<Recipe[]>('/recipes')).find((r) => r.name === 'Browser garden sweep')!;
    assert.deepEqual(recipe.scope, { rootId: null, query: 'garden', project: seeded.garden });

    const asked = requests.length;
    await web.locator('li.card', { hasText: 'Browser garden sweep' }).getByRole('button', { name: 'Run…' }).click();
    const run = web.getByRole('region', { name: 'Run Browser garden sweep' });
    await run.getByRole('checkbox', { name: /Garden filing/ }).check();
    await run.getByRole('button', { name: 'Run now' }).click();
    const choices = run.getByRole('checkbox', { name: 'Include this action' });
    await choices.first().waitFor();
    assert.equal(await choices.count(), 4);
    assert.equal(requests.length, asked + 1);
    assert.match(requests.at(-1)!.prompt, /- File garden plans under Community garden/, 'the ticked preference is sent');
    const plan = plans.at(-1)!;
    assert.ok(plan.titles.includes('Compost bin notes'));
    const titleId = async (title: string) => (await byTitle('note', title))[0]!.id;
    const [firstId, lastId] = [await titleId(plan.first), await titleId(plan.last)];
    assert.deepEqual((await item(firstId)).tags, [], 'running changes nothing');
    await shoot('knowledge-browser-workflow', web);

    await choices.first().uncheck();
    await run.getByRole('button', { name: 'Apply 3 actions' }).click();
    await run.getByText('Added 1 item and updated 2 items.').waitFor();
    assert.deepEqual((await item(firstId)).tags.sort(), ['beds', 'garden']);
    assert.equal((await item(lastId)).remindAt, '2026-11-05T17:00:00.000Z');
    assert.equal((await activeTasks('Order cedar boards')).length, 0, 'the unticked task was left out');
    const briefs = await byTitle('note', 'Garden brief');
    assert.equal(briefs.length, 1);

    await run.getByRole('button', { name: 'Undo these actions' }).click();
    await run.getByText('Undid 3 changes. Nothing from these actions is applied.').waitFor();
    assert.deepEqual((await item(firstId)).tags, []);
    assert.equal((await item(lastId)).remindAt, null);
    assert.ok((await item(briefs[0]!.id)).archivedAt);
    assert.equal((await k<Recipe[]>('/recipes')).length, 2, 'both saved workflows remain');
  });

  test('browser: the collection shows the desktop values, edits a row, and moves a Kanban card', { timeout: 120_000 }, async () => {
    await webKnowledge('Collections');
    const panel = web!.getByRole('region', { name: 'Reading tracker' });
    await panel.getByRole('columnheader', { name: 'Owned' }).waitFor();
    const lanternRow = panel.locator('tbody tr', { hasText: 'The Lantern Orchard' }).first();
    await lanternRow.getByText('Reading', { exact: true }).waitFor();
    await lanternRow.getByText('2026-10-01', { exact: true }).waitFor();
    await lanternRow.getByText('Yes', { exact: true }).waitFor();
    assert.equal(await panel.locator('tbody tr', { hasText: 'A Pocket Star Atlas' }).count(), 0, 'the saved filter applies in the browser too');

    const collection = await k<Collection>(`/collections/${made.collection}`);
    const field = (name: string) => collection.fields.find((f) => f.name === name)!;
    const moss = (await byTitle('note', 'Moss and Stone'))[0]!.id;
    const lantern = (await byTitle('note', 'The Lantern Orchard'))[0]!.id;
    await panel.getByRole('button', { name: 'Edit values of Moss and Stone' }).click();
    const values = panel.getByRole('form', { name: 'Values of Moss and Stone' });
    await values.getByLabel('Notes', { exact: true }).fill('Reread in winter');
    await values.getByRole('button', { name: 'Save values' }).click();
    await web!.getByText('Values saved').waitFor();
    const mossValues = await fieldValues(moss, collection.id);
    assert.equal(mossValues[field('Notes').id], 'Reread in winter');
    assert.equal(mossValues[field('Rating').id], 5, 'untouched fields keep their values');

    await panel.getByRole('radio', { name: 'Kanban' }).check();
    const board = panel.getByRole('list', { name: 'Grouped by Status' });
    const reading = board.getByRole('listitem', { name: 'Reading', exact: true });
    const move = reading.locator('li.card', { hasText: 'The Lantern Orchard' });
    await move.getByLabel('Move The Lantern Orchard to').selectOption({ label: 'Finished' });
    await move.getByRole('button', { name: 'Move', exact: true }).click();
    await web!.getByText('Moved to Finished').waitFor();
    await board.getByRole('listitem', { name: 'Finished', exact: true }).getByText('The Lantern Orchard').waitFor();
    const finished = field('Status').options!.find((o) => o.name === 'Finished')!.id;
    assert.equal((await fieldValues(lantern, collection.id))[field('Status').id], finished);
  });

  test('browser: research quotes PDF page 2, seeks a transcript cue, and leaving releases the player and keeps drafts unsaved', { timeout: 180_000 }, async () => {
    await webKnowledge('Research');
    await web!.getByRole('button', { name: made.pdfTitle, exact: true }).click();
    const reader = web!.getByRole('region', { name: 'PDF reader' });
    await reader.getByRole('button', { name: 'Next', exact: true }).click();
    const text = reader.getByLabel('Text of page 2');
    const quote = 'Water the seedlings at dawn';
    await text.getByText(quote, { exact: false }).waitFor();
    assert.ok(await selectText(web!, '.pdf-text[aria-label="Text of page 2"]', quote));
    const annotate = reader.getByRole('form', { name: 'Annotate a passage' });
    await annotate.getByRole('button', { name: 'Use selection' }).click();
    assert.equal(await annotate.getByLabel('Exact quote').inputValue(), quote);
    await annotate.getByText('Quoting page 2.').waitFor();
    await annotate.getByLabel('Note', { exact: true }).fill('Dawn watering, from the browser.');
    await annotate.getByRole('button', { name: 'Save annotation' }).click();
    await web!.getByText('Annotation saved as a note').waitFor();
    const annotations = await k<Annotation[]>(`/research/pdf/${made.pdf}/annotations`);
    const saved = annotations.find((a) => a.quote === quote);
    assert.equal(saved?.page, 2);
    assert.equal(saved?.status, 'current');
    await reader.locator('.annotation-list li', { hasText: quote }).getByText('Current', { exact: true }).waitFor();

    const tasksBefore = (await call<Item[]>('tasks.list', {}, 200)).filter((t) => !t.archivedAt).length;
    const passagesBefore = (await k<Passage[]>(`/research/transcripts/${made.transcript}/passages`)).length;
    await web!.getByRole('button', { name: made.audioTitle, exact: true }).click();
    const workspace = web!.getByRole('region', { name: 'Recording and transcripts' });
    await workspace.getByRole('button', { name: 'Garden club meeting transcript', exact: true }).click();
    const transcript = workspace.getByRole('region', { name: 'Transcript Garden club meeting transcript' });
    const player = workspace.locator('audio.research-audio');
    await until(() => player.evaluate((a: HTMLAudioElement) => a.readyState), (state) => state >= 1, 'browser audio metadata');
    await transcript.getByRole('button', { name: '0:02', exact: true }).click();
    await until(() => player.evaluate((a: HTMLAudioElement) => a.currentTime), (time) => time >= 2 && time < 4.5, 'browser seek to 0:02');
    await player.evaluate((a: HTMLAudioElement) => a.pause());

    await transcript.getByRole('button', { name: 'Suggest tasks and a brief' }).click();
    await transcript.getByRole('checkbox', { name: 'Include this action' }).first().waitFor();
    await transcript.getByRole('checkbox', { name: 'Select segment at 0:05' }).check();
    await transcript.getByLabel('Passage note').fill('A thought that was never saved.');
    const media = await player.elementHandle();
    assert.match(await media!.evaluate((a) => a.getAttribute('src') ?? ''), /^blob:/);

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Sources', exact: true }).click();
    await web!.getByRole('heading', { name: 'Watched sources' }).waitFor();
    assert.equal(await media!.evaluate((a) => a.getAttribute('src')), null, 'leaving releases the recording');
    assert.equal(await media!.evaluate((a) => (a as HTMLAudioElement).paused), true);
    assert.equal((await call<Item[]>('tasks.list', {}, 200)).filter((t) => !t.archivedAt).length, tasksBefore, 'a proposal is never applied by leaving');
    assert.equal((await k<Passage[]>(`/research/transcripts/${made.transcript}/passages`)).length, passagesBefore, 'a passage draft is never autosaved');
    await media!.dispose();
  });

  test('browser: an approved folder shows its status without a path, checks and applies one reviewed file, and information review keeps text', { timeout: 180_000 }, async () => {
    writeFileSync(join(watched, 'harvest-log.md'), '# Harvest log\n\nFirst beans picked on the twelfth.\n');
    await webKnowledge('Sources');
    const folder = web!.locator('li.card', { hasText: 'Field notes folder' });
    await folder.getByText('Approved and available').waitFor();
    assert.ok(!(await web!.content()).includes(watched), 'the browser never sees the host folder path');

    await web!.getByRole('button', { name: 'New source' }).click();
    const form = web!.getByRole('form', { name: 'New watched source' });
    await form.getByLabel('Kind').selectOption('folder');
    await form.getByText('After saving, approve the folder in the desktop app', { exact: false }).waitFor();
    assert.equal(await form.locator('input[type="url"]').isVisible(), false);
    assert.equal(await form.locator('input[type="text"]').count(), 1, 'there is no field for a host path');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await web!.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await form.waitFor({ state: 'detached' });

    await folder.getByRole('button', { name: 'Check now' }).click();
    const queue = web!.getByRole('region', { name: 'Review queue for Field notes folder' });
    const row = queue.locator('li.queue-item', { hasText: 'harvest-log.md' });
    await row.waitFor();
    assert.equal(await queue.getByRole('button', { name: 'Apply selected' }).isDisabled(), true);
    assert.equal((await byTitle('file', 'harvest-log.md')).length, 0);
    await row.getByRole('checkbox').check();
    await shoot('knowledge-browser-source-review', web);
    await queue.getByRole('button', { name: 'Apply 1 change' }).click();
    await queue.getByText(/^Applied 1 change\./).waitFor();
    const [harvest] = await byTitle('file', 'harvest-log.md');
    assert.equal((await item(harvest!.id)).attachments[0]!.sha256, sha(readFileSync(join(watched, 'harvest-log.md'))));

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Information review', exact: true }).click();
    await web!.getByRole('button', { name: 'Show items' }).click();
    const ferry = web!.locator('.freshness-list li', { hasText: 'Ferry timetable (2025)' });
    await ferry.getByRole('button', { name: 'Mark checked' }).click();
    await ferry.getByText('Marked checked. The text is unchanged.').waitFor();
    assert.equal((await item(seeded.ferryOld)).body, 'The harbor ferry leaves at 7:15 each weekday.');

    await web!.getByLabel('Topic keywords').fill('harbor ferry');
    await web!.getByRole('button', { name: 'Look for conflicts' }).click();
    const suggestion = web!.locator('li.suggestion');
    await suggestion.getByText('The harbor ferry leaves at 7:15 each weekday.', { exact: true }).waitFor();
    await suggestion.getByText('The harbor ferry now leaves at 7:45 each weekday.', { exact: true }).waitFor();
    await suggestion.getByText('Newer by last edit date').waitFor();
    await suggestion.getByRole('button', { name: 'Both are still correct' }).click();
    await suggestion.getByText('Both marked checked. Their text is unchanged.').waitFor();
    for (const [id, body] of [[seeded.ferryOld, 'The harbor ferry leaves at 7:15 each weekday.'], [seeded.ferryNew, 'The harbor ferry now leaves at 7:45 each weekday.']] as const) {
      const ferryNote = await item(id);
      assert.equal(ferryNote.body, body);
      assert.ok((ferryNote.metadata.freshness as { checkedAt?: string }).checkedAt);
      assert.equal((ferryNote.metadata.freshness as { supersededBy?: string }).supersededBy, undefined);
    }
  });

  test('browser: a read-only token browses every knowledge section but cannot mutate or apply', { timeout: 120_000 }, async () => {
    readerToken = (await call<{ token: string }>('clients.create', 'E2E knowledge reader', ['read'])).token;
    await web!.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await connectWeb(readerToken);
    await web!.getByText('Read-only token: you can browse and search, but not change anything.', { exact: false }).waitFor();
    const collection = await k<Collection>(`/collections/${made.collection}`);
    const lantern = (await byTitle('note', 'The Lantern Orchard'))[0]!.id;
    const valuesBefore = await fieldValues(lantern, collection.id);

    await webKnowledge('Workflows');
    const recipeCard = web!.locator('li.card', { hasText: 'Garden weekly plan' });
    await recipeCard.waitFor();
    assert.equal(await web!.getByRole('button', { name: 'New workflow' }).count(), 0);
    assert.equal(await recipeCard.getByRole('button', { name: 'Run…' }).isDisabled(), true);
    await recipeCard.getByText('Applying suggestions needs a read,write token.').waitFor();

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Collections', exact: true }).click();
    const panel = web!.getByRole('region', { name: 'Reading tracker' });
    await panel.locator('li.card, tbody tr').first().waitFor();
    assert.equal(await web!.getByRole('button', { name: 'New collection' }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: /^Edit values of/ }).count(), 0);
    await panel.getByRole('radio', { name: 'Kanban' }).check();
    await panel.getByRole('list', { name: 'Grouped by Status' }).getByText('Moss and Stone').waitFor();
    assert.equal(await panel.getByRole('combobox', { name: /^Move .* to$/ }).count(), 0, 'Kanban cards can’t be moved');
    assert.equal(await panel.getByRole('button', { name: 'Move', exact: true }).count(), 0);

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Research', exact: true }).click();
    assert.equal(await web!.getByLabel('PDF or audio file').count(), 0);
    await web!.getByRole('button', { name: made.pdfTitle, exact: true }).click();
    const reader = web!.getByRole('region', { name: 'PDF reader' });
    await reader.getByLabel('Text of page 1').waitFor();
    assert.equal(await reader.getByRole('form', { name: 'Annotate a passage' }).count(), 0);

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Sources', exact: true }).click();
    const folder = web!.locator('li.card', { hasText: 'Field notes folder' });
    assert.equal(await folder.getByRole('button', { name: 'Check now' }).isDisabled(), true);
    assert.equal(await web!.getByRole('button', { name: 'New source' }).count(), 0);

    await web!.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('button', { name: 'Information review', exact: true }).click();
    assert.equal(await web!.getByRole('button', { name: 'Look for conflicts' }).isDisabled(), true);
    await web!.getByRole('button', { name: 'Show items' }).click();
    const shed = web!.locator('.freshness-list li', { hasText: 'Shed key location (2025)' });
    await shed.waitFor();
    assert.equal(await shed.getByRole('button', { name: 'Mark checked' }).count(), 0);

    const denied = [
      await api(`/knowledge/sources/${seeded.folderWatch}/check`, { method: 'POST', body: {}, token: readerToken }),
      await api(`/knowledge/collections/${collection.id}/values`, { method: 'POST', body: { itemId: lantern, values: { [collection.fields[0]!.id]: null } }, token: readerToken }),
      await api('/knowledge/freshness/check', { method: 'POST', body: { id: seeded.ferryNew, stateHash: 'x' }, token: readerToken }),
      await api('/knowledge/preferences', { method: 'POST', body: { instruction: 'Never file anything.' }, token: readerToken }),
    ];
    assert.deepEqual(denied.map((response) => response.status), [403, 403, 403, 403], 'the server refuses every write from a read-only token');
    assert.deepEqual(await fieldValues(lantern, collection.id), valuesBefore, 'nothing changed');
    assert.equal((await k<Preference[]>('/preferences')).length, 1);
    await shoot('knowledge-browser-read-only', web);
  });

  test('no renderer errors and no unexpected model requests across the journeys', () => {
    assert.deepEqual(unexpected, [], 'only the actions and freshness pipelines asked the model');
    assert.deepEqual(problems, [], 'neither window reported an error');
  });
});
