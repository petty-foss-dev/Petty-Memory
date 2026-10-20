import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { AiError, PROVIDERS, type ProviderId, ask, chat, createProvider, enrichItem, isProviderId, proposeEdit } from '@enve-memory/ai';
import { invokeKnowledgeRequest, lanUrls, pairingLink } from '@enve-memory/api';
import { localEmbeddingsSupported } from '@enve-memory/embeddings';
import { type Item, type ItemFilter, MAX_SEALED_FILE_BYTES, MemoryError, SEALED_FILE_MIME, SEALED_FILE_NAME, pageCursor } from '@enve-memory/core';
import {
  importBookmarks, importCsv, importEnveExport, importEnveHighlights, importMarkdownFolder, previewEnveHighlights,
  importBiscottiMeetings, listBiscottiMeetings, previewBiscottiImport,
} from '@enve-memory/importers';
import { extractImageText, ingestItem } from '@enve-memory/ingestion';
import { type BrowserWindow, dialog, shell } from 'electron';
import QRCode from 'qrcode';
import {
  type AiConfig, type AiStatus, type AppInfo, IMPORT_KINDS, type ImportKind, MAX_HIGHLIGHT_FILE_BYTES, type Prefs, type RemoteStatus, SHELVES, type Shelf,
  UNOPENED_DAYS, type SyncStatus, type ThemeMode, type VaultFile,
} from '../shared/ipc.ts';
import { DesktopError, type Handlers } from './dispatch.ts';
import type { Library } from './library.ts';
import { type LaunchContext, claudeAddArgs, findExecutable, mcpLaunch, setupSnippets } from './mcp.ts';
import { REMOTE_TOKEN, remoteUrl } from './remote.ts';
import type { PrefsFile } from './prefs.ts';
import type { SecretStore } from './secrets.ts';
import { TRANSCRIPTION_KEY, type TranscriptionStatus } from '../shared/knowledge.ts';
import { BiscottiClient, biscottiLink } from './biscotti.ts';

export interface HandlerContext {
  library: Library;
  secrets: SecretStore;
  prefs: PrefsFile;
  version: string;
  isPackaged: boolean;
  launch: LaunchContext;
  shortcutRegistered: () => boolean;
  applyTheme: (theme: ThemeMode) => void;
  parentWindow: () => BrowserWindow | undefined;
  openCapture: () => void;
  closeCapture: () => void;
}

const CLOUD_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);
const NON_TASK = (type: string) => type !== 'task' && type !== 'decision';

const MAX_KIT_BYTES = 256 * 1024;
const formatMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new DesktopError('invalid', `${name} must be text.`);
  return value;
};

const highlightText = (value: unknown): string => {
  const text = str(value, 'The highlights export');
  if (Buffer.byteLength(text, 'utf8') > MAX_HIGHLIGHT_FILE_BYTES) {
    throw new DesktopError('invalid', 'That export is larger than 2 MB. Export fewer books at a time and import each file.');
  }
  return text;
};

export function createHandlers(ctx: HandlerContext): Handlers {
  const { library, secrets, prefs } = ctx;
  const memory = () => library.memory;
  const biscotti = new BiscottiClient();
  const requireBiscottiMac = () => {
    if (process.platform !== 'darwin') throw new DesktopError('unavailable', 'The direct Biscotti connection needs a Mac. Import a Biscotti CSV export here instead.');
  };

  const shelfFilter = (shelf: Shelf): ItemFilter => {
    if (!SHELVES.includes(shelf)) throw new DesktopError('invalid', `Unknown shelf "${shelf}".`);
    if (shelf === 'pinned') return { pinned: true };
    if (shelf === 'unopened') return { unopenedDays: UNOPENED_DAYS };
    return { intent: shelf };
  };

  const inbox = () => memory().items.list({ inbox: true }, 200).filter((item) => NON_TASK(item.type));

  const providerId = (value: string): ProviderId => {
    if (!isProviderId(value)) throw new DesktopError('invalid', `Unknown AI provider "${value}".`);
    return value;
  };

  const adHocProvider = (config: AiConfig) => {
    const id = providerId(config.provider);
    if (id === 'none') throw new AiError('Choose a provider first.');
    return createProvider({
      provider: id,
      model: config.model || PROVIDERS[id].defaultModel || 'default',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || secrets.get(id),
    });
  };

  const requireProvider = () => {
    const provider = library.provider();
    if (!provider) throw new AiError(library.aiError ?? 'Set up an AI provider in Settings → AI first.');
    return provider;
  };

  const aiStatus = (): AiStatus => {
    const settings = memory().settings.all();
    if (settings.aiProvider !== 'none') library.provider();
    return {
      provider: settings.aiProvider,
      model: settings.aiModel,
      baseUrl: settings.aiBaseUrl,
      enrich: settings.aiEnrich,
      enrichSince: settings.aiEnrichSince,
      autoApply: settings.aiAutoApply,
      providers: Object.entries(PROVIDERS).map(([id, info]) => ({
        id, label: info.label, baseUrl: info.baseUrl, needsKey: info.needsKey, defaultModel: info.defaultModel ?? null, cloud: CLOUD_PROVIDERS.has(id),
      })),
      keys: secrets.names().filter((name) => name !== REMOTE_TOKEN && name !== TRANSCRIPTION_KEY),
      encryptionAvailable: secrets.available,
      error: settings.aiProvider === 'none' ? null : library.aiError,
    };
  };

  const prefsView = (): Prefs => ({
    theme: prefs.get('theme'), lan: prefs.get('lan'), shortcut: prefs.get('shortcut'), shortcutRegistered: ctx.shortcutRegistered(),
  });

  const syncStatus = (): SyncStatus => {
    const last = library.lastSync;
    return {
      folder: memory().settings.get('syncFolder'),
      encrypted: memory().sync.encrypted,
      running: library.syncRunning,
      needsPassphrase: last?.code === 'locked',
      last,
    };
  };

  const remoteStatus = (): RemoteStatus => ({
    url: prefs.get('remoteUrl'), hasToken: secrets.names().includes(REMOTE_TOKEN), running: library.remoteRunning, last: library.lastRemote,
  });

  const launch = () => mcpLaunch(ctx.launch);
  const transcriptionStatus = (): TranscriptionStatus => ({
    configured: Boolean(memory().settings.get('transcriptionBaseUrl') && memory().settings.get('transcriptionModel')),
    baseUrl: memory().settings.get('transcriptionBaseUrl'), model: memory().settings.get('transcriptionModel'),
    hasKey: secrets.names().includes(TRANSCRIPTION_KEY), encryptionAvailable: secrets.available,
  });

  const pick = async (options: Electron.OpenDialogOptions): Promise<string | null> => {
    const parent = ctx.parentWindow();
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  };

  const dialogOpen = async (options: Electron.OpenDialogOptions) => {
    const parent = ctx.parentWindow();
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? [] : picked.filePaths;
  };
  const dialogSave = async (options: Electron.SaveDialogOptions): Promise<string | null> => {
    const parent = ctx.parentWindow();
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return picked.canceled || !picked.filePath ? null : picked.filePath;
  };

  const sealedFiles = (itemId: string) =>
    memory().items.get(itemId).attachments.filter((a) => a.filename === SEALED_FILE_NAME && a.mimeType === SEALED_FILE_MIME);

  const vaultSession = () => {
    const current = memory();
    const vault = current.vault;
    const revision = vault.sessionRevision;
    return () => {
      if (memory() !== current || vault.sessionRevision !== revision) throw new MemoryError('locked', 'The vault or library changed. Open it again and retry.');
      return vault;
    };
  };

  // Names and types live inside the ciphertext, so listing them decrypts each file; the bytes are wiped straight away.
  const fileInfo = (itemId: string, attachment: { id: string; createdAt: string }): VaultFile => {
    const { filename, mimeType, data } = memory().vault.readFile(itemId, attachment.id);
    const size = data.byteLength;
    data.fill(0);
    return { id: attachment.id, filename, mimeType, size, createdAt: attachment.createdAt };
  };

  const secretItems = () => {
    const found: Item[] = [];
    let before: string | undefined;
    for (;;) {
      const page = memory().items.list({ secret: true, before }, 200);
      found.push(...page);
      if (page.length < 200) return found;
      before = pageCursor(page.at(-1)!);
    }
  };

  const IMPORT_DIALOGS: Record<ImportKind, Electron.OpenDialogOptions> = {
    bookmarks: { title: 'Choose a bookmarks file exported from your browser', properties: ['openFile'], filters: [{ name: 'Bookmarks', extensions: ['html', 'htm'] }] },
    markdown: { title: 'Choose a folder of Markdown notes', properties: ['openDirectory'] },
    csv: { title: 'Choose a CSV file', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] },
    enve: { title: 'Choose a Petty Memory export folder', properties: ['openDirectory'] },
  };

  return {
    'biscotti.previewCsv': (data) => previewBiscottiImport(memory(), data, 'csv'),
    'biscotti.query': (options) => {
      requireBiscottiMac();
      return biscotti.query(options);
    },
    'biscotti.previewMeeting': async (id) => {
      requireBiscottiMac();
      const meeting = await biscotti.meeting(id);
      return previewBiscottiImport(memory(), [meeting], 'mcp');
    },
    'biscotti.import': (request) => importBiscottiMeetings(memory(), request),
    'biscotti.list': (options) => listBiscottiMeetings(memory(), options),
    'biscotti.open': async (id, seconds) => {
      requireBiscottiMac();
      try { await shell.openExternal(biscottiLink(id, seconds)); }
      catch (error) {
        if (error instanceof DesktopError) throw error;
        throw new DesktopError('unavailable', 'Install and open Biscotti on this Mac to play the original meeting.');
      }
    },
    'knowledge.request': async (request) => {
      const result = await invokeKnowledgeRequest(memory(), request, {
        aiProvider: () => library.provider(), transcription: () => library.transcription(),
        afterWrite: () => library.afterWrite(),
      });
      return result;
    },
    'research.file': (sourceId) => {
      const item = memory().items.get(str(sourceId, 'Source'));
      if (item.metadata.secret === true || item.archivedAt) throw new DesktopError('invalid', 'Choose an active, ordinary research source.');
      const { attachment } = memory().files.primary(item.id);
      const { data } = memory().files.readAttachment(attachment.id, { maxBytes: 32 * 1024 * 1024 });
      if (attachment.mimeType !== 'application/pdf' && !attachment.mimeType.startsWith('audio/')) throw new DesktopError('invalid', 'Choose a PDF or audio source.');
      return { data, filename: attachment.filename, mimeType: attachment.mimeType, sha256: attachment.sha256 };
    },
    'research.saveAudio': (data, filename, mimeType) => {
      if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > 25 * 1024 * 1024) throw new DesktopError('invalid', 'Choose an audio recording up to 25 MB.');
      const type = str(mimeType, 'Audio type').split(';')[0]!.toLowerCase();
      if (!['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/webm'].includes(type)) throw new DesktopError('invalid', 'Choose MP3, M4A, WAV, Ogg, FLAC or WebM audio.');
      return memory().files.save({ data, filename: str(filename, 'Filename'), mimeType: type }).item;
    },
    'research.transcriptionStatus': transcriptionStatus,
    'research.configureTranscription': (input) => {
      if (!input || typeof input !== 'object') throw new DesktopError('invalid', 'Choose a transcription endpoint and model.');
      const baseUrl = str(input.baseUrl, 'Transcription URL').trim();
      const model = str(input.model, 'Transcription model').trim();
      if (baseUrl.length > 2000 || model.length > 200 || Boolean(baseUrl) !== Boolean(model)) throw new DesktopError('invalid', 'Provide both a transcription URL and model, or leave both blank to turn transcription off.');
      if (baseUrl) {
        let url: URL;
        try { url = new URL(baseUrl); } catch { throw new DesktopError('invalid', 'Use an http or https transcription URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DesktopError('invalid', 'Use an http or https transcription URL without embedded credentials, query or fragment.');
      }
      if (input.apiKey !== undefined) {
        const key = str(input.apiKey, 'Transcription key').trim();
        if (key.length > 4096) throw new DesktopError('invalid', 'The transcription key is too long.');
        if (key) secrets.set(TRANSCRIPTION_KEY, key); else secrets.delete(TRANSCRIPTION_KEY);
      }
      memory().settings.set('transcriptionBaseUrl', baseUrl);
      memory().settings.set('transcriptionModel', model);
      return transcriptionStatus();
    },
    'sources.approveFolder': async (watchId) => {
      const folder = await pick({ title: 'Approve a folder to watch for research files', properties: ['openDirectory'] });
      return folder ? memory().sources.approveFolder(str(watchId, 'Watched source'), folder) : null;
    },
    'app.info': (): AppInfo => {
      const m = memory();
      const stats = m.stats();
      return {
        version: ctx.version,
        home: m.paths!.home,
        database: m.paths!.database,
        platform: process.platform,
        isPackaged: ctx.isPackaged,
        schemaVersion: m.schemaVersion,
        deviceId: m.deviceId,
        stats,
        inboxCount: inbox().length,
        aiEnabled: m.settings.get('aiProvider') !== 'none',
        aiClientsSeen: m.clients.list().length > 0 || m.activity.recent({}, 200).some((c) => /^(mcp|api)(:|$)/.test(c.actor)),
      };
    },
    'app.openLibraryFolder': async () => {
      await shell.openPath(memory().paths!.home);
    },
    'app.openExternal': async (url) => {
      const parsed = new URL(str(url, 'URL'));
      if (!['http:', 'https:', 'mailto:', 'enve:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new DesktopError('invalid', 'Only web, mail and Enve links without embedded credentials open outside the app.');
      }
      await shell.openExternal(parsed.href);
    },
    'prefs.get': prefsView,
    'prefs.setTheme': (theme) => {
      if (!['system', 'dark', 'light'].includes(theme)) throw new DesktopError('invalid', `Unknown theme "${theme}".`);
      prefs.set('theme', theme);
      ctx.applyTheme(theme);
      return prefsView();
    },

    'items.list': (filter, limit) => memory().items.list(filter, limit),
    'items.page': (filter, cursor, limit) => {
      const items = memory().items.list({ ...filter, before: cursor ?? undefined }, limit);
      return { items, next: items.length === limit ? pageCursor(items[items.length - 1]!) : null };
    },
    'items.inbox': inbox,
    'items.get': (id) => memory().items.get(id),
    'items.saveNote': (input) => memory().items.saveNote(input),
    'items.saveLink': (input) => memory().items.saveLink(input),
    'items.update': (id, input) => memory().items.update(id, input),
    'items.tag': (id, change) => memory().items.tag(id, change),
    'items.archive': (id) => memory().items.archive(id),
    'items.unarchive': (id) => memory().items.unarchive(id),
    'items.delete': (id) => memory().items.delete(id),
    'items.acceptSuggestions': (id) => memory().items.acceptSuggestions(id),
    'items.enrich': (id) => enrichItem(memory(), requireProvider(), id),
    'items.retryIngest': (id) => ingestItem(memory(), id),
    'items.retryFailed': () => memory().items.retryFailedIngest(),
    'items.openFile': async (id) => {
      if (memory().items.get(id).metadata.secret === true) {
        throw new DesktopError('invalid', 'Encrypted files are saved from the Secret section after unlocking. They are never opened directly.');
      }
      const { attachment, data } = memory().files.read(id);
      // Opened from a temp copy under its real name, so the OS picks the right app and edits can't touch the stored blob.
      const dir = join(tmpdir(), 'enve-memory', id);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, attachment.filename);
      writeFileSync(target, data);
      const error = await shell.openPath(target);
      if (error) throw new DesktopError('open_failed', error);
      memory().items.markOpened(id);
    },
    'items.openUrl': async (id) => {
      const item = memory().items.get(id);
      if (!item.url || !/^https?:/i.test(item.url)) throw new DesktopError('invalid', 'This item has no web link to open.');
      await shell.openExternal(item.url);
      memory().items.markOpened(id);
    },
    'items.pin': (id, pinned) => memory().items.pin(id, Boolean(pinned)),
    'items.setReminder': (id, when) => memory().items.setReminder(id, when),
    'items.setIntent': (id, intent) => memory().items.setIntent(id, intent),
    'shelves.counts': () => {
      const items = memory().items;
      const count = (filter: ItemFilter) => items.list(filter, 200).length;
      const reminders = items.list({ reminders: true }, 200);
      const now = new Date().toISOString();
      return {
        ...(Object.fromEntries(SHELVES.map((shelf) => [shelf, count(shelfFilter(shelf))])) as Record<Shelf, number>),
        reminders: reminders.length,
        due: reminders.filter((item) => item.remindAt! <= now).length,
      };
    },
    'shelves.list': (shelf) => memory().items.list(shelfFilter(shelf), 200),
    'reminders.list': () => {
      const now = new Date().toISOString();
      const all = memory().items.list({ reminders: true }, 200);
      return { due: all.filter((item) => item.remindAt! <= now), upcoming: all.filter((item) => item.remindAt! > now) };
    },
    'files.save': (paths, project) => {
      if (!Array.isArray(paths) || paths.length === 0) throw new DesktopError('invalid', 'Drop at least one file.');
      return paths.map((path) => {
        const file = str(path, 'File path');
        if (!isAbsolute(file) || !statSync(file).isFile()) throw new DesktopError('invalid', `${file} is not a file. Folders can’t be saved yet.`);
        return memory().files.saveFromPath(file, { project }).item;
      });
    },

    'outline.children': (parentId, options) => memory().outline.children(parentId, options),
    'outline.get': (id) => memory().outline.get(id),
    'outline.ancestors': (id) => memory().outline.ancestors(id),
    'outline.move': (id, input) => memory().outline.move(id, input),
    'outline.createNote': (input) => memory().outline.createNote(input),

    'editor.apply': (commands, options) => {
      if (!Array.isArray(commands)) throw new DesktopError('invalid', 'Editor commands must be a list.');
      return memory().editor.apply(commands, options);
    },
    'editor.undo': (actionId) => memory().editor.undo(str(actionId, 'Action')),
    'editor.redo': (actionId) => memory().editor.redo(str(actionId, 'Action')),

    'presentation.get': (id) => memory().presentation.get(id),
    'presentation.update': (id, patch) => memory().presentation.update(id, patch),
    'presentation.toggle': (id, checked) => memory().presentation.toggle(id, Boolean(checked)),
    'presentation.reset': (id) => memory().presentation.reset(id),
    'presentation.progress': (id) => memory().presentation.progress(id),

    'versions.list': (itemId, options) => memory().versions.list(itemId, options),
    'versions.get': (versionId) => memory().versions.get(versionId),
    'versions.restore': (versionId) => memory().versions.restore(versionId),

    'references.insert': (fromId, toId, label) => memory().references.insert(fromId, toId, label),
    'references.list': (id) => memory().references.list(id),
    'items.relate': (fromId, toId, kind) => memory().items.relate(fromId, toId, kind),
    'items.unrelate': (fromId, toId, kind) => memory().items.unrelate(fromId, toId, kind),

    'edits.propose': (rootId, instruction) =>
      proposeEdit(memory(), requireProvider(), { rootId: str(rootId, 'Item'), instruction: str(instruction, 'Instruction') }),
    'edits.apply': (proposal) => memory().edits.apply(proposal),
    'edits.undo': (receipt) => memory().edits.undo(receipt),
    'organizer.apply': (proposal, includeIds) => memory().organizer.apply(proposal, includeIds),
    'organizer.undo': (receipt) => memory().organizer.undo(receipt),
    'actions.apply': (proposal, includeIds) => memory().actions.apply(proposal, includeIds),
    'actions.undo': (receipt) => memory().actions.undo(receipt),

    'chats.list': (options) => memory().chats.list(options ?? {}),
    'chats.get': (id) => memory().chats.get(str(id, 'Conversation')),
    'chats.save': (input) => memory().chats.save(input),
    'chats.archive': (id) => memory().chats.archive(str(id, 'Conversation')),

    'review.queue': (options) => memory().review.queue(options ?? {}),
    'review.schedule': (id, days) => memory().review.schedule(str(id, 'Item'), days),

    'insights.forItem': (id) => memory().insights.forItem(str(id, 'Item')),
    'insights.previewMerge': (sourceId, targetId) => memory().insights.previewMerge(str(sourceId, 'Note'), str(targetId, 'Note')),
    'insights.merge': (proposal) => memory().insights.merge(proposal),

    'ocr.extract': (attachmentId) => extractImageText(memory(), str(attachmentId, 'Attachment')),

    'vault.state': () => memory().vault.state(),
    'vault.setup': (passphrase) => memory().vault.setup(str(passphrase, 'Passphrase')),
    'vault.unlock': (passphrase) => memory().vault.unlock(str(passphrase, 'Passphrase')),
    'vault.lock': () => memory().vault.lock(),
    'vault.create': (input) => memory().vault.create(input),
    'vault.read': (id) => memory().vault.read(id),
    'vault.update': (id, input) => memory().vault.update(id, input),
    'vault.outline': () => {
      const m = memory();
      if (!m.vault.state().unlocked) throw new MemoryError('locked', 'Unlock the vault first.');
      return secretItems().map((item) => {
        const entry = m.outline.get(item.id);
        return { id: item.id, parentId: entry.parentId, title: m.vault.read(item.id).title, childCount: entry.childCount, updatedAt: item.updatedAt };
      });
    },
    'vault.files': (itemId) => sealedFiles(str(itemId, 'Item')).map((attachment) => fileInfo(itemId, attachment)),
    'vault.attachFiles': async (itemId) => {
      const id = str(itemId, 'Item');
      const session = vaultSession();
      if (memory().items.get(id).metadata.secret !== true) throw new DesktopError('invalid', 'Only secret notes hold encrypted files.');
      const paths = await dialogOpen({ title: 'Choose files to encrypt into this secret note', properties: ['openFile', 'multiSelections'] });
      if (!paths.length) return null;
      session();
      let attached = 0;
      const failed: { filename: string; message: string }[] = [];
      for (const path of paths) {
        const filename = basename(path);
        try {
          const size = statSync(path).size;
          if (size > MAX_SEALED_FILE_BYTES) throw new DesktopError('invalid', `It is ${formatMiB(size)}; encrypted files can be at most 20 MiB.`);
          const data = readFileSync(path);
          try {
            session().attachFile(id, { data, filename });
            attached++;
          } finally {
            data.fill(0);
          }
        } catch (error) {
          failed.push({ filename, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { attached, failed };
    },
    'vault.saveFile': async (itemId, attachmentId) => {
      const session = vaultSession();
      const { filename, data } = session().readFile(str(itemId, 'Item'), str(attachmentId, 'Attachment'));
      try {
        const target = await dialogSave({ title: 'Save a decrypted copy', defaultPath: filename });
        if (!target) return null;
        session();
        writeFileSync(target, data);
        return { filename: basename(target) };
      } finally {
        data.fill(0);
      }
    },
    'vault.removeFile': (itemId, attachmentId) => memory().vault.removeFile(str(itemId, 'Item'), str(attachmentId, 'Attachment')),
    'vault.recoveryKit': async () => {
      const session = vaultSession();
      const { kit, code } = session().recoveryKit();
      const target = await dialogSave({
        title: 'Save the vault recovery kit', defaultPath: 'Petty Memory recovery kit.json', filters: [{ name: 'Recovery kit', extensions: ['json'] }],
      });
      if (!target) return null;
      session();
      // Locked while the dialog was open: nothing is written and no code is shown after the fact.
      if (!memory().vault.state().unlocked) throw new MemoryError('locked', 'The vault was locked before the kit was saved. Unlock it and create a new kit.');
      writeFileSync(target, `${JSON.stringify(kit, null, 2)}\n`);
      return { code };
    },
    'vault.recover': async (code) => {
      const session = vaultSession();
      const text = str(code, 'Recovery code');
      const [path] = await dialogOpen({ title: 'Choose the vault recovery kit', properties: ['openFile'], filters: [{ name: 'Recovery kit', extensions: ['json'] }] });
      if (!path) return null;
      session();
      if (statSync(path).size > MAX_KIT_BYTES) throw new DesktopError('invalid', 'That file is too large to be a Petty Memory recovery kit.');
      let kit: unknown;
      try {
        kit = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        throw new DesktopError('invalid', 'That file isn’t a Petty Memory recovery kit.');
      }
      return session().recover(kit, text);
    },
    'vault.restoreVersion': (versionId) => memory().vault.restoreVersion(str(versionId, 'Version')),

    'views.list': () => memory().views.list(),
    'views.get': (id) => memory().views.get(str(id, 'View')),
    'views.results': (id, options) => memory().views.results(str(id, 'View'), options),
    'views.create': (input) => memory().views.create(input),
    'views.update': (id, input) => memory().views.update(str(id, 'View'), input),
    'views.remove': (id) => memory().views.remove(str(id, 'View')),

    'templates.list': () => memory().templates.list(),
    'templates.create': (sourceId, name) => memory().templates.create(str(sourceId, 'Note'), name),
    'templates.instantiate': (id, input) => memory().templates.instantiate(str(id, 'Template'), input),

    'shares.list': () => memory().shares.list(),
    'shares.create': (rootId, options) => {
      const { share, token } = memory().shares.create(rootId, options);
      const { url, lanUrls: network } = library.apiStatus;
      const page = library.servesWeb;
      const path = page ? `/s/${encodeURIComponent(token)}` : `/api/v1/public/${encodeURIComponent(token)}`;
      const links = [
        ...(url ? [{ url: `${url}${path}`, label: 'On this computer' }] : []),
        ...network.map((base) => ({ url: `${base}${path}`, label: 'On your network' })),
      ];
      return { share, token, links, page };
    },
    'shares.revoke': (shareId) => memory().shares.revoke(shareId),

    'remoteSync.get': remoteStatus,
    'remoteSync.configure': async ({ url, token }) => {
      const address = remoteUrl(str(url, 'Server address'));
      const secret = token === undefined ? undefined : str(token, 'Token').trim();
      if (secret === '' || (secret === undefined && !secrets.names().includes(REMOTE_TOKEN))) {
        throw new DesktopError('invalid', 'Paste a sync token created on the server with `petty-memory clients add "<this computer>" --scope sync`.');
      }
      if (secret) secrets.set(REMOTE_TOKEN, secret);
      prefs.set('remoteUrl', address);
      await library.remoteSync();
      return remoteStatus();
    },
    'remoteSync.run': async () => {
      if (!prefs.get('remoteUrl')) throw new DesktopError('invalid', 'Connect to a server first.');
      await library.remoteSync();
      return remoteStatus();
    },
    'remoteSync.disconnect': () => {
      secrets.delete(REMOTE_TOKEN);
      prefs.set('remoteUrl', null);
      library.forgetRemote();
      return remoteStatus();
    },

    'projects.list': (status) => {
      const m = memory();
      return m.projects.list(status).map((project) => ({ ...project, openTasks: m.tasks.list({ project: project.id }, 200).length }));
    },
    'projects.create': (input) => memory().projects.create(input),
    'projects.update': (ref, input) => memory().projects.update(ref, input),
    'projects.setMemory': (ref, text) => memory().projects.setMemory(ref, str(text, 'Memory')),
    'projects.briefing': (ref) => memory().briefing(ref),
    'projects.memoryHistory': (ref, options) => memory().projects.memoryHistory(ref, options),
    'decisions.record': (input) => memory().decisions.record(input),

    'tasks.list': (query, limit) => memory().tasks.list(query, limit),
    'tasks.create': (input) => memory().tasks.create(input),
    'tasks.update': (id, input) => memory().tasks.update(id, input),

    'search.hybrid': (text, filter, limit) => memory().search.hybrid(str(text, 'Search'), filter, limit),
    'activity.recent': (query, limit) => memory().activity.recent(query, limit),
    'graph.get': (project) => memory().graph(project ? { project } : {}),

    'settings.get': () => memory().settings.all(),
    'settings.set': (key, value) => {
      if (key !== 'fetchLinks' && key !== 'semanticSearch') throw new DesktopError('invalid', `"${key}" can’t be changed here.`);
      if (typeof value !== 'boolean') throw new DesktopError('invalid', `${key} is on or off.`);
      memory().settings.set(key, value);
      if (key === 'semanticSearch') library.attachEmbedder();
      return memory().settings.all();
    },
    'index.status': () => {
      const model = library.embedderModel;
      const supported = localEmbeddingsSupported();
      const enabled = supported && memory().settings.get('semanticSearch');
      if (!model) return { supported, enabled, model: null, indexed: 0, pending: 0, chunks: 0 };
      return { supported, enabled, model, ...memory().embeddings.status(model) };
    },

    'ai.status': aiStatus,
    'ai.configure': ({ provider, model, baseUrl }) => {
      const id = providerId(provider);
      const settings = memory().settings;
      settings.set('aiProvider', id);
      if (id === 'none') {
        settings.set('aiEnrich', false);
      } else {
        settings.set('aiModel', str(model, 'Model').trim() || PROVIDERS[id].defaultModel || '');
        settings.set('aiBaseUrl', str(baseUrl, 'Base URL').trim());
      }
      return aiStatus();
    },
    'ai.setKey': (provider, key) => {
      const id = providerId(provider);
      if (key === null || key.trim() === '') secrets.delete(id);
      else secrets.set(id, key.trim());
      return aiStatus();
    },
    'ai.models': async (config) => (await adHocProvider(config).listModels()).sort(),
    'ai.test': async (config) => {
      const reply = await adHocProvider(config).complete({
        system: 'You are a connectivity check. Reply with the single word OK.',
        prompt: 'Reply with OK.',
        maxTokens: 256,
      });
      return reply.trim().slice(0, 200) || '(empty reply)';
    },
    'ai.setEnrich': (on) => {
      const settings = memory().settings;
      if (on) {
        requireProvider();
        settings.set('aiEnrichSince', new Date().toISOString());
      }
      settings.set('aiEnrich', Boolean(on));
      return aiStatus();
    },
    'ai.setAutoApply': (on) => {
      memory().settings.set('aiAutoApply', Boolean(on));
      return aiStatus();
    },
    'ai.ask': (question, project) => ask(memory(), requireProvider(), str(question, 'Question'), project ? { project } : {}),
    'ai.chat': (request) => chat(memory(), requireProvider(), request),

    'clients.list': () => memory().clients.list(),
    'clients.create': (name, scopes) => memory().clients.create(name, scopes),
    'clients.pair': async (name, options) => {
      const { client, token } = memory().clients.create(name, options?.secrets === true ? ['read', 'write', 'secrets'] : ['read', 'write']);
      const links = await Promise.all(
        lanUrls(library.apiStatus.port).map(async (url) => {
          const link = pairingLink(url, token, client.name);
          return { url, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' }) };
        }),
      );
      return { client, token, links };
    },
    'clients.revoke': (id) => memory().clients.revoke(id),
    'api.status': () => library.apiStatus,
    'api.setLan': async (lan) => {
      prefs.set('lan', Boolean(lan));
      return library.setLan(Boolean(lan));
    },
    'mcp.setup': () => ({
      ...setupSnippets(launch(), library.apiStatus.url ?? `http://127.0.0.1:${library.apiStatus.port}`),
      claudeAvailable: findExecutable('claude') !== null,
    }),
    'mcp.addToClaudeCode': () => {
      const claude = findExecutable('claude');
      if (!claude) throw new DesktopError('not_found', 'The `claude` command isn’t installed. Copy the command instead.');
      return new Promise((resolve) => {
        execFile(claude, claudeAddArgs(launch()), { timeout: 30_000 }, (error, stdout, stderr) => {
          resolve({ ok: !error, output: [stdout, stderr, error && !stderr ? error.message : ''].filter(Boolean).join('\n').trim() });
        });
      });
    },

    'backups.list': () => memory().backups.list(),
    'backups.create': () => memory().backups.create('manual'),
    'backups.restore': (file) => library.restore(str(file, 'Snapshot')),
    'exports.run': async () => {
      const folder = await pick({ title: 'Choose where to export', properties: ['openDirectory', 'createDirectory'] });
      if (!folder) return null;
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
      const summary = memory().exports.write(join(folder, `Petty Memory Export ${stamp}`));
      shell.showItemInFolder(summary.path);
      return summary;
    },

    'rules.list': () => memory().rules.list(),
    'rules.create': (input) => memory().rules.create(input),
    'rules.setEnabled': (id, enabled) => memory().rules.setEnabled(id, Boolean(enabled)),
    'rules.delete': (id) => memory().rules.delete(id),
    'imports.run': async (kind, project) => {
      if (!IMPORT_KINDS.includes(kind)) throw new DesktopError('invalid', `Unknown import "${kind}".`);
      const source = await pick(IMPORT_DIALOGS[kind]);
      if (!source) return null;
      const m = memory();
      switch (kind) {
        case 'bookmarks':
          return importBookmarks(m, readFileSync(source, 'utf8'), { project });
        case 'markdown':
          return importMarkdownFolder(m, source, { project });
        case 'csv':
          return importCsv(m, readFileSync(source, 'utf8'), { project });
        case 'enve':
          return importEnveExport(m, source);
      }
    },
    'highlights.preview': (data) => previewEnveHighlights(highlightText(data)),
    'highlights.import': (data, options) =>
      importEnveHighlights(memory(), highlightText(data), options?.project ? { project: str(options.project, 'Project') } : {}),

    'sync.status': syncStatus,
    'sync.pickFolder': () => pick({ title: 'Choose a folder your computers already sync', properties: ['openDirectory', 'createDirectory'] }),
    'sync.start': async (folder, passphrase) => {
      const dir = str(folder, 'Folder');
      if (!isAbsolute(dir)) throw new DesktopError('invalid', 'Choose a folder.');
      const m = memory();
      if (passphrase) m.sync.setPassphrase(passphrase, dir);
      else m.sync.forgetKey();
      m.settings.set('syncFolder', dir);
      await library.sync();
      return syncStatus();
    },
    'sync.unlock': async (passphrase) => {
      memory().sync.setPassphrase(str(passphrase, 'Passphrase'));
      await library.sync();
      return syncStatus();
    },
    'sync.now': async () => {
      if (!memory().settings.get('syncFolder')) throw new MemoryError('invalid', 'Choose a sync folder first.');
      await library.sync();
      return syncStatus();
    },
    'sync.stop': () => {
      const m = memory();
      m.sync.forgetKey();
      m.settings.set('syncFolder', '');
      library.lastSync = null;
      return syncStatus();
    },

    'capture.open': () => ctx.openCapture(),
    'capture.close': () => ctx.closeCapture(),
  };
}

