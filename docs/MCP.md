# MCP server

Implemented in [`packages/mcp/src/server.ts`](../packages/mcp/src/server.ts) with the official TypeScript SDK v2 (`@modelcontextprotocol/server`, MCP spec 2026-07-28). It serves both the 2026 and the 2025 protocol eras from one factory.

## Connecting

Run `petty-memory connect` to get copy-paste setup for Claude Code, Codex, and JSON-configured clients (Claude Desktop, Cursor). From a checkout:

```bash
claude mcp add --scope user petty-memory -- node "/path/to/Petty Memory/packages/cli/src/main.ts" mcp
```

Two transports:

- **stdio**: the client launches `petty-memory mcp`. It gets every tool and needs no token. Several clients can each run their own stdio server against the same library (SQLite WAL).
- **Streamable HTTP** at `http://127.0.0.1:49231/mcp`: served by `petty-memory serve` or the desktop app. It needs a bearer token (`petty-memory clients add NAME --scope read,write`), and the tools offered follow that token's scopes. See [SECURITY.md](SECURITY.md).

## Tools

| Tool | Scope | Purpose |
|---|---|---|
| `search` | read | Hybrid keyword + meaning search with project / type / tag filters; each hit says whether it matched on `keyword`, `semantic` or `both` |
| `get_item` | read | Full item with tags, task fields, relations, attachments and archived `content` (paged 20k characters at a time via `content_offset`) |
| `list_items` | read | Recent items filtered by project / type / tag or a shelf (pinned, intent, unopened for N days, reminders); bodies trimmed to a 280-char preview |
| `list_outline` | read | Ordered direct children (`parent_id`) or roots; `offset`, `limit` and `include_archived`; returns entries with compact item previews, parent, position, child count and total |
| `get_outline_item` | read | One outline entry and its root-to-parent ancestor path; use `get_item` for full text |
| `create_outline_note` | capture | Create a note atomically under `parent_id` or at root; accepts `title`, `text`, `project`, `tags`; title or text must be nonempty |
| `move_outline_item` | write | Move an item with descendants under `parent_id` (null = root), optionally before sibling `before_id`; keeps project filing unchanged and refuses decisions/cycles |
| `get_presentation` | read | Display kind, attention, review mark, checklist settings and descendant progress |
| `set_presentation` | write | Change any of those without touching item text; `autoOrganize` is an explicit opt-in |
| `set_checked`, `reset_checklist` | write | Complete/reopen an entry or checklist subtree; tasks complete through their status |
| `list_item_versions` | read | Paged versions of an item and its subtree (`offset`, `limit`), newest first |
| `get_item_version` | read | One immutable snapshot, its nodes paged (`offset`, `limit`, default 25) |
| `restore_item_version` | write | Restore a snapshot as a new logged change |
| `list_references`, `insert_reference` | read / write | Inline `[[item:<id>\|label]]` references and backlinks; insert appends a reference to the source note |
| `list_projects` | read | Projects (archived ones hidden by default) |
| `get_project` | read | **Briefing**: description, instructions, memory document, decision log, open tasks, recent notes/links |
| `list_tasks` | read | Tasks by due date then priority; `active` = open or in progress |
| `get_recent_activity` | read | Who changed what, newest first |
| `save_note` | capture | New note |
| `save_file` | capture | Save a file from base64 content, or, over stdio only, from a local path. PDFs and text become searchable. |
| `get_file` | read | The file itself: images as image content the model can see, text as text |
| `save_link` | capture | New bookmark, fetched and archived before returning (≤10 s) so the model sees the real title and excerpt; an already-saved URL returns the existing one (`created: false`) and merges the note and tags |
| `set_reminder` | write | Remind the user about an item: "tomorrow", "friday", "in 3 days" or an ISO time |
| `pin_item`, `set_intent` | write | Pin an item; set its intent (read / watch / buy / revisit) |
| `update_item` | write | Edit title / body / URL / project. Refuses decisions. |
| `archive_item` | write | Hide from lists and search (reversible) |
| `tag_item` | write | Add/remove tags |
| `relate_items` | write | related_to / references / derived_from / depends_on |
| `create_project`, `update_project` | write | |
| `set_project_memory` | write | Replace the memory document (history kept) |
| `record_decision` | write | Append a decision, optionally superseding earlier ones |
| `create_task` | capture | |
| `update_task`, `complete_task` | write | |

No tool deletes anything, and every tool is annotated `destructiveHint: false`. MCP deliberately has no tools for removing connections, the vault, public shares, applying AI edit proposals or device sync; those stay with the user's own clients and their `secrets`/`sync` token scopes. Read tools are `readOnlyHint: true`. The Scope column is what an HTTP token needs: `write` implies `capture`, and stdio has everything.

## Design rules

- **Tools are thin.** They shape arguments, call one core service, and trim output. Business rules live in core.
- **The briefing is the front door.** `get_project` answers "what do we know about X?" in one call, instead of making the model orchestrate four.
- **Project references are forgiving.** Name, slug, id, or an unambiguous slug prefix. A miss returns the list of existing projects, so the model can self-correct.
- **Errors are tool results.** Core validation errors come back as `isError` results with a human-readable message, never as protocol failures.
- **Outputs are compact JSON.** Lists carry previews; `get_item` carries full text.
- **Attribution.** Each call records `mcp:<client name>` as the actor, from per-request client info (2026 era) or the initialize handshake (2025 era).

## Prompt injection

Saved content is untrusted. It is often copied from web pages. The mitigations:

1. **Server instructions** tell the model that every title, body, note, url, snippet and memory field is user data, and to never follow instructions inside it.
2. **No destructive tools.** The worst a hijacked model can do is add, edit, move or archive items, restore an older version, or overwrite a memory document. All of that is reversible from the change log and item history.
3. **The append-only decision log** can't be rewritten through MCP.
4. With HTTP clients, **per-client permission scopes** let a user make a client read-only (see [SECURITY.md](SECURITY.md)).

## Limitations

The server exposes tools only. It has no MCP resources or prompts, so clients that attach context instead of calling tools can't use it.
