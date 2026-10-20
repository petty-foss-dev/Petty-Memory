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
| `editor_actions` | Local atomic editor journals, with an action id, command hash, captured before/after states, created ids and undo state. Organization uses the same journal; structural creates can explicitly skip capture rules, and that option is part of their action hash. |
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
- `savedView`: `{version: 1, query, filter}` on an ordinary note whose title names the view. Filters are whitelisted and project references resolve to stable IDs. Removing a view archives its note; matching items are unchanged.
- `template`: `{version: 1, rootId}` on copied template notes. Root and members use fresh UUIDv7 identities; using the template creates ordinary notes without this marker. Editing its text and outline uses the existing item services. No schema migration or separate sync entity is needed.

Inline references are stored in body text as `[[item:<UUID>|label]]`; backlinks are parsed from them, not stored.

## Body vs content

`body` is what the user (or their agent) wrote: a note, or why a link matters. `content` is what came from the source: a page's readable Markdown, a PDF's text, a text file. Keeping them apart lets search rank the user's words higher, lets exports and UIs label source text as quoted material, and keeps extracted text from ever looking like the user's instructions.

## Derived data

`chunks` (item, model, ordinal, text, float32 vector) and `embedded_items` (which items are current for which model) are rebuildable from `items`. They aren't in the change log and are never synced. The `items_embedding_stale` trigger deletes an item's `embedded_items` row whenever its title, body or content changes.

## Organization and chat

Applying a library organization records its result and original undo receipt in the destination's `subtree` change (`data.organization`), in the same transaction as its editor action. Retries return that immutable receipt; they never hash newer work into a fresh undo authorization. Undo checks both the recorded receipt and the current destination tree. Source-parent validity is checked by the editor before restoring placements. Opening an item and reminder delivery are bookkeeping and do not invalidate the organization hash.

Unsaved chat messages and preview responses have no library table or server response cache. Chat, OCR, import previews and merge previews bypass idempotency storage; explicit saves, reviewed Apply and Undo use the ordinary replay cache. Applied headings, placements and their history remain normal library content.

The daily knowledge layer adds versioned metadata without a migration:

- `conversation`: `{version:1,mode,rootId,query,messages}`. The ordinary note's title/project name the saved chat and its body is a readable transcript. Saving updates structured messages and transcript together. Saved chats are ordinary plaintext content, covered by normal history/export/sync; editing the transcript body directly does not edit the structured messages used to resume it.
- `reviewSchedule`: `{version:1,dueAt,lastReviewedAt,count,history:[{at,days}]}`. The last 50 reviews are retained; older item versions remain available through history. A `review` change journals each scheduling action.
- `enveHighlight`: `{version:1,id,bookTitle,author,text,note,location,sourceUrl}` with an `importedFrom` identity for deduplication. Imported notes are snapshots, not live links to the book player's database.
- `biscottiMeeting`: `{version:1,id,date,source,summary,speakers,participants,moments}` on an ordinary note. `importedFrom:{kind:'biscotti',path:id}` is the source identity, including archived imports. The metadata keeps a 500-character summary excerpt and at most 2,000 `{start,speaker}` moments; the full source summary, notes and transcript live in the readable body. Source IDs never become item IDs. Imports are snapshots, preserve the source date and caller's actor, and bypass capture automations. Reimport never overwrites or revives the prior note.
- `aiAction`: `{version:1,actionId}` marks generated tasks and brief notes. It prevents automatic enrichment from altering a just-applied action's Undo guard.

Action apply/Undo records (`ai_actions`, `ai_actions_undo`) keep the result, selected operation hash, before-state and original guard in the local change log. Another device receives ordinary resulting content through sync; these local action receipts do not become cross-device Undo authority.


## Knowledge metadata

No migration is needed. Definition notes carry `knowledgeDefinition:true` and either `knowledge:{version:1,kind:'recipe'|'preference'|'collection',…}` or `watchedSource:{version:1,kind,url,project,enabled}`. Human-readable instruction/field bodies are secondary to the validated metadata. Definition trees are excluded before AI search ranking and from action, organization, review and connection sources.

List, outline and collection summaries omit `pdfPages`; full item details, history, export and content sync retain it. Research lists also omit extracted `content`, and dedicated page endpoints return the requested range. Offline library batches stop between items around 8 MiB, advancing their cursor without splitting an item or dropping its full metadata.

- `fieldValues[collectionId][fieldId]`: typed values on ordinary items; stable field/option ids preserve independent collections, removed fields and partial edits.
- `pdfPages:{version:1,pageCount,pages,clipped,truncated}`: contiguous original page numbers with bounded source text. Blank pages remain in place.
- `research:{version:1,kind,…}`: `transcript`, `transcriptPassage`, `pdfOcrPage` or `pdfAnnotation`. Records retain immutable source hash, timing/page/quote identity and ordinary source relations. Transcripts/passages/annotations are repeat-safe and source state is revalidated on read/save.
- `watchedFrom`: provenance on accepted source material; changed files keep earlier snapshots and a supersedes relation. Device-local `sources.queue.<id>` tracks pending candidates, applied identities and target mappings; `sources.folder.<id>` holds approved paths and size/time/hash observations. These settings are not content sync/export. Backup restore clears `sources.*` before a restored library can scan host paths.
- `freshness:{version:1,checkedAt?,dismissed?,supersededBy?,supersededAt?,lastReview?}`: explicit review state, with ordinary history/sync. Decisions remain append-only. Review actions require the source state hash and preserve text.

Speech endpoint/model are device-local preferences; keys remain outside SQLite. Preview-only speech/OCR/AI results are not replay-cached. See [Knowledge workflows](KNOWLEDGE_FEATURES.md) for limits.
