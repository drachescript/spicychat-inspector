## 0.1.12

- Fixed a likely Orion/iOS settings mismatch: the content script can now receive extension messages through callback-style as well as Promise-style APIs (including promise-only APIs that reject callback arguments). Empty or unavailable replies no longer masquerade as successful settings reads.
- Added an extension-local storage fallback when runtime settings replies are unavailable. Recording remains safely paused if neither source responds with verifiable settings.
- The existing on-demand **Check Inspector build** action can relay validated settings from the background worker when both content-side read paths are unavailable (no new permission, observer, timer loop, or implicit recording override).
- Event delivery now handles callback-based runtime messages rather than assuming every call returns a Promise. The build diagnostic shows the settings source and acknowledged/failed event batches; a responding page bridge alone does not guarantee successful recording.
- Reused the core collector's validated recording state for optional Test Driver heartbeat reporting, preventing its own duplicate settings request from wrongly reporting a paused recording.
- Preserved bridge startup and existing passive collection limits; no new long-lived polling.

## 0.1.11

- Fixed the Orion/iOS diagnostic false ambiguity where an active Inspector content script could report `Page bridge not started` simply because page-bridge setup waited for an asynchronous settings reply. The bridge now starts independently of settings and only saves telemetry when recording is enabled.
- Removed the overstrict `runtime.id` checks for both the content script and the optional Driver-support heartbeat; a compatible messaging API is a better startup signal on partial WebExtension implementations.
- Added a one-shot document-ready bridge launch and a safe on-demand attempt from the existing popup build-status button if startup did not run. No polling, auto-reloads or new permissions.
- Expanded popup diagnostics with bridge attempts, launch trigger, settings initialization status and `runtime.id` presence. Distinguishes unavailable settings, script failures and missing page-world handshakes.
- Fail closed for recording if Inspector cannot retrieve settings; avoids treating an unsupported settings response as permission to record.
- Kept page interception methods, bridge instrumentation, desktop behavior and privacy filters otherwise unchanged. Orion device-side verification is still required; the popup result cannot prove compatibility alone.

## 0.1.10

- Added an on-demand, privacy-safe page-bridge health indicator to the existing popup build check. Distinguishes an active content script from a page bridge that actually replies, rather than treating a loaded script tag as proof of working capture.
- Added one-shot, bounded bridge startup diagnostics: resource URL/injection errors, load failures, missing confirmations and successful bridge handshakes. A short ping confirms the isolated-world to page-world message path; no background polling, new permissions or captured page content.
- Extended the existing bounded mobile trace/DOM path to iOS WebKit (including Orion environments where Firefox-style extension injection is supported). Labels such sessions `ios-webkit-lightweight` without claiming compatibility is guaranteed.
- Preserved normal desktop capture, existing Firefox Android handling, the Driver support heartbeat contract, QoL tracing and privacy limits.
- **Orion limitation:** this update improves visibility into what fails but cannot make unsupported Orion extension APIs work. iOS device testing is still necessary.

## 0.1.9

- Fixed full-history QoL Normal-mode aggregate summaries showing `0` items despite recorded source `trace-aggregate` payload rows. The compact full-capture projection now preserves bounded, privacy-safe routine summary rows (type, feature, name, count, optional aggregate wall time) and cumulative coalesced counts. These summaries are not individual observed spans or CPU time.
- Display aggregate report counts even if a report contains no valid rows; do not silently hide the existence of a diagnostic collection issue.
- Firefox build: explicitly declare `browser_specific_settings.gecko_android` (Firefox for Android 142+) alongside the existing Firefox desktop ID/data-collection declaration. Keep the Firefox event-page background conversion; Firefox Android cannot use the Chrome MV3 service worker.
- Added package-time verification of the Firefox Android manifest declaration and a viewport setting for the mobile Inspector viewer. Chrome/Brave runtime manifest, permissions, and background worker remain unchanged apart from version.
- Updated content-script version/build marker and Firefox mobile development/signing notes. Real Firefox Android device testing and AMO signing are still required; source tests alone are not proof of live Android compatibility.

## 0.1.8

- Removed all direct `chrome.runtime.getManifest()` invocations from injected `content.js`, including the Driver-support startup probe. The extension version and a unique content-script build ID are now static in the source; stale runtime contexts cannot throw from those lookups.
- Added a read-only **Check Inspector build in active tab** popup control. It returns the version and build identifier from the actual responding tab without polling or new permissions. An old, unmatched, or missing script is reported instead of being mistaken for a current one.
- Included the content-script build ID in the normal `page-start` diagnostic and the on-demand QoL connection response for easier version attribution.
- Chrome and Firefox build BAT files now delete their own temporary staging folders after a successful verified ZIP build. The scripts retain old final ZIPs/history and do not delete user data.
- Existing QoL protocol v2 tracing, privacy filtering, Driver support, observer limits, extension-context shutdown and recording storage are unchanged.
- **Known limitation:** errors emitted by an already-stale injected script or previously retained in Brave cannot be retroactively suppressed. An exact active-tab build check is the reliable way to verify what is running.

## 0.1.7

- Added a confirmation-gated popup action to refresh previously open SpicyChat tabs after an Inspector extension reload. It excludes discarded/loading tabs and Research Export pages; no automatic reloads or new permissions. This replaces stale injected scripts but does not clear Brave’s retained extension-error history.

- Aligned Inspector with QoL v0.2.87 diagnostic protocol v2: send canonical v2 requests on one transport, correctly unsubscribe QoL when Detailed QoL internals is disabled, retain v1 fallback only when a v2 peer is not known, and keep explicit phase separate from event type.
- Preserve privacy-safe worker grouping from v2 batch envelopes without exporting raw worker-session IDs.
- Report QoL Normal-mode source aggregates separately from observed individual operation spans; never count aggregate wall time as CPU time.
- Clarified popup connection status during quiet Normal tracing.
- Audited Chrome permissions: storage, unlimitedStorage, webRequest and existing restricted host access remain; activeTab retained pending an optional future removal.
- Retained v0.1.6 trigger/reason attribution, low-overhead recording and extension-context invalidation protection.

## 0.1.4
- Grouped static assets and tracker resources on QoL helper pages into a few bounded Resource Timing categories, avoiding page-close event bursts; slow API request timings remain individually observable.
- Changed reported Inspector throttle coverage to stop at observed page hide/freeze and distinguish events emitted after page closure from genuine active capture gaps. Unobserved page endings remain upper bounds, not asserted data loss.
- Clarified that browser page-freeze lifecycle signals are not Long Tasks or evidence of a blocked main thread.
- Added static-vs-API worker timing breakdowns and labeled QoL features beside severe Long Tasks when actual trace events are present; nearby activity is not treated as causation.
- Corrected page-context reporting to use page starts and observed SPA route transitions instead of locking in the first event's context; chats, Favorites, creator pages, Lorebooks, lists, and QoL worker pages are distinguished.
- Recognized current QoL 0.2.65 helper-page markers (including bot-backup and Lorebook export workers) in new captures and older URL-redacted recordings. Worker helpers use the existing light capture path without new DOM observers.
- Added derived severe-Long-Task windows (≥1s), showing nearby network outcomes, DOM sampling gaps, QoL traces and visibility indicators without inferring causes or recording message contents.
- Tightened the defense-in-depth redaction of Typesense search keys in captured/exported diagnostic strings.
- Restricted favorites count-difference reporting to sufficiently nearby account snapshots; latest account totals, native requested IDs, indexed matches, and page hits remain separate observations.
- Verified observed Typesense POST responses against the October 29 HAR: the 19 recorded search POSTs match 19 Inspector network responses. Browser preflight OPTIONS are not page fetch/XHR responses and are not counted as search POSTs.
- Compacted favorites and Typesense requests/responses at the page bridge. Preserve request counts, requested-ID counts, result counts, status, and timing without keeping individual favorite IDs, full filter values, bot names, or search hit documents.
- Added defense-in-depth sanitation on capture/export plus one-time cleanup of older saved Typesense events; historical exports are also sanitized on read.
- Preserved exact saved-favorite array counts when available before bridge truncation; do not convert previously redacted counts back to unknown.
- Clarified that export summary projections omit some low-value events and must not be confused with exact stored-event totals; exposed the different count scopes.
- Added a favorites search-coverage summary, distinguishing account favorite counts, native requested-ID counts, Typesense hits, and separate small-batch probe searches; it does not claim that unmatched bots are deleted.
- Kept all other existing capture settings and QoL trace opt-in behavior unchanged.

## 0.1.3
- Added a Lorebook operations report with entry creation/read counts, nearby follow-up requests, pagination candidates, errors, and per-book activity. It does not assume a backup is incomplete just because the API returns paged entries.
- Added worker activity summaries by page and role. Browser-observed responses and aggregated Resource Timing requests are kept separate so they are not double-counted.
- Made QoL trace availability clearer when tracing is off, only a handshake was seen, or operation traces were actually recorded.
- Added capture coverage warnings for skipped DOM mutation records, Inspector throttling, and Resource Timing buffer limits.
- Added Long Task comparisons by chat, lorebook, worker, and other page contexts, with the measurement limits stated.
- Fixed HTTP 429 / SC-001-5201 being reported as a daily message cap without explicit daily-limit evidence.
- Added an exact-reply text observation using the existing DOM observer. It checks for nonempty text in the matching reply container without recording the text; it is not a paint-timing measurement.
- Added optional export-only pseudonymization for names, identifiers, and fingerprints, keeping matching references linked within a single export.
## 0.1.2
- Updated Inspector diagnostics for QoL v0.2.62: native Memory Probe success, unchanged, baseline, cooldown and error outcomes now appear correctly when tracing is enabled.
- Added optional message-bookmark star creation, repair, reuse and slow-pass summaries from existing QoL traces, without adding another page observer.
- Preserved those new results in compact full-history exports and separated confirmed Memory Probe outcomes from attempted checks.
- Fixed exported page-start session summaries being entirely redacted instead of preserving safe startup counts and timings.
- Improved generation pressure sampling with a versioned cache, explicit reuse/skip reasons, and protection against reusing samples after changing chat routes.
- Added per-page comparisons for startup blocking, chat generations, post-response Long Tasks, mounted messages, DOM activity and sampled heap use.
- Clarified confirmed reply-node matches, already-present replies, tentative DOM signals and checks limited by delayed or missing observations.
- Improved diagnostic visibility when background Memory Probe results are not observable through the existing QoL tracing connection; no Memory text or identifiers are collected.
- Redacted URL query values, fragments and sensitive third-party path identifiers in new and older Inspector recordings, including raw event fields and exports. Preserved non-sensitive worker flags for attribution.
- Reduced repeated full-DOM/resource scans during rapid chat generations by reusing recent measurements, with cached samples clearly labelled.
- Clarified exact reply-node matches versus tentative DOM changes and replies already present at network observation; timing summaries no longer describe tentative signals as confirmed rendering latency.
- Added a conservative feedback HTTP timeline linking Recombee ratings, nearby native `characterRating` events, preflight failures and worker-tab changes without guessing saved Dislike state.
- Capped Inspector DOM sampling by callback time and record count, reporting skipped observations so long-chat captures remain lighter without claiming complete coverage.
- Grouped page starts into browsing/worker/clone sessions and improved burst labels without treating intentional tabs as reload loops.
- Expanded privacy-safe API reporting with notable endpoints and error hotspots, and flagged generation checks affected by reduced DOM sampling.
- Fixed the Inspector popup collapsing into a narrow column in Brave/Chrome on desktop, while keeping Firefox Android responsive.
- Added background Memory Probe observability reporting, distinguishing confirmed QoL diagnostic results from unobserved background activity. Memory text, IDs and authentication details are not included.
- Added page-start and localStorage activity summaries to help investigate excessive reloads and storage writes.
- Clarified generation rendering reports when replies were already present before the network response was observed, rather than treating these as failed renders.
- Improved privacy-safe performance diagnostics while keeping regular recording lightweight.

## 0.1.1
- Improved Firefox for Android support with reduced-overhead DOM capture and bounded normal-level QoL trace sampling.
- Added mobile capture-coverage and browser timing-capability information so unsupported measurements are not shown as zero lag.
- Improved Inspector popup and recording viewer layouts for narrow Android screens.
- Added browser-level HTTP outcome tracking for SpicyChat's native `characterRating` events, separate from recommendation ratings, without saving event bodies or credentials.
- Improved generation DOM-check coverage reporting when hidden tabs coalesce followups, timers run late, or a conversation route changes.
- Added privacy-safe method/endpoint inventory with response status and latency summaries, without query values or response text.
- Added message-node addition/removal pressure summaries to help investigate long-chat rerenders without adding a new DOM observer.
- Redacted native SpicyChat Memory text from network diagnostics and exports, retaining Memory IDs, types, pinned status, timestamps, lengths and fingerprints.
- Added automatic privacy cleanup for previously stored Memory responses.
- Redacted persistent user and device identifiers from recorded request headers and older diagnostics.

## 0.1.0
- Improved QoL diagnostics to distinguish tracing being disabled, no connection response, a handshake only, and actual detailed operation traces. Added targeted trace requests when investigating lag spikes.
- Improved chat generation timing checks, including early-rendered replies, delayed checks and clearer explanations when a reply cannot be matched.
- Added lightweight scrolling frame-gap measurements and correlation with nearby input and browser Long Tasks.
- Improved freeze investigations by combining Long Tasks, Long Animation Frames, possible script sources and available QoL operation timing without guessing the cause.
- Corrected shared recommendation-worker reporting so negative ratings are not automatically labelled Less Like when they could come from Dislike.
- Improved recording coverage reports when Inspector temporarily reduces detail on busy pages, without double-counting overlapping intervals.

## 0.0.34
- Improved Rulebook diagnostic privacy by removing authored rule text, instructions and labels from captures and exports while keeping useful counts and status information.
- Applied the same privacy handling to older saved Rulebook recordings.
- Stopped treating uncertain message-DOM detections as confirmed reply-rendering times.

## 0.0.29
- Added privacy-safe Lorebook request and response diagnostics, including entry counts, versions, identifiers and change fingerprints without storing private entry text or keywords.
- Updated older saved Lorebook diagnostic events to use the safer format.
- Improved Firefox compatibility and removed flagged HTML-insertion methods.

## 0.0.24
- Improved attribution of recommendation requests to SpicyChat, QoL or unknown sources using available script and worker evidence.
- Grouped retries with the original rating action instead of treating every request as a separate action.
- Improved detection of native and QoL chat exports and history requests.

## 0.0.22
- Reduced Inspector's own DOM observer overhead by removing expensive text reads and limiting node traversal.
- Added measurements of Inspector observer processing time.
- Improved comparisons between recordings with QoL enabled and disabled, including warnings about mismatched workloads.

## 0.0.16
- Fixed QoL version reporting when multiple browser tabs with different extension versions remain open.

## 0.0.12
- Improved DOM attribution so an unrelated element is not marked as QoL-owned simply because it sits inside a QoL-marked parent.
- Expanded chat message and history-loading measurements, including mounted messages and pagination.
- Added Long Task breakdowns by mounted-message count.

## 0.0.11
- Added connectivity diagnostics for going offline, reconnecting and first-party requests affected by connection loss.

## 0.0.10
- Fixed duplicate Long Task counting and incorrect focus/blur activity attribution.
- Stopped treating automatic page scrolling as proof of user interaction.
- Added Long Animation Frame details, including script and forced-layout information where the browser provides it.

## 0.0.9
- Reduced DOM recording size by saving counts and a small sample of representative changes instead of every repeated mutation.

## 0.0.8
- Fixed Inspector viewer failures with very large recordings by reading saved events directly from IndexedDB.
- Added faster initial loading, on-demand event details and more reliable refreshes.
- Corrected an overzealous diagnostic-field redaction.

## 0.0.7
- Improved classification of SpicyChat, QoL, third-party scripts and unknown work, with clearer differences between triggers and responsible scripts.
- Added more detailed mutation, focus and idle-time context, plus direct IndexedDB export.

## 0.0.6
- Expanded DOM mutation analysis, Long Task correlation, foreground/idle context and QoL-specific element attribution.
