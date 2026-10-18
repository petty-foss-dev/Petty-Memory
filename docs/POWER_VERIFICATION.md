# Everyday workflows — verification

October 17, 2026. Scope and acceptance are in [POWER_PLAN.md](POWER_PLAN.md); user instructions are in [POWER_FEATURES.md](POWER_FEATURES.md). This extends the earlier [parity](PARITY_VERIFICATION.md) and [chat](AI_CHAT.md#verification--october-17-2026) checks.

Codex inspected the implementation drafts from Claude Opus 5.5, integrated corrections and ran the checks below against disposable libraries and fictional fixtures. No personal library was opened or modified.

| Check | Result |
|---|---|
| `npm run check` | Passed: core/package TypeScript and tests, extension tests, desktop TypeScript/unit tests, browser build/check/TypeScript/tests. |
| `xcrun swift test` in `apps/ios/Packages/EnveMemoryKit` | 198 tests across 40 suites passed. |
| Desktop build | Passed without build warnings. |
| macOS ARM64 package | Built and ad-hoc signed; packaged OCR read the fixture using its bundled worker, WASM and English data. Original image retained; no language download. |
| Existing desktop/browser journeys | 48 passed, including a real small-model cited answer. |
| New desktop/browser journeys | 14 passed. The combined desktop/browser suite passed all 62 tests; the new journeys also passed after final capture guards and visual fixes. |
| Dedicated iPhone Air simulator | Six native journeys passed: cited answers/edits, topic organization, saved-chat continuation, selected actions/Undo, review/merge/host OCR, and Files import plus Photos/Vision capture. Zero new compiler warnings. |
| Live AI actions | `qwen2.5:1.5b` on the configured lab Ollama produced two tasks, a tag plus reminder, and a source-based brief. Each applied and undid correctly; original note body retained. |
| Browser dogfooding | Explicit chat save; branch action preview; applying only a tag; Undo. API readback confirmed no task, reminder or brief was applied with the tag. |

Core and API coverage includes complete topic scopes, privacy exclusions, bounded model context, selective atomic apply, replay and stale guards, guarded Undo, saved-chat export/sync/reopen/search, review scheduling/history, merge placement/Undo, repeated Enve imports, real OCR, and transient previews bypassing the API response cache. Optional semantic failures preserve valid keyword organization.

Review and UI runs corrected an outdated test expectation and fixture classification, explicit OCR field naming, duplicate onboarding region names, action checkbox layout and custom review spacing. They also hardened import/merge preview races and capture controls while saving. The ordinary iOS build emits the pre-existing App Intents metadata-extraction notice because it has no AppIntents dependency.

The five-case native run exceeded the tool wrapper's 300-second response limit. The completed `.xcresult` and xcodebuild log independently report Passed: five tests, zero failures, zero skips, with no runtime warnings.

The additional capture case passed separately after waiting for the system picker to cover the presenting view before selecting a fixture. It read a real JSON file through the Files picker, previewed/imported the passage, recognized the chosen PNG with Vision on the simulator, then saved the image and reviewed text through the outbox.

Physical iPhone speech, camera/Vision accuracy, background refresh and share-sheet acceptance remain unverified. Windows/Linux installer validation, Intel packaging, full accessibility/IME/performance acceptance, Developer ID signing, notarization and store publication require their respective environments. The macOS package check is a local ARM64 smoke test, not a signed distribution release.
