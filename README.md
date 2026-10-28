# spicychat-inspector



Load the full extension folder using Chrome or Brave's **Load unpacked** option. The changed-files ZIP is a patch; merge its files into your existing Inspector folder, rather than loading that ZIP alone.

The Inspector overview shows recent loaded events. Export uses the full on-device event history for its compact diagnostics summary. The extra **Pseudonymize IDs and names** checkbox only affects the exported file; it never modifies recorded events. Normal exports still redact private content.

**Detailed QoL internals** remains opt-in. If a capture says tracing was disabled, lack of QoL operation spans cannot be used to rule out or blame QoL. The reply-text observation reports nonempty text in an exact reply container with layout geometry, not a confirmed painted frame.

Regression checks: `node tests/diagnostics.test.js`. These are analysis tests, not a browser end-to-end test.
