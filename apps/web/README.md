# Petty Memory for the browser

A browser client for a Petty Memory library, plus a small launcher that serves it alongside the HTTP API. It is plain HTML, CSS and JavaScript with no build step. Beyond the engine and API packages in this repository, the page uses vendored copies of `marked` and DOMPurify in `public/vendor/` (refreshed with `npm --prefix apps/web run vendor`).

## Run it

Requires Node 24 or newer. From the repository root:

```bash
npm --prefix apps/web start -- --home ~/em-demo
```

or directly with `node apps/web/server.ts --home ~/em-demo`. Without `--home`, the launcher uses `$ENVE_MEMORY_HOME` and then the platform data folder, the same library as the desktop app and CLI. Try it against a demo library first (`npm run demo -- ~/em-demo`).

It prints the address to open, by default `http://127.0.0.1:49232`. Stop it with Ctrl-C; it closes the library cleanly. While running it also archives links, indexes for semantic search, runs AI enrichment and auto-organize when configured, and takes scheduled backups.

| Option | Meaning |
|---|---|
| `--home DIR` | Library folder |
| `--port N` | Port (default 49232, so it doesn't collide with the desktop app's API on 49231) |
| `--origin URL` | The exact origin browsers use to reach the server. Defaults to `http://127.0.0.1:<port>` |
| `--lan` | Listen on every interface for phones and other computers. Requires `--origin`, for example `--lan --origin http://192.168.1.20:49232` |

The desktop app and `petty-memory serve` serve the same client from their API address (`http://127.0.0.1:49231/` by default). In LAN mode they also accept this computer's network addresses as origins. Public `/s/<token>` pages work on either host.

The launcher's listener is loopback-only unless you pass `--lan`. Traffic is plain HTTP, so beyond your own network put it behind Tailscale or a TLS proxy and set `--origin` to the address people actually open. This is a self-hosting tool for your own devices, not a production service.

## Connect

The browser never creates credentials. Make a token on the machine that holds the library and paste it into the connection screen:

```bash
petty-memory --home ~/em-demo clients add "Browser" --scope read,write
```

The token stays in the tab's memory only; reloading the page or choosing Disconnect forgets it. A `read` token can browse, search, read saved chats and see what's due for review; `write` is needed to edit, run AI chat changes, save chats, reschedule review, merge, import, extract image text and create shares. To open encrypted secret notes, create a separate token that adds the `secrets` scope (`--scope read,write,secrets`). Ordinary tokens never gain it.

The same server also accepts other libraries' server sync with a `sync`-scoped token (see [SYNC.md](../../docs/SYNC.md#syncing-through-a-server)). The browser itself never uses that scope.

## What it does

- **AI chat:** cited questions and follow-ups, selected-branch edit proposals, suggested actions and natural-language topic organization across projects. Review the proposed hierarchy and carried branches, apply a selection and undo safely; notes found by meaning are marked Suggested. Web Speech dictation fills the draft on supporting browsers, with system dictation guidance elsewhere; sending and applying are explicit. The host supplies the AI provider. A conversation stays in this tab's memory unless you press Save chat, which stores it as an ordinary note; Saved chats searches, reopens and archives them, and Save as note keeps a single answer. [Guide and limits](../../docs/AI_CHAT.md).
- **Capture & import:** write or dictate a note, and preview and import Enve Book Player highlight exports (JSON or Markdown, up to 2 MB). Passages already imported are skipped.
- **Review:** due knowledge to revisit; choose Tomorrow, Next week, Next month or a number of days. No background job or notification.
- **Suggested connections:** an item's Find connections lists unlinked mentions, related notes and possible duplicates without AI. Connect, or merge a duplicate after a preview; the merged note is archived with its files, and Undo reverses it.
- **Image text:** Extract text on an image item is read by the host with bundled English Tesseract, not in the browser and not by the AI provider. Correct the draft, then save it as a note; the image is unchanged.
- **Getting started:** a dismissible checklist above the outline for write tokens in libraries with 20 or fewer items. [Everyday workflows](../../docs/POWER_FEATURES.md).
- **Outline:** paged nested tree with inline creation (Enter to add the next line), Add child / Add below, indent and outdent (Tab / Shift+Tab), move up and down (Alt+↑ / Alt+↓), Move to… with a search picker, arrow-key navigation and expand/collapse.
- **Editing:** plain title and text, no formatting syntax needed. Drafts survive background refreshes, and a failed save keeps them.
- **Organize:** show an item as text, a heading or a section break; attention levels; review marks; pins.
- **Checklists:** checkboxes on children, progress, reset and hide/show completed.
- **Highlights:** pinned, high attention, marked for review, set to revisit, and saved-but-never-opened items. Search can filter by type, tag, attention and review.
- **History:** paged versions with before/after views, and restore as a new change.
- **Connections:** references, backlinks and linked items, with a picker. Inline references use the stable `[[item:<id>|label]]` token, inserted for you, and show the target's current title.
- **AI edits:** Organize, Correct, Add and Sort presets or your own instruction, then a reviewable proposal that changes nothing until you apply it. Tick the changes to keep; they apply together or not at all. "Undo these changes" then restores the earlier state as a new history entry, unless something changed the item since, in which case use History. Needs an AI provider configured on the host (`petty-memory ai use`). Background auto-organize is an opt-in per item.
- **Vault:** end-to-end encrypted secret notes. The passphrase never leaves the tab: the page derives the key with Web Crypto (PBKDF2-SHA256, 600,000 iterations), seals the title and text with AES-256-GCM and sends only ciphertext to `/vault/sealed-items`. It never calls the host-decryption routes. The vault locks when the tab is hidden or closed. Needs HTTPS or localhost. Notes made in the desktop's older scrypt format open only in the desktop app.
- **Sharing:** public read-only links with parts left out and an optional expiry, copied once at creation (a retried create never returns the link again); list and revoke under Shares.
- **Projects:** briefings with decisions, open tasks and filed items.

Sync between devices runs on the server that hosts the library. The browser keeps no database of its own: it re-reads every 30 seconds while the tab is visible and leaves anything you're editing alone.

## Public links

`/s/<token>` opens a separate read-only viewer. It loads none of the private client code, sends no credentials, and reads only `GET /api/v1/public/<token>`, the sanitized projection the server computes. It shows nested text, headings, section breaks, attention and checklist state. It offers no history, editing or search.

## Safety

Saved text is rendered as Markdown with raw HTML escaped, then sanitized with DOMPurify: no images, forms, media, frames or inline styles, and only `http:`, `https:` and `mailto:` links. Titles and other fields use `textContent`. Inline references become in-app links to the target item. The public viewer uses the same renderer. The page's Content-Security-Policy allows scripts, styles and connections from its own origin only. The launcher serves files only from `public/`.

## Check

```bash
npm --prefix apps/web run check
```

This syntax-checks every file and type-checks the launcher.
