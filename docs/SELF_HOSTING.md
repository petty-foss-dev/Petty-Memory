# Self-hosting Petty Memory

The CLI serves the browser app, private API, device sync and public share viewer from one library. Hosting is optional: desktop, CLI and local MCP keep working independently. These instructions describe one owner's server; there are no multi-user accounts or tenant boundaries.

## Local or private-network server

Use Node 24 or newer, install the repository dependencies, and choose a dedicated library folder. Do not use a real personal library for a trial.

```sh
npm ci --ignore-scripts
npm run cli -- --home /path/to/memory settings semanticSearch false
npm run cli -- --home /path/to/memory clients add Browser --scope read,write,secrets
npm run cli -- --home /path/to/memory serve --port 49231
```

Open `http://127.0.0.1:49231/`. Enter the displayed client token in Connect. The browser holds it in tab memory; incoming server credentials are stored as hashes. The `secrets` scope permits client-encrypted vault operations; leave it out for a device that should not access the vault.

For a phone or another computer on a trusted network, add `--lan`. For an external server, use HTTPS or a private encrypted network. Browser vault encryption requires a secure context (HTTPS or localhost). A LAN HTTP connection alone does not encrypt ordinary notes or bearer tokens.

Enroll a desktop sync peer separately:

```sh
npm run cli -- --home /path/to/memory clients add Laptop --scope sync
```

Use that server address and token in the desktop Sync settings. A `sync` token exchanges the whole library, including tombstones and opaque secret envelopes; it belongs only to the owner's trusted replicas. Browser and iPhone tokens use the ordinary read/write API. Revoke a device with `clients revoke <client-id>`; current live waits check revocation too. Revocation prevents future access and cannot erase data a device already downloaded.

## HTTPS reverse proxy

Keep the Node listener on loopback and forward a dedicated HTTPS origin to it. Pass that exact origin to `serve`:

```sh
npm run cli -- --home /path/to/memory serve --port 49231 \
  --origin https://memory.example.com \
  --max-upload-mb 32 --max-json-kb 2048 --max-writes 4
```

Configure the proxy's upstream Host as `127.0.0.1:49231`, keep its body limit consistent with the application, and allow at least 30 seconds for long-poll responses. Do not cache `/api/`, `/mcp` or `/s/` responses. Do not log authorization headers or full public capability URLs. Public shares intentionally work anonymously; the rest of the library requires a bearer token. The app checks browser origins rather than allowing arbitrary websites to use the API.

`GET /healthz` returns only `{"status":"ok"}` after a database read. A failed read returns 503. Use this for service monitoring without publishing library counts, paths or credentials. Run the process under a service manager that restarts it after a crash and sends SIGTERM for orderly shutdown.

## Storage, retention and recovery

Use an encrypted host volume, restrict the library directory to its service account, and keep backup copies encrypted. Ordinary SQLite content and original ordinary attachments are readable to someone with filesystem access. The client-sealed vault protects secret title/body content and attachment names, types and bytes independently of the host; visible placement, project and tag metadata are not secret.

Ordinary uploads default to 200 MiB, ordinary JSON writes to 2 MiB, sync JSON to 32 MiB, and concurrent writes to eight. Encrypted file payloads are capped at the bounded wire envelope for a 20 MiB original file. The flags above lower those limits for a smaller server. Live waits have separate per-client and process limits. Apply a filesystem or container disk quota to the whole library volume, including WAL, attachments, history and backups. The application rejects request overload; it does not silently remove content to fit a storage budget.

Automatic snapshots retain 24 hourly, 30 daily and 12 monthly copies. Item versions retain attachment bytes needed for recovery. History is not compacted automatically, so include it in storage planning. An item restore reports unavailable bytes explicitly in `missingFiles`; clients show the partial recovery and can fetch retained bytes from a peer.

Copy the whole library directory, including `attachments/`, for an off-host backup. A standalone database snapshot cannot recreate attachment bytes that no backup retained. Keep the vault passphrase safely, or make a recovery kit and store its separate recovery code elsewhere. A kit holds no content: it still needs the encrypted library backup.

To recover, stop the desktop app, server and MCP processes that use the library. Run `restore <snapshot|latest> --yes`; it saves the current database first. Restart and let paired clients rebuild or resynchronize. Test this with a scratch copy before relying on an unattended server.

## Compatibility and publication

Current clients negotiate live-change support and retain bounded polling for older sync servers. Updates apply append-only migrations and save a pre-migration database snapshot. Keep a full-directory backup before upgrading, and do not open a newer schema with an older app.

Managed hosting, DNS/TLS credentials, signing and store publication are deployment tasks. This implementation does not create a hosted account or publish the user's library.
