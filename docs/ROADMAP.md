# Roadmap

## In 0.1

The whole local product: the library (notes, links, files, images, tasks, decisions, projects), link and PDF archiving, keyword and semantic search, the MCP server, the local HTTP API, optional AI enrichment and cited answers, backups and export, importers, automation rules, encrypted folder sync, the desktop app, the browser extension and the iOS app. See the [changelog](../CHANGELOG.md) for details.

## Next

- **Signed and notarized macOS builds**, so the app opens without the right-click workaround.
- **Windows and Linux installers** built and tested on those systems, published with each release.
- **Store listings** for the browser extension (Chrome Web Store, Firefox Add-ons) and the iOS app.
- **Physical-device acceptance** on iPhone for dictation, the camera, Vision text recognition, background refresh and the share sheet.
- **Better briefings for AI tools**, tuned from real use: tool descriptions, what `get_project` returns, and how much context each call costs.
- **Semantic search on Intel Macs**, once the embedding runtime ships an Intel build.
- **Links back into Enve books**, once Enve Book Player's export includes stable book identifiers or source links. Imports are file-based today, with no live sync.

## Daftak parity program

The user authorized a full parity plan and initial implementation on 2026-10-17. See [DAFTAK_PARITY_PLAN.md](DAFTAK_PARITY_PLAN.md) for scope, milestones, delegation, acceptance checks and current progress.

The feature implementation now includes formatted editing, split/join and structural undo/redo; paged project and item history with retained file recovery; a complete ordinary offline phone library and durable outbox; live server sync; nested encrypted secrets, encrypted attachments and portable recovery kits. Core, desktop, browser and iPhone share the contracts. Codex verification and external platform/release gates are recorded in [PARITY_VERIFICATION.md](PARITY_VERIFICATION.md). A public feature comparison is not a claim of signed-in Daftak equivalence or production release readiness.

Local capture, storage, search and editing remain complete without an account, network connection or AI provider. Hosting and public sharing are optional additions, with their own security designs and release gates.

## Workflow additions after parity

The October 17 research pass selected reusable note/checklist templates and saved keyword/filter views as the first implementation batch. They reduce repeated setup and make large libraries easier to use without AI. [Outline templates](https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl) and [Obsidian Bases](https://obsidian.md/help/bases) informed the workflow choices; Memory implements a bounded version within its existing item model. See [WORKFLOWS.md](WORKFLOWS.md).

## Everyday workflows

The second batch, also authorized on October 17, adds opt-in saved AI chats, suggested actions, semantic suggestions for topic organization, note dictation and image text, daily review, suggested connections with duplicate merging, Enve highlight imports and first-run checklists. [POWER_PLAN.md](POWER_PLAN.md) records the scope; [POWER_FEATURES.md](POWER_FEATURES.md) is the user guide.

[Readwise's review model](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights) was the reference for daily review's local history and adjustable intervals. [Obsidian's backlinks](https://obsidian.md/help/plugins/backlinks) were the reference for unlinked mentions: suggestions are offered, and explicit references stay the authority. Physical-device, signing, cross-platform installer and store gates are unchanged and listed under *Next*.

## Later

These need a security design before any code:

- Third-party plugins, sandboxed.
- Managed hosting and production publication, after the parity service has passed its local and self-hosted acceptance checks.

## Not planned

Team collaboration, social features, analytics and a custom model. The local product stays complete and free; if a paid tier ever exists, it will cover only optional services such as hosted encrypted sync.
