# Changelog

## Unreleased

- Saved views: reusable keyword searches with combined project, type, tag, task-status, shelf and attention filters, dynamic results and cursor paging.
- Note/checklist templates: atomic tree copies with fresh identities, remapped internal references, reset completion and optional date/project placeholders.
- Workflow management in desktop, browser and iPhone, with CLI and scoped MCP access. Definitions travel with ordinary library history, exports and sync; iPhone writes require a connection.

## 0.1.0 (2026-09-25)

The first release: the whole memory layer, apps on three platforms, and every AI tool reading and writing one library that lives on your computer.

### Library
- Everything is an item: notes, links, files, images, tasks and decisions, grouped into projects, with tags and relations.
- Projects carry standing instructions, a memory document (every version kept) and an append-only decision log. `get_project` hands an agent all of it in one call.
- Links are archived as readable Markdown; PDFs and text files are extracted. Pages stay searchable after they disappear from the web.
- Search matches words and meaning: SQLite FTS5 plus a local MiniLM embedding model, fused by reciprocal rank with a relevance floor.
- Shelves (Pinned, Read, Watch, Buy, Revisit, unopened for a month) and reminders in plain words ("tomorrow", "friday").
- Automation rules, a graph of items, projects and tags, and importers for browser bookmarks, Markdown/Obsidian folders, bookmark CSVs and Enve exports.
- Automatic hourly, daily and monthly backups, verified restore with undo, and Export Everything to Markdown, JSON and the original files.
- Folder sync between computers (iCloud Drive, Dropbox, Syncthing) with hybrid logical clocks, conflict notes instead of lost text, and optional passphrase encryption.

### AI
- MCP server over stdio and Streamable HTTP, with about 25 tools and none that delete. Saved content is always presented as data, never instructions.
- Optional bring-your-own AI (Ollama, OpenAI, Anthropic, Gemini, OpenRouter, any OpenAI-compatible server) for summaries, tag and project suggestions or automatic filing, and cited answers from your library.

### Apps
- **Desktop** (macOS, with Windows and Linux configured): library, project briefings, search palette, Ask, activity, graph, shelves and reminder notifications, and settings for AI tools, devices (QR pairing), sync, automations, import and backups.
- **Browser extension** (Chrome, Edge, Firefox): popup, side panel with "this page" and related items, right-click and shortcut saving, one-click import of the browser's bookmarks, and an offline queue.
- **iOS**: capture, search, projects, tasks and shelves, plus a share extension, an offline outbox and reminders as local notifications.
- **CLI**: every feature, plus `serve`, `connect`, `sync`, `import`, `export` and `backup`.

### Local HTTP API
Loopback by default, scoped bearer tokens stored only as hashes, Host and Origin checks, idempotency keys, and paging. See [docs/API.md](docs/API.md).
