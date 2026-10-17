import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { type ElectronApplication, type Page, _electron as electron } from 'playwright';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'enve-desktop-chat-'));
// Screenshots of fictional data for docs review; ENVE_EVIDENCE_DIR moves them.
const evidence = process.env.ENVE_EVIDENCE_DIR ?? '/tmp/petty-memory-evidence';

let app: ElectronApplication;
let page: Page;
let server: Server;
let modelUrl = '';
/** What the stand-in model server was asked, in order. */
const requests: { prompt: string; step: string }[] = [];
let failNext = false;

type Canned = { step: string; keys: string[]; reply: (prompt: string) => unknown };
/** Replies picked by the JSON-schema properties each pipeline step asks for, so the real chat code runs offline. */
const CANNED: Canned[] = [
  {
    step: 'edit',
    keys: ['summary', 'operations'],
    reply: () => ({
      summary: 'Made the packing list a checklist and tidied one item.',
      operations: [{ op: 'presentation', ref: 'n1', checklist: true }, { op: 'update', ref: 'n2', title: 'Tent and poles' }],
    }),
  },
  {
    step: 'intent',
    keys: ['ready', 'topic', 'destination', 'system', 'question'],
    reply: (prompt) => {
      const found = [...prompt.matchAll(/about (\w+) into (?:an? )?(.+?)(?: system)?[.!?]?$/gim)].at(-1);
      if (!found) return { ready: false, topic: '', destination: '', system: '', question: 'Which notes should I organize, and into what system?' };
      const [, topic, system] = found as unknown as [string, string, string];
      return { ready: true, topic, destination: topic[0]!.toUpperCase() + topic.slice(1), system, question: '' };
    },
  },
  {
    step: 'grouping',
    keys: ['summary', 'groups', 'placements'],
    reply: (prompt) => {
      const notes = [...prompt.matchAll(/"ref":"(c\d+)"/g)].map((match) => match[1]);
      return {
        summary: 'Sorted with PARA: what you’re actively doing under Projects, reference notes under Resources.',
        groups: [
          { ref: 'g1', title: 'Projects', parent: null }, { ref: 'g2', title: 'Active', parent: 'g1' },
          { ref: 'g4', title: 'Areas', parent: null }, { ref: 'g3', title: 'Resources', parent: null },
          { ref: 'g5', title: 'Archives', parent: null },
        ],
        placements: notes.map((note, i) => ({ note, group: i === 0 ? 'g2' : 'g3' })),
      };
    },
  },
];

function cannedReply(prompt: string, schema: { properties?: Record<string, unknown> } | undefined): { step: string; content: string } {
  if (!schema) return { step: 'answer', content: 'Pack the tent and the stove [1].' };
  const keys = Object.keys(schema.properties ?? {}).sort().join();
  const canned = CANNED.find((entry) => [...entry.keys].sort().join() === keys);
  assert.ok(canned, `no canned reply for a schema with ${keys}`);
  return { step: canned.step, content: JSON.stringify(canned.reply(prompt)) };
}

async function capture(name: string, target?: Page): Promise<void> {
  mkdirSync(evidence, { recursive: true });
  await (target ?? page).screenshot({ path: join(evidence, `${name}.png`) });
}

const setHidden = (hidden: boolean, target?: Page) => (target ?? page).evaluate((value) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

type Entry = { item: { id: string; title: string; body: string; project?: { id: string } | null }; parentId: string | null };
const entry = (id: string) => call<Entry>('outline.get', id);
const topTitles = async () => (await call<{ items: Entry[] }>('outline.children', null)).items.map((e) => e.item.title);
const parents = async (ids: string[]) => Promise.all(ids.map(async (id) => (await entry(id)).parentId));

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const envelope = await page.evaluate(async ([m, a]) => window.enve.call(m as string, ...(a as unknown[])), [method, args] as const);
  assert.ok(envelope.ok, JSON.stringify(envelope));
  return (envelope as { value: T }).value;
}

const nav = (label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).click();
const message = () => page.getByLabel('Message');
const send = () => page.locator('form.ask-form').getByRole('button', { name: 'Send' });

/** Installs a scripted speech recognizer in the page; the real one (and the microphone) is never touched. */
const installFakeSpeech = (target = page) => target.evaluate(() => {
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

const speech = (script: string, target = page) => target.evaluate((body) => {
  const r = (window as unknown as { fakeSpeech: Record<string, (...a: unknown[]) => void>[] }).fakeSpeech.at(-1)!;
  const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });
  new Function('r', 'result', body)(r, result);
}, script);

const speechCalls = (target = page) => target.evaluate(() => (window as unknown as { fakeSpeech: { calls: string[] }[] }).fakeSpeech.at(-1)!.calls);

describe('AI chat', { timeout: 120_000 }, () => {
  before(async () => {
    // A disposable stand-in for an Ollama server: canned replies, so the real chat, retrieval and proposal pipeline runs offline.
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture' }] }));
        const body = JSON.parse(raw) as { messages: { content: string }[]; format?: { properties?: Record<string, unknown> } };
        const prompt = body.messages.at(-1)!.content;
        const { step, content } = cannedReply(prompt, body.format);
        requests.push({ prompt, step });
        if (failNext) {
          failNext = false;
          res.statusCode = 503;
          return res.end(JSON.stringify({ error: 'model is loading' }));
        }
        res.end(JSON.stringify({ message: { content } }));
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await call('settings.set', 'semanticSearch', false);
  });

  after(async () => {
    await app?.close();
    server?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('AI chat is always in the sidebar and points to settings until an AI is set up', async () => {
    await nav('AI chat');
    await page.getByText('Set up an AI provider to chat').waitFor();
    await page.getByRole('button', { name: 'Open AI settings' }).click();
    await page.getByLabel('Provider').waitFor();
  });

  test('answers with citations, keeps the draft when a turn fails, and carries the conversation into follow-ups', async () => {
    const trip = await call<{ item: { id: string } }>('outline.createNote', { parentId: null, title: 'Lake weekend', body: 'Packing for the lake weekend.' });
    await call('outline.createNote', { parentId: trip.item.id, title: 'Tent' });
    await call('outline.createNote', { parentId: trip.item.id, title: 'Stove' });
    await call('ai.configure', { provider: 'ollama', model: 'fixture', baseUrl: modelUrl });

    await nav('AI chat');
    await page.getByText(/Runs on the Ollama server/).waitFor();
    failNext = true;
    await message().fill('What should I pack for the lake weekend?');
    await send().click();
    await page.locator('form.ask-form [role="alert"]').waitFor();
    assert.equal(await message().inputValue(), 'What should I pack for the lake weekend?', 'a failed turn gives the message back');
    assert.equal(await page.locator('.chat-turn').count(), 0, 'a failed turn leaves no half exchange');

    await send().click();
    await page.locator('.chat-turn.assistant .answer .cite').first().waitFor();
    assert.equal(await message().inputValue(), '');
    await page.locator('.chat-turn.assistant .sources').getByRole('button', { name: /Lake weekend/ }).waitFor();
    await capture('desktop-chat-answer');

    await message().fill('And for the stove?');
    await message().press('Enter');
    await page.locator('.chat-turn.assistant').nth(1).waitFor();
    assert.equal(await page.locator('.chat-turn.user').count(), 2);
    const followUp = requests.at(-1)!.prompt;
    assert.match(followUp, /<conversation>[\s\S]*What should I pack for the lake weekend\?[\s\S]*<\/conversation>/);
    assert.match(followUp, /Question: And for the stove\?/);

    await page.locator('.chat-turn.assistant .answer .cite').first().click();
    await page.getByRole('dialog', { name: /details/ }).waitFor();
    await page.keyboard.press('Escape');
  });

  test('changing the mode starts a new chat, and a proposal opens the existing review without asking the model again', async () => {
    await page.getByRole('radio', { name: 'Change notes' }).click();
    await page.getByText('Started a new chat. Changes you already applied stay in your notes.').waitFor();
    assert.equal(await page.locator('.chat-turn').count(), 0);
    await page.getByText(/You review each change before it’s applied/).waitFor();

    await page.getByRole('button', { name: 'Turn into checklist' }).click();
    assert.equal(await send().isDisabled(), true, 'nothing is sent until notes are chosen');
    await page.getByRole('button', { name: 'Choose notes to change…' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose notes to change' });
    await picker.getByLabel('Find an item').fill('Lake weekend');
    await picker.getByRole('button', { name: /Lake weekend/ }).click();
    await page.getByRole('button', { name: 'Notes: Lake weekend' }).waitFor();

    await send().click();
    await page.getByRole('button', { name: 'Review changes…' }).waitFor();
    assert.equal(requests.at(-1)!.step, 'edit');
    await page.getByText('2 suggested changes. Nothing has changed yet.').waitFor();

    const asked = requests.length;
    await page.getByRole('button', { name: 'Review changes…' }).click();
    const review = page.getByRole('dialog', { name: 'Edit “Lake weekend” with AI' });
    await review.getByRole('list', { name: 'Proposed changes' }).waitFor();
    assert.equal(requests.length, asked, 'opening the review doesn’t call the model');
    await review.getByRole('checkbox').nth(1).uncheck();
    await review.getByRole('button', { name: 'Apply 1 change' }).click();
    await review.getByText('Applied 1 change.').waitFor();

    const trip = (await call<{ items: { item: { id: string; title: string } }[] }>('outline.children', null)).items.find((e) => e.item.title === 'Lake weekend')!;
    assert.equal((await call<{ checklist: boolean }>('presentation.get', trip.item.id)).checklist, true);
    const children = await call<{ items: { item: { title: string } }[] }>('outline.children', trip.item.id);
    assert.deepEqual(children.items.map((e) => e.item.title).sort(), ['Stove', 'Tent'], 'the unticked change was left out');

    await review.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('AI edit undone').waitFor();
    assert.equal((await call<{ checklist: boolean }>('presentation.get', trip.item.id)).checklist, false);

    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByText('Started a new chat. Changes you already applied stay in your notes.').waitFor();
    assert.equal(await page.locator('.chat-turn').count(), 0);
  });

  test('dictation fills the draft after typed text, shows its state, never sends, and stops on Stop, errors and leaving', async () => {
    await page.getByRole('radio', { name: 'Ask' }).click();
    await installFakeSpeech();
    await message().fill('Also');
    const asked = requests.length;

    await page.getByRole('button', { name: 'Dictate' }).click();
    await page.getByText('Starting dictation…').waitFor();
    await speech('r.onstart()');
    await page.getByText('Listening. Press Stop when you’re done.').waitFor();
    assert.equal(await send().isDisabled(), true, 'no sending while recording');

    await speech("r.onresult({ resultIndex: 0, results: [result('pack the', false)] })");
    await page.locator('.chat-interim', { hasText: 'pack the' }).waitFor();
    assert.equal(await message().inputValue(), 'Also', 'partial words stay out of the draft');
    await speech("r.onresult({ resultIndex: 0, results: [result('pack the matches', true)] })");
    await speech("r.onresult({ resultIndex: 0, results: [result('pack the matches', true)] })");
    assert.equal(await message().inputValue(), 'Also pack the matches');
    await speech("r.onresult({ resultIndex: 1, results: [result('pack the matches', true), result('and the', false)] })");
    await capture('desktop-chat-dictation');

    await page.getByRole('button', { name: 'Stop' }).click();
    assert.deepEqual(await speechCalls(), ['start', 'stop']);
    await speech('r.onend()');
    await page.getByRole('button', { name: 'Dictate' }).waitFor();
    assert.equal(requests.length, asked, 'dictation never sends on its own');

    await page.getByRole('button', { name: 'Dictate' }).click();
    await speech("r.onerror({ error: 'not-allowed' })");
    await page.getByText('Microphone or speech access was blocked here.').waitFor();
    await page.getByText(/Dictation shortcut|Windows key \+ H|dictation or voice typing tool/).waitFor();
    assert.deepEqual(await speechCalls(), ['start', 'abort']);

    await page.getByRole('button', { name: 'Dictate' }).click();
    await speech('r.onstart()');
    await setHidden(true);
    assert.deepEqual(await speechCalls(), ['start', 'abort'], 'hiding the window releases the recognizer at once');
    await setHidden(false);
    await page.getByRole('button', { name: 'Dictate' }).waitFor();
    assert.equal(await send().isDisabled(), false, 'the composer is usable again on return');

    await page.getByRole('button', { name: 'Dictate' }).click();
    await speech('r.onstart()');
    await page.getByRole('radio', { name: 'Change notes' }).click();
    assert.deepEqual(await speechCalls(), ['start', 'abort'], 'a new scope drops audio meant for the old one');
    await page.getByRole('radio', { name: 'Ask' }).click();

    await page.getByRole('button', { name: 'Dictate' }).click();
    await speech('r.onstart()');
    await nav('Home');
    assert.deepEqual(await speechCalls(), ['start', 'abort'], 'leaving the screen releases the recognizer');
    assert.equal(requests.length, asked);
  });

  test('organizes every note on a topic from one sentence, moving nothing until the reviewed subset is applied, with guarded undo', async () => {
    const backyard = await call<{ id: string }>('projects.create', { name: 'Backyard' });
    const note = async (parentId: string | null, title: string, body = '', project?: string) =>
      (await call<Entry>('outline.createNote', { parentId, title, body, project })).item.id;
    const spring = await note(null, 'Spring projects', 'Things to do this spring.');
    const tomatoes = await note(spring, 'Tomato seedlings', 'Gardening: start tomatoes indoors under the grow light.');
    const trays = await note(tomatoes, 'Seed tray order', 'Order 72-cell trays.');
    const hardening = await note(tomatoes, 'Hardening off', 'Gardening step: a week outdoors before planting.');
    const reading = await note(null, 'Reading list', 'Books to borrow.');
    const soil = await note(reading, 'Soil for small gardens', 'A gardening book about compost and soil.');
    const compost = await note(null, 'Compost bin build', 'Gardening: a three-bay pallet compost bin.', backyard.id);
    const ids = [tomatoes, trays, hardening, soil, compost];
    const before = await parents(ids);

    await nav('AI chat');
    await page.getByRole('radio', { name: 'Organize library' }).click();
    await page.getByText(/for example “Organize all notes about gardening into a PARA system”/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Choose notes to change…' }).count(), 0, 'no branch to pick');

    await message().fill('Organize my notes');
    await send().click();
    await page.getByText('Which notes should I organize, and into what system?').waitFor();
    await message().fill('All notes about gardening into a PARA system');
    await send().click();
    const review = page.getByRole('button', { name: 'Review organization…' });
    await review.waitFor();
    assert.deepEqual(requests.slice(-2).map((r) => r.step), ['intent', 'grouping']);
    assert.match(requests.at(-2)!.prompt, /Organize my notes/, 'the clarifying turn is carried as context');
    await page.getByText('4 matching notes, 5 items counting what’s inside them, into a new top-level note “Gardening”.').waitFor();
    await page.getByText('Nothing has moved yet.').waitFor();
    assert.deepEqual(await parents(ids), before, 'nothing moves before review');
    assert.ok(!(await topTitles()).includes('Gardening'));
    await capture('desktop-organize-proposal');

    const asked = requests.length;
    await review.click();
    const dialog = page.getByRole('dialog', { name: 'Organize into “Gardening”' });
    const structure = dialog.getByRole('group', { name: 'Proposed structure' });
    await structure.getByText('New top-level note').waitFor();
    for (const heading of ['Projects', 'Active', 'Areas', 'Resources', 'Archives']) await structure.getByText(heading, { exact: true }).waitFor();
    await structure.locator('label', { hasText: 'Tomato seedlings' }).filter({ hasText: 'brings 2 inside it' }).filter({ hasText: 'from “Spring projects”' }).waitFor();
    await structure.locator('label', { hasText: 'Compost bin build' }).filter({ hasText: 'from the top level' }).waitFor();
    assert.equal(requests.length, asked, 'reviewing doesn’t call the model again');
    await capture('desktop-organize-review');

    await structure.getByRole('checkbox', { name: /Compost bin build/ }).uncheck();
    await dialog.getByRole('button', { name: 'Move 2 notes' }).click();
    await dialog.getByText('Moved 2 notes into “Gardening”.').waitFor();
    const gardening = (await call<{ items: Entry[] }>('outline.children', null)).items.find((e) => e.item.title === 'Gardening')!;
    const active = await entry((await entry(tomatoes)).parentId!);
    assert.equal(active.item.title, 'Active');
    assert.equal((await entry(active.parentId!)).parentId, gardening.item.id);
    assert.deepEqual(await parents([trays, hardening]), [tomatoes, tomatoes], 'a moved note keeps what’s inside it');
    assert.equal((await entry((await entry(soil)).parentId!)).item.title, 'Resources');
    const kept = await entry(compost);
    assert.equal(kept.parentId, null, 'the unticked note stays put');
    assert.equal(kept.item.project?.id, backyard.id);
    assert.equal((await entry(tomatoes)).item.body, 'Gardening: start tomatoes indoors under the grow light.');

    await dialog.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Organization undone').waitFor();
    assert.deepEqual(await parents(ids), before);
    assert.ok(!(await topTitles()).includes('Gardening'));
    await page.getByText('Undone. Nothing from this plan is applied.').waitFor();
  });

  test('a plan made stale by a new matching note is refused and the chat and draft survive; a fresh plan opens its result', async () => {
    await message().fill('Organize all notes about gardening into a PARA system');
    await send().click();
    const review = page.getByRole('button', { name: 'Review organization…' });
    await review.waitFor();
    const turns = await page.locator('.chat-turn').count();
    const watering = (await call<Entry>('outline.createNote', { parentId: null, title: 'Watering schedule', body: 'Gardening: water the beds at dawn.' })).item.id;
    await message().fill('A draft to keep');

    await review.click();
    const dialog = page.getByRole('dialog', { name: 'Organize into “Gardening”' });
    await dialog.getByRole('button', { name: 'Move 3 notes' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'changed since the proposal was made' }).waitFor();
    assert.equal((await entry(watering)).parentId, null);
    assert.ok(!(await topTitles()).includes('Gardening'), 'a stale plan moves nothing');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('.chat-turn').count(), turns);
    assert.equal(await message().inputValue(), 'A draft to keep');

    await message().fill('Organize all notes about gardening into a PARA system');
    await send().click();
    await page.getByText(/^5 matching notes/).waitFor();
    await page.getByRole('button', { name: 'Review organization…' }).last().click();
    await dialog.getByRole('button', { name: 'Move 4 notes' }).click();
    await dialog.getByText('Moved 4 notes into “Gardening”.').waitFor();
    await dialog.getByRole('button', { name: 'Open “Gardening”' }).click();
    await page.getByRole('button', { name: 'Gardening', exact: true }).waitFor();
    await capture('desktop-organized-outline');
  });

  test('browser client: chat keeps its session across sections, reviews proposals with the existing apply and undo, and forgets on disconnect', async () => {
    const { url } = await call<{ url: string }>('api.status');
    const readOnly = await call<{ token: string }>('clients.create', 'E2E chat read', ['read']);
    const full = await call<{ token: string }>('clients.create', 'E2E chat', ['read', 'write']);
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, address) => {
      void new BrowserWindow({ width: 1100, height: 800 }).loadURL(address);
    }, `${url}/`);
    const web = await opened;
    const sections = web.getByRole('navigation', { name: 'Sections' });
    const connect = async (token: string) => {
      await installFakeSpeech(web);
      await web.getByPlaceholder('em_…').fill(token);
      await web.getByRole('button', { name: 'Connect' }).click();
      await sections.getByRole('button', { name: 'AI chat' }).click();
    };
    const webMessage = web.getByLabel('Message');
    const webSend = web.locator('form.chat-form').getByRole('button', { name: 'Send' });

    await connect(readOnly.token);
    await web.getByText(/Uses Ollama \(fixture\), set up on the server/).waitFor();
    assert.equal(await web.getByRole('radio', { name: 'Change notes' }).isDisabled(), true, 'a read-only token can only ask');
    await web.getByText('Changing notes needs a token with the write scope; this one can only ask.').waitFor();
    await web.getByRole('button', { name: 'Disconnect' }).click();

    await connect(full.token);
    await webMessage.fill('What should I pack for the lake weekend?');
    await webSend.click();
    await web.locator('.chat-turn.assistant .answer .cite').first().click();
    await web.getByRole('complementary', { name: 'Item details' }).waitFor();
    await capture('browser-chat-answer', web);

    await webMessage.fill('A draft that survives');
    await sections.getByRole('button', { name: 'Outline' }).click();
    await sections.getByRole('button', { name: 'AI chat' }).click();
    assert.equal(await webMessage.inputValue(), 'A draft that survives');
    assert.equal(await web.locator('.chat-turn.assistant').count(), 1, 'the conversation stays while switching sections');

    await web.getByRole('button', { name: 'Dictate' }).click();
    await speech('r.onstart()', web);
    await web.getByText('Listening. Press Stop when you’re done.').waitFor();
    assert.equal(await webSend.isDisabled(), true);
    await speech("r.onresult({ resultIndex: 0, results: [result('with matches', true)] })", web);
    assert.equal(await webMessage.inputValue(), 'A draft that survives with matches');
    await sections.getByRole('button', { name: 'Outline' }).click();
    assert.deepEqual(await speechCalls(web), ['start', 'abort'], 'leaving the section releases the recognizer');
    await sections.getByRole('button', { name: 'AI chat' }).click();
    await web.getByRole('button', { name: 'Dictate' }).click();
    await speech('r.onstart()', web);
    await setHidden(true, web);
    assert.deepEqual(await speechCalls(web), ['start', 'abort'], 'a hidden tab releases the recognizer at once');
    await setHidden(false, web);
    await web.getByRole('button', { name: 'Dictate' }).waitFor();

    await web.getByRole('radio', { name: 'Change notes' }).check();
    await web.getByText('Started a new chat. Changes you already applied stay in your notes.').waitFor();
    await web.getByRole('button', { name: 'Choose notes to change…' }).click();
    await web.getByLabel('Search items').fill('Lake weekend');
    await web.getByRole('option', { name: /Lake weekend/ }).click();
    await webMessage.fill('Make this a checklist');
    await webSend.click();
    const review = web.getByRole('button', { name: 'Review changes' });
    await review.waitFor();
    const asked = requests.length;
    await review.click();
    assert.equal(requests.length, asked, 'reviewing doesn’t call the model again');
    await web.getByRole('checkbox', { name: 'Include change 2' }).uncheck();
    await web.getByRole('button', { name: 'Apply selected' }).click();
    await web.getByText('Applied 1 change.').waitFor();
    const trip = (await call<{ items: { item: { id: string; title: string } }[] }>('outline.children', null)).items.find((e) => e.item.title === 'Lake weekend')!;
    assert.equal((await call<{ checklist: boolean }>('presentation.get', trip.item.id)).checklist, true);
    await web.getByRole('button', { name: 'Undo these changes' }).click();
    await web.getByText('AI changes undone as a new history entry').waitFor();
    assert.equal((await call<{ checklist: boolean }>('presentation.get', trip.item.id)).checklist, false);
    await web.getByRole('button', { name: 'Close details' }).click();

    const feeder = (await call<Entry>('outline.createNote', { parentId: null, title: 'Feeder log', body: 'Birding: finches at the feeder every morning.' })).item.id;
    const trips = (await call<Entry>('outline.createNote', { parentId: null, title: 'Trips', body: 'Day trips.' })).item.id;
    const marsh = (await call<Entry>('outline.createNote', { parentId: trips, title: 'Marsh walk', body: 'Birding trip to the marsh at low tide.' })).item.id;
    await web.getByRole('radio', { name: 'Organize library' }).check();
    await webMessage.fill('Organize all notes about birding into a PARA system');
    await webSend.click();
    const organize = web.getByRole('button', { name: 'Review organization' });
    await organize.waitFor();
    assert.deepEqual(await parents([feeder, marsh]), [null, trips], 'nothing moves before review');
    const planned = requests.length;
    await organize.click();
    const structure = web.getByRole('group', { name: 'Proposed structure' });
    await structure.getByText('New top-level note').waitFor();
    await structure.locator('label', { hasText: 'Marsh walk' }).filter({ hasText: 'from' }).getByRole('button', { name: 'Trips' }).waitFor();
    assert.equal(requests.length, planned);
    await capture('browser-organize-review', web);
    await web.getByRole('button', { name: 'Move 2 notes' }).click();
    await web.getByText('Moved 2 notes into “Birding”.').waitFor();
    assert.equal((await entry((await entry(feeder)).parentId!)).item.title, 'Active');
    await capture('browser-organize-applied', web);
    await web.getByRole('button', { name: 'Open “Birding”' }).click();
    await web.getByRole('complementary', { name: 'Item details' }).getByText('Birding').first().waitFor();
    await web.getByRole('button', { name: 'Undo this organization' }).click();
    await web.getByText('Organization undone. Nothing from this plan is applied.').waitFor();
    assert.deepEqual(await parents([feeder, marsh]), [null, trips]);

    await web.getByRole('button', { name: 'Disconnect' }).click();
    await connect(full.token);
    assert.equal(await web.locator('.chat-turn').count(), 0, 'disconnecting forgets the conversation');
    assert.equal(await webMessage.inputValue(), '');
    await web.close();
  });
});
