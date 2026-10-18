# Knowledge workflows

Authorized October 17, 2026. Implement all seven additions in breadth-first layers, then verify the connected workflows. Codex owns integration, review, builds, browser and simulator acceptance; Claude drafts bounded implementations.

## Scope

| Addition | Working outcome |
|---|---|
| Reusable AI workflows | Save a named instruction and branch/topic scope; run against a fresh snapshot, review individual actions, apply and Undo through the existing action service. No unattended AI writes. |
| Meeting and lecture capture | Record or import audio, preview/import SRT, VTT or timed JSON transcripts, play at a timestamp, save searchable source-linked passages, and propose tasks/briefs. Optional explicitly configured transcription; no model downloads or required cloud service. |
| PDF research | Preserve page text and originals, browse/jump to pages, highlight/annotate exact quoted passages, OCR scanned pages into reviewed drafts, and retain page locators in source citations. |
| Custom fields and views | Typed fields on ordinary items and reusable collections with table, cards and Kanban layouts. Stable ids, validated values, filtering/sorting and explicit edits. |
| Outdated/conflicting information | Bounded, source-grounded conflict suggestions with exact quotes and dates; review, dismiss, mark checked or explicitly supersede ordinary notes. Never silently rewrite claims or append-only decisions. |
| Watched sources | Opt-in URL/RSS and host-approved folder monitoring; bounded checks and a review queue for new/changed material. Preview before import/update; retain originals/history and refuse stale previews. Folder paths are local configuration, never remotely supplied host paths. |
| Organization preferences | Explicitly saved instructions with optional project scope. Use approved preferences when proposing organization; no implicit learning from private chats or automatic filing changes. |

## Shared implementation contracts

- All durable content uses ordinary item metadata, existing history/export/sync and core service transactions. No new SQLite access outside core. No schema migration unless the implementation actually needs one.
- Definition notes carry `metadata.knowledgeDefinition = true`. They, descendants of templates, secrets, decisions and saved chats stay outside action/review/conflict/organization source scopes. Research passages remain ordinary source notes.
- Codex owns `memory.ts`, core/AI/ingestion exports, shared API/IPC wiring, existing source-scope exclusions, provider credentials, and integration. Delegates own separate new services and their tests; shared files are assigned sequentially.
- Services accept `Context`, `ItemService` and required existing services through constructors. Root integration adds the named `EnveMemory` facade members.
- Workflows: `knowledge` service in `packages/core/src/knowledge.ts`: recipes, preferences, collection definitions, typed item values and filtered collection rows. New AI runners live separately in `packages/ai/src/knowledge.ts`.
- Research: `research` service in `packages/core/src/research.ts`: PDF page access, annotations and timed transcript preview/save. PDF extraction retains bounded `metadata.pdfPages`. Pure parsing / optional transcription in ingestion research files. No credentials stored in content.
- Sources: `sources` service in `packages/core/src/sources.ts` plus host-only ingestion watcher and AI freshness analysis. Folder approval must be local; remote clients can check/apply only already approved watch ids. Source checks never silently update original content.
- Proposals have bounded source snapshots and stale checks. Saved recipes are definitions, never stored executable proposals. Imported source text never becomes instructions.
- Root controls commits/pushes on `main`. Delegates must not change branches, commit, push, run destructive commands, access personal libraries, or launch unapproved models.

## Layers

1. Shared foundations for all seven features: core state and validation, pure parsers/host workers, AI proposal functions, tests specifying the boundaries.
2. REST and desktop IPC contracts, desktop/browser/iPhone UI. Reuse Petty colors, existing controls, per-operation previews and user-facing errors. Every feature must be reachable.
3. Review every delegated diff; typecheck/build; exercise realistic fictional workflows, malicious/stale inputs, export/sync/history and optional-provider failure paths. Use only `qwen2.5:1.5b` at `http://100.114.100.51:11434` for real LLM calls.
4. Update README, user guides, API/data/architecture/security notes and precise verification evidence; run `npm run check` on its own before committing and pushing `main`.

## Acceptance gates

- Automated core/API/client checks; meaningful tests for metadata round trips, authorization, stale proposals and unchanged originals.
- Desktop and browser: recipe to reviewed apply/Undo; collection editing and three layouts; audio+transcript seek; PDF annotation/page OCR; reviewed source update; conflict review; approved organization preference.
- iPhone Air: build and simulator journeys through the same available host workflows, native PDF and recording/import UI; microphone/camera accuracy remains a physical-device gate if no device is available.
- Packaged assets verified where PDF/OCR introduces worker or resource dependencies. No new compiler warnings; report pre-existing tool notices separately.
- No claim that a real speech provider was tested unless it actually ran. Caption import and provider adapter checks are separate from transcription accuracy.

## Status

- Planning and scope: complete.
- Shared implementation: complete; core/API boundary and real-provider checks passed.
- Desktop/browser/iPhone integration: complete.
- Final client verification and documentation: complete. All seven additions passed their acceptance journeys; exact results and remaining device/distribution gates are recorded in [KNOWLEDGE_VERIFICATION.md](KNOWLEDGE_VERIFICATION.md).
- Delivery: implementation, tests, screenshots and documentation ship together on `main`.
