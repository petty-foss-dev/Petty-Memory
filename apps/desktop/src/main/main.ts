import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT } from '@enve-memory/api';
import { defaultHome } from '@enve-memory/core';
import type { Intent, Item } from '@enve-memory/core';
import {
  BrowserWindow, type MenuItemConstructorOptions, Menu, Notification, type WebFrameMain, app, globalShortcut, ipcMain, nativeTheme,
  safeStorage, session, shell,
} from 'electron';
import { type Command, METHOD_KINDS, type ThemeMode, isMethod } from '../shared/ipc.ts';
import { dispatch } from './dispatch.ts';
import { createHandlers } from './handlers.ts';
import { Library } from './library.ts';
import { PrefsFile } from './prefs.ts';
import { REMOTE_TOKEN } from './remote.ts';
import { SecretStore } from './secrets.ts';
import { displayTitle } from '../shared/text.ts';
import { TRANSCRIPTION_KEY } from '../shared/knowledge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const devServer = process.env.VITE_DEV_SERVER_URL;
const rendererIndex = join(here, 'renderer', 'index.html');
const home = resolve(process.env.ENVE_MEMORY_HOME || defaultHome());
const port = process.env.ENVE_MEMORY_PORT ? Number(process.env.ENVE_MEMORY_PORT) : DEFAULT_PORT;
const isMac = process.platform === 'darwin';

// The library folder is the app's userData, as the CLI expects; Chromium's own state goes in a subfolder of it.
mkdirSync(home, { recursive: true });
app.setName('Petty Memory');
app.setPath('userData', home);
app.setPath('sessionData', join(home, 'Session'));

let library: Library | null = null;
let quitting = false;
let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let shortcutRegistered = false;
let lastFocusSync = 0;

const appUrl = devServer ? new URL(devServer).origin : pathToFileURL(rendererIndex).href;
const isAppUrl = (url: string) => (devServer ? url.startsWith(`${appUrl}/`) || url === appUrl : url.split('#')[0] === appUrl);
const isTrusted = (frame: WebFrameMain | null) => frame !== null && isAppUrl(frame.url);

function openIfWeb(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url);
  } catch {}
}

function load(win: BrowserWindow, hash = ''): void {
  if (devServer) void win.loadURL(hash ? `${devServer}#${hash}` : devServer);
  else void win.loadFile(rendererIndex, hash ? { hash } : {});
}

const webPreferences = () => ({
  preload: join(here, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: true,
});

const background = () => (nativeTheme.shouldUseDarkColors ? '#0e1113' : '#f3f5f6');

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Petty Memory',
    backgroundColor: background(),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: webPreferences(),
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
    if (!isMac) app.quit();
  });
  load(win);
  return win;
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function openCapture(): void {
  if (!captureWindow || captureWindow.isDestroyed()) {
    captureWindow = new BrowserWindow({
      width: 560,
      height: 248,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Quick capture',
      backgroundColor: background(),
      webPreferences: webPreferences(),
    });
    captureWindow.on('blur', () => captureWindow?.hide());
    load(captureWindow, 'capture');
    captureWindow.once('ready-to-show', () => showCapture());
    return;
  }
  showCapture();
}

function showCapture(): void {
  if (!captureWindow) return;
  captureWindow.center();
  captureWindow.show();
  captureWindow.focus();
  captureWindow.webContents.send('enve:command', 'capture-focus');
}

/** Shows the main window on an item, waiting for the page if the window is new. */
function openItemInMain(id: string): void {
  showMain();
  const contents = mainWindow?.webContents;
  if (!contents) return;
  if (contents.isLoading()) contents.once('did-finish-load', () => contents.send('enve:open', id));
  else contents.send('enve:open', id);
}

const REMINDER_TITLES: Record<Intent, string> = { read: 'Time to read', watch: 'Time to watch', buy: 'Still want to buy this?', revisit: 'Time to revisit' };
// Electron drops click handlers for notifications that get garbage-collected, so keep the live ones.
const shownReminders = new Set<Notification>();

function remind(item: Item): void {
  const notification = new Notification({
    title: item.intent ? REMINDER_TITLES[item.intent] : 'Reminder',
    body: displayTitle(item),
  });
  shownReminders.add(notification);
  notification.on('click', () => {
    shownReminders.delete(notification);
    openItemInMain(item.id);
  });
  notification.on('close', () => shownReminders.delete(notification));
  notification.show();
}

/** Each due reminder is shown once, then marked delivered; the Reminders view keeps listing it until it's cleared. */
function deliverReminders(): void {
  if (!library || quitting || !Notification.isSupported()) return;
  try {
    const items = library.memory.items;
    for (const item of items.dueReminders()) {
      remind(item);
      items.markReminded(item.id);
    }
  } catch (error) {
    console.error('reminders:', error);
  }
}

function sendCommand(command: Command): void {
  showMain();
  mainWindow?.webContents.send('enve:command', command);
}

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastChanged(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('enve:changed');
    deliverReminders();
  }, 60);
}

function applyTheme(theme: ThemeMode): void {
  nativeTheme.themeSource = theme;
}

function buildMenu(): void {
  // Shortcuts are handled in the renderer (so they work in every text field); the menu only shows them.
  const shortcut = (label: string, accelerator: string, command: Command): MenuItemConstructorOptions => ({
    label, accelerator, registerAccelerator: false, click: () => sendCommand(command),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: 'Petty Memory',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            shortcut('Settings…', 'CommandOrControl+,', 'settings'),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        shortcut('New Note', 'CommandOrControl+N', 'new-note'),
        shortcut('Save Link', 'CommandOrControl+L', 'save-link'),
        { label: 'Quick Capture', click: () => openCapture() },
        { type: 'separator' },
        { label: 'Import…', click: () => sendCommand('import') },
        { type: 'separator' },
        shortcut('Search', 'CommandOrControl+K', 'search'),
        ...(isMac ? [] : [shortcut('Settings', 'CommandOrControl+,', 'settings')]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged ? [] : [{ role: 'reload' } as const, { role: 'toggleDevTools' } as const, { type: 'separator' } as const]),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function harden(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openIfWeb(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      openIfWeb(url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audio = permission === 'media' && details.isMainFrame && isAppUrl(contents.getURL()) && isAppUrl(details.requestingUrl)
      && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
    callback(allowed.has(permission) || audio === true);
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => allowed.has(permission)
    || (permission === 'media' && contents !== null && details.isMainFrame && isAppUrl(contents.getURL())
      && isAppUrl(details.requestingUrl ?? '') && details.mediaType === 'audio'));
}

async function start(): Promise<void> {
  const prefs = new PrefsFile(join(home, 'desktop.json'));
  const secrets = new SecretStore(join(home, 'desktop-secrets.json'), safeStorage);
  applyTheme(prefs.get('theme'));

  const lib = new Library({
    home,
    version: app.getVersion(),
    port,
    lan: prefs.get('lan'),
    // Built and packaged apps carry dist/web; development serves the browser client's sources.
    webRoot: [join(here, 'web'), resolve(here, '..', '..', 'web', 'public')].find((dir) => existsSync(join(dir, 'index.html'))) ?? null,
    keys: (provider) => {
      try {
        return secrets.get(provider);
      } catch (error) {
        console.error('secrets:', error);
        return undefined;
      }
    },
    transcriptionKey: () => secrets.get(TRANSCRIPTION_KEY),
    remote: () => {
      const url = prefs.get('remoteUrl');
      if (!url) return null;
      try {
        const token = secrets.get(REMOTE_TOKEN);
        return token ? { url, token } : null;
      } catch (error) {
        console.error('secrets:', error);
        return null;
      }
    },
    onChanged: broadcastChanged,
  });
  library = lib;
  await lib.start();
  if (quitting) return;

  const platformHome = resolve(defaultHome({ ...process.env, ENVE_MEMORY_HOME: '' }));
  const handlers = createHandlers({
    library: lib,
    secrets,
    prefs,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    launch: {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      repoRoot: resolve(here, '..', '..', '..'),
      home: home === platformHome ? null : home,
    },
    shortcutRegistered: () => shortcutRegistered,
    applyTheme,
    parentWindow: () => mainWindow ?? undefined,
    openCapture,
    closeCapture: () => captureWindow?.hide(),
  });

  ipcMain.handle('enve:call', async (event, method: unknown, args: unknown) => {
    if (!isTrusted(event.senderFrame)) return { ok: false, error: { code: 'forbidden', message: 'Untrusted caller.' } };
    const result = await dispatch(handlers, method, args);
    if (result.ok && isMethod(method) && METHOD_KINDS[method] === 'write') lib.afterWrite();
    return result;
  });

  harden();
  buildMenu();
  mainWindow = createMainWindow();

  if (!process.env.ENVE_MEMORY_NO_GLOBAL_SHORTCUT) {
    try {
      shortcutRegistered = globalShortcut.register(prefs.get('shortcut'), openCapture);
    } catch (error) {
      console.error('shortcut:', error);
    }
  }

  deliverReminders();
  setInterval(deliverReminders, 60_000);

  app.on('browser-window-focus', () => {
    if (Date.now() - lastFocusSync < 30_000) return;
    lastFocusSync = Date.now();
    void lib.sync();
    void lib.remoteSync();
  });
  app.on('activate', showMain);
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

// Cleanup runs once: stop the API and workers and close the database, then exit for real.
app.on('before-quit', (event) => {
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  globalShortcut.unregisterAll();
  (library?.stop() ?? Promise.resolve())
    .catch((error: unknown) => console.error('shutdown:', error))
    .finally(() => app.exit(0));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(start).catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
}
