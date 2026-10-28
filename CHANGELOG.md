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
