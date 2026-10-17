// Renders the README hero and the GitHub social preview from the app screenshots:
// `node scripts/render-banner.mjs` (after the apps' `npm run screenshots`). Uses the Playwright Chromium the apps' tests install.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const image = (path) => `data:image/png;base64,${readFileSync(join(root, path)).toString('base64')}`;
const out = join(root, 'docs', 'assets');
mkdirSync(out, { recursive: true });

const logo = image('apps/desktop/build/icon.png');
const desktop = image('docs/screenshots/desktop/project.png');
const panel = image('docs/screenshots/extension/sidepanel.png');
const phone = image('docs/screenshots/parity/ios-home-dark.png');

const page = ({ width, height, title, tagline, compact }) => `<!doctype html>
<html><head><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${width}px; height: ${height}px; overflow: hidden; position: relative;
    background: radial-gradient(1200px 700px at 78% 30%, #173238 0%, #12191d 55%, #0e1113 100%);
    font-family: -apple-system, "SF Pro Display", "Segoe UI", sans-serif; color: #e6ebee;
  }
  .glow { position: absolute; width: 640px; height: 640px; right: 18%; top: 8%; border-radius: 50%;
    background: radial-gradient(circle, rgba(79,193,201,.24), rgba(79,193,201,0) 65%); }
  .copy { position: absolute; left: ${compact ? 64 : 88}px; top: ${compact ? 72 : 110}px; width: ${compact ? 470 : 560}px; }
  .brand { display: flex; align-items: center; gap: 18px; margin-bottom: ${compact ? 26 : 34}px; }
  .brand img { width: ${compact ? 64 : 76}px; height: ${compact ? 64 : 76}px; }
  .brand span { font-family: "New York", "Iowan Old Style", Georgia, serif; font-size: ${compact ? 40 : 46}px; letter-spacing: -.5px; }
  h1 { font-family: "New York", "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: ${compact ? 44 : 56}px;
    line-height: 1.08; letter-spacing: -1px; margin-bottom: 22px; }
  h1 em { font-style: normal; color: #4fc1c9; }
  p { font-size: ${compact ? 19 : 22}px; line-height: 1.5; color: #aeb8be; max-width: 520px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
  .chips span { font-size: 15px; padding: 7px 13px; border-radius: 999px; border: 1px solid #4b565d; color: #e6ebee; background: rgba(255,255,255,.03); }
  .shot { position: absolute; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.07); }
  .shot img { display: block; width: 100%; }
  .desktop { width: ${compact ? 700 : 1000}px; left: ${compact ? 560 : 720}px; top: ${compact ? 92 : 120}px; }
  .panel { width: ${compact ? 210 : 290}px; height: ${compact ? 470 : 640}px; left: ${compact ? 520 : 650}px; top: ${compact ? 160 : 230}px; }
  .panel img { width: 100%; height: auto; }
  .phone { width: ${compact ? 190 : 260}px; aspect-ratio: 644 / 1400; left: ${compact ? 1070 : 1480}px; top: ${compact ? 205 : 300}px; border-radius: ${compact ? 28 : 36}px; }
</style></head>
<body>
  <div class="glow"></div>
  <div class="copy">
    <div class="brand"><img src="${logo}" alt=""><span>Petty Memory</span></div>
    <h1>${title}</h1>
    <p>${tagline}</p>
    ${compact ? '' : '<div class="chips"><span>Claude · Codex · ChatGPT · any MCP client</span><span>Local-first</span><span>Semantic search</span><span>Desktop · Browser · iOS</span></div>'}
  </div>
  <div class="shot desktop"><img src="${desktop}" alt=""></div>
  <div class="shot panel"><img src="${panel}" alt=""></div>
  <div class="shot phone"><img src="${phone}" alt=""></div>
</body></html>`;

const browser = await chromium.launch();
try {
  const shots = [
    { file: 'hero.png', width: 1800, height: 900, scale: 1.5, compact: false },
    { file: 'social-preview.png', width: 1280, height: 640, scale: 1, compact: true },
  ];
  for (const shot of shots) {
    const tab = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: shot.scale });
    await tab.setContent(page({
      ...shot,
      title: 'One memory for you and <em>every AI you use</em>.',
      tagline: 'Save links, notes, files and decisions once. Claude, Codex and any MCP client read and write the same library, and it stays on your computer.',
    }));
    await tab.waitForLoadState('networkidle');
    await tab.screenshot({ path: join(out, shot.file) });
    await tab.close();
    console.log(`docs/assets/${shot.file}`);
  }
} finally {
  await browser.close();
}
