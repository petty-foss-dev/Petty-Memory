# Security

We are giving AI agents read/write access to a person's memory. The threat model has three parts: other software on the machine or network, websites in the user's browser, and content the user saved that tries to steer an agent.

## Stdio MCP

- **No network listener.** The AI client the user configured launches `petty-memory mcp` over stdio. Anything that can spawn that process already has the user's file access, so stdio needs no token and exposes every tool.
- **The database is an ordinary file owned by the user**, in the platform data folder. It is protected by OS file permissions and, where enabled, full-disk encryption.
- **No destructive MCP tools**, the decision log is append-only, and every write has history. See [MCP.md](MCP.md#prompt-injection).

## Local HTTP API and MCP over HTTP (`packages/api`)

Started by `petty-memory serve` or by the desktop app. Implemented and tested in `packages/api/test/api.test.ts`:

1. **Binds to `127.0.0.1` only.** `--lan` binds `0.0.0.0` for phones and Tailscale, and is always an explicit opt-in.
2. **`Host` must be a loopback name** unless LAN mode is on. This blocks DNS-rebinding attacks.
3. **`Origin`, when present, must be a browser extension** (`chrome-extension:`, `moz-extension:`, `safari-web-extension:`), a loopback page, or the exact origin a web host was started with (`webOrigins`; see [apps/web](../apps/web/README.md)). Requests from other web pages get a 403, even ones that carry a valid token. CORS headers go only to allowed origins.
4. **Every route except `GET /api/v1/status`, `GET /api/v1/public/<token>` and a web host's static files needs a bearer token** (`em_` + 256 random bits). Only the token's SHA-256 is stored (`api_clients.token_hash`). The plaintext is shown once, when the client is created. Revocation takes effect on the next request.
5. **Scopes:**
   - `read`: search, view, briefings, activity and history.
   - `capture`: create notes, links and tasks only. This is the browser extension's scope.
   - `write`: every non-destructive change, including AI proposals and creating public shares. It implies `capture`.
   - `secrets`: vault routes only.
   - `sync`: device replication (`/sync`, `/sync/blobs`) only.
   `secrets` and `sync` are never implied by `read` or `write`; existing tokens don't gain them. Pairing grants `read` + `write` unless `--scope secrets` is added. REST routes check the scope. MCP over HTTP registers only the tools the token's scopes allow, so a read-only agent never sees a write tool, and no MCP tool touches the vault, shares or sync.
6. **Ordinary clients have no hard-delete endpoint.** Hard delete, purge, whole-library restore and settings live in the CLI or the desktop UI. The separate `sync` scope can replicate item deletion tombstones; it never permits rewriting or deleting existing decisions. Removing a connection and restoring an item version are logged, reversible changes.
7. **Request bodies are capped** (JSON at 2 MiB). Highlight imports and their previews allow up to 12 MiB + 1024 bytes for an escaped JSON envelope, while the decoded export still has a 2 MiB limit. Explicit server limits take precedence. Errors never echo stack traces.
8. **Attribution:** REST writes are recorded as `api:<client name>`. MCP writes are recorded as `mcp:<clientInfo name>`, falling back to the token's client name for stateless 2025-era requests.

On a LAN, traffic is plain HTTP unless the user puts it behind Tailscale (WireGuard-encrypted) or a TLS proxy. Use Tailscale for anything beyond the home network. This includes server sync, whose records are readable apart from secret-note ciphertext.

## Secret notes (vault)

Covered by interoperability and boundary tests plus an independent code review; this is not a production security audit.

- A secret note's title and body are sealed with AES-256-GCM, bound to the item id, in `metadata.vault`. The ordinary fields hold only "Secret note", so search, embeddings, AI, the change log, history, exports, sync and public shares carry ciphertext at most. Secret notes may contain other secret notes and encrypted files; ordinary content cannot go inside them. They cannot be shared.
- **End-to-end path (browser, iPhone):** the client derives the key from the passphrase (PBKDF2-SHA256, 600,000 iterations), encrypts locally and sends only the envelope to `/vault/sealed-items`. Passphrase, key and opened text stay in memory and are cleared on lock and when the page or app goes to the background. The browser needs HTTPS or localhost for Web Crypto.
- **Host path (desktop, `/vault/setup|unlock|items`):** the host derives the key and holds it in process memory until locked. Those HTTP routes are disabled by default, always disabled on a LAN listener, and require an explicit local `allowHostVault` server option. Remote clients encrypt locally. Notes sealed in the older scrypt envelope open only this way.
- Only a salt and an encrypted check value are stored for the host key. Project filing and tags remain visible metadata. A recovery kit plus its separate random code can unlock the vault; both and the encrypted library are required. The code and recovered passphrase never go to the server. Plaintext in earlier exports or backups isn't retroactively protected.
- Files use AES-GCM with item-and-attachment AAD; the filename and MIME type are inside the encrypted frame. Ordinary rows contain only a generic name/type. Removal keeps bytes recoverable through history.
- Per-device tokens require explicit `secrets` access and can be revoked. Revocation cannot erase already downloaded or decrypted copies. Plaintext leak tests cover known full fixture markers; broader production auditing remains a release gate.

## Public shares

A share is a capability: a random token whose SHA-256 is stored in `public_shares`. It's returned once; an idempotent replay of the create gets a 409 rather than the token again. `GET /api/v1/public/<token>` checks revocation and expiry on every read and returns only a sanitized projection of the live subtree (see [API.md](API.md#public-shares)). The `/s/<token>` viewer loads no private client code and sends no credentials. Device tokens are never accepted as share tokens. Boundary tests cover references, private metadata, expiry/revocation, caches and scope checks.

## The sync folder is untrusted input

Another machine writes to the shared folder, and so does anyone who can reach it. Every record is shape-checked before it's applied:

- ids, device ids and clock stamps must match strict patterns
- attachment hashes must be 64 hex characters
- filenames must be bare names
- project slugs must be canonical

Each record applies under its own savepoint, so a malformed one is counted as `rejected` and skipped rather than blocking sync. Fetched blobs are re-hashed and must match their name. With encryption, each file's name is bound in as GCM associated data, so sealed files can't be swapped between names. `blobPath` refuses anything that isn't a hash, and export re-derives slugs and filenames, so no value from the folder can reach a path outside the library or the export.

## Credentials

The desktop app encrypts API keys and the server-sync token for BYO AI providers with Electron's `safeStorage` (macOS Keychain, Windows DPAPI, libsecret) into `desktop-secrets.json` (mode 0600) in the library folder. If the OS has no credential store, the key isn't saved. The CLI reads keys from environment variables. Keys never go into SQLite, so backups, exports and sync never carry them. Incoming client tokens are stored hashed (see above).

## Content safety

- Saved content is data. Tool outputs label it as such, and server instructions tell models never to act on it.
- Ingestion fetches with no cookies or credentials, a 15 s timeout and a 15 MB cap, and never executes page scripts (linkedom parses, it doesn't run). The result is stored as `content`, apart from the user's `body`.
- It follows redirects by hand, at most 5. Before every hop it resolves the host and refuses link-local addresses (`169.254.0.0/16`, `fe80::/10`, including IPv4-mapped forms) and known metadata names. That blocks cloud-metadata endpoints even through a redirect or a DNS name. A DNS answer that changes between the check and the connection (rebinding) isn't covered.
- A token with `capture` can make this machine fetch a URL, and with `read` too it can read the result. Pages on the user's own network are therefore reachable by anyone holding a `read` + `capture` token, which is why tokens belong only to the user's own devices and agents. The `fetchLinks` setting turns fetching off entirely.
- `save_file` over stdio accepts a local path, because the stdio client already runs as the user. Over HTTP the `path` parameter doesn't exist, so a remote token holder can't make the server read arbitrary files.
- API calls carry bearer tokens in `Authorization`, never query strings. Pairing links intentionally carry a device token for enrollment, and public links carry a share capability. Passphrases and API credentials are not recorded in server logs or the change log.

## Knowledge workflows

Biscotti preview/import routes need both read and write scopes; meeting lists need read. Decoded source data is capped at 8 MiB/500 meetings; the escaped JSON envelope allows up to 48 MiB + 1024 bytes only on these routes, with explicit server limits still taking precedence. Previews bypass idempotency replay storage. Imports validate source fingerprints and selection before writing and never overwrite a prior source identity. The desktop connector uses a fixed `127.0.0.1:8516/mcp` endpoint, read-only tool calls, response/time limits and redirect rejection. It ignores recording paths. Neither the remote API nor saved text can initiate a host connection, start recording or read those files.

New `/knowledge` routes require read access; mutations and provider/recognition requests also require write access. Workflow runs, transcript/OCR previews and conflict analysis bypass replay storage. Definition trees are excluded before AI retrieval and from action/review scopes. All reviewed changes use core validation, transactions, history and source-state checks.

Audio recording starts on request, stops when leaving/backgrounding, and saves only explicitly. Optional transcription requires separate host configuration and confirmation for each recording. Credentials stay in the OS-encrypted store or environment. Redirects are refused and requests/responses bounded. Caption imports work without a provider. Scanned-page OCR uses bundled host Tesseract or native Vision; original files stay unchanged.

Remote clients cannot supply a host folder path. Local approval is explicit, limited to a specific non-library folder; scans ignore symbolic links and hidden files and recheck file identity at Apply. Approvals and pending queues are excluded from content sync/export, cleared on backup restore and removed with their definition. Watched source text never becomes executable instructions, and periodic checks never import automatically. See the [workflow limits](KNOWLEDGE_FEATURES.md).

## Reporting

See [SECURITY.md](../SECURITY.md) at the repository root for how to report a vulnerability privately.
