# Contributing to Petty Memory

Thanks for helping. Petty Memory is a local-first memory layer shared by a person and their AI tools, so the bar is simple: **never lose data, never phone home, and keep it useful without AI.**

## Setup

Requires Node 24 or newer (26 recommended).

```bash
npm install
npm run check                          # typecheck + package, extension, desktop and browser checks
npm run demo -- ~/em-demo              # a realistic demo library to play with
npm run cli -- --home ~/em-demo project show garage
```

Node runs the TypeScript sources directly (type stripping), so the engine has no build step. To try semantic search, run `npm run models` once to cache the embedding model in `.cache/models`; this also enables the retrieval eval. Tests never download anything.

| Part | Where | Run |
|---|---|---|
| Engine, CLI, MCP, API | `packages/*` | `npm run check` |
| Desktop app (Electron) | `apps/desktop` | `npm --prefix apps/desktop run dev`, `run test:e2e`, `run dist:mac` |
| Browser extension | `apps/extension` | `npm --prefix apps/extension test`, `run test:e2e` |
| Browser client and self-host launcher | `apps/web` | `npm run web -- --home ~/em-demo`, `npm run check:web` |
| iOS app | `apps/ios` | `xcodegen generate` and Xcode; `xcrun swift test` in `Packages/EnveMemoryKit` |

## Layout

- `packages/core`: the only code that touches SQLite. Services for projects, items, tasks, decisions, search and activity, behind the `EnveMemory` facade.
- `packages/mcp`: MCP tools over core. Thin.
- `packages/ingestion`: fetching and extracting pages and PDFs, and the background ingest worker.
- `packages/embeddings`: the local embedding model and background indexer.
- `packages/ai`: optional LLM providers, enrichment and cited answers.
- `packages/api`: the local HTTP API and MCP over HTTP (tokens, scopes, Host/Origin guards).
- `packages/importers`: browser bookmarks, Markdown folders, CSV and Enve exports.
- `packages/cli`: the `petty-memory` binary.
- `apps/desktop`, `apps/extension`, `apps/ios`: the apps. Each has its own README.

Before designing a change, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DATA_MODEL.md](docs/DATA_MODEL.md), plus [docs/MCP.md](docs/MCP.md), [docs/SECURITY.md](docs/SECURITY.md) or [docs/SYNC.md](docs/SYNC.md) if your change touches them.

## Invariants

These keep people's libraries safe. A pull request that breaks one won't be merged.

- **Every mutation goes through a core service and calls `Context.record()` in the same transaction.** The change log is the history, the activity feed and the sync stream.
- **Migrations are append-only.** Never edit, reorder or delete a shipped migration. Every new migration gets a test that upgrades a populated library.
- **`items.seq` stays an explicit `INTEGER PRIMARY KEY`.** The full-text index depends on it surviving `VACUUM`.
- **No `CHECK` constraints on enum-like columns** (`type`, `status`, `kind`). Validate in core instead, since SQLite can't alter a CHECK.
- **Decisions are append-only.** Change one by superseding it.
- **The MCP server never gets a destructive tool.** Hard delete, purge and settings changes are user-only, with explicit confirmation.
- **Saved content is data, not instructions.** Never add behaviour that executes or obeys item text.
- **IDs are UUIDv7 strings.** Never derive identity from `seq` or a rowid.
- **No network listener without the [security requirements](docs/SECURITY.md):** loopback bind, Host/Origin validation, hashed per-client tokens and scopes.
- **Local-first and AI-optional.** Nothing in the capture, storage or search path may require network access or an AI provider.

## Code style

- Erasable TypeScript only (`erasableSyntaxOnly`): no enums, namespaces or constructor parameter properties. Use `as const` arrays and derived unions.
- Relative imports use the `.ts` extension; cross-package imports use the package name (`@enve-memory/core`).
- Core has no runtime dependencies. Add a dependency elsewhere only for a concrete reason, and prefer Node built-ins.
- Validate at boundaries (core service inputs, CLI arguments, MCP schemas) and trust internal calls.
- User-facing failures throw `MemoryError` with `not_found`, `invalid`, `conflict` or `schema`. People and models both read these messages, so say what to do next.
- Comments explain *why*, not *what*.
- Tests use `node:test` and in-memory libraries (`EnveMemory.open({ inMemory: true, actor: 'test' })`). CLI tests spawn the real binary against a temporary `--home`.

## Pull requests

- `npm run check` passes. If you changed an app, its own tests pass too.
- New behaviour has a test. Anything touching migrations, sync, backups or API security needs one.
- One concern per pull request.
- Never commit a `.sqlite` file or anything from a real library.

## Reporting bugs and ideas

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md) and don't open a public issue.

## License

Contributions are licensed under [AGPL-3.0-only](LICENSE.md), like the rest of the project.
