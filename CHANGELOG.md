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
