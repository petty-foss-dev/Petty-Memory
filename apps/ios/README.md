# Petty Memory for iOS

The phone companion for Petty Memory. The library stays on your computer; the phone is a client of the local HTTP API (`petty-memory serve --lan`) over your home network or Tailscale. It keeps its pairing token (Keychain), an outbox of writes that couldn't be sent yet, and a read-only copy of the ordinary library for offline browsing and search. Core on the computer stays the authority: the phone never validates or applies edits itself, it queues them and shows them on top of its copy until the server accepts them.

| Home | Outline | Formatted editor |
|---|---|---|
| ![Home in dark mode](../../docs/screenshots/parity/ios-home-dark.png) | ![Ordered outline](../../docs/screenshots/parity/ios-outline-dark.png) | ![Formatted note editing](../../docs/screenshots/parity/ios-editor-dark.png) |

| Light mode | Locked vault |
|---|---|
| ![Home in light mode](../../docs/screenshots/parity/ios-home-light.png) | ![Locked vault](../../docs/screenshots/parity/ios-vault-locked-dark.png) |

Screenshots use a disposable fictional library. Outline, editing and vault captures come from the native UI tests.

## Requirements

- Xcode 26 or newer, iOS 17.0+ deployment target, Swift 6 language mode.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen). The `.xcodeproj` is generated from `project.yml`; run `xcodegen generate` after adding files or changing `project.yml`.
- A Petty Memory server: `petty-memory serve --lan` on the computer that holds the library.

## Build and run

```bash
cd apps/ios
./scripts/build-editor.sh        # bundles the shared formatted editor (needs the repo's npm dependencies)
xcodegen generate
xcodebuild -project EnveMemory.xcodeproj -scheme EnveMemory \
  -destination "platform=iOS Simulator,name=iPhone Air" build
```

To run on a device, set `DEVELOPMENT_TEAM` in `project.yml` (both targets share it) and register the App Group `group.com.enve.memory` for `com.enve.memory` and `com.enve.memory.share`. Simulator builds are ad-hoc signed and need no team.

## Pairing

On the computer:

```bash
petty-memory serve --lan
petty-memory clients pair "My iPhone"      # prints enve-memory://pair?url=…&token=…&name=… links, one per network address
```

Then on the phone, either:

- **Scan** the QR code of a pairing link (camera, real devices only),
- **Open** the link (AirDrop it, or tap it in Messages or Notes). If the phone is already paired it asks before replacing the pairing,
- **Paste** the link on the onboarding screen, or
- **Enter** the server address (`http://192.168.1.20:49231`) and the `em_…` token by hand.

`clients pair` grants `read` and `write`; add `--scope secrets` for a phone that should use the vault. Nothing is stored until `GET /status` and `GET /whoami` both succeed. Settings shows the address, device name, server version and granted scopes. Unpairing deletes the token from the phone; revoke it on the computer with `petty-memory clients revoke <id>`.

For the simulator, which shares the Mac's network, a loopback link works without `--lan`:

```bash
petty-memory --home /tmp/em serve --port 49871
petty-memory --home /tmp/em clients pair "iPhone Sim" --port 49871 --json   # take the token from the output
xcrun simctl openurl <udid> "enve-memory://pair?url=http%3A%2F%2F127.0.0.1%3A49871&token=<token>&name=iPhone+Sim"
```

## What it does

- **Home**: a quick-capture bar (a bare URL becomes a link, anything else a note), shortcuts to new note, link and task, the outbox status, and recent items 30 at a time ("Show older" follows the server's `before=<updatedAt>,<id>` cursor).
- **Shelves** (on Home): Pinned, Read, Watch, Buy, Revisit, Unopened (30 days) and Reminders, each a filtered `/items` list.
- **Search**: debounced hybrid search with type and project filters. Matched terms are highlighted, and each hit notes quietly whether it matched on words, meaning or both.
- **Projects**: the same briefing an AI gets from `get_project`, with standing instructions, the memory document rendered as Markdown, the decision log (superseded decisions struck through and dimmed), open tasks you can complete, and recent items.
- **Tasks**: active tasks grouped by project, with due dates and priority, loaded 50 at a time as you scroll (`offset`). Tap the circle or swipe to complete.
- **Item detail**: pin toggle, intent chips (Read / Watch / Buy / Revisit, marked "Guessed" while the server's guess stands), a "Remind me" menu (Tonight, Tomorrow, This weekend, Next week, or a picked date and time), the AI summary with suggested tags and project and an Accept button, title, site, byline and date, your note, tags, the task card, attachments (downloaded and previewed with Quick Look), the archived copy in a quiet reading column, relations, and "Open original" in Safari. Archived text is data: only `http`, `https` and `mailto` links in it are followed.
- **Share extension**: accepts links, text, images and files from any share sheet. Links and files get intent chips, every share gets "Remind me" chips (files send them as `X-Intent` / `X-Remind` headers), and every share gets a project picker (from the cached project list), tags and a note. Links and text go to `POST /capture`, files stream to `POST /files`. When the server can't be reached the share goes to the outbox and the sheet says "Saved — will sync when you're back on your network".
- **Outbox**: every write (captures, new items, task completions, uploads) goes straight to the server when it can and into the outbox when it can't. The app flushes it on launch and foreground, every 20 s while something is waiting (honouring backoff), and from a `BGAppRefreshTask`. Settings lists queued entries with retry and discard.
- **Reminders as local notifications**: after every sync (launch, foreground, each write, background refresh) the app mirrors `GET /reminders` into `UNUserNotificationCenter` requests keyed `enve-memory.reminder.<item id>`, adding, moving and cancelling as the server changes, so the phone reminds you even when it can't reach the server. Tapping one opens `enve-memory://item/<id>`. Permission is asked the first time you set a reminder (or from the Reminders shelf), never at launch. A capture or share that sets a reminder schedules its notification right away (the share extension only when the app already has permission): under the item's id when the server answered, or under the outbox entry's id while it waits, which the first sync after the entry is sent swaps for the real one.
- **Opened signal**: "Open original" and attachment previews report `POST /items/:id/opened`, which drives the Unopened shelf.
- **Appearance**: System, Dark and Light modes plus true-black OLED, shared with the share extension.
- **Outline** (Home → Outline, or "Show in outline" on any item): branches load 50 children at a time with a breadcrumb path; add notes at the top level or inside a branch; move up/down, indent, outdent, "Move to…" a picked branch and sibling (the picker pages 100 rows at a time), and merge a note into the one above. Moves always place with `beforeId`; positions are never computed on the phone. These are journalled actions (`POST /editor/actions` with a client UUIDv7 action id), so the outline's Undo and Redo buttons reverse whole actions, named for what they'd undo. Undoing an action that hasn't been sent yet takes it back out of the outbox when nothing queued after it could depend on it; otherwise it queues `/editor/actions/:id/undo` behind it. A stale undo is reported, never forced.
- **Presentation and checklists**: an item's "Shows as" card sets text/heading/section, low/normal/high attention, a review mark, checklist and hide-completed, and done; checklist progress and reset. Tasks complete by status, everything else by its checkmark. Home's Suggestions open Review, Needs attention, Revisit and Unopened.
- **Editing and references**: the text is edited in the shared formatted editor from `packages/editor` (the same one as the desktop and browser apps), running in a web view that loads only the bundled `EnveMemory/Resources/Editor` files over a private `petty-editor:` scheme, with no network, no website data and no navigation. It keeps unchanged Markdown byte for byte, has its own toolbar (formatting, lists, checkboxes, links, references, its own undo and redo, "Edit as Markdown"), and asks the app for links (web and email only) and references (the item picker). A build without the bundled editor uses a Markdown field with formatting buttons (bold, italic, heading, bullet, checkbox, quote) and "Link to an item", which inserts `[[item:<id>|label]]` (the picker pages recent items with the `before` cursor and widens a search up to the server's 200). Saving is one undoable action carrying the text it started from; typing keeps the field's own undo. On iOS 18, "Split at cursor" splits a note's title (or, in the Markdown field, its text) at the caret, sent as a UTF-16 offset with a client id for the new note, saving any unsaved text in the same action. References render as in-app links showing the target's current name; backlinks and explicit connections (add, remove) appear on the item.
- **History**: an item's versions, a version's snapshot compared with the newest or the one before, and restore as a new change. Libraries upgraded from before history show a labelled starting point. A restore (or an AI undo) whose files are no longer on the computer says which ones didn't come back; a restore that waited in the outbox reports it when it's sent, as a notice in Settings › Outbox.
- **Edit with AI**: ask the computer's configured AI for a proposal, review each change before/after, apply the ones you keep (all together or none), and undo them afterwards unless the item changed again. Online only; turning on "Auto-organize" is a separate opt-in.
- **Vault** (only when the token has the `secrets` scope, which pairing grants only with `--scope secrets`): secret notes are sealed on the phone (PBKDF2-SHA256 600,000 rounds, AES-256-GCM bound to a client-made UUIDv7) and sent as ciphertext. The passphrase, keys and opened text live only in memory and are dropped on lock, on leaving the app, and on re-pairing. The phone never uses the host-decryption vault routes. Notes sealed in the computer's older scrypt format open only on the computer. The list loads 50 at a time with "Show older secret notes", fetched only through the uncached session, and shows secret notes nested under the secret notes they sit in (placement is visible metadata; text isn't).
  - **Nesting**: a secret note can hold other secret notes ("New secret note inside", sent with `parentId`) and move between them or to the top level through the outline route; nothing ordinary goes under a secret note, though a secret note may sit inside ordinary content.
  - **Files**: "Add a file" reads the file on the phone and seals it as one envelope (`PMVF1` frame with the real name and type inside, AAD `petty-memory:file:v1:<item>:<attachment>`, at most 20 MB) sent with `PUT /vault/items/:id/attachments/:attachmentId`; the computer stores only "Encrypted attachment.pmv". "Save…" downloads the envelope, decrypts it here and hands it to the system save sheet: it is never previewed or opened in the app, and the decrypted bytes are dropped when saved, dismissed or locked. Removing a file keeps it in the note's history.
  - **Recovery kit**: while unlocked, "Make a recovery kit" wraps the passphrase with a random key and shows that key once as a `pmr1_…` code, with the kit offered as a file to save. Both are needed (plus a library backup) to open the vault again from "Forgot it? Use a recovery kit"; neither is sent to the server or stored by the app, the code and kit leave the screen on lock or background, and the recovered passphrase is never shown.
  - **History**: restoring a secret note's version uses `POST /vault/versions/:id/restore` (ciphertext only, `secrets` scope); missing files are named.
- **Public links**: create a read-only `<server>/s/<token>` link for an item and what's inside it, leaving children out and choosing an expiry; the link is shown once. List and revoke links from Settings. The `/s/` page is served by the desktop app, `petty-memory serve` and the web launcher (`apps/web`).
- **Offline copy**: while the app is in the foreground and connected, it pulls the read-only `GET /library` feed 200 changes a page, saving its cursor with every page so an interrupted pull resumes, then long-polls `GET /changes` (one request for the whole app, cancelled in the background, backing off on failures) and pulls again when anything changes, reloading open screens once the pull has saved something new. A page counts only once its data and the cursor after it are on disk: a failed save is reported in Settings and retried from the same page, and overlapping refreshes run one after the other. The copy holds every ordinary item with its placement, archived text and file list, projects (and their briefings), and connections; secret notes never arrive (their ids come as deletions), and AI suggestions are dropped. A restored or replaced library rebuilds it from the start. Settings shows how much is saved and when it was last confirmed current. It lives per server and token and is deleted on unpair or re-pair. A refused token is reported, never answered from the copy.
- **Offline**: when the server can't be reached, the outline (including branches never opened), items, references, checklist progress, search (every word must appear in the title, text, tags, project, address or site), shelves, Home, projects, briefings and tasks answer from the copy or the last saved answer, whichever is newer, with an "Offline · saved copy" banner showing its age. Writes queue in the outbox in order and later ones wait behind earlier ones. New notes get a client UUIDv7, so they can be opened, edited, moved and given children before they're sent; queued moves, merges, splits, checks (with everything below a checked item) and presentation changes show at once, and rows queued past the end of a partly loaded branch are counted but held back until the rows before them load. Text edits carry their base text, so one that conflicts with a newer edit on another device, or a new note whose place is gone, is kept for you to save as a new note rather than overwriting. Vault, history, shares and AI are never saved and need a connection.

## Architecture

```
apps/ios/
  project.yml                XcodeGen spec: app, share extension, package and UI tests in the scheme
  Packages/EnveMemoryKit/    Foundation-only Swift package shared by both targets
    Models.swift             Codable models matching packages/core/src/types.ts
    Endpoint.swift           Every API call as a Codable value (the outbox persists these)
    APIClient.swift          async/await URLSession client, file upload/download
    APIError.swift           {error:{code,message}} → typed errors, retryability
    Pairing.swift            Pairing link parser, stored pairing
    CredentialStore.swift    Keychain store in the App Group access group
    Outbox.swift             File-per-entry queue in the App Group container, strict order, backoff, idempotent flush
    Editor.swift             Journalled editor commands and actions (`/editor/actions`), refused-draft recovery
    PendingEdits.swift       The outbox read back in order as an overlay: text, checks, presentation, new notes, placements
    OfflineLibrary.swift     The per-server replica from `/library` and `/changes`, answering ordinary reads offline
    AppGroup.swift           Shared container paths and settings (project cache, theme)
    Share.swift              NSItemProvider → SharedContent → API calls
  Shared/                    SwiftUI compiled into both targets
    Design/                  Hearth tokens: palette, type, spacing, radius, cards, chips, buttons, background
    Components/              ProjectPicker
  EnveMemory/                App target
    App/                     App entry, root view, router, Mantel dock
    Services/                Connection, OutboxService, EditorHistory, OfflineSync, ProjectStore (@Observable, via @Environment)
    Components/              Markdown renderer, item rows, empty/error states
    Features/                Onboarding, Home, Search, Projects, Tasks, Items, Outline, Capture, Settings, Vault, History, AI, Sharing
    Resources/Editor/        Host page and bridge for the shared editor; editor.js/.css are built by scripts/build-editor.sh
  EnveMemoryShare/           Share extension (UIHostingController + SwiftUI sheet)
```

Design choices worth knowing:

- **Every write carries an `Idempotency-Key`.** The key is generated when the request is built and persisted with the outbox entry, so the direct attempt and every retry, including from the share extension, share one key. If a response is lost after the server applied the write, the retry gets the original response (`Idempotent-Replayed: true`) instead of creating a second item.
- **Reminder words are resolved on the phone.** "Tonight" becomes an ISO time (20:00, 9:00 or Saturday 10:00, matching the server's rules) in the phone's time zone at the moment you tap it, so a capture that waits in the outbox until tomorrow still means tonight.
- **One path for writes.** `OutboxService.submit` tries the server and falls back to the outbox only for retryable failures (unreachable, timeouts, 5xx, 401). A 400 or 413 is shown to the user, since resending the same request can't succeed.
- **The share extension never flushes.** It tries the server once, and anything left goes to the outbox for the app to send. Only one process drains the queue, so flushing never double-sends in-process; concurrent `flush` calls collapse into one.
- **The pairing lives in the Keychain** as one item in the `group.com.enve.memory` access group, accessible after first unlock (so background refresh works while the phone is locked). If an unsigned build lacks the entitlement, the store falls back to the app's default access group.
- **The design system is local.** `Shared/Design` uses Petty Tracker's cool gray surfaces and teal accent (`#0F7A8A` in light mode, `#4FC1C9` in dark mode), plus true-black OLED surfaces. It keeps the serif display type with Dynamic Type, the 4 pt spacing rhythm, radii (inner 14, card 20, bar 30), floating Mantel dock with a published `bottomBarInset`, and Reduce Motion-aware ambient background. Stored `ink`/`paper` preference values remain compatible; their labels are Dark/Light. Long text sits on opaque surfaces with no glow behind it.

## Tests

The package tests use Swift Testing and run on macOS or the simulator:

```bash
cd apps/ios/Packages/EnveMemoryKit && xcrun swift test          # macOS, a few seconds
cd apps/ios && xcodebuild test -project EnveMemory.xcodeproj -scheme EnveMemory \
  -destination "platform=iOS Simulator,name=iPhone Air"
```

(`xcrun swift` avoids a stale toolchain that `swiftly` may put first on `PATH`.)

They cover the new item fields (tags, intent, pin, opened, reminder, AI suggestions, search previews), shelf queries, reminder presets (including a daylight-saving change), the pure reminder plan (what to schedule, replace and cancel given the server's list, capped at 60 because iOS keeps 64 pending), item deep links, idempotency keys (fresh per write, kept across a lost response and the outbox retry), paging parameters and cursors, pairing-link parsing (valid, invalid and missing fields, `+` as space), request building (paths, strict query and header percent-encoding, bodies), error mapping through a `URLProtocol` stub (envelope codes, non-envelope statuses, connection failures, decoding), the outbox (persistence, strict ordering behind a retryable failure, timestamps that survive rewriting, concurrent flushes, backoff schedule, permanent failures, file uploads, withdrawal, removal), the offline copy against a fake `/library` feed (unopened branches, ancestors, archived text, connections, references, search ranking and snippets, paging that resumes from its cursor, long-poll, moves, deletions and secret evictions, backup resets and device changes, a revoked token, compaction, per-token isolation, nothing secret or AI on disk), the pending overlay (ordered placements across branches, client-id notes with children and edits, partly loaded branches, checks on ancestors, splits with UTF-16 offsets and merges, undo and redo of queued actions), editor action and undo/redo request shapes, refused-draft recovery, restore results with missing files, AI grouping proposals that keep their temporary ids, JSON decoding of responses captured from a real `petty-memory serve` 0.1.0 (`Tests/EnveMemoryKitTests/Fixtures`), and the share extension's item-provider → payload conversion.


## Parity regression checks

`xcrun swift test` runs the package checks without downloading models. To include the live encrypted-file API contract, set `MEMORY_TEST_SERVER` and `MEMORY_TEST_TOKEN` to a disposable server/library with the fixed vault fixture seeded (`packages/core/test/fixtures/vault-closeout-v1.json`). The token needs read/write/secrets. Without the server variable that one integration case is disabled.

The `EnveMemoryUITests` target uses the normal pairing, outline/editor and vault interfaces, plus read-only API assertions. Run it on a dedicated simulator with a fictional library. Provide `TEST_RUNNER_MEMORY_PAIRING_LINK`, `TEST_RUNNER_MEMORY_VAULT_PASSPHRASE`, `TEST_RUNNER_MEMORY_VAULT_PARENT_TITLE`, `TEST_RUNNER_MEMORY_VAULT_CHILD_TITLE` and `TEST_RUNNER_MEMORY_VAULT_CHILD_SECRET`. A missing required fixture skips the corresponding tests. If the runner pasteboard is isolated, `TEST_RUNNER_MEMORY_UI_TYPE_PAIRING_LINK=1` types the disposable link instead. XCTest records typed fixture values: never use real credentials or a personal library. The vault case saves an encrypted kit with a unique filename in the simulator's Files storage and checks locking. Explicit snapshots omit the recovery code; automatic recordings and activity logs still contain fixture data. See [the verification record](../../docs/PARITY_VERIFICATION.md) for authoritative results.
