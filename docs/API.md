# Local HTTP API

Served by the desktop app or `petty-memory serve` at `http://127.0.0.1:49231` (add `--lan` to reach it from other devices). Implementation: [`packages/api/src`](../packages/api/src). The security model is in [SECURITY.md](SECURITY.md).

## Authentication

Create a token with `petty-memory clients add "<name>" --scope read,capture` (or in Settings → Devices), or pair a phone with `petty-memory clients pair "<device>"`, which grants `read` and `write` (add `--scope secrets` for an encrypted-vault phone). Send it as `Authorization: Bearer em_…`.

| Scope | Allows |
|---|---|
| `read` | Search, view, briefings, activity, downloads, history, references |
| `capture` | Create notes, links, tasks and files |
| `write` | Every non-destructive change, AI proposals and public shares; implies `capture` |
| `secrets` | Vault routes only. Never implied by `read` or `write` |
| `sync` | Device replication (`/sync`, `/sync/blobs`) only. Never implied by `read` or `write` |

Pairing from the desktop app (Settings → Devices) also grants `read` and `write`. `secrets` and `sync` tokens are created deliberately, from `clients add`/`pair --scope` or the desktop scope picker.

Browser origins are restricted. Extension origins (`chrome-extension:`, `moz-extension:`, `safari-web-extension:`), loopback pages and explicitly configured `webOrigins` are allowed and get CORS headers; other origins get a 403. The desktop and CLI hosts add their own network addresses in LAN mode. See [apps/web](../apps/web/README.md).

Errors are `{"error": {"code", "message"}}` with the status: `401 unauthorized`, `403 insufficient_scope | forbidden_origin | forbidden_host`, `400 invalid | invalid_json`, `404 not_found`, `409 conflict | in_progress`, `413 too_large`, `423 locked`.

**Safe retries:** send `Idempotency-Key: <1–128 chars>` on any write. Repeating a key within 24 hours (per client) returns the original response with `Idempotent-Replayed: true` instead of writing again. The exception is `POST /shares`: its public token is returned only once, so a replay gets `409 conflict` instead of the token. If that response was lost, revoke the share and create a new one.

## Endpoints (prefix `/api/v1`)

| Method & path | Scope | Notes |
|---|---|---|
| `GET /status` | none | `{name: "enve-memory", version, api: 1}` |
| `GET /whoami` | any token | The calling client: name, scopes, last used |
| `GET /search?q=&project=&type=&tag=&limit=&archived=` | read | Hybrid keyword + semantic hits: `{id, type, title, url, project, snippet, match, taskStatus, updatedAt}` |
| `GET /items?project=&type=&tag=&inbox=true&limit=&before=` | read | Newest first. The next page is `before=<updatedAt>,<id>` of the last item. Shelves: `pinned=true`, `intent=read\|watch\|buy\|revisit`, `unopened=<days>`, `reminders=true` (soonest first). |
| `GET /outline?parent=&limit=&offset=&archived=` | read | Ordered direct children, or roots when `parent` is omitted. Returns `{items: [{item, parentId, position, childCount}], total}`. `limit` is capped at 200; continue with `offset`. |
| `GET /outline/:id` | read | The item's outline entry, including parent, sibling position and child count |
| `GET /outline/:id/ancestors` | read | Ancestor items ordered from root to direct parent, excluding the item itself |
| `POST /outline` | capture | `{id?: UUIDv7, parentId?: id \| null, title?, body?, project?, tags?}` → outline entry. A nonempty title or body is required. Creates and nests the note atomically. |
| `GET /capabilities` | read | API/schema versions and supported feature names. |
| `GET /library?cursor=&limit=` | read | Paged ordinary library replica, projects, relations and deletions; secret items are evicted, never copied. |
| `GET /changes?since=&wait=25000` | read | `{revision, deviceId}`; bounded foreground long-poll notification. |
| `POST /editor/actions` | write | `{commands, id?: UUIDv7}` → `{actionId, focusId, createdIds, label}`. Atomic create/update/move/style/check/split/merge batch; retrying the same id is idempotent. |
| `POST /editor/actions/:id/undo` and `/redo` | write | Restores the action's fields if they still match its expected state; stale actions return 409. Split offsets are UTF-16 code units. |
| `PUT /outline/:id/parent` | write | `{parentId: id \| null, beforeId?: id \| null}` → outline entry. `parentId` is required; null moves to the root. Omitting `beforeId` appends. Preserves descendants and project filing. |
| `GET /reminders[?due=true]` | read | Upcoming reminders, or only those due and not yet delivered |
| `GET /related?url=&q=&limit=` | read | Items related to a page, by hybrid search on `q` plus the page's saved title and excerpt; the page itself is excluded |
| `GET /items/:id` | read | Full item with `content`, `attachments`, `tags`, `task`, `relations` and `metadata` |
| `GET` or `HEAD /items/:id/file` | read | The file's bytes with `Content-Type` and `Content-Disposition` |
| `GET /lookup?url=` | read | `{item}` if the URL is already bookmarked, else `{item: null}` |
| `POST /capture` | capture | `{url?, title?, note?, selection?, project?, tags?, intent?, remind?, pinned?, createdAt?}` → `{item, created}`. A URL becomes a bookmark (re-saving merges the note and tags); otherwise it's a note. The selection is stored as a quote. `remind` accepts plain words ("tomorrow", "friday", "in 3 days") or an ISO time. `intent` on an already-saved URL changes it; `createdAt` (e.g. an imported bookmark's original date) applies only to a new bookmark. |
| `POST /capture/batch` | capture | `{items: [capture bodies]}` (≤ 2000) → `{created, skipped, failed, results}`; each entry succeeds or fails alone |
| `POST /items/:id/opened` | capture | Records that the user opened it (drives the "unopened" shelf) |
| `POST /items/:id/reminded` | capture | Marks a due reminder delivered, so other clients don't show it again (`/reminders?due=true` omits delivered ones) |
| `POST /items` | capture | `{type: note \| bookmark \| task, title, body, url, project, tags, due, priority}` |
| `POST /files` | capture | Raw body. Headers: `Content-Type`, `X-Filename`, and optionally `X-Title`, `X-Note`, `X-Project`, `X-Tags` (comma list), `X-Remind`, `X-Intent`, `X-Pinned: true`, all percent-encoded UTF-8. Up to 200 MB. |
| `PATCH /items/:id` | write | `{title?, body?, url?, project? (null = unfile), baseTitle?, baseBody?}`. With a base, a changed field is written only if the stored text still equals it; otherwise `409 conflict` and nothing changes. |
| `POST /items/:id/archive` and `/unarchive` | write | |
| `POST /items/:id/pin` | write | `{pinned}` |
| `PUT /items/:id/reminder` | write | `{at: "tomorrow" \| ISO \| null}` |
| `PUT /items/:id/intent` | write | `{intent: read \| watch \| buy \| revisit \| null}` |
| `POST /items/:id/accept` | write | Apply the item's AI-suggested tags and project |
| `POST /items/:id/tags` | write | `{add?, remove?}` |
| `GET /projects?status=` | read | |
| `POST /projects` | write | `{name, description?, instructions?}` |
| `GET /projects/:ref` | read | Briefing: `{project, decisions, openTasks, recentItems}`. `:ref` is an id, slug, name or unique slug prefix. |
| `PATCH /projects/:ref` | write | `{name?, description?, instructions?, status?}` |
| `PUT /projects/:ref/memory` | write | `{memory}`; every earlier version is kept |
| `GET /projects/:ref/memory/versions?offset=&limit=` | read | `{items, total}`; paged local and synced project memory history. |
| `GET /projects/:ref/decisions` | read | Oldest first |
| `POST /projects/:ref/decisions` | write | `{decision, reason?, supersedes?: [id]}` |
| `GET /tasks?project=&status=active\|open\|in_progress\|done\|cancelled\|all&tag=&limit=&offset=` | read | Due date, then priority |
| `PATCH /tasks/:id` | write | `{title?, notes?, status?, due? (null clears), priority?, project?}` |
| `POST /tasks/:id/complete` | write | |
| `GET /activity?project=&limit=` | read | Newest first, with the acting client |

`GET /items` and `GET /search` also take `review=true|false`, `attention=high|normal|low` and `secret=true|false`.

### Presentation, checklists, history and references

| Method & path | Scope | Notes |
|---|---|---|
| `GET` / `PATCH /items/:id/presentation` | read / write | `{kind: text\|heading\|section, attention: normal\|high\|low, review, checklist, hideCompleted, checked, autoOrganize}`; PATCH takes any subset |
| `POST /items/:id/check` | write | `{checked}`; applies to the item and its applicable descendants in one transaction |
| `POST /items/:id/checklist/reset` | write | Unchecks the subtree → `{updated}` |
| `GET /items/:id/checklist` | read | `{done, total}` over applicable leaves |
| `GET /items/:id/versions?offset=&limit=` | read | `{items: [{id, itemId, at, actor, op}], total}`, newest first; default 50, max 200 per page |
| `GET /versions/:id` | read | The version with its subtree snapshot |
| `POST /versions/:id/restore` | write | Restores as a new change → `{restored}` |
| `GET` / `POST /items/:id/references` | read / write | `{outgoing, incoming}`; POST `{toId, label?}` appends `[[item:<id>\|label]]` |
| `POST` / `DELETE /items/:id/relations` | write | `{toId, kind}`; DELETE removes a connection (logged and synced, not an item delete) |

Completion has one authority per item: a task's status for tasks (checking sets it to `done`, unchecking to `open`), `presentation.checked` for other ordinary items. Decisions and archived items take no part. Libraries upgraded from before history start with one `baseline` version holding the state at upgrade; earlier states aren't invented.

### AI edits

| Method & path | Scope | Notes |
|---|---|---|
| `POST /ai/edit` | write | `{rootId, instruction}` → proposal `{rootId, baseHash, summary, createdAt, operations, titles}`. Uses the host's configured provider; changes nothing |
| `POST /ai/apply` | write | `{proposal}` → `{applied, undo?}`. Send only the operations you accept; all of them apply or none |
| `POST /ai/undo` | write | `{receipt}` → `{restored}` |

Operations update text, create notes, move items or change presentation inside the selected subtree; none delete. Decisions, secret notes and archived items are outside the scope. A proposal is bound to `baseHash`, so applying it after the subtree changed returns `409`. The undo receipt restores the version from before the apply and archives the notes the edit created; it returns `409` if the subtree changed again after the apply, in which case use History.

### Vault (`secrets` scope)

| Method & path | Notes |
|---|---|
| `POST /vault/sealed-items` | `{id, envelope, project?, tags?, parentId?}`: store a note the client already encrypted. `id` is a client-made UUIDv7 |
| `PATCH /vault/sealed-items/:id` | `{envelope}`: replace the ciphertext |
| `PUT /vault/items/:id/attachments/:attachmentId` | Body is the encrypted file envelope; returns `Attachment`. Retrying identical bytes and id is safe. |
| `GET` / `DELETE /vault/items/:id/attachments/:attachmentId` | Read ciphertext / recoverably remove it; no host key needed. |
| `POST /vault/versions/:id/restore` | Restore secret ciphertext and attachments; `{restored, missingFiles?}`. Ordinary version restore refuses secrets. |
| `GET /vault` | `{configured, unlocked}` for the host's in-memory key |
| `POST /vault/setup`, `/vault/unlock` | `{passphrase}`; the host derives and holds the key |
| `POST /vault/lock` | |
| `POST /vault/items`, `PATCH /vault/items/:id` | `{title, body}`; the host encrypts |
| `GET /vault/items/:id` | The host decrypts and returns `{id, title, body}` (`423 locked` when locked) |

Two models. **Sealed items are end-to-end:** the client derives the key (PBKDF2-SHA256, 600,000 iterations, 16-byte salt, NFKC passphrase) and seals `{title, body}` with AES-256-GCM, the item id as associated data. The server only stores the envelope; read it from `/items?secret=true` and `metadata.vault`. The browser and iPhone use only this path. **The other vault routes send the passphrase and plaintext to the host,** which is appropriate only for a client on the same machine. Secret items carry the label "Secret note" in their ordinary fields. Notes sealed in the older desktop scrypt format open only on the host.

Host plaintext routes require the explicit local `allowHostVault` server option; they return 403 by default and always on a LAN listener. Desktop uses local IPC. Files use the bounded `PMVF1` frame, a 20 MiB original limit and AAD bound to both ids. Recovery kit generation/unlocking is entirely local; no recovery endpoint receives the code or passphrase. See [VAULT_CLOSEOUT_CONTRACTS.md](VAULT_CLOSEOUT_CONTRACTS.md).

### Public shares

| Method & path | Scope | Notes |
|---|---|---|
| `GET /shares` | write | `[{id, rootId, createdAt, expiresAt, revokedAt, excludedIds}]` |
| `POST /shares` | write | `{rootId, excludedIds?, expiresAt?}` → `{share, token}`. The token is shown once and stored only as a hash |
| `POST /shares/:id/revoke` | write | |
| `GET /public/:token` | none | `{title, items: [{id, parentId, title, body, type, presentation}]}`, computed live. Revoked, expired or unknown tokens fail |

The public projection leaves out excluded, secret and archived nodes with their descendants, private metadata, history, attachments and file paths, and scrubs references to anything outside it. Every failure looks the same, so a visitor can't tell a revoked link from a wrong one. A secret, archived or decision root can't be shared. Shares live in the library that created them and aren't synced.

### Device sync (`sync` scope)

| Method & path | Notes |
|---|---|
| `GET /sync?cursor=&limit=` | `{records, nextCursor, hasMore, deviceId, reset}`: this library's changes, including ones it received from other devices; `reset` signals a cursor rewind after restore |
| `GET /sync/capabilities` | Protocol version, live-wait and blob features, maximum wait and JSON body bytes. `GET /sync` accepts `wait=25000`. |
| `POST /sync` | `{records}` → `{imported, conflicts, rejected}`, using the same validation and conflict rules as folder sync |
| `GET` / `PUT /sync/blobs/:sha256` | Attachment bytes; PUT bytes must hash to the name and belong to a known attachment |

See [SYNC.md](SYNC.md#syncing-through-a-server).

Ordinary API clients have no hard-delete endpoint. Replication with the separate `sync` scope can apply deletion tombstones; decisions remain append-only. Links saved through the API are fetched and archived in the background.

Outline operations preserve existing item identities and content. Nesting is separate from project filing. A decision cannot move or contain children; missing, archived or descendant destinations are rejected. Capture-only clients may create nested notes, but moving an existing item requires `write`. New outline writes support the same idempotency keys as other endpoints.

## MCP over HTTP

`POST /mcp` (Streamable HTTP, MCP 2026-07-28 with 2025 fallback), using the same bearer token. The tools offered follow the token's scopes. See [MCP.md](MCP.md).

## Pairing links

`enve-memory://pair?url=<base URL>&token=<token>&name=<device name>`: shown as a QR code by the desktop app and printed by `petty-memory clients pair`. CLI pairing tokens get `read` and `write`; `--scope secrets` adds the vault scope.
