// Screenshots for the repository page: `npm --prefix apps/desktop run screenshots`.
// Builds the app, creates a fresh demo library (scripts/demo-library.ts) in a temp folder, drives the real app with
// Playwright, and writes 2x PNGs to docs/screenshots/desktop/. Machine-specific details that would otherwise appear
// (this Mac's network addresses, a random port, dev-build paths) are replaced with representative values by answering
// those few calls in the main process; everything else is the live app.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import QRCode from 'qrcode';
import { pairingLink } from '@enve-memory/api';
import { mcpLaunch, setupSnippets } from '../src/main/mcp.ts';
import { repo, root } from './bundle.mjs';

const OUT = join(repo, 'docs', 'screenshots', 'desktop');
const OLLAMA = process.env.ENVE_SCREENSHOT_OLLAMA ?? 'http://127.0.0.1:11434';
const skipped = [];

// Screens read best in the evening (greeting, "Tonight" reminders), so run in a time zone where it's evening now.
const ZONES = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Atlantic/Azores', 'Europe/London', 'Europe/Berlin', 'Europe/Helsinki', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const hourIn = (zone) => Number(new Date().toLocaleString('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }));
const TZ = ZONES.find((z) => hourIn(z) >= 18 && hourIn(z) <= 20) ?? ZONES.find((z) => hourIn(z) >= 15 && hourIn(z) <= 21) ?? 'UTC';

const freePort = () => new Promise((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

async function representativeValues() {
  const port = 49231;
  const url = `http://127.0.0.1:${port}`;
  const lanUrls = [`http://192.168.1.20:${port}`, `http://100.101.12.7:${port}`];
  const launch = mcpLaunch({
    isPackaged: true,
    execPath: '/Applications/Petty Memory.app/Contents/MacOS/Petty Memory',
    resourcesPath: '/Applications/Petty Memory.app/Contents/Resources',
    repoRoot: '',
    home: null,
  });
  const token = 'em_4mQ7yXc2Lr9pVt1ZkHs8dNf3Bw6Gj0Ea5Uo2Ri7Cy_';
  const links = await Promise.all(lanUrls.map(async (lan) => {
    const link = pairingLink(lan, token, 'iPhone');
    return { url: lan, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' }) };
  }));
  return {
    'api.status': { running: true, url, port, lan: true, lanUrls, error: null },
    'mcp.setup': { ...setupSnippets(launch, url, 'darwin'), claudeAvailable: true },
    pairLinks: links,
  };
}

const home = mkdtempSync(join(tmpdir(), 'enve-memory-demo-'));
try {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(repo, 'scripts', 'demo-library.ts'), home], { stdio: 'inherit', cwd: repo, env: { ...process.env, TZ } });
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ theme: 'dark' }));
  mkdirSync(OUT, { recursive: true });

  const app = await electron.launch({
    args: [root, '--force-device-scale-factor=2', '--use-mock-keychain'],
    colorScheme: null,
    env: {
      ...process.env,
      TZ,
      ENVE_MEMORY_HOME: home,
      ENVE_MEMORY_PORT: String(await freePort()),
      ENVE_MEMORY_CACHE: join(repo, '.cache'),
      ENVE_MEMORY_NO_GLOBAL_SHORTCUT: '1',
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await app.evaluate(({ ipcMain }, values) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get('enve:call');
    handlers.set('enve:call', async (event, method, args) => {
      if (method === 'api.status' || method === 'mcp.setup') return { ok: true, value: values[method] };
      const result = await original(event, method, args);
      if (method === 'clients.pair' && result.ok) return { ok: true, value: { ...result.value, links: values.pairLinks } };
      // The answer comes from the lab's Ollama; describe it as the usual Ollama on this computer.
      if (method === 'ai.status' && result.ok) return { ok: true, value: { ...result.value, baseUrl: '' } };
      return result;
    });
  }, await representativeValues());

  const call = (method, ...args) => page.evaluate(async ([m, a]) => window.enve.call(m, ...a), [method, args]);
  const nav = (name) => page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).first().click();
  const settings = async (section) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  };
  const scrollMain = (y) => page.evaluate((top) => document.querySelector('.main').scrollTo({ top }), y);
  // Bring an element's bottom edge just inside the window, so a whole section shows.
  const revealBottom = (selector) => page.evaluate((sel) => {
    const main = document.querySelector('.main');
    main.scrollTop += document.querySelector(sel).getBoundingClientRect().bottom - (innerHeight - 32);
  }, selector);
  const shot = async (name) => {
    await page.evaluate(() => {
      // Scrollbars appear only while scrolling with a trackpad on a default macOS setup; match that.
      if (!document.body.dataset.shots) {
        document.styleSheets[0].insertRule('::-webkit-scrollbar { width: 0; height: 0; }');
        document.body.dataset.shots = '1';
      }
      document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden');
      document.activeElement?.blur?.();
    });
    await page.mouse.move(1, 899);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
    await page.evaluate(() => document.querySelector('.toasts')?.style.removeProperty('visibility'));
    console.log(`  ${name}.png`);
  };

  const localHour = await page.evaluate(() => new Date().getHours());
  console.log(`Demo library ${home}; time zone ${TZ} (renderer local hour ${localHour})`);

  await page.getByRole('heading', { name: 'Recent' }).waitFor();
  await shot('home');

  await nav('Garage Door Controller');
  await page.locator('.timeline').waitFor();
  await scrollMain(0);
  await shot('project');
  await revealBottom('.timeline');
  await shot('project-decisions');
  await scrollMain(0);

  await nav('Links');
  await page.locator('.item-row').filter({ hasText: 'How Security+ 2.0 openers talk' }).getByRole('button').first().click();
  const drawer = page.getByRole('dialog', { name: 'Link details' });
  await drawer.locator('.reader').waitFor();
  await shot('item');
  await page.keyboard.press('Escape');

  await nav('Inbox');
  await page.locator('.suggestion').first().waitFor();
  await shot('inbox');

  await nav('Home');
  await page.keyboard.press('Meta+K');
  await page.getByLabel('Search your library').fill('how does the remote avoid replay attacks');
  await page.locator('.palette-results .match.semantic, .palette-results .match.both').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(300);
  await shot('search');
  await page.getByLabel('Search your library').press('Escape');

  await nav('Watch');
  await page.locator('.item-row').first().waitFor();
  await shot('shelves');

  await nav('Activity');
  await page.locator('.activity li').first().waitFor();
  await shot('activity');

  await nav('Graph');
  await page.getByRole('img', { name: /Graph of \d+ nodes/ }).waitFor();
  await page.waitForTimeout(6000);
  await shot('graph');

  await settings('AI tools');
  await page.locator('.snippet').first().waitFor();
  await shot('settings-ai-tools');

  await call('clients.create', 'Chrome extension', ['capture']);
  await settings('Devices & extensions');
  await page.getByLabel('Phone name').fill('iPhone');
  await page.getByRole('button', { name: 'Pair a phone' }).click();
  await page.locator('.qr-grid img').first().waitFor();
  await page.locator('.pairing').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot('settings-devices');
  await page.getByRole('button', { name: 'Done' }).click();

  const lab = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (lab) {
    await call('ai.configure', { provider: 'ollama', model: 'qwen2.5:1.5b', baseUrl: OLLAMA });
    await nav('AI chat');
    // A small model doesn't always pick the current decision (the demo switched to the ESP32-S3) or cite inline;
    // ask up to four times, and leave the shot out rather than publish a wrong answer.
    let correct = false;
    for (let attempt = 1; attempt <= 4 && !correct; attempt++) {
      if (attempt > 1) await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByLabel('Message').fill('What have we decided about the garage controller?');
      await page.locator('form.ask-form').getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('.answer .answer-text').waitFor({ timeout: 180_000 });
      const answer = (await page.locator('.answer .answer-text').textContent()) ?? '';
      correct = /ESP32-S3/i.test(answer) && (await page.locator('.answer .answer-text .cite, .answer .sources li').count()) > 0;
    }
    if (correct) await shot('ask');
    else {
      rmSync(join(OUT, 'ask.png'), { force: true });
      skipped.push('ask.png: in four tries qwen2.5:1.5b never named the current ESP32-S3 decision');
    }
    await call('ai.configure', { provider: 'none', model: '', baseUrl: '' });
  } else {
    skipped.push(`ask.png: no Ollama server answered at ${OLLAMA} (set ENVE_SCREENSHOT_OLLAMA)`);
  }

  await call('prefs.setTheme', 'light');
  await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
  await nav('Home');
  await page.getByRole('heading', { name: 'Recent' }).waitFor();
  await shot('home-light');
  await nav('Garage Door Controller');
  await page.locator('.timeline').waitFor();
  await scrollMain(0);
  await shot('project-light');

  await app.close();
  console.log(`Wrote ${OUT}`);
  for (const reason of skipped) console.log(`Skipped ${reason}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
