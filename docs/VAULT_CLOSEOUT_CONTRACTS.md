# Protected content closeout contracts

2026-10-17. Add the remaining protected-content behavior from milestone 8 after the existing editor/offline layer hands off. Keep secrets optional and client-encrypted on browser/iPhone. This is implementation, not deployment or a claim of independent security certification. Codex reviews and tests every change.

## Ownership

- Claude core: `packages/core/**` for encrypted files, portable recovery helpers, secret-only nesting, retained historical sync blobs, and boundary tests.
- Claude desktop/browser: `apps/desktop/**`, `apps/web/**` after that owner's editor handoff. Local file/recovery UI and browser Web Crypto; no core/API edits or dependency installs.
- Claude native: `apps/ios/**` after that owner's offline handoff. Matching crypto/routes/UI and interoperability tests.
- Codex: API, CLI, MCP, root manifests, integration, documentation, final verification. No generic destructive HTTP or MCP tools.

Core/API signatures below are binding. Additive fields only; keep existing callers working. No agent commits, pushes, changes branches, deploys, uses real libraries or accesses credentials. Delegates run supporting scratch checks only; Codex owns authoritative tests and UI/device work.

## Secret-only nesting

Allow a secret note to contain other secret notes, while refusing ordinary content or decisions under a secret parent. An ordinary parent may contain secret notes. All secret title/body text remains in its envelope; placement and the fact that an encrypted branch exists remain visible metadata. Do not claim that ordinary siblings or an ordinary ancestor have been encrypted.

`vault.create` and `vault.createSealed` gain optional `parentId?: string | null`. Use the same transaction, `slots` and `place` rules as ordinary notes. `outline.move` may place an already secret node under a secret parent, with cycle and sibling checks unchanged. Core insertion, sync pending-parent resolution, history restore and import/export must enforce the same rule. Never create an ordinary child under a secret parent through a shortcut. Preserve locked nodes' stable ids and ciphertext across restart/sync/export.

Browser/iPhone sealed-note request adds `parentId`. Owner clients can create child secrets and move secret nodes using the existing outline route/IPC. The vault UI shows the hierarchy, decrypting labels only in memory while unlocked. Generic library views and public shares never reveal secret labels. No conversion of existing plaintext is implied: old exports/backups cannot be retroactively made private.

## Encrypted attachments

Use the existing AES-256-GCM `SecretEnvelope` format and allowed KDF parameters. Encrypt bytes locally in browser/iPhone; the host stores and syncs opaque envelopes. Attachment title, filename and original MIME type are inside ciphertext. Unlocked desktop may encrypt in its local core process, as for existing local secret notes.

Attachment AAD is exactly UTF-8:

`petty-memory:file:v1:<itemId>:<attachmentId>`

The encrypted plaintext is a binary frame: ASCII `PMVF1` (5 bytes), a four-byte unsigned big-endian metadata length, that many UTF-8 JSON bytes `{"filename":"…","mimeType":"…"}`, then the original file bytes. Metadata is at most 4096 bytes; original file is at most 20 MiB. Validate lengths, safe basename and MIME at the decrypted boundary. Never render decrypted HTML or execute downloaded content; offer save/download. Each envelope gets a fresh 12-byte IV. Keys use the envelope salt/KDF and the vault passphrase, like notes. Reuse cached derived keys only in RAM and clear them on lock/background.

The stored attachment blob is the UTF-8 JSON encoding of that encrypted envelope. The ordinary `attachments` row holds only a generic filename (`Encrypted attachment.pmv`), generic MIME (`application/vnd.petty-memory.vault+json`), ciphertext size/hash, id and creation time. It belongs to the secret item and receives normal version/backup/sync retention. No plaintext filename, MIME or bytes may enter a row, change payload, log, ordinary export or public projection.

Core adds:

```ts
vault.attachSealed(itemId: string, attachmentId: string, envelope: unknown): Attachment
vault.sealedAttachment(itemId: string, attachmentId: string): SecretEnvelope
vault.attachFile(itemId: string, input: {id?: string; data: Uint8Array; filename: string; mimeType?: string}): Attachment
vault.readFile(itemId: string, attachmentId: string): {filename: string; mimeType: string; data: Uint8Array}
vault.removeFile(itemId: string, attachmentId: string): {removed: boolean}
```

Validate item/attachment identities, secret ownership, envelope shape and bounded encrypted size before a write. Sealed writes need no host key. Host read/write needs an unlocked vault. Retrying the same attachment id and identical envelope returns the existing row; a different payload under an existing id conflicts. Removing an attachment is recoverable through item history, with bytes retained. Every content mutation records atomically; immutable snapshots retain ciphertext only.

Codex implements secrets-scoped routes (authentication separate from ordinary read):

- `PUT /vault/items/:id/attachments/:attachmentId` with a JSON envelope body, using the upload size limit rather than the small ordinary JSON limit; returns `Attachment`.
- `GET /vault/items/:id/attachments/:attachmentId` returns the encrypted envelope.
- `DELETE /vault/items/:id/attachments/:attachmentId` returns `{removed}` (recoverable attachment removal, never item/history/blob purge).

Desktop IPC uses `vault.attachFile`, `vault.readFile`, `vault.removeFile`; handlers open native pickers/save dialogs in main and never expose arbitrary filesystem access to a browser. Typed details may be passed as data for a small file; no filesystem path from renderer input.

Ordinary API downloads of secret attachments must require `secrets` as well as `read`; raw device sync retains its explicit whole-library `sync` privilege. Public shares never serve secret attachments.

## Portable recovery kit

A recovery kit plus its separate random recovery code can recover the vault passphrase. It contains no notes or files: the library/backup is still needed. Nothing is sent to an account service, and the recovery code is never persisted or logged by the app. Generate the code only on an explicitly requested local recovery action while unlocked; keep the display transient and clear it on lock/background.

```ts
interface VaultRecoveryKit {
  v: 1;
  kind: 'petty-memory-vault-recovery';
  iv: string; tag: string; data: string;
}
vault.recoveryKit(): {kit: VaultRecoveryKit; code: string}
vault.recover(kit: unknown, code: string): VaultState
```

Recovery code is `pmr1_` plus unpadded base64url of 32 cryptographically random bytes. Those bytes are the AES-256-GCM key. AAD is exactly UTF-8 `petty-memory:recovery:v1`; use a fresh 12-byte IV and 16-byte tag, base64 envelope fields. Encrypted plaintext is UTF-8 JSON `{"passphrase":"<NFKC normalized passphrase>"}`. Validate kit kind/version/lengths and exact code shape before decrypting. Failed authentication yields a useful generic error and never changes the configured vault. Successful recovery calls existing setup/unlock verification with the recovered passphrase, supporting foreign salts. Keys stay in RAM; do not return the recovered passphrase to UI text or place it in a URL.

Desktop does this through local IPC. Browser/iPhone implement the same local crypto and then their existing local unlock against sealed notes. There is no remote recovery endpoint: the passphrase and code must not travel to the host. UI offers an explicit recovery-file download/export, one-time code display/copy and import/recover controls. Explain briefly that both pieces and the library backup are needed, and keep the two pieces separate. This does not reset a lost passphrase without a saved kit/code.

Device enrollment/revocation uses the existing per-device API client flow with an explicit `secrets` scope. Surface that option in the owner pairing UI and explain that revocation stops future server access; it cannot erase copies a device already decrypted. Do not invent remote wipe or rotate every existing envelope silently.

## Historical bytes and acceptance

Sync blob membership may include immutable item history as well as live attachments. Serve a retained blob only if its hash belongs to a live or historical attachment; allow a history-owned blob in `.trash` to be read without treating arbitrary hash guesses as library membership. Writes still verify the hash and ownership. After restoring an older file on another device, its missing bytes can then arrive from a peer's retained history. Keep missing-file reporting when no peer retained the bytes.

Cover: binary round trip and wrong item/attachment/code/AAD; fixed Node-generated envelope and kit opened in Swift; browser-to-core interoperability; lock/background/generation races; secret nesting through sync/export/import/restore; public/AI/search/cache/plaintext leak boundaries; idempotent uploads and recoverable removal; recovery failure leaves vault unchanged; retained-history bytes crossing device sync. Codex inspects actual scratch database/WAL/export/backup/sync/logs for full known plaintext markers. Never use real secrets for tests.
