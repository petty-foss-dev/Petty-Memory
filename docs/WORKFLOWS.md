# Saved views and note templates

These workflows reduce repeated setup and help you return to useful material. They need no AI provider. The first research references were [Outline templates](https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl) and [Obsidian Bases](https://obsidian.md/help/bases), reviewed October 17, 2026. Memory implements its own note-tree templates and keyword/filter lists within the existing library architecture.

## Saved views

Open **Saved views**, give the view a name, and choose a keyword query and filters. All filters combine with AND; keyword matching uses Memory's ordinary tokenized full-text search. Useful examples:

| Name | Filters |
|---|---|
| Garage work | Project Garage Door, type Task, status Open |
| Security reading | Type Bookmark, tag security, intent Read |
| Needs attention | Review marked, attention High |
| Forgotten links | Type Bookmark, unopened for 30 days |

Results reflect the current library whenever refreshed. They exclude archived items, secrets and workflow definitions. They are ordered by most recently changed time, with ID as a stable tie-breaker, and support cursor paging beyond the first 200 matches. The keyword query is stored as inert text, not SQL or an executable expression. Normal search's optional semantic ranking is separate.

Edit a view to replace its name/query/filters. Removing a view archives only its definition; it does not change matching notes, tasks or bookmarks. A project filter stores the project's stable ID, so renaming the project does not redirect the view.

```sh
petty-memory views create "Garage work" -p "Garage Door" --type task --status open
petty-memory views
petty-memory views run VIEW_ID --limit 50 --json
petty-memory views run VIEW_ID --before CURSOR --json
petty-memory views show VIEW_ID --json
petty-memory views edit VIEW_ID --set updated-view.json
petty-memory views remove VIEW_ID --yes
```

The replacement JSON contains `name`, optional `query`, and optional `filter`. Supported filter fields are `project`, `inbox`, `type`, `tag`, `taskStatus`, `pinned`, `intent`, `unopenedDays`, `reminders`, `review` and `attention`. Unknown fields are rejected.

## Templates

Create an ordinary note with optional nested notes, headings and checklist entries. Use **Save as template** in its detail actions to copy it into the template library. The original stays intact. Open a template in the existing note editor to improve future copies.

For example, a **Weekly review** root can contain **Wins**, **Open questions** and a **Next steps** checklist. Put `Review — {{date}}` in its title and `Project: {{project}}` in its body. Open **Templates**, choose it, select the destination project and create the next review.

Every copied note gets a fresh UUIDv7. Sibling order, nesting, tags and presentation are preserved; completion, review marks, automatic organization, reminders and pins are reset. Capture automation rules do not retag or refile these copies. Internal item references point to the new copies; references outside the tree keep their existing targets. Markdown checklist boxes are reset while code examples remain unchanged. A later edit to the template does not change copies already made.

Only `{{date}}` and `{{project}}` expand when using a template. Date is a calendar date (`YYYY-MM-DD`), supplied by the client or current UTC date by default. Project is the chosen project's name, or `Inbox`. Other placeholders remain literal text. Templates never execute code or request AI actions.

```sh
petty-memory templates create NOTE_ID --name "Weekly review — {{date}}"
petty-memory templates
petty-memory templates use TEMPLATE_ID -p "Garage Door" --date 2026-10-17
```

Template creation accepts active ordinary note trees of up to 200 entries. Secrets, attachments, archived descendants and non-note item types are rejected before writing anything. When editing an existing template, archive a step to leave that branch out of future copies. Active unsupported entries still prevent the whole copy. Use note checklist entries for repeatable steps. Files and append-only decisions remain in their normal workflows. Both template creation and use are atomic and recorded in library history.

## Clients, history and portability

Desktop and browser provide view management, result lists and template creation/use. iPhone provides native forms and lists; new workflow writes require the paired server. Disconnected iPhones can show previously cached lists/results with a saved-copy indicator. Cached results are a prior answer, not a live evaluation of later offline edits. Ordinary notes and template content remain part of the phone's offline library.

Definitions are ordinary notes with versioned `metadata.savedView` or `metadata.template`, rather than a separate external database. History, exports, backups and folder/server sync preserve them. Old clients can retain and display their ordinary note content. Workflow definitions should be edited through their dedicated forms; template text uses the ordinary editor.

MCP offers `list_saved_views`, `get_saved_view`, `run_saved_view`, `create_saved_view`, `list_templates`, `save_template` and `use_template`. Reads require `read`; creation requires `write`. Capture-only clients cannot inspect or copy source trees. MCP has no view-removal tool. See [API.md](API.md) and [MCP.md](MCP.md) for transport details.

## Further candidates

[Readwise's review workflow](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights) suggests a local, scheduled way to revisit useful knowledge with adjustable frequency. [Obsidian's unlinked mentions](https://obsidian.md/help/plugins/backlinks) suggest non-AI connection discovery. These are future ideas, not shipped capabilities. Existing review marks, explicit references and backlinks remain available today.

## Verification — October 17, 2026

Codex reviewed the delegated Claude Opus 5.5 changes, tightened imported-definition validation and copy behavior, then ran:

| Check | Result |
|---|---|
| Root `npm run check` | Passed: package/editor tests, 47 extension tests, 55 desktop unit tests, browser build/syntax/type checks and 9 browser crypto tests. |
| Desktop/browser E2E | 41 passed, zero failed or skipped, including the real `qwen2.5:1.5b` integration, template copying, saved-view create/edit/remove, draft retention and browser read-only scope checks. |
| Swift package | 161 tests in 31 suites passed. New tests cover endpoint bodies, decoding, offline metadata retention and cached-answer behavior. |
| Native iPhone build/run | Succeeded on the dedicated iPhone Air simulator. No compiler errors or new warnings; Xcode's existing AppIntents metadata-extraction notice remains. |
| Native workflow UI journey | One passed, zero failed or skipped: save/use template, create/query/rename/remove view, with independent server assertions. |
| Manual browser workflow | Confirmed project/task filters, Inbox and zero-day filters, removal confirmation, date/project expansion and fresh checklist progress against a disposable library. |

The desktop build initially crossed the bundle warning threshold; the workflow UI now loads as a separate chunk and the final build has no new warning. Test selectors were updated for the new “Saved views” navigation label and the normal drawer-close step. The [screenshots](screenshots/workflows) come from the browser regression test using fictional data. Physical-device and distribution gates in [PARITY_VERIFICATION.md](PARITY_VERIFICATION.md) still apply.
