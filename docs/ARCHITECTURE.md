# Architecture

## Shape

```
 Desktop UI ─┐   Browser extension ─┐   iOS share sheet ─┐
             │                      │                    │
             │            HTTP API (packages/api) ◄──────┘
             ▼                      ▼
 CLI ─────► @enve-memory/core  ◄──── @enve-memory/mcp ◄──── Claude / Codex / Cursor / …
                    │
              node:sqlite (WAL)
                    │
     <data folder>/memory.sqlite  +  attachments/  +  backups/
```

**Every client goes through core services.** Nothing outside `packages/core` touches SQLite. `createTask()` exists once, and the desktop app, the CLI, MCP and the HTTP API all call it. Validation, change logging and invariants such as "decisions are append-only" live in core, so no client can bypass them.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Schema and migrations, services (projects, items, tasks, decisions, search, activity), and the `EnveMemory` facade. No dependencies. |
| `packages/mcp` | MCP tool definitions over core, using the official TypeScript SDK v2 (`@modelcontextprotocol/server`, spec 2026-07-28). Thin: argument shaping and output trimming only. |
| `packages/ingestion` | Fetch (no cookies, time/size caps), readable-article extraction (Readability + linkedom → Markdown via Turndown), PDF text (unpdf), and `IngestWorker` for background draining. |
| `packages/embeddings` | `LocalEmbedder` (transformers.js), `attachLocalEmbedder`, and the background `indexWorker`. |
| `packages/ai` | Optional LLM providers behind one interface, background enrichment (`enrichWorker`) and cited `ask`. |
| `packages/importers` | Browser bookmark exports (a token scan of the Netscape format), Markdown folders and Obsidian vaults (front matter, inline tags, re-runs skip what's imported), bookmark CSVs, and Enve exports (ids, dates, files, decisions and relations restored). |
| `packages/api` | Local HTTP server: REST (`/api/v1`) + MCP over Streamable HTTP (`/mcp`), with token auth, scopes and Host/Origin guards; optionally serves a web root and public share pages. Also `RemoteSyncClient`, which syncs a library with another one over this API. |
| `packages/cli` | The `enve-memory` binary: human and `--json` commands, `mcp` (stdio), `serve` (HTTP), `clients` (tokens) and `connect` (client setup snippets). |

| App | Role |
|---|---|
| `apps/desktop` | Electron 44 + React desktop app. Opens the library directly through core, hosts the HTTP API and runs the background workers. See its [README](../apps/desktop/README.md). |
| `apps/extension` | MV3 browser extension for Chrome, Edge and Firefox; a client of the HTTP API. See its [README](../apps/extension/README.md). |
| `apps/ios` | SwiftUI app and share extension; a client of the HTTP API over the LAN or Tailscale, with a read cache and outbox rather than a local engine. See its [README](../apps/ios/README.md). |
| `apps/web` | Plain HTML/JS browser client and a Node launcher that hosts it with the HTTP API, for self-hosting on your own devices. The desktop app serves the same client. See its [README](../apps/web/README.md). |

## Stack decisions

| Decision | Why |
|---|---|
| TypeScript on Node ≥ 24 (Electron 44 ships Node 24.21) | One codebase for macOS, Windows and Linux. The MCP SDK, parsers and browser tooling are all native to it. |
| `node:sqlite`, not better-sqlite3 | Built into Node, so there are no native modules to compile per OS or per Electron ABI. Supports FTS5 and loadable extensions (`allowExtension`). |
| Node's built-in TypeScript type stripping | No build step in development. Code must stay within erasable syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. |
| npm workspaces | Ships with Node, so there's nothing extra to install. |
| `node:test` + `tsc --noEmit` (TypeScript 7) | Zero-dependency test runner. `npm run check` runs both. |
| UUIDv7 ids (`crypto.randomUUIDv7`) | Globally unique across devices and time-ordered. This is a precondition for sync. |
| Electron for the desktop app | It runs the same Node engine in-process, so the app opens the library through core with no sidecar. Its `userData` path matches the default data folder, so the CLI and the app share one library. |

Node refuses to strip types from files under `node_modules`, so anything that ships as a package has to be `.js`. The desktop app bundles the engine and CLI with esbuild for that reason. The workspace packages are private and aren't published to npm.

## Data location

`$ENVE_MEMORY_HOME`, or the platform default. The default is the same as Electron's `userData` for "Petty Memory", so the CLI and the desktop app share one library:

- macOS: `~/Library/Application Support/Enve Memory/`
- Windows: `%APPDATA%\Enve Memory\`
- Linux: `$XDG_CONFIG_HOME/Petty Memory/` (default `~/.config/…`)

The folder contains `memory.sqlite` (with `-wal`/`-shm` files), `attachments/` (content-addressed file blobs, plus `.trash/` for 30 days after deletion) and `backups/`. The embedding model lives in `models/` inside the OS cache folder (`~/Library/Caches/Petty Memory`, `%LOCALAPPDATA%\Petty Memory\Cache`, `$XDG_CACHE_HOME/enve-memory`; override with `$ENVE_MEMORY_CACHE`). It's shared by every library, never backed up, and re-downloads if cleared.

## Ordered outlines

`OutlineService` in core owns item containment and sibling ordering. The desktop Outline, CLI `outline` commands, REST `/outline` routes and MCP outline tools call the same service. Item ids, note bodies and the existing Item response shape remain unchanged; outline entries wrap an item with its parent, sibling position and direct-child count.

Nesting is independent of project filing. A move retains descendants and does not refile them. Decisions remain at the top level and cannot contain other items. The active outline projects active children of archived parents to the top level, while the archived view retains the stored tree. Deleting a parent adopts its children into the parent's former place and records those moves.

Children are paged with an exact total. Sibling positions are finite numeric sort keys with item ids as the tie-breaker; clients request placement with `beforeId` instead of calculating keys. Schema migration, ordering, cycle checks and interchange behavior belong in core, not in client renderers.

## Parity services

The breadth-first parity layer ([DAFTAK_PARITY_PLAN.md](DAFTAK_PARITY_PLAN.md#current-status), contracts in [PARITY_FEATURE_CONTRACTS.md](PARITY_FEATURE_CONTRACTS.md)) adds these core services. Every client calls them; none reimplements their rules.

- `presentation`: display kind, attention, review mark and checklist state in `metadata.presentation`. Completion has one authority per item: task status for tasks, `checked` for other ordinary items.
- `versions`: item and subtree snapshots for local and synced changes, paged newest first; restore writes a new change.
- `references`: `[[item:<id>|label]]` tokens and parsed backlinks; `items.unrelate` removes explicit connections.
- `edits`: validates and applies AI proposals (`proposeEdit` in `@enve-memory/ai` builds them) against a subtree hash, all or nothing, and returns an undo receipt. `organizeWorker` runs opt-in background organizing.
- `vault`: secret text notes. Remote clients seal notes themselves and store opaque envelopes; the host path derives and holds a key in memory for local use.
- `shares`: hashed public tokens and a live, sanitized subtree projection.
- `sync.exportChanges` / `applyChanges` / blob methods: the folder-sync engine exposed for server sync.

Decisions, secret notes and archived items stay outside AI edit scopes; MCP has no vault, share, AI-apply or sync tools.

## Automations

`RuleService` (core) runs every enabled rule when an item is created and again when its source is archived, so the title, domain and text are known. Conditions (all must hold): item types, link domains (subdomains included), keywords in the title, note or archived text, and the saving client (`mcp:`, `api:Chrome`, …). Actions: add tags, and file into a project if the item has none. Because core applies rules, every client benefits: MCP, the API, the CLI and the desktop app. Actions are attributed to `rule:<name>`. Rules are device-local configuration; they aren't synced.

## Backups and export

- **Snapshots:** `VACUUM INTO` copies taken while the library stays open. `runSchedule()` keeps 24 hourly, 30 daily and 12 monthly. The desktop app and `serve` call it every 10 minutes; `petty-memory backup` takes one on demand.
- **Restore:** `petty-memory restore <file|latest> --yes` verifies the snapshot (integrity check, schema version, looks like a library), snapshots the current library first as `pre-restore-*` so the restore can be undone, swaps the file in, and brings back any attachments the snapshot needs from `.trash/`. Other processes must be closed first.
- **Export Everything:** `petty-memory export <folder>` writes readable Markdown and the original files, plus a complete `metadata.json`:
  - per project: `README.md` (description, instructions, memory), `decisions.md`, `tasks.md` and `links.md`
  - `notes/` with YAML front matter
  - `archive/`: the saved page text
  - `files/`: the originals

## Concurrency

SQLite runs in WAL mode with a 5 s busy timeout. The desktop app, a CLI invocation and several MCP stdio servers (one per AI client) can all open the same file safely. Writes use `BEGIN IMMEDIATE`. The desktop app or `serve` hosts the HTTP API and MCP endpoint, and stdio servers keep working alongside it.

## Search

- **Keyword:** SQLite FTS5 over `title`, `body`, `url` and `content`, with the porter stemmer and unicode61 tokenizer with diacritics removed. Ranking is bm25 with column weights 10 / 1.5 / 2 / 1. User text is tokenized, stopwords are dropped (unless they're the whole query), and every term is quoted so FTS syntax is inert. Terms are OR'd so partial matches still surface, and the last term is a prefix match.
- **Meaning:** items are chunked (≈1000 characters, 200 overlap, at most 48 per item) and embedded by an `Embedder`. The default is `LocalEmbedder`: all-MiniLM-L6-v2 through transformers.js and onnxruntime-node, int8, about 23 MB, downloaded once into the cache folder (see [Data location](#data-location)). Vectors live in `chunks` as float32 blobs and are searched brute-force in memory. That's fast enough for a personal library, and it avoids depending on pre-1.0 sqlite-vec. A trigger marks an item stale whenever its text changes, and the in-memory index reloads when another process writes vectors.
- **Hybrid:** reciprocal rank fusion (k = 60) of the two lists. Vector hits below the model's `minScore` (0.18 for MiniLM) are dropped, so an unrelated query returns nothing rather than the least-bad items. We chose MiniLM over bge-small because bge packs every score into 0.4–0.7, which makes a relevance floor impossible. `packages/embeddings/test/retrieval.test.ts` is the fixture eval: hybrid gets 5 of 6 paraphrased questions right at #1, keyword alone gets 1 of 6.
- Semantic search is on by default (`semanticSearch` setting). `serve` and the desktop app index in the background; `petty-memory index` does it on demand.

## Ingestion

`save → (pending) → fetch or read file → extract → setSource(title if empty, content, metadata) → index`. Saving never waits on the network: the CLI and MCP `save_link` wait up to 10 s so the user or model sees the real title, the API returns at once and a background `IngestWorker` finishes the job, and failures are recorded on the item (`metadata.ingest.status = failed`) for `petty-memory ingest --retry`. The `fetchLinks` setting turns all fetching off. Deterministic steps never depend on AI. A bookmark keeps its URL plus cleaned Markdown (and optionally the original HTML), so it outlives the page. Capture clients such as the browser extension and the share sheet send only `{url, title, selection, note}`. Extraction always runs on the computer that holds the library.

## AI providers (`packages/ai`)

Optional. With AI off (the default), everything else still works: capture, search including semantic, MCP, the API, backups.

- **One interface:** `complete({system, prompt, schema?, maxTokens?})` and `listModels()`.
- **Implementations:**
  - Anthropic uses the official `@anthropic-ai/sdk`, defaulting to `claude-opus-5` at `effort: low` with JSON-schema output and server-side refusal fallbacks (`fallbacks: "default"`).
  - OpenAI, OpenRouter and any OpenAI-compatible server (LM Studio, vLLM, llama.cpp) use Chat Completions with `json_schema`.
  - Ollama uses native `/api/chat` with `format` = schema. `num_ctx` and `num_predict` are sized to each request, because Ollama silently truncates from the start of long prompts.
  - Gemini uses `generateContent` with `responseJsonSchema`.
- **Reasoning models:** thinking inlined as `<think>` is stripped. Schema output that LM Studio returns in `reasoning_content` is accepted.
- **Enrichment:** a 2–3 sentence summary, up to 5 tags (existing ones preferred) and one existing project, stored as `metadata.ai` suggestions. They are applied on `accept`, or straight away with `aiAutoApply` on. The worker only sends items saved after enrichment was turned on (`aiEnrichSince`), so enabling it never bills a backlog.
- **Ask:** hybrid search → top 8 items → for each, the passages that share the most (IDF-weighted, lightly stemmed) terms with the question → an answer with numbered citations.
- **Prompt injection:** item text is wrapped in `<item>` / `<source>` tags, and the system prompts say it's material to describe, never instructions. Suggestions are data the user reviews. Nothing the model says executes anything.
- **Keys:** the CLI reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_COMPATIBLE_API_KEY`. The desktop app encrypts keys with the OS credential store (Electron `safeStorage`). Keys are never written to SQLite.
