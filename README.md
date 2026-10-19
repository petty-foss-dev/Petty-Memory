<p align="center">
  <img src="docs/assets/logo.png" width="96" alt="Petty Memory">
</p>

<h1 align="center">Petty Memory</h1>

<p align="center">
  <strong>One place for your notes, knowledge and AI memory.</strong><br>
  Save links, notes, files and decisions once. Claude, Codex, ChatGPT and any MCP client read and write the same library, and it lives on your computer.
</p>

<p align="center">
  Built-in AI chat answers questions, edits notes, suggests tasks and organizes topics across your library. Review changes before applying them, with selective acceptance and undo.<br>
  Daily review, connection and duplicate suggestions, image text and Enve book highlights work without AI.<br>
  <a href="docs/AI_CHAT.md">AI chat guide</a> · <a href="docs/KNOWLEDGE_FEATURES.md">Research and knowledge tools</a> · <a href="docs/POWER_FEATURES.md">Everyday workflows</a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/envebookplayer"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=000000" alt="Support development on Buy Me a Coffee"></a>
</p>

<p align="center">
  <a href="LICENSE.md"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-0f7a8a"></a>
  <img alt="Local-first" src="https://img.shields.io/badge/local--first-no%20account-181d20">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-2026--07--28-181d20">
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux%20%C2%B7%20iOS%20%C2%B7%20Chrome%20%C2%B7%20Firefox-181d20">
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="Petty Memory on the desktop, in the browser side panel and on iPhone">
</p>

## What you get

- **Capture from anywhere.** The desktop app (quick-capture window, drag and drop), the browser extension (popup, side panel, right-click, one-click import of your browser bookmarks, offline queue), the iOS app and its share sheet, the CLI, and any AI tool over MCP.
- **Pages that outlive the web.** Saved links are fetched and stored as readable Markdown, and PDFs and text files are extracted, so everything stays searchable even after the original page disappears.
- **Search by words and by meaning.** Full-text search plus a local embedding model (no cloud), fused so both exact terms and paraphrases surface, with a relevance floor so irrelevant results don't crowd in.
- **Project memory for AI agents.** Each project has standing instructions, a living memory document (every version kept), an append-only decision log, tasks, and a briefing an agent reads in one call.
- **Formatted editing.** Shared rich-text and Markdown editing, note split/join, and undo/redo for text and structural changes.
- **Ordered outlines.** Nest items inside other items, keep their sibling order, and move a parent with its children. The desktop Outline and the CLI, MCP and HTTP API use the same core rules; existing notes and project filing stay intact.
- **Organize, review and recover.** Headings and section breaks, attention levels, review marks, highlights and nested checklists; inline item references with backlinks; per-item history with compare and restore; and optional AI edit proposals you review, apply selectively and can undo.
- **Secret notes and public links.** Passphrase-encrypted notes, nested secret branches and encrypted files, sealed on the device in the browser and on iPhone, with portable recovery kits. Read-only public links to a chosen subtree, with parts left out, expiry and revocation. See the [security model](docs/SECURITY.md); these features have engineering and interoperability tests, but no production security audit.
- **In the browser.** A browser client served by the desktop app or a small self-hosted launcher ([apps/web](apps/web)), for your own devices.
- **Shelves and reminders.** Pinned, Read, Watch, Buy, Revisit, "unopened for a month". Reminders take plain words ("tomorrow", "friday") and notify on the desktop, the phone or in the browser.
- **Saved views.** Name a recurring search such as "Open Garage tasks" or "Security articles to read". Combine keywords, project, type, tag, task status and attention filters; the results follow the current library. Available on desktop, web, iPhone, CLI and MCP.
- **Reusable templates.** Turn an ordinary note/checklist tree into an editable template, then create fresh copies for meeting notes, research briefs or recurring checklists. Copies keep nesting and references, reset completed boxes and expand `{{date}}` and `{{project}}`. [Examples and limits](docs/WORKFLOWS.md).
- **Chat with your library.** Ask questions with source links, discuss follow-ups, or say “organize all notes about gardening into a PARA system.” Review the proposed hierarchy and note placements, keep the branches you want, apply them together and undo safely. Ask for tasks, tags, reminders or a brief from a branch or topic, and review each before applying. Chats are kept only when you save them. Dictate into the draft on iPhone and supporting browsers, with system dictation available on desktop. [Chat and voice guide](docs/AI_CHAT.md).
- **Review and connect what you know.** A daily review queue brings notes back on a schedule you choose. Find connections suggests unlinked mentions, related notes and possible duplicates, and duplicates can be merged with a preview and undo. Neither needs AI. [Everyday workflows](docs/POWER_FEATURES.md).
- **Text from images, highlights from books.** Extract text from an image locally and review it before saving, with the image kept. Import Enve Book Player highlights and annotations; importing again skips what you already have.
- **Optional AI, bring your own.** Ollama, OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible server for summaries, tag and project suggestions (or automatic filing), and cited answers from your own library. Everything else works with AI off.
- **Automations.** For example, "links from github.com → #code, file into Development".
- **Sync between your computers** through a folder you already sync (iCloud Drive, Dropbox, Syncthing), with optional passphrase encryption, or through a Petty Memory server you run yourself. Server sync watches local changes and long-polls for incoming work; folder sync runs periodically. Conflicting text is retained for review.
- **Petty appearance.** Cool gray surfaces, teal accents, light/dark themes and true-black OLED on iPhone.
- **Yours to keep.** Automatic hourly, daily and monthly backups; Export Everything to Markdown, JSON and the original files; importers for browser bookmarks, Markdown folders or Obsidian vaults, bookmark CSVs, and Enve exports.

## Daftak feature comparison

This work began as a public challenge to build an open-source alternative to [Daftak](https://www.daftak.com/). Petty Memory is an independent implementation under AGPL-3.0-only. The table maps all **17 feature groups** on Daftak's public page, reviewed October 17, 2026, to implemented Memory capabilities.

| Advertised capability | What Petty Memory implements |
|---|---|
| Nested items | Ordered, paged outlines; move, indent and outdent whole branches while keeping stable item identities. |
| Automatic formatting | A formatted editor with toolbar controls, semantic headings and checklists, plus optional Markdown source. Existing Markdown stays intact. |
| Automatic organization | Opt-in background organization, selected-branch proposals and natural-language topic organization across the library, with review, selective acceptance and guarded undo. |
| Attention levels | Raise or lower an item's visual emphasis without changing its content or filing. |
| Checklists | Nested completion and progress, completed-item visibility and quick reset. |
| Connections | Create and remove relations between items; browse related items, backlinks and the desktop graph. Suggested connections are offered without AI. |
| Item history | Automatic item/subtree snapshots, comparisons and restore as a new change; historical attachment bytes are retained. |
| AI assistance | Chat with optional saving, dictated prompts, cited answers, scoped editing, suggested actions and topic-wide grouping with selective acceptance and guarded undo. Bring your own provider or keep AI off. |
| Inline references | Insert references to stable item identities from the editor and navigate to the referenced item. |
| Hybrid encryption / secrets | Optional encrypted notes, nested secret branches and encrypted attachments, with locking, recovery kits and scoped device access. See the encryption differences below. |
| Selective sharing | Read-only public subtree links with excluded branches, expiry and revocation. Secrets are excluded. |
| Highlights | A highlights view, explicit highlighting/pinning and optional AI suggestions. |
| Tags | Tag capture, editing, filtering and search across the library. |
| Section breaks | Labeled dividers between unrelated sections of an outline. |
| Review marks | Mark items that need improvement or organization and find them again. |
| Instant sync | Local change watching and server long-polls; foreground browser/iPhone refresh; optional encrypted folder sync runs periodically. |
| Data ownership | Import, export, deletion, portable Markdown/JSON/original files and full-library backups. |

**All 17 groups have implementations.** The [verification record](docs/PARITY_VERIFICATION.md) lists the tested workflows and remaining release checks; this is not a claim of identical signed-in behavior or production certification.

A few differences matter when choosing how to run it:

- **You host the library.** Use the desktop app or the [self-hosted browser/server setup](docs/SELF_HOSTING.md). A managed account service has not been deployed, and the local product needs no account.
- **Encryption is selective.** Secret payloads and files are encrypted; ordinary SQLite content and some structural metadata remain readable on the host. Configure TLS for remote access. [Security details](docs/SECURITY.md) explain key handling, recovery and limits.
- **iPhone keeps an ordinary offline library.** Browse, search and queue edits offline. Secret notes, server history, public links, AI, saved-chat resuming, daily review, connection suggestions and imports need a connection. Saved transcripts remain readable as ordinary cached notes; attachment listings are cached, file bytes are not mirrored automatically.
- **Release work remains.** Physical-device/background/share-sheet acceptance, full accessibility/IME and performance checks, Windows/Linux installer validation, signing and store distribution still need their respective environments. Daftak lists native mobile apps, collaboration and image support as roadmap work; Memory already has iPhone and image capture, while team collaboration is outside this comparison.

## Workflows beyond the comparison

The comparison above covers Daftak's 17 public feature groups. These additions go further, and most work without an AI provider:

- **Saved chats.** Opt in per conversation. A saved chat is an ordinary plaintext note that syncs, exports and searches like any other. Unsaved chats are not stored.
- **Suggested actions.** Tasks, tags, reminders and a brief from a branch or topic. Each operation is previewed. Selected operations apply together, stale proposals are refused, and Undo stops before overwriting newer work.
- **Broader topic organization.** Keyword discovery stays complete. Up to 50 related-in-meaning notes are added and marked Suggested, with keyword-only results when semantic search is unavailable.
- **Voice and image capture.** Dictate a note, or extract text from an image and correct it before saving. The original image is kept. Image text is read locally: by Tesseract (English) on the library host for desktop and browser, and by Vision on iPhone.
- **Daily review.** A local schedule and review history on each item. Choose when to see each item again. No background service or extra notifications.
- **Connections and duplicate cleanup.** Unlinked mentions, related notes and possible duplicates are found without AI. Merges are previewed, keep the original note archived with its files, and can be undone.
- **Enve book highlights.** Preview and import highlights, annotations and bookmarks from Enve Book Player's JSON or Markdown export. Importing again doesn't create duplicates. Enve's export has no book identifiers or source links, so there is no live sync or deep link back into a book.
- **Getting started.** A first-run checklist on desktop, browser and iPhone. AI and accounts stay optional.

The Knowledge workspace adds seven further workflows:

- **Reusable AI commands.** Save a named instruction and scope, then run it against fresh notes. Review tasks, tags, reminders and briefs before Apply; guarded Undo remains available.
- **Explicit organization preferences.** Save filing and organization instructions, optionally per project, and choose which ones each workflow or organization request should use.
- **Typed collections.** Add text, number, date, checkbox and select fields, then use table, card or Kanban layouts with typed filtering and sorting.
- **Audio research.** Record or import audio, preview/save timestamped captions, seek to cues and keep source-linked passages. Optional transcription uses a separately configured speech server with confirmation for each recording.
- **PDF research.** Read and search by page, annotate exact passages, recognize scanned pages into reviewed text, and follow AI citations to a page or recording timestamp. Originals are retained.
- **Watched sources.** Opt into checks for pages, RSS/Atom feeds or a locally approved folder. New and changed material waits for selected import or update, preserving originals and history.
- **Information review.** Find older notes, mark them checked and review possible conflicts using exact quotes and separate dates. Explicitly choose which ordinary note supersedes another; AI never silently rewrites claims.

[Knowledge workflows](docs/KNOWLEDGE_FEATURES.md) explains these features, limits and privacy boundaries. [Verification](docs/KNOWLEDGE_VERIFICATION.md) records their actual acceptance checks.

| Typed collections | Reviewed AI workflows |
|---|---|
| ![Collection with typed fields in the packaged desktop app](docs/screenshots/knowledge/desktop-collections.png) | ![A saved workflow and selected organization preference in the browser](docs/screenshots/knowledge/browser-workflow.png) |

[Everyday workflows](docs/POWER_FEATURES.md) explains each workflow, its limits and its privacy boundaries. [Verification](docs/POWER_VERIFICATION.md) records the checks for this batch; physical-device acceptance for microphone, camera and Vision text recognition is still outstanding.

Saved views and templates came first. For example, create a view named **Garage work** with project *Garage Door*, type *Task* and status *Open*. It updates as tasks are added and completed. Save a **Weekly review** note with nested checklist entries as a template, then choose a destination project when creating the next review. Both workflows work without an AI provider.

Desktop and browser evaluate views locally on their library host. iPhone can display cached lists/results when disconnected; creating or editing views and copying template trees requires the paired server. These are keyword/filter views, with cursor paging, rather than saved semantic rankings. [Workflow guide](docs/WORKFLOWS.md) includes CLI and MCP usage and the research references behind this batch.

| Saved view | Note created from a template |
|---|---|
| ![Saved keyword view with current results](docs/screenshots/workflows/browser-views.png) | ![Template copy with its date expanded](docs/screenshots/workflows/browser-template.png) |

## Chat and organize notes

Configure your provider in desktop **Settings → AI**, or with `petty-memory ai use` on a self-hosted server. Your phone and browser use that host's provider.

In **AI chat → Organize library** (Organize on iPhone), type or dictate:

> Organize all notes about gardening into a PARA system.

Memory finds matching notes across projects and proposes a destination, headings and placements. Review the tree, untick anything that does not belong, then move the selection together. Note contents, files, identities and project filing stay intact. Undo protects newer work. Questions and follow-ups have source links; Change notes proposes edits to a branch you choose. [The guide](docs/AI_CHAT.md) explains keyword matching and suggestions, size limits, saving chats and provider privacy.

Dictation fills the draft and never sends or applies automatically. iPhone uses native speech recognition; supporting browsers use Web Speech. Desktop offers system dictation guidance when in-app speech is unavailable. Live microphone acceptance still needs a physical-device run.

Choose **Suggest actions** (Actions on iPhone) for tasks, tags, reminders or a brief. Each operation is reviewed before applying; the examples below use fictional notes.

| Desktop action review | iPhone action review |
|---|---|
| ![Select tasks, tags, reminders and a brief before applying](docs/screenshots/power/desktop-actions.png) | <img src="docs/screenshots/power/iphone-actions.png" width="260" alt="iPhone action review with the proposed brief excluded"> |

| Desktop organization review | iPhone organization review |
|---|---|
| ![Selective organization with preserved child notes](docs/screenshots/chat/desktop-organize-review.png) | <img src="docs/screenshots/chat/iphone-organize-review.png" width="260" alt="Native iPhone organization review with one note excluded"> |

## Screenshots

### Outlines and formatted editing

| Desktop outline | Browser editor |
|---|---|
| ![Ordered desktop outline in the Petty dark palette](docs/screenshots/parity/outline-dark.png) | ![Formatted browser editor in the Petty light palette](docs/screenshots/parity/browser-editor-light.png) |

### Desktop

| | |
|---|---|
| ![Home](docs/screenshots/desktop/home.png) | ![Project briefing](docs/screenshots/desktop/project.png) |
| **Home.** Quick capture, reminders, recent items. | **Project briefing.** Instructions, a living memory document, tasks: what an AI reads first. |
| ![Decision log](docs/screenshots/desktop/project-decisions.png) | ![Archived page](docs/screenshots/desktop/item.png) |
| **Decision log.** Append-only; replaced decisions stay visible as history. | **Archived pages.** The readable text is saved locally, next to your note, tags and reminder. |
| ![Search](docs/screenshots/desktop/search.png) | ![Inbox](docs/screenshots/desktop/inbox.png) |
| **Search by meaning.** "How does the remote avoid replay attacks" finds the rolling-code article. | **Inbox with AI suggestions.** Summaries, tags and a project to accept, or file automatically. |
| ![Activity](docs/screenshots/desktop/activity.png) | ![Graph](docs/screenshots/desktop/graph.png) |
| **Activity.** Which AI did what: Claude Code, Codex, the extension, your phone. | **Graph.** Items, projects and tags, connected. |
| ![AI tools](docs/screenshots/desktop/settings-ai-tools.png) | ![Devices](docs/screenshots/desktop/settings-devices.png) |
| **Connect AI tools.** One-click setup for Claude Code, Codex and JSON-configured clients. | **Devices.** Scoped tokens and QR pairing for your phone. |
| ![Ask](docs/screenshots/desktop/ask.png) | ![Light theme](docs/screenshots/desktop/home-light.png) |
| **Ask your library.** Answers only from what you saved, with sources; replaced decisions give way to current ones. | **Light theme**, or follow the system. |

### Browser extension

![Side panel beside a page](docs/screenshots/extension/panel-in-browser.png)

| | | |
|---|---|---|
| ![Side panel](docs/screenshots/extension/sidepanel.png) | ![Popup](docs/screenshots/extension/popup.png) | ![Import](docs/screenshots/extension/import.png) |
| **Side panel.** This page, related items from your library, and shelves. | **Popup.** Save with project, tags, intent, reminder and the selected text. | **One-click import** of your browser's bookmarks, folders becoming tags. |

### iPhone

Home keeps quick capture, Ask AI, Library and recent notes in view. Open Library for the outline, daily review, shelves, saved views, templates and other tools.

| Home | Outline | Formatted editor |
|---|---|---|
| ![iPhone home in the Petty dark palette](docs/screenshots/parity/ios-home-dark.png) | ![iPhone ordered outline](docs/screenshots/parity/ios-outline-dark.png) | ![iPhone formatted editor](docs/screenshots/parity/ios-editor-dark.png) |

Screenshots use disposable fictional libraries. The [verification record](docs/PARITY_VERIFICATION.md) includes light/dark captures and the tested recovery workflows.

## Install

Build from `main` for the feature layer described here; published installers follow their own release version.

- **Desktop (macOS):** download the `.dmg` for Apple Silicon or Intel from [Releases](../../releases). The builds aren't notarized yet, so the first time, right-click the app and choose **Open**. Intel Macs use keyword search: the local embedding runtime has no Intel build.
- **Windows and Linux:** installers are configured (NSIS, AppImage, deb). Build them with `npm --prefix apps/desktop run dist:win` or `dist:linux` on that OS.
- **Browser extension:** run `node apps/extension/scripts/build.mjs`, then load `apps/extension/dist/chrome` in `chrome://extensions` (Developer mode → Load unpacked). Firefox: load `dist/firefox` from `about:debugging`. Create a token in the desktop app under Settings → Devices.
- **iPhone:** after `npm install`, run `sh apps/ios/scripts/build-editor.sh`, then generate the project in `apps/ios` with XcodeGen, set your team in Xcode, and run. Pair by scanning the QR code in Settings → Devices. See the [iPhone build guide](apps/ios/README.md).
- **CLI and MCP server only:** Node 24+, then `npm install` in this repository (see *Try it* below).

## How it works

```mermaid
flowchart LR
  subgraph You
    D[Desktop app]
    E[Browser extension]
    P[iPhone + share sheet]
    W[Browser client]
    C[CLI]
  end
  subgraph AI["AI tools"]
    CC[Claude Code]
    CX[Codex]
    O[ChatGPT, Cursor, …]
  end
  D --> Core
  C --> Core
  E -- "local API · scoped token" --> Core
  P -- "HTTP API over LAN / Tailscale" --> Core
  W -- "scoped HTTP API" --> Core
  CC -- "MCP (stdio)" --> Core
  CX -- "MCP (stdio)" --> Core
  O -- "MCP (HTTP)" --> Core
  Core["Petty Memory core<br/>services · rules · workers"] --> DB[("memory.sqlite<br/>FTS5 + vectors")]
  Core --> Files[("attachments/<br/>backups/")]
  Core -. optional .-> LLM["Your AI provider<br/>(Ollama, OpenAI, Anthropic…)"]
  Core -. optional .-> Sync[("Shared folder<br/>encrypted sync")]
  Core -. optional .-> Remote["Self-hosted server<br/>live sync + public links"]
```

Every client goes through the same core services, so the rules hold everywhere:

- every change is logged, with the client that made it
- decisions are append-only
- nothing an AI does can delete your data
- saved content is always treated as data, never as instructions

## Try it

Requires Node 24+.

```bash
npm install
npm run cli -- project new "Garage Door" --instructions "Must work without internet."
npm run cli -- link https://example.com/security-plus --title "Security+ 2.0 protocol" -p garage
npm run cli -- note "Need a bench rig before touching the real opener" -p garage
npm run cli -- decide garage "Use ESP32-S3" --reason "USB host support"
npm run cli -- project show garage
npm run cli -- search opener protocol
```

The desktop app is in [`apps/desktop`](apps/desktop): `npm --prefix apps/desktop run dev`, or `run dist:mac` for the installers. The browser extension is in [`apps/extension`](apps/extension), the iOS app in [`apps/ios`](apps/ios) and the browser client in [`apps/web`](apps/web) (`npm --prefix apps/web start -- --home ~/em-demo`, then connect with a token from `npm run cli -- --home ~/em-demo clients add "Browser" --scope read,write`); each README explains setup.

The planned [Daftak feature layer](docs/DAFTAK_PARITY_PLAN.md#current-status) is implemented and has passed the [documented functional checks](docs/PARITY_VERIFICATION.md). Release and external validation gates remain explicit.

## Connect your AI

```bash
npm run cli -- connect
```

This prints ready-to-paste setup for Claude Code, Codex and JSON-configured clients such as Claude Desktop and Cursor. The desktop app has the same setup under Settings → AI tools, with one-click "Add to Claude Code". Then ask your assistant *"What do we know about my garage door project?"*

The MCP server exposes search, briefings, notes, links, files, tasks, ordered outlines, presentation and checklists, item history, references, project memory, decisions, reminders and shelves. None of its tools can delete anything, decrypt secret notes, publish shares or replicate a library, and saved content is always presented to the model as data, never instructions. See [docs/MCP.md](docs/MCP.md). Devices and remote agents use the local [HTTP API](docs/API.md) with scoped tokens.

## Where your data lives

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/Enve Memory/` |
| Windows | `%APPDATA%\Enve Memory\` |
| Linux | `~/.config/Enve Memory/` |

Override it with `--home DIR` or `ENVE_MEMORY_HOME`.

## Docs

[Product](docs/PRODUCT.md) · [AI chat](docs/AI_CHAT.md) · [Everyday workflows](docs/POWER_FEATURES.md) · [Saved views and templates](docs/WORKFLOWS.md) · [Architecture](docs/ARCHITECTURE.md) · [Data model](docs/DATA_MODEL.md) · [MCP](docs/MCP.md) · [HTTP API](docs/API.md) · [Security](docs/SECURITY.md) · [Sync](docs/SYNC.md) · [Roadmap](docs/ROADMAP.md) · [Parity plan](docs/DAFTAK_PARITY_PLAN.md) · [Verification](docs/PARITY_VERIFICATION.md) · [Self-hosting](docs/SELF_HOSTING.md) · [Contributing](CONTRIBUTING.md)

## License

[AGPL-3.0-only](LICENSE.md). Plugins and clients that talk to Petty Memory over MCP or its API are separate programs.
