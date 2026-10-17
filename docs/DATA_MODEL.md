# Data model

Source of truth: [`packages/core/src/migrations.ts`](../packages/core/src/migrations.ts). This document explains the *why*.

## Everything is an item

One `items` table holds every type: `note`, `bookmark`, `task`, `decision`, `file` and `image`. A new type is a new `type` value, not a new table. Search, tags, projects, relations, MCP and sync therefore work for every type without modification. Type-specific structured fields go in a side table keyed by `item_id`, as `tasks` does; files keep theirs in `attachments`.

`type` has no CHECK constraint on purpose: SQLite can't alter a CHECK without rebuilding the table. Core validates types against `ITEM_TYPES`.

## Tables

| Table | Purpose |
|---|---|
| `items` | `seq` (rowid alias), `id` (UUIDv7), `type`, `title`, `body` (the user's own words), `url`, `content` (text extracted from the source: untrusted), `metadata` (JSON: site, byline, excerpt, dates, word/page counts, `ingest.status`, `ai` suggestions), `intent` (read / watch / buy / revisit; guessed for links from the address and Open Graph type until the user sets one), `pinned_at`, `opened_at`, `remind_at` + `reminded_at` (fires once; rescheduling re-arms), `project_id`, `parent_id` (outline containment), `sort_order` (sibling ordering), `source` (the actor that created it), timestamps, `archived_at` |
| `attachments` | `item_id`, `sha256`, `filename`, `mime_type`, `size`. The bytes live at `attachments/<sha[0:2]>/<sha>`, written atomically and shared by identical files. |
| `tasks` | `item_id`, `status` (open / in_progress / done / cancelled), `priority` (1 high, 2 normal, 3 low), `due_at`, `completed_at` |
| `projects` | `id`, `name`, `slug` (unique handle for CLI/MCP), `description`, `instructions`, `memory` (Markdown document), `status` (active / paused / done / archived) |
| `tags`, `item_tags` | Normalized tag names (lowercase slug, 64 chars max) |
| `relations` | `from_id`, `to_id`, `kind` (related_to / references / derived_from / depends_on / supersedes), unique per triple |
| `changes` | Append-only activity and change log. See below. |
| `settings` | Key/value. `device_id` is generated on first open. `pref.*` holds per-library preferences (`fetchLinks`, `semanticSearch`, the AI provider and model, `syncFolder`). `sync.*` holds sync state, including the derived folder encryption key and per-server cursors. `vault.salt` and `vault.check` hold the host vault's salt and encrypted check value, never a key. |
| `rules` | Automations: name, `conditions` and `actions` JSON, enabled. Configuration, so not in the change log. |
| `sync_versions`, `sync_cursors` | Per-entity newest/last-exchanged clock stamps, and the last segment applied from each other device (see [SYNC.md](SYNC.md)). |
| `sync_pending` | Synced references that arrived before their target (an item before its project or outline parent, a relation before its items), linked once the target lands. |
| `api_clients` | HTTP clients: name, SHA-256 of the token, scopes, last used, revoked. Not user content, so it's never logged or synced. |
| `idempotency` | Stored responses to API writes that carried an `Idempotency-Key`, per client, so a retry after a lost response gets the original answer. |
| `item_versions` | Immutable item states (`state` JSON, null for deleted), one per user-visible change, local or synced, with `actor`, `op`, `parent_id` and `snapshot_seq` for rebuilding a subtree at that point. Built by each device from the changes it applies, so not synced. Upgraded libraries get one `baseline` version per item holding the state at upgrade; earlier states aren't invented. |
| `public_shares` | Public read-only links: `root_id`, SHA-256 of the token, `excluded_ids`, `expires_at`, `revoked_at`. Configuration, so not logged or synced. |
| `items_fts` | FTS5 external-content index over `title`, `body`, `url` and `content`, kept in sync by triggers. bm25 weights 10 / 1.5 / 2 / 1. |

## Invariants

- **IDs** are UUIDv7 strings everywhere. Two devices can create objects independently without coordinating.
- **`items.seq` is an explicit `INTEGER PRIMARY KEY`** because `items_fts` is keyed on it. An implicit rowid can be renumbered by `VACUUM`, which would silently misalign the index. A test covers this.
- **Timestamps** are ISO 8601 UTC strings with milliseconds, so they sort lexically. A task's `due_at` is either a `YYYY-MM-DD` date (all-day) or a full timestamp.
- **Decisions are append-only.** Core refuses to edit or archive a `decision`. A change is a new decision plus a `supersedes` relation pointing at the old one. Only the user can hard-delete one, from the CLI or the desktop app.
- **Nothing is deleted through AI clients.** Archive is reversible. Hard delete is only in the CLI and the desktop app, needs explicit confirmation, and leaves a `delete` tombstone in `changes`.
- **Project memory keeps its history.** Each `set_memory` change stores the full new text, so every earlier version can be recovered from `changes`.
- **Checklist completion has one authority per item:** `tasks.status` for tasks, `metadata.presentation.checked` for other ordinary items. Decisions take no part.
- **A project's slug is unique.** Names that slug the same ("Garage Door" / "garage-door") conflict. References resolve by id, then exact slug, then an *unambiguous* slug prefix.

## The change log

Every write goes through `Context.record()` inside the same transaction as the write:

```
changes(seq, id, device_id, actor, entity, entity_id, op, project_id, data, at, hlc)
```

- `actor`: `cli`, `desktop`, `mcp:<client name>` (from MCP client info, e.g. `mcp:claude-code`), `api:<client name>` (the browser extension and the iOS app write through the API under their token's name), `ai` (enrichment), `rule:<name>` (automations) and `import:<format>`.
- `entity`: `item` | `project` | `relation`.
- `op`: `create`, `update`, `archive`, `unarchive`, `delete` (also a removed relation), `move` (outline parent and sibling key), `tag`, `set_memory`, `ingest` (extracted title/content/metadata), `attach` (a file's hash, name, type and size), `pin`, `unpin`, `intent`, `remind`, `reminded`, `open`, `enrich` (AI suggestions), `accept`, `present` (presentation), `check`, `organized` (auto-organize bookkeeping), `restore` (an item version restored), and `sync` (a change applied from another device).
- `data`: the *new* values of the changed fields (null for changes applied from another device, whose state lives in the sync segment). Applied in order, the log reconstructs each object. It powers the activity view and sync ([SYNC.md](SYNC.md)).
- `hlc`: the hybrid logical clock stamp that orders changes across devices.

## Migrations

- `PRAGMA user_version` is the schema version. A migration's version is its 1-based position in `MIGRATIONS`. **Append only**: never edit, reorder or remove a shipped migration.
- Each migration runs in its own transaction together with its `user_version` bump. A failure rolls back completely.
- Before upgrading an existing library, core writes `backups/pre-migration-v<N>-<timestamp>.sqlite` with `VACUUM INTO`.
- A library with a newer schema than the build knows is refused, not touched.
- Every new migration needs a test that upgrades a populated library from the previous version and checks nothing was orphaned or lost.

## Item metadata added by the parity layer

These live in `items.metadata`, so the Item shape and the sync record are unchanged:

- `presentation`: `{kind: text|heading|section, attention: normal|high|low, review, checklist, hideCompleted, checked, autoOrganize}`, with defaults filled in on read.
- `secret: true` and `vault`: a secret note's sealed envelope `{v: 1, kdf, salt, iv, tag, data}` (AES-256-GCM, item id as associated data; `kdf` is PBKDF2-SHA256 600,000 or the older scrypt). The note's `title` is "Secret note" and its `body` is empty.
- `organized`: `{hash, at}`, the subtree state the background organizer last left, so its own edits don't trigger another pass.

Inline references are stored in body text as `[[item:<UUID>|label]]`; backlinks are parsed from them, not stored.

## Body vs content

`body` is what the user (or their agent) wrote: a note, or why a link matters. `content` is what came from the source: a page's readable Markdown, a PDF's text, a text file. Keeping them apart lets search rank the user's words higher, lets exports and UIs label source text as quoted material, and keeps extracted text from ever looking like the user's instructions.

## Derived data

`chunks` (item, model, ordinal, text, float32 vector) and `embedded_items` (which items are current for which model) are rebuildable from `items`. They aren't in the change log and are never synced. The `items_embedding_stale` trigger deletes an item's `embedded_items` row whenever its title, body or content changes.
