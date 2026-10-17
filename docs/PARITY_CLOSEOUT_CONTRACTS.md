# Parity closeout contracts

2026-10-17. Continue the existing plan until the functional feature gap is closed. Keep all prior changes on `main`; no commits, pushes, branches or deployment. This pass finishes the remaining behavior before broad verification, then fixes the failures found. Codex owns final testing and review.

## File ownership for this pass

- Claude core: `packages/core/**`, `packages/ai/**` for editor operations/journal, project-memory history, recovery and AI grouping. No transport or app edits.
- Claude desktop/browser: `apps/desktop/**`, `apps/web/**`, `packages/editor/**`. Shared formatted editor, structural controls and undo/redo, accessible browser dialogs. No core/API/iOS edits or dependency installs.
- Claude native: `apps/ios/**`. Offline library, ordered pending structural operations, paging and structural editor controls. No other paths.
- Codex: `packages/api/**`, `packages/cli/**`, `packages/mcp/**`, root dependency manifests, documentation, source review and final verification.

## Core editor API (new, owned by core)

Export these types from `@enve-memory/core`. `memory.editor` is the facade; validate every command, including references, current base text, cycle constraints and protected content. Never hard-delete or edit decisions/secrets with it.

```ts
type EditorCommand =
  | { op: 'create'; id?: string; parentId: string | null; beforeId?: string | null; title?: string; body?: string; project?: string; tags?: string[] }
  | { op: 'update'; id: string; title?: string; body?: string; baseTitle?: string; baseBody?: string }
  | { op: 'move'; id: string; parentId: string | null; beforeId?: string | null }
  | { op: 'presentation'; id: string; patch: Partial<ItemPresentation> }
  | { op: 'check'; id: string; checked: boolean }
  | { op: 'split'; id: string; field: 'title' | 'body'; offset: number; baseText: string }
  | { op: 'merge'; id: string; previousId: string };
interface EditorActionResult { actionId: string; focusId: string; createdIds: string[]; label: string }
memory.editor.apply(commands: EditorCommand[], options?: { id?: string }): EditorActionResult
memory.editor.undo(actionId: string): EditorActionResult
memory.editor.redo(actionId: string): EditorActionResult
```

The batch and its immutable journal receipt must commit atomically. The server owns saved before/after state, not the client. Guard undo/redo against newer edits to any actual affected item; leave unrelated work untouched. Undo new notes by archiving, redo with the same ids. Include placement respacing, applicable checklist descendants, and moved/merged children in the journal. Avoid whole-library snapshots per keystroke. Ignore incidental opened/reminded timestamps for content-conflict checks, but preserve them when restoring. Every content change is recorded in the same transaction; the journal itself is local derived history, not replicated settings.

Split only ordinary active notes. Offsets use UTF-16 units, matching DOM selection; reject invalid/surrogate-splitting boundaries. Split inside the selected field, create the following sibling, keep existing children on the original. A title split leaves its body on the original. A body split leaves its title on the original and creates a body-only following note. Blank-end Enter is a client composer, not an empty persisted note. Merge only adjacent active note siblings with the exact previous id; combine titles with a space and bodies with a paragraph break, append the source's children to the previous note and archive the source so its identity/content remains recoverable. Undo restores both sides.

Allow a client-generated UUIDv7 `id` on `outline.createNote` / REST `POST /outline` so queued new nodes have stable ids before reconnecting. Validate it and reject existing ids. Batch create ids may be referenced by subsequent commands in that batch. The optional action id is also UUIDv7, for durable offline undo and idempotency.

## Transport and UI mapping

Codex implements authenticated, write-scoped routes:

- `POST /editor/actions` `{commands, id?}` → `EditorActionResult`.
- `POST /editor/actions/:id/undo` and `/redo` → `EditorActionResult`.

Desktop IPC, owned by the desktop delegate: `editor.apply(commands, options?)`, `editor.undo(actionId)`, `editor.redo(actionId)` using the same types. Keep existing IPC methods for compatibility. User editing, movement, paste and completion controls should use journalled actions where relevant; preserve failed drafts and do not apply global structural undo while an input's own undo should handle text.

Clients keep an undo/redo action stack and clear redo when a new action succeeds. Handle a stale action as a visible conflict, never by silently clobbering. Structural undo is distinct from the rich editor's local typing history and existing AI undo receipts.

## Project memory and recovery

Core adds `projects.memoryHistory(ref, {offset?, limit?}?)` → `{items: [{id, projectId, at, actor, memory}], total}`. Store truthful local and synced memory changes, backfill existing recorded `set_memory` states, and retain an honest current baseline where earlier remote text wasn't recorded. Desktop IPC `projects.memoryHistory` gains optional paging arguments and returns that page; update its panel to load older pages.

Retain file bytes referenced by item versions. Restore must never report a complete file recovery with missing bytes; return an optional `missingFiles` list or refuse before mutating with a useful error. Preserve existing response fields and callers. Backups/import/export must retain the new content states and encrypted envelopes. Do not silently prune history to hide missing-file problems.

## Formatted editor

The desktop/browser delegate builds a small shared `packages/editor` module using ProseMirror's Markdown integration. Codex owns installing the declared dependencies. Support formatted editing, toolbar, local undo/redo, composition/IME, safe paste, links and existing stable inline references. Use it in both desktop and browser body editors; preserve the exact original Markdown until the document is actually changed. Unsupported Markdown must remain editable and intact, never silently dropped by conversion. Render raw HTML inert and remote images as placeholders/links. Source mode remains an explicit option. No script evaluation, remote images or new network calls from saved text.

Build the shared browser module into a static asset for the web launcher and package it with desktop builds; no CDN. A bounded prototype plus round-trip/paste/keyboard tests should establish the adapter before widespread replacement. Existing title/body fields and exports remain Markdown. Do not introduce a general document framework beyond these two actual clients.

## Offline iPhone

Core also adds a read-only `memory.feed.page(cursor = 0, limit = 200): LibraryPage` and `memory.feed.revision: number`, reusing the existing change sequence/validation instead of introducing a second sync engine. Codex exposes it as read-scoped `GET /library?cursor=&limit=`. It never accepts writes or grants the phone raw sync privileges. `LibraryPage` is:

```ts
interface LibraryPage {
  deviceId: string; cursor: number; hasMore: boolean; reset: boolean;
  items: { item: ItemDetail; parentId: string | null; position: number }[];
  deletedItemIds: string[];
  projects: Project[]; deletedProjectIds: string[];
  relations: { id: string; fromId: string; toId: string; kind: RelationKind }[];
  deletedRelationIds: string[];
}
```

Return current ordinary states for changed ids; secret nodes are omitted and their ids enter `deletedItemIds` to evict any earlier ordinary cached state. Relation records to secret nodes are likewise excluded. Cursor advances over all consumed changes, including omitted records. Rewind after a server backup restore sets `reset`, letting the client clear/rebuild the replica. Initial paging is bounded, persists the cursor per page and may resume after an interrupted foreground refresh. `GET /changes?since=<revision>&wait=25000` (read scope) returns `{revision, deviceId}` immediately on a different revision or after the wait. It is a notification, not a data feed. Native/web should long-poll in the foreground and pull/refresh on changes; cancel on background/disconnect and back off on failures. Sync clients get optional long-poll via `GET /sync?...&wait=25000` under their existing sync scope.

Maintain a per-server/token offline snapshot of ordinary library content and complete outline placement, refreshed incrementally or in bounded pages in the foreground. Do not reimplement core validation or use raw sync scope on the phone. Stable new ids, queued moves/reorders and created notes must appear immediately and survive restart; later queued edits must refer to those ids. Preserve before-text conflict recovery and idempotency. Cache/rebuild projects, tags and search from available ordinary records so unopened cached branches can be browsed offline. Never cache decrypted secrets, passphrases, AI replies or public capability tokens. Permission failures/revocation must not be treated as temporary offline connectivity.

Remove native picker/vault 200-row truncation with real paging and accessible loading controls. Implement the structural endpoints/controls above, keeping UTF-16 offsets explicit. Rich native body-editor integration may use a local bundled version of the shared editor after it exists; coordinate through the handoff notes, not speculative JS calls.
