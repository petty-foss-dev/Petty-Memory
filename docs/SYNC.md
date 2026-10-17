# Sync

Petty Memory syncs a library between computers through a **folder you already sync**: iCloud Drive, Dropbox, OneDrive, Syncthing or a NAS share, or, optionally, **through a Petty Memory server you run yourself** (see [Syncing through a server](#syncing-through-a-server)). There's no server of ours in the middle, and no managed service exists. Phones and browsers don't replicate the library; they are API clients of the computer or server that holds it (see [SECURITY.md](SECURITY.md)).

```bash
petty-memory sync ~/Library/Mobile\ Documents/com~apple~CloudDocs/Enve\ Memory   # set the folder and sync now
petty-memory sync                                                               # sync again
petty-memory sync off                                                           # stop (nothing is deleted)
petty-memory sync <new empty folder> --passphrase -                             # encrypted sync; reads the passphrase from stdin
```

The desktop app and `serve` sync every 2 minutes while a folder is set. Implementation: [`packages/core/src/sync.ts`](../packages/core/src/sync.ts). Tests: [`packages/core/test/sync.test.ts`](../packages/core/test/sync.test.ts).

## Layout of the shared folder

```
<folder>/
  devices/<device-id>/device.json               who this device is, when it last synced
  devices/<device-id>/000000001234.ndjson       segments, named by the last change sequence they cover
  blobs/<sha256>                                attachment bytes, content-addressed
```

Each device writes only its own `devices/<id>/` folder, and each segment is written to a temp file then renamed. Cloud providers therefore never see two writers on one file, which is what produces "conflicted copy" files. A segment that fails to parse (a cloud client still downloading it) is retried on the next run.

## What a record is

Every change is stamped with a **hybrid logical clock**: ISO time, a 6-digit counter, then the device id. It sorts by time, never goes backwards, and moves past any stamp the device has seen, so a machine with a slow clock still orders its later edits correctly.

A segment line holds an entity's **full current state** (or `null` for a delete) at its clock stamp:

- `project`: the whole row.
- `item`: the row, task fields, tag names and attachment rows.
- `relation`: the row.

A record also carries `base`: the version the writing device had last exchanged before it edited.

## Applying records

- Records apply projects first, then items, then relations, in clock order.
- If the local version is the same or newer, the record is skipped. Otherwise the remote state is upserted. Tags, the task, and attachments are replaced to match.
- **Concurrent edits** are when the record's `base` isn't our current version: both sides changed the entity since they last agreed. The newer stamp wins. When an incoming ordinary edit wins, the local losing body is copied to "Conflicting edit of …" in the same project. An older ordinary edit that arrives after a newer one is retained in that item's history. Secret conflicts keep the ciphertext under the original item id in history, so its authenticated binding still opens. Project memory keeps losing text in a conflict note. Other fields (tags, status) are last-writer-wins.
- **Deletes** are tombstones: a newer delete removes the item everywhere, and a newer edit beats an older delete.
- **Same-named projects** created on two devices before their first sync are both kept (one becomes "Garage (2)"). Nothing is merged blindly.
- Applied changes go into the change log attributed to the remote device and actor, so Activity shows what came from where, and they're never echoed back.
- Attachment bytes travel through `blobs/`. A row that arrives before its bytes gets them on a later run, and bytes are re-hashed before they're installed.
- Every pending segment from every device is read first, then applied in one global order, so a peer's folder being read first can't strand an item without its project. References that still arrive before their target (an item whose project hasn't synced yet, a relation between items not yet here) wait in `sync_pending` and are linked once the target lands.
- Clock stamps use a 6-digit counter that rolls into the next millisecond on overflow. Stamps more than 5 minutes ahead of this machine's clock are applied but never followed, so one peer with a wrong clock can't drag every device forward.
- Segment names only grow, even after a backup restore rolls the change sequence back.
- See [SECURITY.md](SECURITY.md#the-sync-folder-is-untrusted-input) for how records from the folder are validated.

## Encryption

With a passphrase, everything written to the folder (segments and file blobs) is sealed with AES-256-GCM under a key derived with scrypt (N = 2¹⁶, r = 8). The folder's `sync.json` holds only the salt and a sealed verifier, so a wrong passphrase is rejected without touching anything. The derived key is kept in the library's settings on each device, never in the folder.

The first device to set a passphrase on an empty folder creates the key, and every other device enters the same passphrase. An existing unencrypted folder can't be converted in place; start a new, empty one. Without a passphrase the folder holds readable JSON and files, fine for a folder only you can reach (Syncthing between your own machines), but not ideal for a cloud drive.

## Syncing through a server

Any library served by `petty-memory serve` or the web launcher (`apps/web`) can act as a sync server for other libraries. It's the same engine as folder sync: the same records, validation, clocks, pending references and conflict copies, exchanged over the HTTP API instead of a folder.

On the server, create a token with the `sync` scope. It's never implied by `read` or `write`:

```bash
petty-memory clients add "Laptop sync" --scope sync
```

Then on each other computer:

```bash
PETTY_MEMORY_SYNC_TOKEN=em_… petty-memory sync remote https://server.example:49231   # one exchange
```

or in the desktop app, Settings → Sync → Sync through a server. The desktop keeps the URL in `desktop.json` and the token in the OS credential store, and watches local changes while long-polling the server (up to 25 seconds per wait). Sync now joins the same exchange; folder sync keeps its periodic schedule.

Each run pushes local changes in pages of 100 (`POST /sync`), uploads their attachment bytes (`PUT /sync/blobs/<sha256>`), then pulls the server's changes from its cursor (`GET /sync`), including what the server received from other devices, and downloads missing bytes. Per-server cursors and pending file hashes live in the library's settings; the token never does. If the server is replaced or restored from a backup, the client starts over from cursor 0, and records already present are skipped. Refused or future-clock pages remain in persistent retry queues while later valid changes continue. Accepted records are acknowledged individually, so editing one after a partial pull does not create a false conflict.

Records travel in the clear apart from secret-note ciphertext, so put the server behind Tailscale or HTTPS. Clients negotiate live waits and body limits through `/sync/capabilities`; older servers fall back to polling. Request limits, bounded live waits, `/healthz`, and retention/recovery guidance are included; see [SELF_HOSTING.md](SELF_HOSTING.md).

## Not synced

API client tokens, public shares, settings (fetch, AI provider, sync folder, sync server), the vault's local check value, automation rules, item history (each device records versions for the changes it applies), the semantic index (each device rebuilds its own), and backups. Secret notes themselves sync as ciphertext.

## Limitations

- Segments are never compacted, so the shared folder grows with the library's full change history.
- Server sync needs the server reachable. Foreground clients use long-polling, with bounded polling for older servers; there is no direct peer-to-peer transport or background mobile push.
