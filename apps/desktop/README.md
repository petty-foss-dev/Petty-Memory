# Desktop app

Electron + React on top of the workspace packages. The app opens the same SQLite library as the CLI and MCP servers, hosts the local HTTP API (browser extension, phone, remote MCP), and runs the background workers: link archiving, the semantic index, optional AI enrichment, backups and folder sync.

![Home](../../docs/screenshots/desktop/home.png)

| | |
|---|---|
| ![Project briefing: memory, open tasks](../../docs/screenshots/desktop/project.png) | ![The decision log, with a superseded decision](../../docs/screenshots/desktop/project-decisions.png) |
| ![A saved page with its archived text, pin and reminder](../../docs/screenshots/desktop/item.png) | ![Inbox with an AI suggestion](../../docs/screenshots/desktop/inbox.png) |
| ![⌘K search matching by meaning and by words](../../docs/screenshots/desktop/search.png) | ![The Watch shelf](../../docs/screenshots/desktop/shelves.png) |
| ![Activity: which app or AI changed what](../../docs/screenshots/desktop/activity.png) | ![Graph](../../docs/screenshots/desktop/graph.png) |
| ![Settings → AI tools](../../docs/screenshots/desktop/settings-ai-tools.png) | ![Settings → Devices with pairing codes](../../docs/screenshots/desktop/settings-devices.png) |
| ![Home, light theme](../../docs/screenshots/desktop/home-light.png) | ![Project, light theme](../../docs/screenshots/desktop/project-light.png) |

`npm --prefix apps/desktop run screenshots` regenerates these images. It builds the app and a fresh demo library (`scripts/demo-library.ts`), then drives the real app at 1440×900 and 2× scale, writing to `docs/screenshots/desktop/`. A few values that would otherwise show the machine taking them (its network addresses, a random port, development paths, the Ollama server's address) are replaced with representative ones; everything else is the live app. `ask.png` is written only when an Ollama server with qwen2.5:1.5b pulled (`ENVE_SCREENSHOT_OLLAMA`, default `http://127.0.0.1:11434`) gives a cited answer that names the current decision (the ESP32-S3), and it isn't in the gallery. The E2E suite keeps its own debug captures in `test-results/`.

## Run it

From the repository root, once: `npm install` (Electron 44's binary also needs `npx install-electron`).

```bash
npm --prefix apps/desktop run dev        # Vite dev server + Electron; renderer hot-reloads, main/preload rebuild restarts the app
npm --prefix apps/desktop run build      # dist/: main.js, preload.cjs, cli.mjs, renderer/
npm --prefix apps/desktop run start      # run the built app
npx tsc -p apps/desktop                  # typecheck (main, preload, renderer, tests)
npm --prefix apps/desktop run dist:mac   # installers: release/Petty Memory-<version>-{arm64,x64}.dmg
npm --prefix apps/desktop run screenshots   # repository screenshots → docs/screenshots/desktop/
```

## Installers

`npm --prefix apps/desktop run dist` (or `dist:mac`, `dist:win`, `dist:linux`) builds the app and runs electron-builder with [`electron-builder.yml`](electron-builder.yml): appId `com.enve.memory`, a macOS dmg, a Windows NSIS installer, and a Linux AppImage and deb, all written to `release/`. `scripts/dist.mjs` passes the installed Electron version, because Electron is hoisted to the workspace root where electron-builder doesn't look.

- **What ships.** The asar holds `dist/` (main, preload, renderer, `cli.mjs`) plus the only runtime dependency, `@huggingface/transformers`, and its tree. Everything else is bundled by esbuild, so it's a devDependency. `onnxruntime-node`, `sharp` and `@img/*` are unpacked from the asar because they load native code; `onnxruntime-web` is left out (transformers inlines it for Node), and so are other operating systems' onnxruntime binaries. `npmRebuild` is off: every native module is an N-API prebuild.
- **MCP from the installed app.** `Resources/cli.mjs` is a two-line entry point that imports the CLI inside the asar, so its imports resolve against the app's `node_modules`. AI clients run `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/Petty Memory" "<app>/Contents/Resources/cli.mjs" mcp`, which is exactly what Settings → AI tools shows for a packaged app.
- **macOS.** Two dmgs, `Petty Memory-<version>-arm64.dmg` and `…-x64.dmg`. onnxruntime-node has no darwin-x64 binary, so the Intel build ships without it and without sharp's native parts. The embedding runtime is only imported when semantic search first runs, and core turns semantic search off on Intel Macs (`localEmbeddingsSupported()`). The Intel app therefore starts normally, searches by keyword, and Settings → Search explains that semantic search isn't available there. Both apps are ad-hoc signed (`identity: '-'`), with no Developer ID and no notarization. On another Mac, open it the first time with right-click → Open. To distribute it, set `CSC_NAME`/`CSC_LINK`, turn on `hardenedRuntime` and notarize.
- **Windows and Linux** builds must be made on their own OS (or in CI) so npm installs the matching `sharp`/`@img` binaries; a cross-build from a Mac would package the macOS ones.
- **Icon.** `npm --prefix apps/desktop run icon` renders `build/icon.png` (and `build/icon.svg`) with sharp. electron-builder turns it into `.icns`/`.ico`.
- **Checking a build.** `npm --prefix apps/desktop run verify:dist -- "/path/to/Petty Memory.app"` uses a throwaway library to connect the MCP SDK client to the packaged `cli.mjs` over stdio (initialize, list tools, save and search). It then starts the app on a free port, checks `/api/v1/status` and runs a keyword search from the packaged CLI. If the embedding model is already cached in `.cache/models` or `~/Library/Caches/Petty Memory/models`, it also waits for the packaged app to index with onnxruntime-node and runs a semantic search. Last, it quits the app and confirms the port is released.

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `ENVE_MEMORY_HOME` | platform data folder (`~/Library/Application Support/Enve Memory`…) | Library folder. Always set it to a scratch folder when developing. |
| `ENVE_MEMORY_PORT` | `49231` | Local API port. `0` picks a free one. If the port is taken the app keeps running without the API and says so in Settings → Devices. |
| `ENVE_MEMORY_NO_GLOBAL_SHORTCUT` | unset | Skip registering ⌘⇧Space / Ctrl+Shift+Space (tests). |
| `ENVE_MEMORY_CACHE` | OS cache folder | Where the embedding model is cached. |

Scratch library for development:

```bash
export ENVE_MEMORY_HOME=/tmp/enve-dev ENVE_MEMORY_PORT=49400
node packages/cli/src/main.ts --home $ENVE_MEMORY_HOME settings semanticSearch false
node packages/cli/src/main.ts --home $ENVE_MEMORY_HOME settings fetchLinks false
npm --prefix apps/desktop run dev
```

## Architecture

```
src/
  shared/ipc.ts        the Api method map (types), METHOD_KINDS allow-list, events, the preload Bridge type
  main/
    main.ts            lifecycle, single-instance lock, windows, menu, global shortcut, CSP-adjacent hardening, IPC entry
    library.ts         Library: EnveMemory + API server + workers + backups + sync + data_version polling; restart for restore
    handlers.ts        one handler per allow-listed method (the only code that calls core for the UI)
    dispatch.ts        allow-list check + { ok, value } | { ok: false, error: { code, message } } envelope
    secrets.ts         provider API keys, encrypted with safeStorage into desktop-secrets.json
    mcp.ts             mcpLaunch() and the Claude Code / Codex / JSON setup snippets
    prefs.ts           desktop.json: theme, LAN mode, capture shortcut
  preload/preload.ts   contextBridge: window.enve.call / on / pathForFile
  renderer/            React 19 app (Vite); lib/ holds the pure logic (markdown, capture detection, formatting)
scripts/               esbuild targets (bundle.mjs), build.mjs, dev.mjs
```

- **Shelves and reminders.** The sidebar's shelves are core filters: Pinned (`pinned`), Read/Watch/Buy/Revisit (`intent`, guessed for links and changeable), Unopened (links saved over 30 days ago and never opened from the app; opening a link or file calls `markOpened`), and Reminders. Every minute, and whenever the library changes, main shows a native notification for each of `items.dueReminders()` and marks it delivered. Clicking the notification opens the item in the main window. The Reminders view lists Due and Upcoming and can snooze or clear.
- **Outline.** Sidebar → Library → Outline shows the whole library as nested, ordered rows through `outline.*` (core's `memory.outline`). Each list loads 100 rows at a time with Show more. Only open rows are fetched, and the open lists reload on `changed`. New top-level notes go first, a note added inside something goes first among its children, and child notes take their parent's project. A note is created by name (Enter), with optional plain-text or Markdown details (⇧↵). Rows move with ⌥↑/⌥↓ (reorder) and ⌥→/⌥← (indent/outdent), from the actions menu, or with the hover buttons. Move to… picks any active, non-decision parent, or the top level. Decisions are read-only rows. Archived items are hidden unless Show archived is on. The item drawer shows a note's parents, how many notes are inside it, Show in outline and Move….
- **Editing and presentation.** In the Outline, F2 or a double-click renames a row in place. Pasting several lines, in a new note or while renaming, adds one note per line, nested by indentation. Rows can show as text, a heading or a section break, with high/normal/low attention and a review mark, all set from the row menu or the drawer's Style controls, so no Markdown is needed. Body text stays Markdown and the drawer editor is unchanged.
- **Checklists.** Any note can become a checklist. Its rows get checkboxes, and it shows progress and offers Hide completed and Reset (`presentation.*`).
- **Highlights.** A Shelves → Highlights view lists high-attention items, review marks and pins, plus suggestions from the Revisit and Unopened shelves. The Outline's Show menu filters to review or high attention.
- **History.** The drawer's Versions and restore lists saved versions (`versions.*`). Choosing one compares it with now, and Restore writes a new change. The earliest entry for an older library is marked as the state when history began.
- **Connections and references.** The drawer's Connections section adds connections through a search picker and can remove them. Supersedes links are left to decisions. It also lists backlinks from inline references. Link to an item… inserts `[[item:UUID|label]]` at the cursor. Previews show the target's current title and open it in the app; references never get an href.
- **AI editing.** Edit with AI… (drawer or row menu, when AI is set up) asks for a proposal about that item and what's inside it. You pick which proposed operations to keep, then Apply; the kept ones apply together or not at all. Undo uses the returned receipt to restore the previous version and archive notes the edit created, and is refused once the item has changed again; History can still restore any version. Top-level rows can opt in to Organize automatically, which is run by core's `organizeWorker` with the existing provider.
- **Secret notes.** New secret note (Outline toolbar, row menu, Settings → Secret notes) sets up or unlocks the vault and saves through `vault.*`. The desktop is the host path: main derives the key and holds it in memory until Lock vault or quit. A new vault uses the same PBKDF2 envelope as the browser and phone, so their notes open everywhere; a vault first set up with the older scrypt envelope opens only here. Secret notes show a lock and can't hold other notes. The drawer reads and edits them only while unlocked. Only text notes can be secret.
- **Shared links.** Share… makes a read-only link to an item's subtree with chosen rows left out and an optional expiry. The link is shown once, as `<API URL>/s/<token>` when the local server runs and otherwise as the bare code. Settings → Shared links lists and revokes links. Nothing is published automatically.
- **Server sync.** Settings → Sync → Sync through a server connects `RemoteSyncClient` (`@enve-memory/api`) to a server URL and a token created on that server with the `sync` scope. The token is stored in `desktop-secrets.json` through the OS credential store and the URL in `desktop.json`. It runs every 2 minutes, on window focus and from Sync now, next to folder sync. See [SYNC.md](../../docs/SYNC.md#syncing-through-a-server).
- **Browser client.** The API server also serves `apps/web` (copied into `dist/web` by the build) at its address, including public `/s/<token>` pages. In LAN mode the computer's network addresses are allowed web origins. Browsers still need a token; see [apps/web](../web/README.md).
- **Devices.** Settings → Devices pairs phones with `read` + `write` tokens and creates other tokens from a scope picker. `secrets` and `sync` are separate choices, never implied by `read` or `write`.
- **Processes.** The main process opens `EnveMemory.open({ home, actor: 'desktop' })`, starts `createApiServer` (127.0.0.1, or 0.0.0.0 in LAN mode), and runs `api.ingest`, `indexWorker` (when semantic search is on), `enrichWorker` (provider from `providerFor(memory, keyLookup)`), `backups.runSchedule()` every 10 minutes and `sync.run()` every 2 minutes and on window focus (when a sync folder is set). Every 1.5 s it reads `memory.dataVersion` and the newest change id; a new `data_version` means an MCP server or the CLI wrote, so it kicks the workers; either change tells every window to refresh.
- **IPC.** The renderer calls `window.enve.call(method, ...args)`. Preload rejects names not in `METHOD_KINDS`, main checks the sender frame is the app's own page, then `dispatch()` runs the handler only if the name is an own key of the handler map. Handlers are typed against `Api`, so a method can't be added on one side only. Every call sets the actor to `desktop` first (the API server leaves its own actor behind). After a `write` method main kicks the workers and broadcasts `changed`; `useLive()` in the renderer reloads on it. Errors reach the UI as `{ code, message }`: `MemoryError` codes, `ai` for provider failures, `internal` otherwise.
- **Build.** esbuild bundles main (ESM, with a `require` shim for bundled CommonJS), preload (CommonJS, required by the sandbox) and `packages/cli/src/main.ts` → `dist/cli.mjs`, resolving the `@enve-memory/*` TypeScript sources. `electron`, `onnxruntime-node`, `onnxruntime-web`, `sharp` and `@huggingface/transformers` stay external and load from `node_modules`. Vite builds the renderer into `dist/renderer` with `base: './'` for `file://`.
- **MCP.** `mcpLaunch()` returns `{ command: <app executable>, args: [<cli>, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } }`: the TypeScript CLI in dev (Electron 44's Node strips types) and `<resources>/cli.mjs` when packaged, plus `--home` when the library isn't in the default folder. Settings → AI tools shows the Claude Code, Codex and JSON snippets, and "Add to Claude Code" runs `claude mcp add …` (only if `claude` is found, only on click) and shows its output.
- **Files the app adds to the library folder.** `desktop.json` (prefs), `desktop-secrets.json` (encrypted keys, mode 0600), `Session/` (Chromium's session data, kept out of the folder root) and Electron's `Singleton*` lock files. userData is the library folder, as the CLI expects, so the single-instance lock is per library.

## Security

- `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity` on; `<webview>` refused; every permission request denied except clipboard writes.
- Production CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'` and no frames, objects, forms or `<base>`. The dev CSP additionally allows Vite's inline preamble and HMR socket.
- `setWindowOpenHandler` and `will-navigate` keep the app on its own page; http(s) and mailto links open in the system browser. `app.openExternal` accepts only those schemes.
- Archived content and notes are untrusted Markdown: `marked` with raw HTML rendered as text, then DOMPurify (HTML profile only, http/https/mailto links only, no `style`, `srcset` or event handlers, no iframes/forms/media). Remote images become "Image: …" links and any stray `<img>` loses its `src`, so opening an archived page never contacts its server (the E2E test counts requests to a tracking pixel). There is no "load remote images" switch on purpose.
- API keys never touch SQLite: `safeStorage` (Keychain / DPAPI / libsecret) encrypts them into `desktop-secrets.json`; they're decrypted once per run and only when a provider needs them. If the OS has no credential store, the key isn't saved.
- Destructive actions ask first: item delete, token revoke, automation delete, stopping sync, and restore (which also needs the word "restore" typed). LAN mode shows a warning before it binds to the network.

## Tests

```bash
npm --prefix apps/desktop test           # node:test unit tests (IPC allow-list/dispatch, secret store, Markdown sanitizing,
                                         #   capture URL detection, MCP launch config, formatting)
npm --prefix apps/desktop run test:e2e   # builds, then drives the real app with Playwright's Electron support
ENVE_E2E_OLLAMA=http://127.0.0.1:11434 npm --prefix apps/desktop run test:e2e   # also runs Ask; any Ollama server with qwen2.5:1.5b pulled
```

The E2E suite uses a fresh temp library (`ENVE_MEMORY_HOME`), port `0`, semantic search and link fetching off (it turns fetching on for one local test page), `--use-mock-keychain`, and no global shortcut. It covers first launch, capture, pinning, reminders and intents (shelves, snooze, and a due-reminder notification with a stubbed notifier whose click opens the item), filing from the Inbox and accepting AI suggestions, project memory + history + decisions, tasks, ⌘K search, a CLI write showing up live, archived-page rendering, MCP setup and pairing QR codes, token creation, drag-and-drop, delete confirmation, the quick-capture window, encrypted folder sync, export, restore, automations, bookmark import, paging, the graph, theme switching and a clean quit that releases the port.

## Limitations

- The global shortcut isn't configurable from the UI; set `shortcut` in `desktop.json`.
- Builds are ad-hoc signed and not notarized (see [Installers](#installers)).
- The Intel Mac, Windows and Linux builds are untested. On an Intel Mac or under Rosetta 2, `verify:dist` checks the x64 build.
