# Parity feature pass contracts

Status: the feature layer behind these contracts is implemented; automated checks and selected browser workflows have passed, while interactive iPhone verification remains open (see [PARITY_VERIFICATION.md](PARITY_VERIFICATION.md)). User-facing behavior is documented in [API.md](API.md), [SYNC.md](SYNC.md) and [SECURITY.md](SECURITY.md). Clarifications from the implementation are noted inline as "As built".

These contracts coordinate the breadth-first implementation pass. Implement real behavior behind them; do not add placeholder methods. Preserve the existing Item shape, with presentation and secret markers in typed `metadata` fields. Core is the only SQLite owner. API/MCP/CLI remain thin, desktop uses typed IPC, and browser/iPhone use REST. Compile while integrating; defer the full functional and hardening suites until the feature layer is present.

## Ownership

- Opus core: `packages/core/**`, `packages/ai/**`, `packages/importers/**`. Append-only schema changes and domain behavior.
- Opus desktop: `apps/desktop/**`. All local feature controls and typed IPC.
- Opus browser: `apps/web/**`. Browser client and self-hostable launcher, no changes in API/core/desktop.
- Codex: transports, native client integration, documentation, review and later authoritative testing. Add a new delegate only after another assignment has handed off if all slots are occupied.

## Core services

The existing `memory.outline` contract remains unchanged. Add these services to `EnveMemory`, exporting their types from core.

Ordinary text PATCH `/items/:id` accepts optional `baseTitle`/`baseBody` strings alongside title/body. Core compares each changed field against its base before writing; a stale edit returns 409 conflict and leaves stored text untouched. Browser/iOS editors send the base strings. Offline outbox entries keep the original payload after a permanent conflict and expose Save as new note recovery; never silently replace another device's text.

### Presentation and checklists

```ts
interface ItemPresentation {
  kind: 'text' | 'heading' | 'section';
  attention: 'normal' | 'high' | 'low';
  review: boolean;
  checklist: boolean;
  hideCompleted: boolean;
  checked: boolean;
  autoOrganize: boolean;
}

memory.presentation.get(id): ItemPresentation
memory.presentation.update(id, patch: Partial<ItemPresentation>): ItemPresentation
memory.presentation.toggle(id, checked: boolean): ItemDetail
memory.presentation.reset(id): { updated: number }
memory.presentation.progress(id): { done: number; total: number }
```

Store presentation in `metadata.presentation`; normalize defaults on read. Checklist completion has one authority per item: task status for tasks, presentation completion for other ordinary nodes. Toggling/resetting a container updates its applicable descendants transactionally. Progress counts applicable leaf entries. Decisions are excluded. Add `review` and `attention` to existing ItemFilter so ordinary list/search clients can find those items.

### Versions

```ts
interface ItemVersionSummary { id: string; itemId: string; at: string; actor: string; op: string }
interface VersionNode { item: ItemDetail; parentId: string | null; position: number }
interface VersionSnapshot { rootId: string; items: VersionNode[] }
interface ItemVersion extends ItemVersionSummary { snapshot: VersionSnapshot }

memory.versions.list(itemId, { offset?, limit? }?): { items: ItemVersionSummary[]; total: number }
memory.versions.get(versionId): ItemVersion
memory.versions.restore(versionId): { restored: number }
```

As built: `list` is newest first, default 50 and at most 200 per page, with an exact `total`; MCP pages snapshot nodes too. The desktop project-memory history still filters recent activity and has not moved to version queries.

Capture immutable item/subtree snapshots for user-visible local and synced changes. Keep ciphertext, never decrypted secrets, in history. Old libraries receive a truthful current-state baseline; missing past states are not fabricated. Restore is a new logged transaction, preserving existing unrelated items, decision immutability and recoverable content. Existing full-library backups remain separate. The desktop/browser compare two snapshots and offer restore; detailed diff polish belongs to the later pass.

### References and connections

```ts
memory.references.insert(fromId, toId, label?): ItemDetail
memory.references.list(id): { outgoing: RelatedItem[]; incoming: RelatedItem[] }
memory.items.unrelate(fromId, toId, kind): ItemDetail
```

Stable inline format: `[[item:UUID|label]]`, with label optional. The UI offers a picker, so users need not type syntax. Display current target names and navigate internally; never execute a URI or trust HTML from note text. Backlinks reflect parsed references. Explicit semantic connections retain existing relation kinds; superseding decisions is handled only by the decision service. Relation removal is logged and syncs as a relation tombstone. Keep destructive capabilities out of MCP.

### AI proposals

```ts
interface EditProposal {
  rootId: string;
  baseHash: string;
  summary: string;
  createdAt: string;
  operations: EditOperation[];
}
// Concrete exported EditOperation union: update text, create an ordinary node,
// move an ordinary node, or update presentation. No delete operation.

proposeEdit(memory, provider, { rootId, instruction }): Promise<EditProposal> // @enve-memory/ai
memory.edits.apply(proposal: EditProposal): { applied: number; undo?: EditUndoReceipt }
memory.edits.undo(receipt: EditUndoReceipt): { restored: number }
```

As built: selective acceptance is done by the client sending only the kept operations with the original `baseHash`; the subset applies atomically. The receipt is `{rootId, versionId, afterVersionId, baseHash, createdIds}`. Undo is refused with a conflict unless the subtree hash and its newest version still match the post-apply state; it archives `createdIds` and restores `versionId` as a new change. No receipt is returned when the root had no prior version.

Proposals are scoped to a selected subtree and reference an immutable base hash. Include trustworthy before/after material for the UI's review. Validate operations and reject stale proposals before applying atomically. Keep secrets, decisions and outside items out of the editable scope. Reuse the existing provider interface and schema parsing. Add an opt-in background organizer for `presentation.autoOrganize` roots; track the last organized state to avoid an AI feedback loop. Existing capture/search remain usable with AI off. Basic highlight suggestions may use the existing revisit/unopened signals rather than introducing a new model.

### Vault

```ts
memory.vault.state(): { configured: boolean; unlocked: boolean }
memory.vault.setup(passphrase): { configured: boolean; unlocked: boolean }
memory.vault.unlock(passphrase): { configured: boolean; unlocked: boolean }
memory.vault.lock(): { configured: boolean; unlocked: boolean }
memory.vault.create({ title, body, project?, tags? }): ItemDetail
memory.vault.read(id): { id: string; title: string; body: string }
memory.vault.update(id, { title, body }): ItemDetail
```

Create new encrypted secret notes; do not claim retroactive secrecy for old plaintext exports/backups. Use Node built-in authenticated encryption and passphrase derivation, with an in-memory key and persisted salt/verifier only. Ordinary item fields contain a generic label and no secret body; `metadata.secret = true`. Encrypt the title/body envelope and carry it through sync, history and export, including the KDF salt/parameters needed to unlock it on another device; do not rely on device-local settings being synced. Locked reading fails explicitly. AI, ordinary search and public sharing never receive decrypted content. Secret notes are leaves in this first pass; reject ordinary children under them. Later work may extend encrypted subtrees/attachments after their boundaries are tested.

Private REST vault operations require a new explicit `secrets` token scope. Existing read/write tokens must not gain that scope automatically. Desktop IPC is a direct user surface. No vault access over MCP.

Remote clients use end-to-end encryption, never the host-decryption `/vault/unlock`/`read` path. New opaque storage routes: `POST /vault/sealed-items` with `{id,envelope,project?,tags?}` and `PATCH /vault/sealed-items/:id` with `{envelope}` (both secrets scope). They call `memory.vault.createSealed` / `updateSealed`; neither requires nor changes the host's unlocked key. Read ciphertext from ordinary `/items?secret=true` and item metadata. Client generates UUIDv7 before encryption; AES-256-GCM associated data is that item id, UTF-8. Client KDF is PBKDF2-SHA256 over the NFKC-normalized UTF-8 passphrase, exactly 600,000 iterations, 16-byte salt, 32-byte key; envelope `kdf: {name:'pbkdf2',hash:'sha256',iterations:600000}`; v1/iv/tag/data fields keep the existing format (12-byte IV, 16-byte authentication tag, base64 fields). Plain JSON is `{title,body}`. Core also retains the existing scrypt envelope for local desktop notes. Browser/iOS implement PBKDF2 using platform crypto (Web Crypto / CommonCrypto + CryptoKit), keep passphrase/keys/decrypted text only in memory, and clear on lock/background. No plaintext vault writes enter the outbox or caches. Existing scrypt notes are readable only by the local host path for this layer, with a clear client message rather than silently sending a remote passphrase. Do not claim cross-client E2E for that legacy envelope.

As built: a host vault set up on a library with no secret notes now uses the PBKDF2 parameters above, so its notes are readable by browser/iPhone clients with the same passphrase; a vault already set up with scrypt keeps sealing with scrypt. CLI `clients pair` grants `read`,`write` and adds `secrets` only with `--scope secrets`; desktop pairing grants `read`,`write`. Only text secret notes exist; encrypted attachments and subtrees remain next-layer work.

### Public shares

```ts
interface PublicShare { id: string; rootId: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; excludedIds: string[] }
interface PublicNode { id: string; parentId: string | null; title: string; body: string; type: string; presentation: ItemPresentation }
interface PublicTree { title: string; items: PublicNode[] }

memory.shares.list(): PublicShare[]
memory.shares.create(rootId, { excludedIds?, expiresAt? }?): { share: PublicShare; token: string }
memory.shares.revoke(shareId): PublicShare
memory.shares.view(token): PublicTree
```

Store only a hash of the capability token and return its plaintext once. As built: an `Idempotency-Key` replay of `POST /shares` returns `409 conflict` instead of the original body, so the token is never re-sent; public tokens use a `ps_` prefix distinct from device tokens. Build a live, sanitized tree; excluded and secret nodes exclude their descendants too. Omit private metadata, history, filesystem paths and attachments from public output. Scrub references to anything outside the public projection, including private reference labels. Reject sharing a secret root. Validate token, revocation and expiry on every read. Public access exposes only this projection, never the private API or MCP. Secret/public security hardening is still a later pass before any production release.

### Network synchronization

```ts
memory.sync.exportChanges(cursor?: number, limit?: number, options?: { base?: 'cursor' | 'synced' }): {
  records: SyncRecord[]; nextCursor: number; hasMore: boolean; deviceId: string; reset: boolean
}
memory.sync.applyChanges(records: unknown[], options?: { pulled?: boolean }): { imported: number; conflicts: number; rejected: number }
memory.sync.markSynced(records: Pick<SyncRecord, 'entity' | 'id' | 'hlc'>[]): void
memory.sync.peerState(url: string): SyncPeerState | null
memory.sync.setPeerState(url: string, state: SyncPeerState | null): void
memory.sync.readBlob(sha256): Buffer
memory.sync.writeBlob(sha256, bytes: Uint8Array): void
```

Reuse existing validation, logical clocks, pending references and recovery rules; do not create a second sync engine. Network pull relays accepted remote changes as well as local changes, with cursors in the serving library. Keep folder sync working. Blob methods validate SHA-256 and content, never accept paths. Desktop remote credentials belong in the OS secret store; CLI uses an environment token. Repeated push/pull should converge without echoing new mutations forever.

As built: CLI `petty-memory sync remote <url>` runs one exchange with `PETTY_MEMORY_SYNC_TOKEN`; peer state is stored under `sync.peer.<sha256(url)>`. Records other than secret-note envelopes are not encrypted beyond the transport, and no managed sync service has been deployed.

Codex implements `RemoteSyncClient` exported by `@enve-memory/api`: constructor `(memory, {url, token})`, async `run(): {pushed, pulled, conflicts, rejected}`. It persists per-peer cursors and pending blob hashes in private library settings; tokens stay outside SQLite. Device replication requires a new explicit `sync` token scope, never implied by ordinary read/write. Desktop connects this to a periodic/focus worker and manual Run action. Its typed IPC is `remoteSync.get`, `remoteSync.configure({url,token?})`, `remoteSync.run`, `remoteSync.disconnect`; URL in desktop preferences and token in the existing OS SecretStore.

## REST mapping (prefix `/api/v1`)

| Endpoint | Scope | Behavior |
|---|---|---|
| `GET /items` | read | Existing filters plus `review=true` and `attention=high|normal|low` |
| `GET /items/:id/presentation` | read | Presentation defaults/current state |
| `PATCH /items/:id/presentation` | write | Partial presentation fields |
| `POST /items/:id/check` | write | `{checked}` |
| `POST /items/:id/checklist/reset` | write | Reset a checklist subtree |
| `GET /items/:id/checklist` | read | Progress |
| `GET /items/:id/versions?offset=&limit=` | read | Paged version summaries |
| `GET /versions/:id` | read | Snapshot |
| `POST /versions/:id/restore` | write | Restore as a new change |
| `GET /items/:id/references` | read | References and backlinks |
| `POST /items/:id/references` | write | Insert `{toId, label?}` |
| `POST /items/:id/relations` | write | `{toId, kind}` |
| `DELETE /items/:id/relations` | write | `{toId, kind}`; remove a reversible connection only |
| `POST /ai/edit` | write | `{rootId, instruction}` → proposal; provider configured on host |
| `POST /ai/apply` | write | `{proposal}` → count and optional undo receipt |
| `POST /ai/undo` | write | `{receipt}`; reject later edits, restore previous state and archive AI-created nodes |
| `GET /vault` | secrets | Vault state |
| `POST /vault/setup`, `/vault/unlock` | secrets | `{passphrase}` |
| `POST /vault/lock` | secrets | Lock |
| `POST /vault/items` | secrets | New secret title/body, project/tags optional |
| `GET /vault/items/:id` | secrets | Explicit unlocked reading |
| `PATCH /vault/items/:id` | secrets | `{title, body}` |
| `POST /vault/sealed-items` | secrets | `{id,envelope,project?,tags?}`; opaque client-encrypted note |
| `PATCH /vault/sealed-items/:id` | secrets | `{envelope}`; replace ciphertext only |
| `GET /shares` | write | User-owned shares |
| `POST /shares` | write | `{rootId, excludedIds?, expiresAt?}` |
| `POST /shares/:id/revoke` | write | Revoke |
| `GET /public/:token` | public | Sanitized PublicTree only |
| `GET /sync?cursor=&limit=` | sync | Export network changes |
| `POST /sync` | sync | `{records}` → apply result |
| `GET /sync/blobs/:sha256` | sync | Content-addressed attachment bytes |
| `PUT /sync/blobs/:sha256` | sync | Raw bytes, checked against the requested hash |

All private routes retain token, Host/Origin, body-limit and idempotency protections. Relation DELETE is recoverable history, not item deletion. Never expose hard delete, whole-library restore, private settings or local filesystem paths through these additions.

## Web host

The browser delegate implements `apps/web` with plain HTML/CSS/JS, vendored copies of the existing Markdown parser/sanitizer, and a Node/TypeScript launcher using the existing core and API packages. `createApiServer` accepts `webRoot` and an explicit `webOrigins` allow-list. Static assets and `/s/<public token>` use the web root; private API routes remain authenticated. Default binding stays loopback; LAN/public origin requires explicit configuration. No production service is deployed during the feature pass. As built: the launcher is `node apps/web/server.ts [--home] [--port 49232] [--lan --origin URL]`; the desktop app and `petty-memory serve` also serve the client and share viewer, adding their own LAN addresses as origins in LAN mode.

The browser client supports the new outline/editor controls, history, checklists, references, AI proposal review, vault and sharing. Keep a private-token connection screen distinct from a public read-only `/s/<token>` view. Use text-safe DOM rendering; public item text cannot execute HTML/scripts. Public mode must not reuse a private credential.
