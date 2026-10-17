# Daftak parity implementation plan

Date: 2026-10-17. Owner: Codex. Primary implementation delegate: Claude Opus 5.5 (`claude-opus-5-5`).

## Outcome and scope

Bring Petty Memory (the former Enve Memory) to parity with Daftak's currently advertised product while retaining local ownership, optional AI, open formats, and existing desktop, extension, CLI, MCP and iPhone workflows. Reference: [Daftak's public feature list and demonstrations](https://www.daftak.com/), reviewed 2026-10-17. Signed-in behavior remains a validation gap; do not claim exact equivalence from screenshots alone.

The target includes nested items, automatic presentation, checklists, attention levels, connections, inline references, item history and restore, AI editing and organization, protected secrets, selective public sharing, highlights, tags, section breaks, review marks, convenient sync, and import/export/delete. Native mobile apps, team collaboration and image support are listed as future work by Daftak; team collaboration is outside this program, and Memory's existing mobile and image support must continue to work.

Cloud access and public sharing are now planned optional capabilities under the user's 2026-10-17 instruction. They must never make an account, subscription, network connection or AI provider necessary for the local product. Start with a self-hostable service; managed hosting and production deployment need an actual hosting destination, credentials and operating budget when that phase is ready.

## Current status

**The planned feature implementation gaps are closed across core, desktop, browser and iPhone. Functional checks passed; this is not a production-release or signed-in Daftak equivalence claim.** See [PARITY_VERIFICATION.md](PARITY_VERIFICATION.md) for Codex's authoritative results and remaining gates.

Implemented layers:

- Ordered, paged outlines, movement and stable offline identities; presentation, checklists, attention, review marks, highlights and section breaks.
- Shared ProseMirror formatted editing with Markdown source mode, lossless preservation of unsupported content, split/join and guarded structural undo/redo.
- References/backlinks/connections, per-item/subtree versions and paged local/synced project memory history. History retains referenced attachment bytes; partial file recovery is reported explicitly.
- Scoped AI proposals with selective atomic apply, guarded undo, heading/group creation and opt-in background organization. AI remains optional.
- Nested secret notes, encrypted files with hidden filenames/types, portable recovery kits, explicit per-device secrets permissions and revocation. Browser/iPhone crypto stays on device; plaintext host HTTP access is disabled by default.
- Browser client, self-host launcher, selective public links, live server sync with capability negotiation, partial-page retry queues, request limits and health checks. Hosting and retention guidance is in [SELF_HOSTING.md](SELF_HOSTING.md).
- A paged ordinary-library replica for offline iPhone navigation/search, persisted structural overlays and FIFO outbox. Secrets, AI, shares and server history remain online operations; file listings are cached, ordinary file bytes are not mirrored automatically.

Remaining acceptance gates are validation or external delivery work: physical-device workflows, accessibility/IME and large-library performance need release evidence; Windows/Linux packaging and signing/store publication need their platforms and credentials. No managed cloud service has been deployed. Independent engineering review and fixture crypto/leak tests do not constitute a production security audit. History and folder-sync segment compaction remain explicit storage limitations; nothing is silently pruned.

## Delivery and delegation

### Breadth-first passes

The user clarified the delivery order on 2026-10-17: bridge the whole feature gap at a working implementation level first, then test that completed layer, then increase depth. The feature groups below describe the full target; their detailed exit checks belong to the later verification/hardening passes, not a reason to exhaustively test one feature before implementing the next.

1. **Feature pass:** implement real end-to-end behavior across the missing feature groups. Keep contracts coherent and perform compilation and essential migration/data-preservation checks while integrating. No placeholders, disabled controls or completion claims based on scaffolding. Avoid exhaustive tests and polish at this stage.
2. **Functional pass:** after the feature layer is present, exercise whole workflows across desktop, iPhone, browser, API, MCP and CLI. Fix integration failures and add targeted regression coverage.
3. **Hardening pass:** deepen migration/recovery, concurrent sync, secret/sharing boundaries, accessibility, performance and release validation. Complete the detailed exit criteria and document remaining external gates.

Codex reviews delegated changes during the feature pass to catch obvious correctness or data-loss issues, while deferring deep per-feature investigation until the breadth layer is complete.

Work on `main` in this standalone repository. No implementation delegate may commit, push, change branches, install dependencies, deploy, access real libraries or manage credentials. Do not create a branch or worktree without the user's request. Keep each milestone independently usable, with no disabled future-feature controls.

Codex defines contracts, owns integration, inspects every changed file, fixes edge cases, runs authoritative builds/tests, and dogfoods user-facing work. Delegate substantial implementation to Opus 5.5 with explicit file ownership. Parallel writers must have disjoint paths; review sessions are read-only. Delegate reports and supporting tests do not substitute for Codex verification.

Initial ownership:

| Work | Owner | Files |
|---|---|---|
| Ordered hierarchy, migrations, sync and export/import fidelity | Opus 5.5 core implementation | `packages/core/**`, `packages/importers/**` |
| Desktop outline, editing and movement controls, typed IPC, desktop tests | Opus 5.5 desktop implementation | `apps/desktop/**` |
| REST, MCP, CLI, documentation, integration and final validation | Codex | Other relevant paths; delegated paths only after their owner finishes |

## Design decisions

- Stable UUIDv7 item identities remain the unit of search, history, relations and sync. Containment is explicit parent identity plus sibling order, separate from semantic relations.
- Existing text stays intact. Adding nesting does not split old Markdown notes or replace the existing capture and reading workflows.
- Nesting and project filing are independent. Moving a node never silently changes its project. Project lists remain useful flat collections.
- Parent moves retain descendants. Deleting a parent preserves its children. Archived parents must not make active children unreachable.
- Decisions remain append-only; ordinary outline editing cannot move decisions, edit their text or turn them into containers.
- Every mutation goes through core and records history in the same transaction. Migrations are append-only and preserve `items.seq` and FTS behavior.
- Order, hierarchy, pending references, cycle prevention and concurrent movement belong in core, never in a renderer or thin transport adapter.
- New presentation metadata is distinct from content and AI suggestions. Saved text remains data and cannot execute commands or redefine model instructions.
- Browser access, hosted transport, public publishing and secret storage have different trust boundaries. Existing device tokens must never become public sharing credentials.

## Feature coverage

| Daftak capability | Starting point | Milestone |
|---|---|---|
| Nested items | Flat items and projects | 1 |
| Auto-formatting / no syntax requirement | Markdown write/preview | 3 |
| Auto-organizing | AI summary/tag/project enrichment | 6 |
| Attention levels | Pinning and task priorities | 4 |
| Checklists | Independent tasks | 4 |
| Connections | Core relations, graph, read-only relation list | 5 |
| Item-level history | Activity events, partial project-memory restore, backups | 2 |
| AI assistance | Cited answers and enrichment | 6 |
| Inline references | No reference picker or inline identity token | 5 |
| Hybrid encryption / secrets | Encrypted folder transport, ordinary local database | 8 |
| Selective sharing | No public publishing surface | 11 |
| Highlights and suggestions | Pins and shelves | 4, 6 |
| Tags | Existing core and clients | Preserve throughout |
| Section breaks | Plain Markdown content only | 3, 4 |
| Review marks | No dedicated review state | 4 |
| Convenient instant sync | Desktop folder sync; iPhone is an API client | 7, 10 |
| Data ownership | Existing import/export/delete/backups | Preserve and extend throughout |

## Milestones and acceptance

### 0. Baseline and execution plan

Record the feature audit, source contracts and acceptance criteria. Establish a scratch library for all runtime verification. Keep real libraries untouched.

Baseline on 2026-10-17: `npm run check` passed; desktop E2E 26 passed and one optional live-LLM test skipped; iOS package 95 passed. These results predate implementation and must be rerun for changed code.

### 1. Ordered hierarchy and a usable desktop outline

Core supports paged roots/children, ancestor lookup, atomic create-child, reparenting and sibling placement. Provide a complete desktop workflow for creating, opening, collapsing, expanding, moving, indenting and outdenting nodes. Add an Outline destination without replacing existing library views. Expose the same operations through the REST API, MCP and CLI.

Public core contract:

```ts
interface OutlineEntry { item: Item; parentId: string | null; position: number; childCount: number }
interface OutlinePage { items: OutlineEntry[]; total: number }
interface OutlineMoveInput { parentId: string | null; beforeId?: string | null }
interface OutlineNoteInput { parentId: string | null; title?: string; body?: string; project?: string; tags?: string[] }
interface OutlineListOptions { offset?: number; limit?: number; includeArchived?: boolean }

memory.outline.children(parentId, options?)
memory.outline.get(id)
memory.outline.ancestors(id)
memory.outline.move(id, input)
memory.outline.createNote(input)
```

Exit checks:

- A populated previous-schema library upgrades with text, files, tasks, decisions and search intact.
- Root/child/grandchild creation, persistent sibling ordering, movement with descendants, self/descendant rejection and decision invariants work.
- Paging exposes more than 200 siblings without silently losing nodes. Deep trees and long content remain usable.
- Restart, folder sync, child-before-parent delivery and export/import preserve hierarchy and order.
- Concurrent opposing moves converge to an acyclic tree on repeated exchange; deleted and missing parents do not strand content.
- Desktop controls work with a keyboard, in ink/paper themes and at a narrow window width. Failed writes retain drafts.
- Existing extension and iPhone clients remain compatible with unchanged Item response fields.

### 2. Reliable version history and recovery

Add a core version service with immutable snapshots of user-visible item state and hierarchy. Record local and synced mutations, actor, operation and causal version. Support item/subtree snapshots, comparison, preview and non-destructive restore as a new change. Restore must preserve decision invariants and validate references. Historical content predating reliable snapshots is labeled honestly; do not fabricate missing versions.

Replace the project-history handler's last-200-events filter with real version queries and paging. Synced project-memory changes must appear. Keep full-library backups and restore distinct from item history.

Exit: recover edited, moved, archived and deleted ordinary items/subtrees; render before/after differences; restore after remote edits without overwriting newer unrelated work; verify migration, repeated restore, missing attachments and version paging.

### 3. Direct editing and automatic presentation

Build a keyboard-friendly outline editor on milestone 1. Support writing and splitting nodes, merging adjacent text, indent/outdent, paste of multiline lists, explicit headings and labeled section dividers, automatic layout, undo/redo and composition/IME input. Preserve selection and drafts through refresh and failures. Provide formatted editing without requiring Markdown syntax, with lossless conversion and export for existing Markdown notes.

Choose an editor dependency only after a bounded prototype proves accessibility, clipboard behavior, safe content rendering, bundle cost and migration fidelity. Do not build a general document framework or discard original formatting without a reversible conversion.

Exit: old notes round-trip; multiline paste and nested movement work; undo restores both text and structure; accessibility and keyboard tests pass; large outlines remain responsive.

### 4. Checklists and personal organization

Allow a list/subtree to become a checklist. Define nested progress, completed visibility, reset, and the relationship to existing tasks/due dates so completion has one source of truth. Add item attention levels, review marks, section dividers and a highlights surface. Keep pins working as existing user intent.

Exit: nested progress and reset behave consistently on all clients; hidden completed nodes remain recoverable; review/attention metadata survives sync and export; keyboard, contrast and reduced-motion checks pass.

### 5. Connections and inline references

Add relation creation/removal controls and a paged item picker. Inline references store stable identity and display the current title; backlinks derive from actual references. Broken or archived targets remain intelligible. Link navigation cannot execute arbitrary schemes or render untrusted HTML.

Exit: rename/move targets without breaking references; remove or restore connections safely; import/export and sync retain identity; distinguish containment, explicit semantic links and derived backlinks.

### 6. AI editing, organization and suggestions

Extend the existing provider interface with typed, bounded edit proposals for the selected subtree: organize, sort, correct wording/mechanics, add content and suggest highlights. Return proposed operations with referenced base versions. Show changes, allow selective acceptance, and provide undo through milestone 2. A proposal cannot delete data, operate outside its selected scope, edit decisions, or silently apply to changed content. Background organization is explicit opt-in with reviewable history and the same safety rules.

Exit: deterministic fixture tests for malformed proposals, stale bases and prompt injection; no executable item text; secrets excluded; cost/context caps; real-model checks against the lab Ollama `qwen2.5:1.5b` required by CLAUDE.md. Saving and ordinary editing continue with AI off or unreachable.

### 7. iPhone editing and durable offline use

Bring hierarchy, direct editing, checklists, references, review state and history to the existing SwiftUI client and share extension. Add a local replica cache and incremental API refresh while retaining the outbox and idempotency keys. Core remains the authority for validation; the phone cache does not become a competing implementation of the full TypeScript engine. Offline drafts and queued edits carry base versions, with explicit conflict recovery after reconnection.

Exit: cold-launch cached reading, offline capture/edit/move, reconnect without duplicates or lost text, revoked token handling, share extension compatibility, notifications, VoiceOver/Dynamic Type and iPhone Air simulator verification. Physical background/network behavior remains a device test gate.

### 8. Protected secret items

Design and implement an optional encrypted item envelope, including body, sensitive title/metadata, attachments and history. Use established cryptography and OS credential storage; specify locking, recovery and device enrollment before coding. Plaintext must not leak into FTS, persisted vectors, activity payloads, sync folders, backups, logs, public shares or automatic AI requests. Locked secrets display a generic label unless the user deliberately exposes metadata.

Exit: inspect actual database, exported files, sync segments, backups and logs for known plaintext; test wrong keys, lock/restart, revoked devices, encrypted attachment retrieval, recovery and explicit encrypted/plain export. Independent read-only security review precedes enabling the feature by default.

### 9. Browser client

Extract only reusable UI and typed client boundaries justified by actual shared use. Add a browser app for the same library operations, paired with an explicitly selected local or self-hosted backend. Support responsive editing, history, checklists and references. Keep Electron IPC and native file access behind desktop-specific adapters.

Exit: keyboard/mobile browser workflows and accessibility; session/token handling; explicit origin allow-list, CSP and transport requirements; no broad relaxation of existing API Host/Origin protections; no browser access to arbitrary filesystem paths.

### 10. Always-available sync and optional hosting

Add a self-hostable service/relay and incremental synchronization with scoped device enrollment, reconnection, revocation and conflict-safe changes. Keep encrypted payloads opaque where possible. Specify retention, quotas, backup, recovery, encryption at rest, upgrade behavior and service health. Managed account hosting is an optional deployment profile, separate from the complete local product.

Exit: desktop/phone/browser edit the same library across restarts and outages; stale clients cannot clobber newer edits; opposing moves converge; revoked clients lose access; realistic library/load and recovery drills pass. Existing folder sync remains supported, with documented capability/version negotiation for older clients.

### 11. Selective public sharing

Publish an explicitly selected subtree with revocable public links. Compute a sanitized public projection with private descendants excluded server-side; filter inline references, titles, attachments, history and search to that projection. Secrets are never implicitly published. Revoke, update and expiry behavior must be visible to the owner.

Exit: creator/visitor views match the selected boundaries; guessing an item or attachment ID cannot expose excluded content; revoked/expired links fail; private references and descendants do not leak through HTML, API responses, search, caches or metadata. The public service cannot proxy arbitrary private API methods.

### 12. Parity acceptance and release

Use a synthetic reference library to run the same capture → nest → format → checklist → connect → review → AI organize → compare → restore → sync → share → export scenarios. Compare against Daftak's accessible current behavior and record any intentional differences. Preserve Memory's existing semantic search, MCP, archival ingestion, decisions and automation workflows.

Verify desktop builds on macOS/Windows/Linux on their respective systems, iPhone and browser workflows, extension compatibility, installer signing/notarization and store packaging when credentials and release destinations are available. No production publication is implied by a local test result.

## Verification matrix

| Changed area | Required authoritative checks |
|---|---|
| Any TypeScript/core change | `npm run check` |
| Schema, sync, backup, versioning | Populated migration + failure rollback + multi-device convergence + recovery tests |
| Desktop UI | Desktop build/E2E plus Codex manual GUI inspection using a scratch library |
| Browser extension integration | Extension unit/integration tests; extension E2E for changed workflows |
| iOS | `xcrun swift test` in EnveMemoryKit, app build/test, simulator dogfooding |
| AI edits | Fixture/provider tests and lab Ollama end-to-end, with declared skips/failures |
| Secrets, web, hosting, sharing | Boundary tests and independent read-only review before release |
| Export/import | Human-readable output review and full round-trip preservation |

Passing a subset does not mark a milestone complete. Record exact command results, material skips and platform limitations below. Zero errors and zero new warnings are the target.

## Sequencing and estimates

Implement the minimum real dependencies in order (hierarchy, history/edit proposals, shared client contracts, secret/public boundaries), while spreading parallel work across feature groups. Finish the feature pass across the program before the full functional pass; reserve exhaustive per-feature edge cases and polish for hardening. Core and desktop implementation run in parallel against fixed contracts.

Measured first-layer implementation is complete; re-estimate remaining hardening after the functional pass. Device testing, hosting setup, security review and external release requirements depend on outside access and may set elapsed time. Migrations and conflict recovery still require sequential review.

## Execution record

- 2026-10-17: Confirmed `claude-opus-5-5` availability through the installed Claude CLI. Started two disjoint Opus 5.5 implementation assignments for milestone 1. Codex owns transport adapters and final verification.
- 2026-10-17: User directed breadth-first implementation. Stopped the initial deep outline-test expansion and requested compile-ready handoffs from both delegates. Subsequent assignments covered the remaining feature groups before the full testing pass.
- 2026-10-17: Feature layer present across core, desktop, browser and iPhone (see [Current status](#current-status)). Documentation reconciled with the implementation. Functional pass started; Codex is running the authoritative checks.
- 2026-10-17: Codex completed repository checks, 34 desktop E2E tests with the lab Ollama model, 117 native package tests, an iPhone Air build/run, browser AI apply/undo and vault workflows, and anonymous sharing checks. Fixed checklist accounting, offline queue ordering, refresh state loss and CLI share-viewer hosting. Interactive native controls and the remaining hardening gates stay open; see the verification record.

- 2026-10-17 closeout: Opus 5.5 implemented the shared editor, core journal/history/AI grouping, native offline library and protected-content layer in disjoint assignments. Codex integrated live transport, quotas/capabilities, recovery/security fixes and browser interoperability. The final root check passed (313 package events, 47 extension, 54 desktop and 9 browser crypto tests), all 38 desktop workflows passed with the actual lab model, all 155 native package tests passed against the real API, and both native UI workflows passed. External release/hosting/audit gates remain in the verification record.

- 2026-10-17 palette/publication: Adopted Petty Tracker's teal/cool-gray palette across desktop, web, extension and native UI, including icons. Codex corrected seven contrast gaps; 156 token pairs passed, the root check and 38 desktop / 14 extension workflows passed, and both native UI workflows passed in dark mode. README now maps all 17 advertised Daftak feature groups and explains the operational differences and remaining release gates. Repository publication is explicitly authorized by the user.
