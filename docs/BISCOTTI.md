# Biscotti meeting notes

Petty Memory can import meeting summaries, personal notes and speaker transcripts from [Biscotti](https://github.com/scosman/Biscotti). Selected meetings become ordinary searchable notes with history, project filing, sync and offline reading. Recording and audio playback remain in Biscotti.

Try the importer with the [fictional sample export](../examples/biscotti-meetings.csv). These sample meetings have no original recording.

## Import an export

In Biscotti, open **Settings → Import/Export** and export meetings as CSV. In Petty Memory:

- **Desktop and browser:** Knowledge → Meetings → Import CSV.
- **iPhone:** Home → Library → Meetings → Import a Biscotti export.

Preview the contents, untick meetings you do not want, choose a project or Inbox, and press Import. Choosing a file never saves it. Existing imports are identified by Biscotti's meeting ID, including notes you archived. Reimporting skips them and preserves your edits; it never updates or revives an earlier note.

The preview keeps the full original transcript alongside parsed speaker turns. Dates, summaries and your notes remain readable in the saved note. A CSV does not include recordings, calendar data, participant records or tags; speaker names written in the transcript are retained.

## Connect the Mac app

On the Mac where Biscotti is installed, enable **Biscotti → Settings → General → MCP**. In Petty Memory's desktop app, open **Knowledge → Meetings → Browse Biscotti**, then **Connect and search**. Search by topic, person or date, choose one meeting, preview it and import it.

The connector only calls Biscotti's read-only meeting search, details and transcript tools at `http://127.0.0.1:8516/mcp`. Opening Meetings does not connect or scan. Each selected meeting is read individually. Participant names and tags are retained when Biscotti supplies them. **Open in Biscotti** and the moment buttons open the original recording at that timestamp; Petty Memory never reads audio paths or copies recording files.

The live connection needs the Mac desktop app and a separately installed, running Biscotti. A server on another computer cannot reach the Mac's loopback address. The browser and iPhone import chosen CSV files and read meetings already saved to their Petty Memory library.

## Work with a meeting

Imported meetings can be filtered by project, title, summary or speaker. The text filter covers loaded pages; load older meetings to include more. Lists follow the library's usual last-updated order, initially the original meeting date.

- **Ask about meeting:** open an editable AI question naming that meeting.
- **Prepare next meeting:** draft questions about earlier agreements, open questions and preparation.
- **Find follow-ups:** suggest tasks from the selected meeting without guessing owners or deadlines.
- **Write a brief:** propose a separate summary note, preserving the meeting.
- **Review in a week:** schedule the ordinary note for another look.

AI shortcuts fill drafts; they never send automatically. Follow-ups and briefs use the existing selected-action review and guarded Undo. AI needs the library's configured provider. Import, search and reading work without AI.

## Privacy and limits

Import copies the selected meeting text into **your Petty Memory library**. It then follows that library's device sync, backups and AI settings. Using a cloud AI provider may send selected note text to that provider. Nothing enables recording, imports in the background or changes Biscotti.

Exports are UTF-8 CSV with `id,title,created,summary,notes,transcript` columns. `document_id`, `document_title` and `document_created` aliases are accepted. Quoted multiline cells and doubled quotes are supported; malformed quoting blocks the file. Invalid rows and duplicate IDs are reported in the preview. Calendar-only dates normalize to midnight UTC; full timestamps preserve their instant.

- Up to 8 MiB and 500 meetings per export.
- Titles up to 500 characters; summaries and notes up to 100,000 each; transcripts up to 500,000, with 600,000 combined characters per meeting.
- At most 2,000 parsed speaker turns/moment buttons per meeting; the saved transcript retains all source text.
- Live search returns up to 250 matches (the desktop view asks for 50); narrow the query or date range when results are capped.
- Imports and review scheduling need a connection. Imported ordinary notes use the existing offline library. The meeting directory can show its last saved response on iPhone after it has been loaded online.

An import binds the chosen meetings to a fingerprint of the previewed source. Changed text must be previewed again. Each meeting is saved independently; failures are reported and retrying skips earlier successes.

## CLI and API

```sh
petty-memory import biscotti meetings.csv --json
petty-memory import biscotti meetings.csv --apply --ids meeting-id -p project
```

The CLI previews by default. `--apply` imports all readable meetings unless `--ids` selects a subset.

Authenticated REST clients can use:

- `POST /api/v1/imports/biscotti/preview` with `{data,source:"csv"}`. It requires read and write scopes and never caches a preview for idempotent replay.
- `POST /api/v1/imports/biscotti` with `{data,source,fingerprint,includeIds,project?}`. It requires read and write scopes and supports the usual idempotency key. `source:"mcp"` accepts normalized meeting objects already read by the desktop connector; it never opens a host connection.
- `GET /api/v1/meetings/biscotti?project=&before=&limit=50` with read scope. It returns `{items,next}`; limits are capped at 100.

Only the desktop has local Biscotti connection methods. Remote API tokens cannot use this integration to browse host paths or make the server contact the Mac app.

## Implementation and verification

This is an independently written data-format and MCP integration. Biscotti code and binaries are not bundled or copied into Petty Memory. Its [PolyForm Perimeter license](https://github.com/scosman/Biscotti/blob/main/LICENSE.md) includes a noncompete restriction; the two applications remain separate.

Importer, API and connector tests cover source identity, selection, stale previews, source preservation, authentication, replay, bounded responses and redirect rejection. Native desktop/browser journeys exercise imports and reviewed follow-ups using fictional meetings and a scripted MCP/model fixture. Those fixtures validate integration behavior, not recognition or model accuracy. An actual Biscotti installation is required to verify recording playback and a connection to a particular Biscotti release.

Verified on October 20, 2026:

- `npm run check`: package, extension, desktop and browser checks passed.
- Biscotti desktop/browser journeys: 4 passed, including selected imports, duplicate preservation, Mac protocol browsing and reviewed follow-ups with Apply/Undo.
- iOS package: 220 tests passed across 44 suites.
- Native iPhone Air journeys: 2 passed, covering speaker filtering and an unsent AI draft, plus Files → preview → import → ordinary note.
- Simulator and signed iPhone 16 Pro builds succeeded with no new warnings. Xcode's existing App Intents metadata warning remains.
