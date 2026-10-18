# Knowledge workflow verification

Status: all seven additions implemented. Shared, desktop, browser, packaged Mac and native iPhone acceptance passed within the scopes below.

Evidence: `/tmp/petty-memory-knowledge.8zj4LP` on the development host. All data is fictional and disposable; no personal library was opened.

| Check | Current result |
|---|---|
| Shared TypeScript/editor typecheck | Passed again in the final root check |
| Shared feature and regression tests | Included in the passing final `npm run check`; covers typed values, definitions, transcript/quote identities, source checks, approval reset, private replacement sources and bounded full-state feed paging |
| Browser recording lifecycle | Four passed, zero failed/skipped (`recording-lifecycle.log`); scripted media, no microphone |
| Existing backend regression suite | `npm test` passed (`backend-regression.log`) |
| Real text provider | Four workflows passed using only the permitted `qwen2.5:1.5b` Ollama model (`real-knowledge.log`) |
| Speech adapter | Mock request/response, redirect, limits and source checks passed; no real speech service called |
| Desktop/browser feature journeys | 14 passed, zero failed/skipped (`knowledge-e2e-final.log`) |
| Existing desktop/browser regression suite | 61 passed, zero failed, one optional real-model test skipped (`desktop-regression.log`); the separate four-flow real-provider check passed |
| Swift package | 216 tests in 43 suites passed; zero compiler warnings (`swift-package-final.log`) |
| iPhone Air build | Built and launched; zero new compiler warnings. Existing AppIntents metadata-extraction notices also occur in the baseline build |
| iPhone Air feature journeys | All six distinct journeys passed across the initial run and focused reruns: five initially passed; the collection journey passed after correcting board layout and the scrolling test helper. The audio journey also passed again after moving audio-session activation off the main thread. The final audio and collection result bundles have no runtime warnings |
| Packaged PDF/OCR workflows | The same 14 journeys passed against the ad-hoc signed Apple Silicon app (`packaged-knowledge.log`), using its retained PDF renderer/worker and bundled Tesseract |
| Packaged runtime | MCP initialize + 48 tools, capture/search, HTTP startup, CLI keyword and cached-model semantic search, clean shutdown passed (`package-smoke-fixed.log`) |
| Final root check | `npm run check` passed (`root-check-final.log`), including 28 browser tests |

The real model run exercised a saved workflow with selected preference and reviewed Apply/Undo, a PDF answer with a page-2 locator, an imported-transcript answer with a 2-second locator, and exact-quote conflict suggestions with a reviewed dismissal preserving both notes. The silent audio fixture had imported captions; this did not test speech accuracy.

The desktop/browser journeys verify explicit workflow Apply/Undo, preference selection, all three collection layouts and five field types, PDF page rendering and exact annotations, scanned-page OCR review, transcript playback/seek/passages, transcription consent using a local mock, folder stale-preview refusal and immutable updates, RSS review, conflict dismissal/supersession and read-only authorization. Screenshots in `docs/screenshots/knowledge` use fictional data.

Native journeys cover workflow creation, selected preference, reviewed Apply/Undo and archival; five typed collection fields, layouts and a board move; PDF page search, whole-page annotations and reviewed on-device OCR; transcript seek and source-linked passages; folder/RSS check and reviewed import; and preference/conflict review. The recording sheet was opened and closed without starting the microphone. Initial results are in `knowledge-native.xcresult`; the final audio rerun is in `knowledge-native-final.xcresult`, and the final collection rerun passed one test with zero failures/skips in `knowledge-native-layout.xcresult`.

Review and acceptance corrected the PDF worker setup, whole-page annotation locators with empty surrounding text, definition-tree source filtering, large list/feed payloads, watched-source fairness and read failures, file-reversion version cycles, feed adoption of saved articles, source-preview refresh and Kanban draft retention. Native acceptance also corrected audio-session activation and a board whose lazy first-column height left taller columns outside the tappable area. The packaged smoke script's stale MCP name expectation was aligned with the existing `petty-memory` server name.

Remaining environment gates include physical microphone permissions/recording/interruptions, real speech-provider accuracy, larger multilingual/scanned documents, Windows/Linux installers, signing/notarization and store distribution. No speech model is downloaded and no cloud service is required.
