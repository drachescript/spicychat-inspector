# spicychat-inspector



Load the full extension folder using Chrome or Brave's **Load unpacked** option. The changed-files ZIP is a patch; merge its files into your existing Inspector folder, rather than loading that ZIP alone.

The Inspector overview shows recent loaded events. Export uses the full on-device event history for its compact diagnostics summary. The extra **Pseudonymize IDs and names** checkbox only affects the exported file; it never modifies recorded events. Normal exports still redact private content.

**Detailed QoL internals** remains opt-in. If a capture says tracing was disabled, lack of QoL operation spans cannot be used to rule out or blame QoL. The reply-text observation reports nonempty text in an exact reply container with layout geometry, not a confirmed painted frame.

Regression checks: `node tests/diagnostics.test.js`. These are analysis tests, not a browser end-to-end test.

## Capture accuracy and limits (v0.1.4)

Network requests made via the instrumented SpicyChat page fetch/XHR interfaces are captured with status and timing when the bridge is active. Browser-managed CORS preflight OPTIONS, requests made in unrelated extension service workers, and activity before the bridge starts are **not** equivalent to recorded page requests. Resource Timing entries can overlap page-network events; do not add their counts together.

The favorites summary records safe aggregate counts only. A discrepancy between the account's saved IDs and native search IDs indicates that the captured native request did not include every favorite; it does not prove a bot was deleted.

DOM observations are sampled and may be throttled on heavy pages. Long Tasks, LoAFs, and reply-text signals may be unsupported or incomplete depending on browser, page visibility, and capture profile. A match between a response and a DOM node is not guaranteed evidence of a painted frame.

For full-history exports, `meta.storedEvents` counts stored raw records; `meta.summary.totalEvents` counts projected diagnostic events and may be lower. Both scopes are labelled in `meta.eventCountScopes`.

Regression checks: `node tests/diagnostics.test.js` and `node tests/recording-014.test.js`.
