# Daftak feature parity verification

2026-10-17 · Codex authoritative checks · `main` in `Enve Memory` · origin `https://github.com/petty-foss-dev/Petty-Memory.git`.

The planned feature implementation gaps are closed. The comparison covers [Daftak's public feature list](https://www.daftak.com/), not a signed-in equivalence audit. Core, desktop, browser and iPhone have working implementations; production hosting, release packaging and physical-device acceptance are separate gates below. See [DAFTAK_PARITY_PLAN.md](DAFTAK_PARITY_PLAN.md) for scope and [PARITY_CLOSEOUT_CONTRACTS.md](PARITY_CLOSEOUT_CONTRACTS.md) and [VAULT_CLOSEOUT_CONTRACTS.md](VAULT_CLOSEOUT_CONTRACTS.md) for the shared contracts.

All checks used fictional libraries and disposable credentials. No real library was opened. The user explicitly requested repository publication after functional verification; no hosting deployment or installer publication was performed. Actual Claude Opus 5.5 handled bounded editor/UI, core/history/sync, native/offline/vault and review assignments. Codex inspected the changes, integrated transports and fixes, and ran the authoritative checks.

## Results

| Check | Result |
|---|---|
| `npm run check`, alone from the repository root | Passed: root/editor typechecks, 313 package test events (including 61 mounted/Markdown editor tests), 47 extension tests, 54 desktop unit tests and 9 browser crypto tests; browser build and launcher checks included |
| `ENVE_E2E_OLLAMA=http://100.114.100.51:11434 npm --prefix apps/desktop run test:e2e` | 38 passed, 0 failed, 0 skipped; builds all desktop/browser/CLI assets and exercises actual `qwen2.5:1.5b` |
| `npm --prefix apps/extension run test:e2e` | 14 passed, 0 failed, 0 skipped; actual Chromium popup, options, side panel, import, reminders, visit tracking and offline queue |
| `xcrun swift test`, with the disposable `MEMORY_TEST_SERVER` and `MEMORY_TEST_TOKEN` | 155 passed in 30 suites; includes native-encrypted file upload/download/history restore against the real API |
| XcodeBuildMCP `test_sim`, scheme `EnveMemory`, dedicated iPhone Air, `-only-testing:EnveMemoryUITests -parallel-testing-enabled NO` | 2 passed, 0 failed, 0 skipped after the palette update in dark mode (280.7 seconds); builds, installs and runs the app through XCUITest |
| XcodeBuildMCP `build_run_sim`, dedicated iPhone Air | Build, installation and launch succeeded in dark and light appearances |
| Browser UI through Codex in-app browser | Formatting/save/undo/redo; nested secrets; encrypted file download/upload; recovery kit creation/unlock; automatic refresh after another client writes; selective anonymous sharing and UI revocation all exercised |
| Palette contrast measurements | 156 measured token pairs passed: at least 4.5:1 for normal text and 3:1 for measured control boundaries |
| `git diff --check` | Passed |

No source/compiler warnings were reported by the final builds. Xcode emitted its tool warning `Metadata extraction skipped, no AppIntents.framework dependency found` for targets without App Intents. The simulator is `Petty Memory Parity Air` (`9A5D0645-4626-4ADD-A976-BDDE3FC3553B`, iOS 27). Direct host UI control was unavailable while macOS was locked; Xcode's native test driver successfully exercised the app. The dark native run logged animation-idle timeouts and continued successfully; this added test-driver time without failing either workflow.

## Feature coverage

- **Editing and outlines:** ordered nesting, stable client ids, paging, move/indent/outdent, multiline paste, title/body split and adjacent-note join, journalled whole-action undo/redo. Desktop, browser and native body editing reuse the bundled ProseMirror editor. Original Markdown is retained exactly until edited, and unsupported tables, HTML and definitions stay editable as inert source. Remote images are not fetched by editing.
- **Presentation:** headings, section breaks, attention levels, review marks, highlights, tags, checklists and completion/progress/reset. References, backlinks and explicit connections retain item identity across moves and sync.
- **History and recovery:** per-item/subtree snapshots, comparison, paged project memory history for local and synced work, restore as a new change, guarded AI undo and retained historical attachment bytes. Missing file bytes are reported explicitly. History cannot steal another item's attachment, and same-owner changed bytes restore correctly.
- **AI:** hash-bound proposals, selective atomic apply, temporary heading references for grouping existing children, guarded undo and opt-in background organization. Decisions, secrets, archived or out-of-scope items stay excluded. The ordinary product works with AI disabled.
- **Offline iPhone:** a complete paged ordinary-library index, unopened branch navigation, local search, per-server/token isolation, optimistic structural overlays and a FIFO outbox with stable ids and base-text conflicts. Interrupted writes do not advance the durable cursor or expose uncommitted archived text/files. Unreadable state is reported, not treated as an empty copy. Secrets, history, AI and shares remain online operations; ordinary attachment bytes are not mirrored automatically.
- **Live sync and hosting:** desktop local-change watching plus negotiated server long-polls; browser/native foreground change notifications; cancellation, revocation checks, older-server fallback, byte-bounded batches and persistent partial-page retries. Accepted records on a partially refused pull are acknowledged, avoiding false conflicts. Host limits, write admission, health and operating guidance are included in [SELF_HOSTING.md](SELF_HOSTING.md).
- **Vault:** secret-only nesting, device-local browser/iPhone encryption, encrypted files with hidden names/types and item/attachment-bound AAD, portable recovery kits, explicit device scopes and revocation. Plaintext host HTTP vault routes are disabled by default and always disabled on a LAN listener. File removal is recoverable through history. Pending desktop save operations cancel if the vault locks/relocks or the library changes while a native dialog waits.
- **Crypto interchange:** independently generated Node fixtures open in Swift and browser crypto, including a NFKC-normalized passphrase, all 256 byte values, Unicode filename and recovery kit. Browser- and native-created ciphertext crossed the actual API and opened in core with exact content. The 20 MiB encrypted-file boundary crossed HTTP intact; excessive requests were refused. These are bounded interoperability/leak tests and engineering reviews, not a production security certification.
- **Selective sharing:** exclusion of branches, secrets, archived content and private references; one-time link display; expiry and revocation. The browser created a share excluding a child, opened its sanitized projection anonymously, revoked it through the in-page dialog and observed “Shared page unavailable.”

## UI and regression evidence

The 38 desktop workflows include existing capture/projects/tasks/search/reading/pairing/import/export/backup/automation/reminder/theme flows, outline reordering and 250-child paging, split/join, text and structural undo/redo, failed-save drafts, narrow/deep layouts, encrypted-file removal/history restore, recovery and browser draft confirmations. Native dialogs are stubbed in Electron E2E; their real OS integration remains a manual release check.

Native UI tests pair through the normal interface, verify server state after outline create/undo/redo, edit title and formatted body, inspect the equivalent Markdown and confirm the saved API state. The vault test opens a nested secret, creates a one-time recovery kit, saves it through the actual system Files sheet, verifies that the vault stays usable and locks it to remove plaintext. The native API test additionally encrypts/uploads, downloads/decrypts and restores a removed secret attachment against the real host.

Two editor regressions received deterministic mounted tests: delayed controlled-value echoes must not replace newer typing, and a first keystroke arriving before `selectionchange` must record history at the visible caret. The desktop keeps the standard Electron Edit menu. Test selectors account for WebKit formatting toggles appearing as switches and scroll controls above the floating dock. The native fixture UI uses the ASCII NFKC equivalent of its passphrase; the crypto tests separately cover the original ligature bytes.

## Petty palette and current screenshots

The palette follows `Petty-Tracker/ios/PettyTracker/UI/Theme.swift`: cool gray surfaces around teal. Desktop, browser/public pages, extension, iPhone and its shared design system use the same semantic roles. Dark/light mode labels changed while existing stored `ink`/`paper` preference values remain compatible. The iPhone also retains true-black OLED surfaces.

| Role | Light | Dark |
|---|---|---|
| Background | `#F3F5F6` | `#0E1113` |
| Elevated surface | `#FFFFFF` | `#181D20` |
| Primary text | `#1B2328` | `#E6EBEE` |
| Accent / on-accent | `#0F7A8A` / `#FFFFFF` | `#4FC1C9` / `#0B1F22` |
| Tinted container / text | `#E2F1F3` / `#0F6573` | `#173238` / `#7FD3D9` |

Primary button contrast is 5.03:1 light and 7.95:1 dark. Codex strengthened control borders and added separate native accent-text tokens after finding seven insufficient color pairings; all 156 measured pairs then passed. These measurements cover semantic tokens, not a full accessibility certification. Codex inspected desktop/browser/extension captures in both schemes and native dark editing/vault and light/dark home screens. The browser reported no runtime errors during the final manual inspection.

Current proof is in [screenshots/parity](screenshots/parity/); the desktop and extension galleries and README hero were regenerated. Desktop and extension icons were rebuilt from their existing vector/code sources with the same geometry.

The native icon at [AppIcon.png](../apps/ios/EnveMemory/Assets.xcassets/AppIcon.appiconset/AppIcon.png) was recolored with the built-in `image_gen` tool from its existing raster source, then resized to the required 1024×1024 opaque PNG. The generated original remains under the local Codex generated-images folder.

<details>
<summary>Native icon edit prompt</summary>

Use case: precise-object-edit. Edit target: the provided Petty Memory iOS app icon. Recolor ONLY this exact existing icon to the current Petty apps teal/slate palette. Keep the exact large serif capital M glyph shape, its size and placement, the small dot placement and size, composition, edge-to-edge square 1024x1024 crop and smooth soft central glow. Replace warm nearly-black background with cool dark slate #0E1113, replace amber/brown glow with a restrained cool teal glow based on #173238, replace cream M with cool near-white #E6EBEE, replace orange dot with solid teal #4FC1C9. No orange, brown or beige anywhere. No additional shapes, text, perspective, bevels, shadow around the icon, frame, rounded corners, or transparency. Output the single recolored flat app icon, keeping every existing shape unchanged.

</details>

## Remaining release and operating gates

- A managed hosted account service has not been deployed. Self-hosted browser access, server sync and sharing work; deployment needs an actual host, DNS/TLS and operating budget.
- Windows/Linux installer validation, macOS signing/notarization, App Store packaging and physical-device/share-extension/background testing need their respective systems and credentials. Full VoiceOver, Dynamic Type, IME and large-library performance acceptance remain release checks.
- Production security auditing and comparison with signed-in Daftak behavior remain external validation. Project/tag/placement metadata stays visible for secrets, and earlier plaintext backups/exports cannot be retroactively encrypted. Revocation cannot erase a device's previously decrypted copies.
- History and folder-sync segments are not compacted automatically. Plan disk capacity and full-directory backups; no content is silently pruned. Grossly future-dated peer changes stay pending until the peer's clock/content is corrected. Native secrets need a connection.

## Local evidence

Current briefs, reviewed handoffs and logs: `/tmp/petty-memory-parity-closeout.ChxWVx/`. Key records: `check-palette.log`, `desktop-e2e-palette.log`, `extension-e2e-palette.log`, `palette-contrast.log`, `ios-kit-live-final.log`, `vault-api.log`, `file-history-final.log`, `editor-caret-final.log` and the native Xcode result bundles under `~/Library/Developer/XcodeBuildMCP/workspaces/enveworkspace-15340b2fb5b6/`. Inspected current screenshots are committed under `docs/screenshots/parity/`; detailed native attachments remain in the evidence folder. Temporary evidence may be cleaned by the OS. Earlier feature-layer evidence remains under `/tmp/petty-memory-parity-run.S7c4r1/`.
