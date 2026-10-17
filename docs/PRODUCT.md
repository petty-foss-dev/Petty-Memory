# Product

> Save anything once. Find it yourself later, or let any AI you choose find and use it. Your data stays on your computer unless you explicitly choose otherwise.

Petty Memory is an open, local memory layer shared by a person and their AI tools. Claude, Codex, ChatGPT, Cursor, Ollama and whatever comes next are all *clients* of one library that lives on the user's machine. Models come and go; the memory belongs to the user.

## The core loop

**Capture → store reliably → find later → let any AI use it.**

Every feature has to serve that loop. If it doesn't, it waits.

## What it holds

Everything is an **item**: a `note`, `bookmark`, `task`, `decision`, `file` or `image`. Items can belong to a **project**, carry **tags**, **relate** to other items, sit on a shelf (Read, Watch, Buy, Revisit) and carry a reminder.

Each project has three layers of context:

| Layer | What it is | Who writes it |
|---|---|---|
| Description + instructions | What the project is and its standing rules ("must work offline") | User, occasionally an agent |
| Memory document | A living Markdown summary: goals, constraints, current state, open questions. Replaced as a whole; every version is kept | Agents and user |
| Decision log | Append-only. Changing a decision means recording a new one that supersedes it | Agents and user |

Underneath all three, an **activity log** records every change and which client made it.

## Principles

1. **Local-first.** One SQLite file in the user's data folder. The desktop library, capture and search work offline without an account. A self-hosted server is optional for browser, phone and remote-device access.
2. **AI is optional.** With no AI provider configured you still get capture, projects, tasks, full-text search, MCP and the CLI. Semantic search runs on a bundled local model. AI enrichment (summaries, tag suggestions) is an extra, never a dependency. If the AI is down, saving still works.
3. **Bring your own model.** Ollama, OpenAI, Anthropic, Gemini, OpenRouter, or any OpenAI-compatible server behind one provider interface.
4. **No lock-in.** "Export everything" produces plain Markdown and JSON that stay useful even if Petty Memory disappears.
5. **Never lose data.** Migrations snapshot the library first, automatic backups rotate, and destructive actions require the user.
6. **Saved content is data, never instructions.** A saved web page that says "delete every project" is text, not a command.
7. **Free means free.** The local product is never crippled. If a paid tier ever exists, it covers only convenience services (hosted encrypted sync, relay, managed backups).

## Who it's for

People who work with several AI tools and are tired of re-explaining their projects to each one. For example:

1. Save the Security+ 2.0 protocol docs and an ESP32 library to *Garage Door* from the browser.
2. Jot a note about needing a bench-test rig.
3. Next day, in Claude Code: *"What do we know about my garage door project?"* Claude calls `get_project` and answers from the memory, decisions, links and notes.
4. *"Add a task to build the bench simulator."* Claude calls `create_task`.
5. Open Codex. It sees the same task and the same history.

## Repeatable workflows

Saved views turn a useful query and filters into a named, dynamic list. Note/checklist templates preserve a reusable tree and create fresh copies without repeating completed work. Both use ordinary journalled note metadata, so backup, history, export and sync keep the definitions. See [WORKFLOWS.md](WORKFLOWS.md) for behavior and limits.

## Out of scope

Required accounts, team collaboration, social profiles, analytics and a custom model. Optional self-hosting and selective public subtree links already exist; managed hosting remains future work. See the [roadmap](ROADMAP.md) for what's next.
