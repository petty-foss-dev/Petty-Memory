# Changelog

## Unreleased

- Saved AI chats, opt in per conversation: save, search, reopen, continue, update and archive. Saved chats are ordinary plaintext notes (at most 100 messages and 200,000 characters) that sync and export. Unsaved chats are still not stored. Any cited answer can be saved as a note with its sources as item references.
- Suggested actions in AI chat: tasks, tags, reminders and a brief from a branch or keyword topic. Operations are previewed individually and selected ones apply atomically. Stale proposals are refused, and Undo is refused over newer work.
- Topic organization adds up to 50 notes found by meaning, marked Suggested, to the complete keyword matches. It falls back to keyword matches only when semantic search is unavailable.
- Note dictation when capturing on desktop, browser and iPhone, with system dictation guidance where in-app speech is unavailable. Image text extraction with an editable draft before saving, keeping the original image: bundled English Tesseract on the library host, and Vision on iPhone.
- Daily review: a local queue of notes, links, files and images, with Tomorrow, next week, next month or custom intervals and per-item review history.
- Suggested connections without AI: unlinked mentions, related notes and possible duplicates. Duplicate merges show a preview, keep the merged note archived with its files, refuse stale previews and support Undo.
- Enve Book Player highlight, annotation and bookmark import from JSON or Markdown exports, with a preview and a project choice. Repeat imports are skipped. A version 1 interchange format can carry optional safe source links.
- First-run checklists on desktop, browser and iPhone. They never change the library or turn on AI.
- CLI commands and HTTP API routes for saved chats, review, insights, merges, actions, OCR and Enve imports. See [docs/POWER_FEATURES.md](docs/POWER_FEATURES.md).
- AI chat on desktop, browser and iPhone: cited follow-ups, selected-branch edit proposals and natural-language library organization with reviewed placements and guarded undo.
- Voice-to-draft input through native iPhone speech recognition and the Web Speech API where available, with system dictation guidance elsewhere. Sending and applying remain explicit.
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
