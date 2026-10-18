# Useful every day — implementation plan

Authorized October 17, 2026. This extends the completed public-feature comparison and AI chat layer. Work proceeds across the feature set in layers: shared contracts and services, usable clients, then verification and polish. An implementation is not called complete until Codex reviews the diff and runs its checks.

## Scope and acceptance

| Improvement | First complete workflow | Acceptance |
|---|---|---|
| Saved AI conversations | Explicitly save, list, reopen and update a conversation; save an answer as an ordinary note. | Opt-in; bounded messages; export/history/sync preserve saved content; unsaved chats remain ephemeral. |
| Broader AI actions | Propose tasks, tags, reminders and a brief from a chosen branch or keyword topic. | Preview individual operations; selective atomic apply; stale scopes refused; guarded undo; no delete or arbitrary tools. |
| Better topic discovery | Supplement complete keyword discovery with bounded semantic suggestions. | Mark suggested matches; user reviews all placements; keep keyword-only operation when embeddings are unavailable. |
| Voice and image capture | Dictate a note; extract text from an image and review before saving it. | Permissions only on request; original image retained; no automatic send; explicit unsupported/error states. |
| Daily review | Revisit due knowledge and choose when to see it again. | Local scheduling and history; adjustable intervals; secrets/definitions excluded; ordinary note access preserved. |
| Connections and duplicate cleanup | Review unlinked mentions, related notes and potential duplicates; connect or merge deliberately. | No AI required; originals recoverable; merge preview, stale checks and undo; attachments and children retained. |
| Enve imports | Import book highlights/annotations with source and location; navigate back when a source link is available. | Validate a documented interchange format; preview/count imports; repeated imports do not duplicate passages; never read private app databases. |
| Onboarding and release quality | A useful first-run checklist, provider guidance and discoverable workflows. | No required AI/account; existing library respected; physical-device, signing, cross-OS and store gates remain explicit. |

## Layers

1. **Shared foundations:** saved conversations, review scheduling, connection discovery/merge, action proposals/apply/undo, semantic candidates, OCR and Enve import boundaries.
2. **Client workflows:** desktop, browser and iPhone entry points, review screens, progress/errors, accessible controls and first-run guidance. CLI/API access for host workflows.
3. **Verification:** authoritative root checks; desktop/browser journeys; Swift package and dedicated iPhone Air builds/UI runs; permitted small-model integration; fictional capture/import fixtures; documented platform limits.
4. **Publication:** update README, API/architecture/user guides and screenshots; commit reviewed increments to `main` and push. Signing/store publication requires the actual distribution environments.

## Constraints

- Existing core owns SQLite and every mutation is journalled in its transaction. Prefer versioned ordinary-note metadata for portable workflows.
- Only ordinary active material enters discovery and models. Decisions, secrets and workflow definitions are excluded. Saved content never authorizes actions.
- AI writes require explicit review and write scope. Receipt replay never refreshes an undo guard over newer edits.
- Only `qwen2.5:1.5b` on the configured lab Ollama may be used for LLM verification. No large model downloads.
- Codex owns integration, git, final tests and UI verification. Delegates have separate file ownership and do not commit or push.

## Shared client contract

Paths below are relative to `/api/v1`. Desktop IPC mirrors the same payloads through core. Additional fields may be introduced compatibly; no secret/provider credentials are returned.

### Conversations

`SavedConversation = {id,title,mode:'ask'|'edit'|'organize'|'actions',project?:string,rootId?:string,query?:string,messages:{role:'user'|'assistant',content:string}[],createdAt,updatedAt}`.

- `memory.chats.list({query?})` / `GET /conversations?query=` → `SavedConversation[]` (newest 100 matching chats; keyword search covers the whole saved library).
- `memory.chats.get(id)` / `GET /conversations/:id`.
- `memory.chats.save(input)` / `POST /conversations` → saved conversation. Input is the fields above, with optional id and without timestamps. Explicit saving only; write scope.
- `memory.chats.archive(id)` / `DELETE /conversations/:id` → archived ordinary item; reversible, never hard delete.
- Saving an answer uses the existing note capture service, with its numbered source links converted to ordinary item references.

### Review

- `memory.review.queue({limit?,project?})` / `GET /review?limit=&project=` → `ReviewCard[]`.
- `ReviewCard = {item:Item,dueAt:string|null,lastReviewedAt:string|null,reviewCount:number,reason:string}`.
- `memory.review.schedule(id,days)` / `POST /review/:id` `{days}` → updated Item. Whole days 1–3650; journalled metadata preserves review count/time/due date. Presets: tomorrow, next week, next month.

### Connections and merge

- `memory.insights.forItem(id)` / `GET /items/:id/insights` → `{itemId,mentions:KnowledgeSuggestion[],related:KnowledgeSuggestion[],duplicates:KnowledgeSuggestion[],scanned,total}`.
- `KnowledgeSuggestion = {id,title,snippet,reason,score}`. Suggestions exclude the current item, archived material, secrets and workflow definitions. Bounded discovery is identified by scanned/total.
- Accepting a connection uses existing `items.relate(id,otherId,'related_to')`.
- `memory.insights.previewMerge(sourceId,targetId)` / `POST /insights/merge/preview` `{sourceId,targetId}` → `MergeProposal = {sourceId,targetId,baseHash,sourceTitle,targetTitle,preview:{title,body,movedChildren,retainedAttachments}}`.
- `memory.insights.merge(proposal)` / `POST /insights/merge` `{proposal}` → `EditorActionResult`. Ordinary notes only; preview bound to live subtree states; original source archived, not deleted; existing editor moves/merge retain children and support `editor.undo`. Source attachments remain on the recoverable original.

### AI actions

`POST /ai/chat` adds mode `actions`, requiring exactly one of `rootId` or `query` and optional project for a topic. Response `{kind:'actions',proposal:ActionProposal}`. A proposal never mutates content.

`ActionProposal = {id,rootId:string|null,query:string|null,project:string|null,baseHash,summary,operations:ActionOperation[],createdAt,titles?:Record<string,string>}`. Titles are presentation labels; the host revalidates scope and targets independently when applying.

Operations have an id and one of these kinds:

- `task`: `{id,kind:'task',title,body,sourceId:string|null,dueAt:string|null}`.
- `tag`: `{id,kind:'tag',itemId,tags:string[]}`.
- `reminder`: `{id,kind:'reminder',itemId,remindAt:string|null}`.
- `note`: `{id,kind:'note',title,body,sourceIds:string[]}`.

The host derives project filing from the reviewed scope, never from model-provided IDs. Operations are bounded to ordinary scope items. `POST /ai/actions/apply` `{proposal,includeIds?:string[]}` → `{actionId,createdIds:string[],updatedIds:string[],undo:{actionId,afterHash}}`. `POST /ai/actions/undo` `{receipt}` → `{restored:number}`. Both require write scope; undo refuses newer work.

### Capture and Enve imports

- `POST /capture/ocr` `{attachmentId}` → `{text,engine}`: read the explicitly selected ordinary image attachment, extract text without saving a note; read+write scope. Native iPhone may extract using Vision on-device and show a draft directly.
- `POST /imports/enve-highlights/preview` `{data}` → `{format,entries:EnveHighlight[],skipped:number}`.
- `POST /imports/enve-highlights` `{data,project?:string}` → `{created,skipped,failed:{source,error}[]}`. Write scope. `EnveHighlight = {id,bookTitle,author,text,note,location,sourceUrl:string|null}`. Source-provided URLs are validated against safe documented schemes.

## Progress

- Shared services and desktop/browser/iPhone workflows implemented and reviewed.
- Root checks, Swift package checks, desktop packaging/OCR and small-model actions verified.
- All 62 desktop/browser journeys and six native iPhone journeys passed. Screenshots and user/API/architecture documentation are updated; see [POWER_VERIFICATION.md](POWER_VERIFICATION.md).
- The planned implementation and documented verification are complete. Physical-device, signing and distribution gates remain listed in the verification record.
