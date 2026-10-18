#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { EnveMemory, MemoryError, type EditProposal, type EditorCommand, type ItemPresentation, type RuleConditions, type SavedViewInput, type Settings, defaultHome, listBackups, pathsFor, restoreBackup } from '@enve-memory/core';
import { AiError, type AiProvider, PROVIDERS, PROVIDER_IDS, ask, chat, createProvider, enrichItem, enrichWorker, envKeys, isProviderId, organizeWorker, proposeEdit, providerFor } from '@enve-memory/ai';
import { attachLocalEmbedder, indexWorker } from '@enve-memory/embeddings';
import { importBookmarks, importCsv, importEnveExport, importMarkdownFolder, importEnveHighlights, previewEnveHighlights } from '@enve-memory/importers';
import { extractImageText, ingestItem, processPending } from '@enve-memory/ingestion';
import { DEFAULT_PORT, RemoteSyncClient, createApiServer, lanUrls, pairingLink } from '@enve-memory/api';
import { SERVER_NAME, serveMemoryOverStdio } from '@enve-memory/mcp';
import pkg from '../package.json' with { type: 'json' };
import * as format from './format.ts';

const USAGE = `petty-memory ${pkg.version} — local memory for you and your AI tools

Usage: petty-memory <command> [options]

Capture
  note <text…>                 Save a note           [--title] [-p project] [-t tag]…
  link <url>                   Save and archive a link  [--title] [--note] [-p project] [-t tag]… [--no-fetch]
  file <path>…                 Save files (PDFs and text become searchable)  [--title] [--note] [-p project] [-t tag]…
  task add <title…>            Add a task            [-p project] [--due] [--priority high|normal|low] [--notes] [-t tag]…

Find
  search <query…>              Full-text search      [-p project] [--type] [-t tag] [--limit] [--all]
  list                         Recent items          [-p project] [--type] [-t tag] [--limit] [--all]
                               shelves: [--pinned] [--intent read|watch|buy|revisit] [--unopened days] [--reminders]
  reminders                    Upcoming reminders, soonest first
  show <id>                    One item in full      [--content] prints the archived text
  open <id>                    Open a link in the browser or a file in its app
  task list                    Tasks                 [-p project] [--status active|open|in_progress|done|cancelled|all]
  activity                     Recent changes        [-p project] [--limit]

Projects
  project new <name>           Create                [--description] [--instructions]
  project list                 List                  [--status active|paused|done|archived]
  project show <project>       Briefing: memory, decisions, open tasks, recent items
  project edit <project>       Change                [--name] [--description] [--instructions] [--status]
  project memory <project>     Print the memory document; --set FILE replaces it (- reads stdin)
  project history <project>    Page through saved memory documents  [--limit] [--offset]
  decide <project> <text…>     Record a decision     [--reason] [--supersedes id]…

Organize
  conversations               List explicitly saved AI chats
  conversations show <id>     Read a saved chat
  conversations save <file>   Save a chat JSON definition (- reads stdin)
  conversations archive <id> --yes  Archive a saved chat
  review                      Due knowledge cards  [-p project] [--limit]
  review schedule <id> --days 1|7|30  Choose when to see an item again
  insights <id>               Suggested mentions, connections and duplicates (use --json)
  views                        List saved searches
  views create <name…>         Save a dynamic view  [--query] [-p project] [--type] [-t tag] [--status] [--inbox]
                               [--pinned] [--intent] [--review] [--attention] [--reminders] [--unopened days]
  views edit <id> --set FILE    Replace name/query/filter with a JSON definition (- reads stdin)
  views show <id>              Show the saved definition
  views run <id>               Matching items, newest changed first  [--limit] [--before cursor]
  views remove <id> --yes      Archive a saved definition, preserving its results
  templates                    List reusable note/checklist trees
  templates create <source-id> Copy an ordinary note tree  [--name]
  templates use <id>           Create a fresh copy  [--title] [-p project] [--date YYYY-MM-DD]
  outline [parent-id]          Ordered roots or direct children  [--limit] [--offset] [--all]
  outline show <id>            Placement and ancestor path
  outline add <title…>         New root or child note  [--parent id] [--body] [-p project] [-t tag]…
  outline move <id>            Move with descendants  --parent id | --root [--before sibling-id]
  presentation <id>            Show formatting; --set FILE applies a JSON presentation patch (- reads stdin)
  check <id> / uncheck <id>    Complete an entry or checklist subtree
  checklist <id> [reset]       Progress, or reset all descendants
  history <item-id>            List item/subtree versions  [--limit] [--offset]
  history show <version-id>    Read a snapshot
  history restore <version-id> Restore as a new change
  editor apply <file.json>     Apply a reversible command batch (- reads stdin)
  editor split <id> <title|body> <offset>  Split a note at a UTF-16 offset
  editor merge <id> <previous-id>         Merge adjacent notes, preserving history
  editor undo|redo <action-id>            Undo or redo a journalled edit
  references <id>              Inline references and backlinks
  reference <from> <to>        Insert a reference  [--title label]
  edit <id>                    Change an item        [--title] [--body] [--url] [-p project | --no-project]
  task edit <id>               Change a task         [--title] [--notes] [--status] [--due] [--priority] [-p project]
  task done <id>               Complete a task
  tag <id>                     Retag                 [--add tag]… [--remove tag]…
  pin <id> / unpin <id>        Keep an item on the pinned shelf
  remind <id> <when…>          "tonight", "tomorrow", "friday", "in 3 days", 2026-10-01…; "remind <id> off" clears
  intent <id> <intent>         read | watch | buy | revisit | none
  relate <from> <kind> <to>    Link two items        kind: related_to|references|derived_from|depends_on
  unrelate <from> <kind> <to>  Remove a reversible connection
  archive <id> / unarchive <id>
  delete <id> --yes            Permanently delete

AI clients and devices
  mcp                          Run the MCP server on stdio
  connect                      Print setup for Claude Code, Codex and other MCP clients
  serve                        Run the browser app, local HTTP API + MCP-over-HTTP  [--port 49231] [--lan]
                               [--origin URL] [--max-upload-mb 200] [--max-json-kb 2048] [--max-sync-mb 32] [--max-writes 8]
  clients add <name>           Create an API token   --scope read|capture|write|secrets|sync (repeat or comma-separate)
  clients pair <device>        Create a read+write phone token and pairing link  [--port] [--scope secrets]
  clients list                 List API clients
  clients revoke <id>          Revoke a token immediately

AI (optional; bring your own provider)
  ai                           Show the AI provider and enrichment status
  ai use <provider>            ollama | openai | anthropic | gemini | openrouter | openai-compatible  [--model] [--base-url]
                               Keys come from OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY
  ai models                    List the provider's models
  ai off                       Turn AI off
  ai enrich on|off             Summarize and suggest tags/projects for items saved from now on
  ai auto-apply on|off         Apply suggested tags and projects automatically instead of waiting for accept
  enrich <id>                  Summarize one item and suggest tags and a project now
  accept <id>                  Apply an item's suggested tags and project
  ask <question…>              Answer from your library with numbered citations  [-p project]
  ai edit <root-id> <request…> Preview a proposed subtree edit as JSON; no changes applied
  ai apply <proposal.json>    Apply a reviewed proposal (- reads stdin); stale proposals are rejected
  ai undo <receipt.json>      Undo an applied proposal using its saved undo receipt (- reads stdin)
  ai actions <root-id> <request…>  Preview tasks, tags, reminders or a brief; no writes
  ai actions-apply <file>     Apply reviewed actions  [--exclude operation-id]…
  ai actions-undo <file>      Undo an action receipt, refusing newer work
  ai organize <request…>     Preview topic organization with optional semantic suggestions

Bring things in
  import bookmarks <file.html> Browser bookmark export; folders become tags  [-p project] [--archive fetches every page]
  import markdown <folder>     A folder of Markdown notes or an Obsidian vault  [-p project]
  import csv <file.csv>        Bookmark CSV (Raindrop, Pinboard, spreadsheets)  [-p project]
  import enve <export-folder>  Restore a Petty Memory export, keeping ids and dates
  import highlights <file>     Enve Book Player JSON/Markdown annotations  [-p project] [--preview]
  ocr <attachment-id>          Extract English text locally; does not save a note

Automations
  rules                        List rules
  rules add <name>             When a saved item matches, tag it and/or file it
                               conditions: [--type t] [--domain d]… [--keyword k]… [--from mcp:|api:…]
                               actions:    [-t tag]… [-p project]
  rules on|off|delete <id>
  graph                        Items, projects and tags as nodes and edges (use --json)

Your data
  export <folder>              Write everything as Markdown + JSON (plus original files)
  backup                       Take a snapshot now
  backups                      List snapshots (taken automatically while the app or \`serve\` runs)
  sync [folder]                Sync through a shared folder (iCloud Drive, Dropbox, Syncthing…); a folder argument sets it
                               --passphrase - reads a passphrase from stdin and encrypts everything in the folder
  sync off                     Stop syncing
  sync remote <server-url>    Exchange changes and files; token from PETTY_MEMORY_SYNC_TOKEN
  shares                       List public links
  shares create <root-id>      Create a live read-only link  [--exclude id]… [--expires ISO-time]
  shares revoke <share-id>     Revoke a public link
  restore <file|latest> --yes  Replace the library with a snapshot; the current state is snapshotted first.
                               Quit the desktop app, \`serve\` and AI clients first.

Other
  ingest                       Fetch and extract anything still pending  [--retry] also retries failures
  index                        Build the semantic search index (downloads a ~23 MB model once)
  settings [key] [value]       Show or change settings (fetchLinks, semanticSearch: true|false)
  info                         Library location and stats

Global options: --home DIR (default $ENVE_MEMORY_HOME or the platform data folder), --json, -h, -v`;

class UsageError extends Error {}

const { values: opts, positionals } = parseCommandLine({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    project: { type: 'string', short: 'p' },
    'no-project': { type: 'boolean' },
    tag: { type: 'string', short: 't', multiple: true },
    add: { type: 'string', multiple: true },
    remove: { type: 'string', multiple: true },
    title: { type: 'string' },
    body: { type: 'string' },
    url: { type: 'string' },
    note: { type: 'string' },
    notes: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    instructions: { type: 'string' },
    status: { type: 'string' },
    type: { type: 'string' },
    due: { type: 'string' },
    priority: { type: 'string' },
    reason: { type: 'string' },
    supersedes: { type: 'string', multiple: true },
    set: { type: 'string' },
    scope: { type: 'string', multiple: true },
    port: { type: 'string' },
    lan: { type: 'boolean' },
    origin: { type: 'string' },
    'max-upload-mb': { type: 'string' },
    'max-json-kb': { type: 'string' },
    'max-sync-mb': { type: 'string' },
    'max-writes': { type: 'string' },
    'no-fetch': { type: 'boolean' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    content: { type: 'boolean' },
    retry: { type: 'boolean' },
    passphrase: { type: 'string' },
    archive: { type: 'boolean' },
    domain: { type: 'string', multiple: true },
    keyword: { type: 'string', multiple: true },
    from: { type: 'string' },
    limit: { type: 'string' },
    offset: { type: 'string' },
    parent: { type: 'string' },
    root: { type: 'boolean' },
    before: { type: 'string' },
    all: { type: 'boolean' },
    pinned: { type: 'boolean' },
    intent: { type: 'string' },
    unopened: { type: 'string' },
    reminders: { type: 'boolean' },
    review: { type: 'boolean' },
    attention: { type: 'string' },
    query: { type: 'string' },
    inbox: { type: 'boolean' },
    date: { type: 'string' },
    days: { type: 'string' },
    preview: { type: 'boolean' },
    exclude: { type: 'string', multiple: true },
    expires: { type: 'string' },
    yes: { type: 'boolean' },
  },
});

function parseCommandLine<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    console.error(`${(error as Error).message}\nRun \`petty-memory --help\` for usage.`);
    process.exit(2);
  }
}

const [command, ...rest] = positionals;

function arg(index: number, name: string): string {
  const value = rest[index];
  if (value === undefined) throw new UsageError(`Missing <${name}>.`);
  return value;
}

const text = (from: number, name: string) => {
  const joined = rest.slice(from).join(' ');
  if (!joined) throw new UsageError(`Missing <${name}>.`);
  return joined;
};

const limit = () => (opts.limit === undefined ? undefined : Number(opts.limit));

const filter = () => ({
  project: opts.project, type: opts.type, tag: opts.tag?.[0], includeArchived: opts.all,
  pinned: opts.pinned, intent: opts.intent, reminders: opts.reminders,
  review: opts.review, attention: opts.attention,
  unopenedDays: opts.unopened === undefined ? undefined : Number(opts.unopened),
});

function emit(data: unknown, human: string): void {
  console.log(opts.json ? JSON.stringify(data, null, 2) : human);
}

function recoveryMessage(result: { restored: number; missingFiles?: { filename: string }[] }): string {
  const missing = result.missingFiles;
  return `Restored ${result.restored} items as a new change.${missing?.length ? ` File contents unavailable: ${missing.map((file) => file.filename).join(', ')}. Keep a backup with the original files.` : ''}`;
}

async function run(memory: EnveMemory): Promise<void> {
  switch (command) {
    case 'conversations': {
      const action = rest[0] ?? 'list';
      if (action === 'list') {
        const items = memory.chats.list();
        return emit(items, items.map((item) => `${item.title}\n    ${item.id}`).join('\n') || 'No saved conversations. Save explicitly from AI chat.');
      }
      if (action === 'show') {
        const item = memory.chats.get(arg(1, 'id'));
        return emit(item, item.messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'));
      }
      if (action === 'save') {
        const file = arg(1, 'file');
        const input = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8'));
        const item = memory.chats.save(input);
        return emit(item, `Saved ${item.title}\n    ${item.id}`);
      }
      if (action === 'archive') {
        if (!opts.yes) throw new UsageError('Use --yes to archive this saved conversation.');
        const item = memory.chats.archive(arg(1, 'id'));
        return emit(item, 'Archived the saved conversation. Its history remains available.');
      }
      throw new UsageError('Usage: conversations [list|show|save|archive]');
    }
    case 'review': {
      if (rest[0] === 'schedule') {
        const item = memory.review.schedule(arg(1, 'id'), Number(opts.days));
        return emit(item, `Scheduled ${item.title} for review in ${opts.days} days.`);
      }
      if (rest.length) throw new UsageError('Usage: review [-p project] [--limit] | review schedule <id> --days N');
      const cards = memory.review.queue({ limit: limit(), project: opts.project });
      return emit(cards, cards.map((card) => `${format.itemLine(card.item)}\n    ${card.reason}`).join('\n') || 'Nothing due for review.');
    }
    case 'insights': {
      const result = memory.insights.forItem(arg(0, 'id'));
      return emit(result, ['mentions', 'related', 'duplicates'].map((kind) => {
        const entries = result[kind as 'mentions' | 'related' | 'duplicates'];
        return `${kind}:\n${entries.map((entry) => `  ${entry.title} (${entry.id}) — ${entry.reason}`).join('\n') || '  None.'}`;
      }).join('\n\n'));
    }
    case 'ocr': {
      const result = await extractImageText(memory, arg(0, 'attachment-id'));
      return emit(result, result.text);
    }
    case 'views': {
      const action = rest[0] ?? 'list';
      if (action === 'list') {
        const views = memory.views.list();
        return emit(views, views.map((view) => `${view.name}\n    ${view.id}`).join('\n') || 'No saved views.');
      }
      if (action === 'create' || action === 'edit') {
        let input: SavedViewInput;
        if (action === 'edit') {
          if (!opts.set) throw new UsageError('Use --set FILE to replace a saved view definition.');
          input = JSON.parse(readFileSync(opts.set === '-' ? 0 : resolve(opts.set), 'utf8')) as SavedViewInput;
        } else {
          input = { name: text(1, 'name'), query: opts.query, filter: {
            project: opts.project, type: opts.type, tag: opts.tag?.[0], taskStatus: opts.status, inbox: opts.inbox,
            pinned: opts.pinned, intent: opts.intent, review: opts.review, attention: opts.attention,
            reminders: opts.reminders, unopenedDays: opts.unopened === undefined ? undefined : Number(opts.unopened),
          } };
        }
        const view = action === 'create' ? memory.views.create(input) : memory.views.update(arg(1, 'id'), input);
        return emit(view, `Saved view ${view.name}\n    ${view.id}`);
      }
      if (action === 'show') {
        const view = memory.views.get(arg(1, 'id'));
        return emit(view, JSON.stringify(view, null, 2));
      }
      if (action === 'run') {
        const page = memory.views.results(arg(1, 'id'), { before: opts.before, limit: limit() });
        return emit(page, [page.items.map(format.itemLine).join('\n') || 'No matching items.', page.next ? `Next page: --before ${page.next}` : ''].filter(Boolean).join('\n'));
      }
      if (action === 'remove') {
        if (!opts.yes) throw new UsageError('Use --yes to archive this saved view.');
        const id = arg(1, 'id');
        memory.views.remove(id);
        return emit({ ok: true }, `Archived saved view ${id}.`);
      }
      throw new UsageError('Use views list, create, edit, show, run or remove.');
    }
    case 'templates': {
      const action = rest[0] ?? 'list';
      if (action === 'list') {
        const templates = memory.templates.list();
        return emit(templates, templates.map(format.itemLine).join('\n') || 'No templates. Save an ordinary note tree with templates create <source-id>.');
      }
      if (action === 'create') {
        const template = memory.templates.create(arg(1, 'source-id'), opts.name);
        return emit(template, `Saved template ${template.id}`);
      }
      if (action === 'use') {
        const item = memory.templates.instantiate(arg(1, 'id'), { title: opts.title, project: opts.project, date: opts.date });
        return emit(item, `Created note tree ${item.id}`);
      }
      throw new UsageError('Use templates list, create or use. Edit a template with the ordinary edit command.');
    }
    case 'note': {
      const item = memory.items.saveNote({ body: text(0, 'text'), title: opts.title, project: opts.project, tags: opts.tag });
      return emit(item, `Saved note ${item.id}`);
    }
    case 'link': {
      const saved = memory.items.saveLink({
        url: arg(0, 'url'), title: opts.title, note: opts.note, project: opts.project, tags: opts.tag,
        ...(opts['no-fetch'] ? { ingest: false } : {}),
      });
      const item = saved.item.metadata.ingest?.status === 'pending' ? await ingestItem(memory, saved.item.id) : saved.item;
      return emit({ item, created: saved.created }, `${saved.created ? 'Saved' : 'Already saved'}: ${format.savedLine(item)}`);
    }
    case 'file': {
      if (rest.length === 0) throw new UsageError('Missing <path>.');
      const results = [];
      for (const path of rest) {
        const saved = memory.files.saveFromPath(path, { title: rest.length === 1 ? opts.title : undefined, note: opts.note, project: opts.project, tags: opts.tag });
        const item = saved.item.metadata.ingest?.status === 'pending' ? await ingestItem(memory, saved.item.id) : saved.item;
        results.push({ item, created: saved.created });
      }
      return emit(results, results.map((r) => `${r.created ? 'Saved' : 'Already saved'}: ${format.savedLine(r.item)}`).join('\n'));
    }
    case 'open': {
      const item = memory.items.get(arg(0, 'id'));
      let target = item.url;
      if (item.attachments.length > 0) {
        const { attachment, path } = memory.files.primary(item.id);
        const dir = join(tmpdir(), 'petty-memory', item.id);
        mkdirSync(dir, { recursive: true });
        target = join(dir, attachment.filename);
        copyFileSync(path, target);
      }
      if (!target) throw new UsageError('That item has no link or file to open.');
      openExternal(target);
      memory.items.markOpened(item.id);
      return emit({ opened: target }, `Opened ${target}`);
    }
    case 'index': {
      const embedder = attachLocalEmbedder(memory);
      if (!embedder) throw new UsageError('Semantic search is off. Turn it on with `petty-memory settings semanticSearch true`.');
      let total = 0;
      const { pending } = memory.embeddings.status(embedder.model);
      if (pending && !opts.json) process.stderr.write(`Indexing ${pending} item${pending === 1 ? '' : 's'} with ${embedder.model}…\n`);
      for (let batch = await memory.embeddings.indexPending(embedder, 25); batch > 0; batch = await memory.embeddings.indexPending(embedder, 25)) {
        total += batch;
        if (!opts.json) process.stderr.write(`  ${total}/${pending}\r`);
      }
      if (total && !opts.json) process.stderr.write('\n');
      const status = memory.embeddings.status(embedder.model);
      return emit({ added: total, ...status }, `${total ? `Indexed ${total}. ` : ''}${status.indexed} items, ${status.chunks} passages in the semantic index.`);
    }
    case 'ingest': {
      const retried = opts.retry ? memory.items.retryFailedIngest() : 0;
      const processed = await processPending(memory, { limit: 200 });
      return emit({ processed, retried }, processed ? `Processed ${processed} item${processed === 1 ? '' : 's'}.` : 'Nothing pending.');
    }
    case 'settings': {
      const [key, value] = rest;
      if (key && value !== undefined) {
        if (value !== 'true' && value !== 'false') throw new UsageError('Setting values are true or false.');
        memory.settings.set(key as keyof Settings, value === 'true');
      }
      const settings = memory.settings.all();
      return emit(settings, Object.entries(settings).map(([k, v]) => `${k.padEnd(14)}${v}`).join('\n'));
    }
    case 'search': {
      attachLocalEmbedder(memory);
      const hits = await memory.search.hybrid(text(0, 'query'), filter(), limit());
      return emit(hits, hits.length ? hits.map(format.hitLine).join('\n') : 'No matches.');
    }
    case 'list': {
      const items = memory.items.list(filter(), limit());
      return emit(items, items.length ? items.map(format.itemLine).join('\n') : 'Nothing saved yet.');
    }
    case 'show': {
      const item = memory.items.get(arg(0, 'id'));
      return emit(item, opts.content ? item.content || '(no archived text)' : format.itemDetail(item));
    }
    case 'outline': {
      const [action] = rest;
      if (opts.root && opts.parent !== undefined) throw new UsageError('Choose --parent or --root, not both.');
      if (action === 'add') {
        const entry = memory.outline.createNote({
          parentId: opts.parent ?? null, title: text(1, 'title'), body: opts.body, project: opts.project, tags: opts.tag,
        });
        return emit(entry, format.itemLine(entry.item));
      }
      if (action === 'move') {
        if (opts.parent === undefined && !opts.root) throw new UsageError('Choose a destination with --parent <id> or --root.');
        const entry = memory.outline.move(arg(1, 'id'), { parentId: opts.parent ?? null, beforeId: opts.before });
        return emit(entry, `Moved ${format.label(entry.item)} to ${entry.parentId ?? 'the root'}.`);
      }
      if (action === 'show') {
        const id = arg(1, 'id');
        const entry = memory.outline.get(id);
        const ancestors = memory.outline.ancestors(id);
        const result = { ...entry, ancestors };
        return emit(result, `${[...ancestors, entry.item].map(format.label).join(' / ')}\n${format.itemLine(entry.item)}\n${entry.childCount} children`);
      }
      if (rest.length > 1) throw new UsageError('Use outline [parent-id], outline show, outline add or outline move.');
      if (action && opts.parent !== undefined) throw new UsageError('Pass the parent id once, as an argument or --parent.');
      if (action && opts.root) throw new UsageError('Choose a parent id or --root, not both.');
      const offset = opts.offset === undefined ? 0 : Number(opts.offset);
      const page = memory.outline.children(action ?? opts.parent ?? null, { offset, limit: limit(), includeArchived: opts.all });
      const displayed = page.items.length;
      const lines = page.items.map((entry) => `${format.itemLine(entry.item)}${entry.childCount ? `\n    ${entry.childCount} children` : ''}`);
      const range = displayed ? `${offset + 1}–${offset + displayed}` : '0';
      return emit(page, `${lines.join('\n')}${lines.length ? '\n\n' : ''}${range} of ${page.total} items${offset + displayed < page.total ? `; continue with --offset ${offset + displayed}` : ''}`);
    }
    case 'editor': {
      const action = arg(0, 'action');
      if (action === 'undo' || action === 'redo') {
        const result = memory.editor[action](arg(1, 'action-id'));
        return emit(result, `${result.label}. Action: ${result.actionId}`);
      }
      let commands: EditorCommand[];
      let id: string | undefined;
      if (action === 'apply') {
        const file = arg(1, 'file.json');
        const value = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8'));
        commands = Array.isArray(value) ? value : value?.commands;
        id = Array.isArray(value) ? undefined : value?.id;
      } else if (action === 'split') {
        const item = memory.items.get(arg(1, 'id'));
        const field = arg(2, 'title|body');
        if (field !== 'title' && field !== 'body') throw new UsageError('Choose title or body for the split field.');
        commands = [{ op: 'split', id: item.id, field, offset: Number(arg(3, 'offset')), baseText: item[field] }];
      } else if (action === 'merge') {
        commands = [{ op: 'merge', id: arg(1, 'id'), previousId: arg(2, 'previous-id') }];
      } else {
        throw new UsageError('Usage: editor apply|split|merge|undo|redo');
      }
      const result = memory.editor.apply(commands, { id });
      return emit(result, `${result.label}. Action: ${result.actionId}`);
    }
    case 'edit': {
      const item = memory.items.update(arg(0, 'id'), {
        title: opts.title, body: opts.body, url: opts.url, project: opts['no-project'] ? null : opts.project,
      });
      return emit(item, format.itemDetail(item));
    }
    case 'presentation': {
      const id = arg(0, 'id');
      const value = opts.set === undefined ? memory.presentation.get(id)
        : memory.presentation.update(id, JSON.parse(readFileSync(opts.set === '-' ? 0 : resolve(opts.set), 'utf8')) as Partial<ItemPresentation>);
      return emit(value, JSON.stringify(value, null, 2));
    }
    case 'check':
    case 'uncheck': {
      const item = memory.presentation.toggle(arg(0, 'id'), command === 'check');
      return emit(item, `${command === 'check' ? 'Completed' : 'Reopened'} ${format.label(item)}`);
    }
    case 'checklist': {
      const id = arg(0, 'id');
      if (rest[1] === 'reset') {
        const result = memory.presentation.reset(id);
        return emit(result, `Reset ${result.updated} entries.`);
      }
      if (rest[1]) throw new UsageError('Usage: checklist <id> [reset]');
      const result = memory.presentation.progress(id);
      return emit(result, `${result.done} of ${result.total} complete.`);
    }
    case 'history': {
      if (rest[0] === 'show') {
        const version = memory.versions.get(arg(1, 'version-id'));
        return emit(version, JSON.stringify(version, null, 2));
      }
      if (rest[0] === 'restore') {
        const result = memory.versions.restore(arg(1, 'version-id'));
        return emit(result, recoveryMessage(result));
      }
      const page = memory.versions.list(arg(0, 'item-id'), { limit: limit(), offset: opts.offset === undefined ? undefined : Number(opts.offset) });
      return emit(page, page.items.map((v) => `${v.id}  ${v.at}  ${v.op}  ${v.actor}`).join('\n') || 'No versions.');
    }
    case 'references': {
      const result = memory.references.list(arg(0, 'id'));
      return emit(result, JSON.stringify(result, null, 2));
    }
    case 'reference': {
      const item = memory.references.insert(arg(0, 'from'), arg(1, 'to'), opts.title);
      return emit(item, format.itemDetail(item));
    }
    case 'pin':
    case 'unpin': {
      const item = memory.items.pin(arg(0, 'id'), command === 'pin');
      return emit(item, `${command === 'pin' ? 'Pinned' : 'Unpinned'} ${format.label(item)}`);
    }
    case 'remind': {
      const when = text(1, 'when');
      const item = memory.items.setReminder(arg(0, 'id'), when === 'off' ? null : when);
      return emit(item, item.remindAt ? `Reminder set for ${new Date(item.remindAt).toLocaleString()}` : 'Reminder cleared.');
    }
    case 'reminders': {
      const items = memory.items.list({ reminders: true }, limit());
      return emit(items, items.map((i) => `${new Date(i.remindAt!).toLocaleString()}  ${format.itemLine(i)}`).join('\n') || 'No reminders.');
    }
    case 'intent': {
      const value = arg(1, 'intent');
      const item = memory.items.setIntent(arg(0, 'id'), value === 'none' ? null : value);
      return emit(item, `${format.label(item)}: ${item.intent ?? 'no intent'}`);
    }
    case 'tag': {
      const item = memory.items.tag(arg(0, 'id'), { add: opts.add, remove: opts.remove });
      return emit(item, item.tags.length ? item.tags.map((t) => `#${t}`).join(' ') : '(no tags)');
    }
    case 'relate': {
      const item = memory.items.relate(arg(0, 'from'), arg(2, 'to'), arg(1, 'kind'));
      return emit(item, format.itemDetail(item));
    }
    case 'unrelate': {
      const item = memory.items.unrelate(arg(0, 'from'), arg(2, 'to'), arg(1, 'kind'));
      return emit(item, format.itemDetail(item));
    }
    case 'archive':
    case 'unarchive': {
      const id = arg(0, 'id');
      const item = command === 'archive' ? memory.items.archive(id) : memory.items.unarchive(id);
      return emit(item, `${command === 'archive' ? 'Archived' : 'Restored'} ${item.id}`);
    }
    case 'delete': {
      const id = arg(0, 'id');
      if (!opts.yes) throw new UsageError('Deleting is permanent. Re-run with --yes, or use `archive` to hide it instead.');
      memory.items.delete(id);
      return emit({ deleted: id }, `Deleted ${id}`);
    }
    case 'decide': {
      const decision = memory.decisions.record({
        project: arg(0, 'project'), decision: text(1, 'decision'), reason: opts.reason, supersedes: opts.supersedes,
      });
      return emit(decision, format.decisionLine(decision));
    }
    case 'activity': {
      const changes = memory.activity.recent({ project: opts.project }, limit());
      return emit(changes, changes.map(format.changeLine).join('\n') || 'No activity yet.');
    }
    case 'clients':
      return runClients(memory);
    case 'ai':
      return runAi(memory);
    case 'enrich': {
      const item = await enrichItem(memory, requireProvider(memory), arg(0, 'id'));
      const ai = item.metadata.ai!;
      if (ai.status === 'failed') throw new MemoryError('invalid', ai.error ?? 'Enrichment failed.');
      return emit(item, format.suggestions(item));
    }
    case 'accept': {
      const item = memory.items.acceptSuggestions(arg(0, 'id'));
      return emit(item, format.itemDetail(item));
    }
    case 'ask': {
      attachLocalEmbedder(memory);
      const answer = await ask(memory, requireProvider(memory), text(0, 'question'), { project: opts.project });
      return emit(answer, format.answer(answer));
    }
    case 'import': {
      const [kind] = rest;
      const source = resolve(arg(1, 'path'));
      if (kind === 'highlights' && opts.preview) {
        const preview = previewEnveHighlights(readFileSync(source, 'utf8'));
        return emit(preview, `${preview.format}: ${preview.entries.length} passages, ${preview.skipped} duplicates in the file. No notes saved.`);
      }
      const result = kind === 'bookmarks' ? importBookmarks(memory, readFileSync(source, 'utf8'), { project: opts.project, archive: opts.archive })
        : kind === 'markdown' ? importMarkdownFolder(memory, source, { project: opts.project })
        : kind === 'csv' ? importCsv(memory, readFileSync(source, 'utf8'), { project: opts.project })
        : kind === 'enve' ? importEnveExport(memory, source)
        : kind === 'highlights' ? importEnveHighlights(memory, readFileSync(source, 'utf8'), { project: opts.project })
        : null;
      if (!result) throw new UsageError('Usage: import bookmarks|markdown|csv|enve|highlights <path>');
      if (opts.archive) await processPending(memory, { limit: 1000 });
      const failures = result.failed.slice(0, 10).map((f) => `  ${f.source}: ${f.error}`).join('\n');
      return emit(result, `Imported ${result.created}, skipped ${result.skipped} already here${result.failed.length ? `, ${result.failed.length} failed:\n${failures}` : '.'}`);
    }
    case 'rules':
      return runRules(memory);
    case 'graph': {
      const graph = memory.graph({ project: opts.project });
      return emit(graph, `${graph.nodes.length} nodes, ${graph.edges.length} edges. Use --json for the data.`);
    }
    case 'export': {
      const summary = memory.exports.write(resolve(text(0, 'folder')));
      return emit(summary, `Exported ${summary.items} items, ${summary.projects} projects and ${summary.files} files to ${summary.path}`);
    }
    case 'sync': {
      const [target] = rest;
      if (target === 'remote') {
        const token = process.env.PETTY_MEMORY_SYNC_TOKEN;
        if (!token) throw new UsageError('Set PETTY_MEMORY_SYNC_TOKEN to a token created on the sync server with --scope sync.');
        const result = await new RemoteSyncClient(memory, { url: arg(1, 'server-url'), token }).run();
        if (result.rejected) process.exitCode = 1;
        return emit(result, `Sent ${result.pushed}, received ${result.pulled}, conflicts ${result.conflicts}, rejected ${result.rejected}.`);
      }
      if (target === 'off') {
        memory.settings.set('syncFolder', '');
        memory.sync.forgetKey();
        return emit({ syncFolder: null }, 'Sync is off. Nothing was removed from the shared folder.');
      }
      if (target) memory.settings.set('syncFolder', resolve(target));
      if (opts.passphrase !== undefined) {
        const passphrase = opts.passphrase === '-' ? readFileSync(0, 'utf8').replace(/\r?\n$/, '') : opts.passphrase;
        memory.sync.setPassphrase(passphrase);
      }
      const result = memory.sync.run();
      return emit({ folder: memory.settings.get('syncFolder'), ...result },
        `Synced with ${result.devices} other device${result.devices === 1 ? '' : 's'} through ${memory.settings.get('syncFolder')}: sent ${result.exported}, received ${result.imported}${result.conflicts ? `, kept ${result.conflicts} conflicting edit${result.conflicts === 1 ? '' : 's'} as notes` : ''}.`);
    }
    case 'shares': {
      if (rest[0] === 'create') {
        const result = memory.shares.create(arg(1, 'root-id'), { excludedIds: opts.exclude, expiresAt: opts.expires });
        return emit(result, `${JSON.stringify(result.share, null, 2)}\n\nPublic token (shown once): ${result.token}\nOpen /s/${result.token} on your web host.\nAnyone with this link can read the shared tree until it expires or is revoked.`);
      }
      if (rest[0] === 'revoke') {
        const share = memory.shares.revoke(arg(1, 'share-id'));
        return emit(share, `Revoked ${share.id}`);
      }
      if (rest.length && rest[0] !== 'list') throw new UsageError('Usage: shares [list|create <root-id>|revoke <share-id>]');
      const shares = memory.shares.list();
      return emit(shares, shares.map((s) => `${s.id}  ${s.rootId}  ${s.revokedAt ? 'revoked' : s.expiresAt ?? 'no expiry'}`).join('\n') || 'No public links.');
    }
    case 'backup': {
      const backup = memory.backups.create('manual');
      return emit(backup, `Snapshot saved: ${backup.path}`);
    }
    case 'backups': {
      const backups = memory.backups.list();
      return emit(backups, backups.map((b) => `${b.createdAt}  ${b.kind.padEnd(13)} ${(b.size / 1024 / 1024).toFixed(1)} MB  ${b.file}`).join('\n') || 'No snapshots yet.');
    }
    case 'task':
      return runTask(memory);
    case 'project':
      return runProject(memory);
    case 'info': {
      const { tagNames: _tagNames, ...stats } = memory.stats();
      const info = {
        version: pkg.version,
        home: memory.paths?.home,
        database: memory.paths?.database,
        schemaVersion: memory.schemaVersion,
        deviceId: memory.deviceId,
        ...stats,
        ai: memory.settings.get('aiProvider'),
        semanticIndex: (() => {
          const embedder = attachLocalEmbedder(memory);
          if (!embedder) return 'off';
          const { indexed, pending } = memory.embeddings.status(embedder.model);
          return `${indexed} indexed, ${pending} pending (${embedder.model})`;
        })(),
      };
      return emit(info, Object.entries(info).map(([k, v]) => `${k.padEnd(14)}${v}`).join('\n'));
    }
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

function requireProvider(memory: EnveMemory): AiProvider {
  const provider = providerFor(memory);
  if (!provider) throw new UsageError('No AI provider is set up. Choose one with `petty-memory ai use <provider>`.');
  return provider;
}

async function runAi(memory: EnveMemory): Promise<void> {
  const [sub, value] = rest;
  switch (sub) {
    case undefined:
      break;
    case 'actions': {
      const result = await chat(memory, requireProvider(memory), { mode: 'actions', rootId: arg(1, 'root-id'), messages: [{ role: 'user', content: text(2, 'request') }] });
      return emit(result.kind === 'actions' ? result.proposal : result, JSON.stringify(result, null, 2));
    }
    case 'actions-apply': {
      const file = arg(1, 'file');
      const value = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8'));
      const proposal = value.proposal ?? value;
      const includeIds = opts.exclude ? proposal.operations.filter((op: { id: string }) => !opts.exclude!.includes(op.id)).map((op: { id: string }) => op.id) : undefined;
      const result = memory.actions.apply(proposal, includeIds);
      return emit(result, `Created ${result.createdIds.length} items and updated ${result.updatedIds.length}. Use --json to keep the undo receipt.`);
    }
    case 'actions-undo': {
      const file = arg(1, 'file');
      const value = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8'));
      const result = memory.actions.undo(value.undo ?? value);
      return emit(result, recoveryMessage(result));
    }
    case 'organize': {
      attachLocalEmbedder(memory);
      const result = await chat(memory, requireProvider(memory), { mode: 'organize', messages: [{ role: 'user', content: text(1, 'request') }] });
      return emit(result.kind === 'organization' ? result.proposal : result, JSON.stringify(result, null, 2));
    }
    case 'edit': {
      const proposal = await proposeEdit(memory, requireProvider(memory), { rootId: arg(1, 'root-id'), instruction: text(2, 'request') });
      return emit(proposal, JSON.stringify(proposal, null, 2));
    }
    case 'apply': {
      const file = arg(1, 'proposal.json');
      const proposal = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8')) as EditProposal;
      const result = memory.edits.apply(proposal);
      return emit(result, `Applied ${result.applied} changes.`);
    }
    case 'undo': {
      const file = arg(1, 'receipt.json');
      const value = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8'));
      const result = memory.edits.undo(value?.undo ?? value);
      return emit(result, recoveryMessage(result));
    }
    case 'use': {
      if (!value || !isProviderId(value) || value === 'none') throw new UsageError(`Choose a provider: ${PROVIDER_IDS.filter((p) => p !== 'none').join(', ')}.`);
      const provider = createProvider({ provider: value, model: opts.model ?? PROVIDERS[value].defaultModel ?? '', baseUrl: opts['base-url'], apiKey: envKeys(value) });
      memory.settings.set('aiProvider', value);
      memory.settings.set('aiModel', provider.model);
      memory.settings.set('aiBaseUrl', opts['base-url'] ?? '');
      break;
    }
    case 'off':
      memory.settings.set('aiProvider', 'none');
      memory.settings.set('aiEnrich', false);
      break;
    case 'models': {
      const models = await requireProvider(memory).listModels();
      return emit(models, models.join('\n'));
    }
    case 'auto-apply':
      if (value !== 'on' && value !== 'off') throw new UsageError('Usage: ai auto-apply on|off');
      memory.settings.set('aiAutoApply', value === 'on');
      break;
    case 'enrich':
      if (value !== 'on' && value !== 'off') throw new UsageError('Usage: ai enrich on|off');
      if (value === 'on') requireProvider(memory);
      memory.settings.set('aiEnrich', value === 'on');
      if (value === 'on') memory.settings.set('aiEnrichSince', new Date().toISOString());
      break;
    default:
      throw new UsageError('Usage: ai [use|models|off|enrich|auto-apply|edit|apply]');
  }
  const settings = memory.settings.all();
  const status = {
    provider: settings.aiProvider,
    model: settings.aiModel || null,
    baseUrl: settings.aiBaseUrl || null,
    enrich: settings.aiEnrich,
    enrichSince: settings.aiEnrichSince || null,
    autoApply: settings.aiAutoApply,
  };
  return emit(status, settings.aiProvider === 'none'
    ? 'AI is off. Everything else works without it. Turn it on with `petty-memory ai use <provider>`.'
    : `Provider  ${settings.aiProvider}${settings.aiBaseUrl ? ` at ${settings.aiBaseUrl}` : ''}\nModel     ${settings.aiModel}\nEnrich    ${settings.aiEnrich ? `on (items saved since ${settings.aiEnrichSince})` : 'off'}\nApply     ${settings.aiAutoApply ? 'automatically' : 'when you accept'}`);
}

function runRules(memory: EnveMemory): void {
  const [sub, target] = rest;
  switch (sub) {
    case undefined:
    case 'list': {
      const rules = memory.rules.list();
      return emit(rules, rules.map(format.ruleLine).join('\n') || 'No rules yet. Add one with `petty-memory rules add`.');
    }
    case 'add': {
      const rule = memory.rules.create({
        name: text(1, 'name'),
        conditions: {
          types: opts.type?.split(',').map((t) => t.trim()) as RuleConditions['types'],
          domains: opts.domain,
          keywords: opts.keyword,
          source: opts.from,
        },
        actions: { tags: opts.tag, project: opts.project },
      });
      return emit(rule, `Added ${format.ruleLine(rule)}`);
    }
    case 'on':
    case 'off': {
      const rule = memory.rules.setEnabled(arg(1, 'id'), sub === 'on');
      return emit(rule, format.ruleLine(rule));
    }
    case 'delete':
      memory.rules.delete(arg(1, 'id'));
      return emit({ deleted: target }, `Deleted rule ${target}`);
    default:
      throw new UsageError('Usage: rules [add|on|off|delete]');
  }
}

function runClients(memory: EnveMemory): void {
  const [sub] = rest;
  switch (sub) {
    case 'add': {
      const scopes = (opts.scope ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      const { client, token } = memory.clients.create(text(1, 'name'), scopes);
      return emit({ client, token }, `Created ${client.name} (${client.scopes.join(', ')})\n\n  ${token}\n\nThis token is shown once. Store it in the client now.`);
    }
    case 'pair': {
      const extraScopes = (opts.scope ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      const { client, token } = memory.clients.create(text(1, 'device'), [...new Set(['read', 'write', ...extraScopes])]);
      const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
      const links = lanUrls(port).map((url) => pairingLink(url, token, client.name));
      return emit(
        { client, token, links },
        `Paired ${client.name}. Start the server with \`petty-memory serve --lan\`, then open one of these on the device:\n\n${links.map((l) => `  ${l}`).join('\n') || '  (no network address found; connect to Wi-Fi or Tailscale)'}\n\nThe link contains the token and is shown once.`,
      );
    }
    case 'list': {
      const clients = memory.clients.list();
      return emit(clients, clients.map(format.clientLine).join('\n') || 'No API clients.');
    }
    case 'revoke': {
      const client = memory.clients.revoke(arg(1, 'id'));
      return emit(client, `Revoked ${client.name}`);
    }
    default:
      throw new UsageError('Usage: clients add|list|revoke');
  }
}

async function serve(): Promise<void> {
  const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port "${opts.port}".`);
  const serverLimit = (name: 'max-upload-mb' | 'max-json-kb' | 'max-sync-mb' | 'max-writes', unit = 1) => {
    if (opts[name] === undefined) return undefined;
    const value = Number(opts[name]) * unit;
    if (!Number.isSafeInteger(value) || value < 1) throw new UsageError(`--${name} must be positive.`);
    return value;
  };
  const maxUploadBytes = serverLimit('max-upload-mb', 1024 * 1024);
  const maxJsonBytes = serverLimit('max-json-kb', 1024);
  const maxSyncBytes = serverLimit('max-sync-mb', 1024 * 1024);
  const maxConcurrentWrites = serverLimit('max-writes');
  const webOrigins: string[] = [];
  if (opts.origin !== undefined) {
    let origin: URL;
    try { origin = new URL(opts.origin); }
    catch { throw new UsageError('--origin must be a complete HTTP or HTTPS origin.'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new UsageError('--origin must contain only the HTTP or HTTPS scheme, host and port.');
    }
    webOrigins.push(origin.origin);
  }
  const memory = EnveMemory.open({ home: opts.home, actor: 'api' });
  const embedder = attachLocalEmbedder(memory);
  const indexer = embedder ? indexWorker(memory, embedder) : null;
  const enricher = enrichWorker(memory, () => {
    try {
      return providerFor(memory);
    } catch (error) {
      console.error('enrich:', (error as Error).message);
      return null;
    }
  });
  const organizer = organizeWorker(memory, () => {
    try { return providerFor(memory); } catch { return null; }
  }, () => indexer?.kick());
  const webRoot = ['./web/', '../../../apps/web/public/']
    .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    .find((path) => existsSync(join(path, 'index.html')));
  const api = createApiServer(memory, {
    version: pkg.version, port, lan: opts.lan, webRoot, webOrigins, maxUploadBytes, maxJsonBytes, maxSyncBytes, maxConcurrentWrites,
    afterWrite: () => {
      indexer?.kick();
      enricher.kick();
      organizer.kick();
    },
  });
  const url = await api.listen();
  webOrigins.push(url, ...(opts.lan ? lanUrls(Number(new URL(url).port)) : []));
  api.ingest.kick();
  indexer?.kick();
  enricher.kick();
  organizer.kick();
  const backup = () => {
    try {
      memory.backups.runSchedule();
    } catch (error) {
      console.error('backup:', error);
    }
  };
  backup();
  const backupTimer = setInterval(backup, 10 * 60_000);
  const sync = () => {
    if (!memory.settings.get('syncFolder')) return;
    try {
      memory.sync.run();
    } catch (error) {
      console.error('sync:', (error as Error).message);
    }
  };
  sync();
  const syncTimer = setInterval(sync, 2 * 60_000);
  console.error(`Petty Memory API listening on ${url}${opts.lan ? ' (also reachable from your network)' : ''}\nREST: ${url}/api/v1   MCP: ${url}/mcp`);
  const stop = async () => {
    clearInterval(backupTimer);
    clearInterval(syncTimer);
    await api.close();
    await indexer?.idle();
    await enricher.idle();
    await organizer.idle();
    memory.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function runTask(memory: EnveMemory): void {
  const [sub] = rest;
  const shift = rest.slice(1);
  switch (sub) {
    case 'add': {
      const task = memory.tasks.create({
        title: shift.join(' '), notes: opts.notes, project: opts.project, due: opts.due, priority: opts.priority, tags: opts.tag,
      });
      return emit(task, `Added ${format.itemLine(task)}`);
    }
    case 'list': {
      const tasks = memory.tasks.list({ project: opts.project, status: opts.status, tag: opts.tag?.[0] }, limit());
      return emit(tasks, tasks.length ? tasks.map(format.itemLine).join('\n') : 'No tasks.');
    }
    case 'done': {
      const task = memory.tasks.complete(arg(1, 'id'));
      return emit(task, format.itemLine(task));
    }
    case 'edit': {
      const task = memory.tasks.update(arg(1, 'id'), {
        title: opts.title, notes: opts.notes, status: opts.status, due: opts.due, priority: opts.priority,
        project: opts['no-project'] ? null : opts.project,
      });
      return emit(task, format.itemLine(task));
    }
    default:
      throw new UsageError('Usage: task add|list|done|edit');
  }
}

function runProject(memory: EnveMemory): void {
  const [sub] = rest;
  switch (sub) {
    case 'new': {
      const project = memory.projects.create({ name: text(1, 'name'), description: opts.description, instructions: opts.instructions });
      return emit(project, `Created ${format.projectLine(project)}`);
    }
    case 'list': {
      const projects = memory.projects.list(opts.status);
      return emit(projects, projects.length ? projects.map(format.projectLine).join('\n') : 'No projects yet.');
    }
    case 'show': {
      const briefing = memory.briefing(text(1, 'project'));
      return emit(briefing, format.briefing(briefing));
    }
    case 'edit': {
      const project = memory.projects.update(text(1, 'project'), {
        name: opts.name, description: opts.description, instructions: opts.instructions, status: opts.status,
      });
      return emit(project, format.projectLine(project));
    }
    case 'history': {
      const page = memory.projects.memoryHistory(text(1, 'project'), {
        limit: limit(), offset: opts.offset === undefined ? undefined : Number(opts.offset),
      });
      return emit(page, page.items.map((v) => `${v.id}  ${v.at}  ${v.actor}\n${v.memory}`).join('\n\n') || 'No memory history.');
    }
    case 'memory': {
      const ref = text(1, 'project');
      if (opts.set === undefined) {
        const project = memory.projects.resolve(ref);
        return emit({ project: project.name, memory: project.memory }, project.memory || '(empty)');
      }
      const content = readFileSync(opts.set === '-' ? 0 : opts.set, 'utf8');
      const project = memory.projects.setMemory(ref, content);
      return emit({ project: project.name, saved: true }, `Updated memory for ${project.name}`);
    }
    default:
      throw new UsageError('Usage: project new|list|show|edit|memory|history');
  }
}

function connectInstructions(): string {
  const node = process.execPath;
  const script = fileURLToPath(import.meta.url);
  const args = [script, 'mcp', ...(opts.home ? ['--home', opts.home] : [])];
  // Inside the packaged desktop app, "node" is the app's own Electron binary, which only acts as Node with this set.
  const env = process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
  const quoted = [node, ...args].map((a) => JSON.stringify(a)).join(' ');
  return `Claude Code:
  claude mcp add --scope user ${SERVER_NAME}${env ? ' -e ELECTRON_RUN_AS_NODE=1' : ''} -- ${quoted}

Codex (~/.codex/config.toml):
  [mcp_servers.${SERVER_NAME}]
  command = ${JSON.stringify(node)}
  args = ${JSON.stringify(args)}${env ? '\n  env = { ELECTRON_RUN_AS_NODE = "1" }' : ''}

Claude Desktop, Cursor and other JSON-configured clients:
  ${JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: node, args, ...(env ? { env } : {}) } } })}

Clients that connect over HTTP (remote agents, other machines):
  1. petty-memory serve            (the desktop app runs this for you)
  2. petty-memory clients add "My agent" --scope read,write
  3. Point the client at http://127.0.0.1:${DEFAULT_PORT}/mcp with header  Authorization: Bearer <token>`;
}

async function main(): Promise<number> {
  if (opts.version) {
    console.log(pkg.version);
    return 0;
  }
  if (opts.help || !command) {
    console.log(USAGE);
    return command || opts.help ? 0 : 2;
  }
  if (command === 'connect') {
    console.log(connectInstructions());
    return 0;
  }
  if (command === 'serve') {
    await serve();
    return 0;
  }
  if (command === 'restore') {
    const paths = pathsFor(opts.home ?? defaultHome());
    const target = arg(0, 'file|latest');
    const snapshot = target === 'latest' ? listBackups(paths.backups).find((b) => b.kind !== 'pre-restore')?.path : resolve(target);
    if (!snapshot) throw new UsageError('There are no snapshots to restore.');
    if (!opts.yes) throw new UsageError(`This replaces your library with ${snapshot}. Quit the desktop app, \`serve\` and AI clients, then re-run with --yes.`);
    const { saved } = restoreBackup(paths, snapshot);
    emit({ restored: snapshot, saved }, `Restored ${snapshot}.\nThe previous state was saved as ${saved}; restore that file to undo.`);
    return 0;
  }
  if (command === 'mcp') {
    // Stays open for the life of the process; stdio EOF ends it.
    serveMemoryOverStdio(EnveMemory.open({ home: opts.home, actor: 'mcp' }), pkg.version);
    return 0;
  }

  const memory = EnveMemory.open({ home: opts.home, actor: 'cli' });
  try {
    await run(memory);
    return 0;
  } finally {
    memory.close();
  }
}

function openExternal(target: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
    : ['xdg-open', [target]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

function fail(error: unknown): void {
  if (error instanceof UsageError) {
    console.error(`${error.message}\nRun \`petty-memory --help\` for usage.`);
    process.exitCode = 2;
  } else if (error instanceof MemoryError || error instanceof AiError) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error('error: that port is already in use. Is Petty Memory already running? Use --port to pick another.');
    process.exitCode = 1;
  } else {
    throw error;
  }
}

main().then((code) => {
  process.exitCode = code;
}, fail);
