# SpicyChat Inspector — Privacy Policy

**Last updated: November 18, 2026**

## 1. About Inspector

SpicyChat Inspector is an independent browser extension for diagnosing performance, network, rendering, and technical problems affecting SpicyChat and, when installed, DragonScript SpicyChat QoL. It is not an official SpicyChat or NextDay AI product.

Inspector is a **local diagnostic recorder**, not a cloud telemetry or analytics service. Recording is enabled by default; users can pause it and clear previously captured events.

## 2. Information processed

Depending on the website activity, browser support, and enabled capture options, Inspector may process:

- Network request URLs and paths, methods, timestamps, timing, status codes, headers, and sanitized request/response information from page fetch/XHR activity; limited network observations of SpicyChat-related recommendation feedback may also be available through browser request permissions.
- WebSocket connection information and sanitized message diagnostics.
- Browser performance data, including resource timing, Long Tasks, Long Animation Frames, rendering or reply-display signals, memory-related measurements where supported, and performance anomalies.
- DOM mutations and page lifecycle, visibility, navigation, and page-state information.
- Technical browser storage activity, including keys, counts, sizes, value types, and diagnostic fingerprints rather than ordinary raw storage contents.
- JavaScript errors, rejection messages, stack traces, and technical failure information.
- Interaction and activity indicators used to interpret performance while a page is active or idle.
- Technical identifiers, including character, conversation, request, session, and event IDs, plus bot names or other visible labels when useful for diagnosis.
- Optional QoL diagnostic events and detailed internal traces when expressly enabled.

Capture availability varies by browser and page. Inspector does not claim that its recordings represent every request, rendered frame, or user interaction.

## 3. Sensitive information and redaction

Inspector applies sanitization during capture and storage, and again during export. Its rules are designed to redact known passwords, authentication tokens, cookies, private account or device identifiers, private chat text, Persona and authoring text, Lorebook entry content and keywords, Rulebook-authored text, and native Memory content. For supported sensitive API endpoints, it favors counts, timings, lengths, statuses, limited metadata, and fingerprints over raw content. Earlier locally saved events may be processed by privacy migrations when Inspector updates.

**Redaction is best-effort, not a guarantee.** Unrecognized response formats, error strings, page labels, file names, URLs, technical IDs, and diagnostic fingerprints may still reveal contextual or sensitive information. Some known IDs and names are deliberately retained in ordinary diagnostic exports because they help correlate failures. Diagnostic fingerprints are not encryption or anonymization.

Inspector also offers a **manual HTML snapshot** for targeted debugging. Such a snapshot can include page structure and visible text or attributes from the current page. Form values and inline scripts are redacted or omitted, but other private on-page material may remain. Treat HTML snapshots as especially sensitive and review or clear them before sharing a recording.

## 4. Optional detailed QoL tracing

Normal Inspector recording does not require detailed QoL internals. Users may enable additional QoL tracing, including a deeper trace level, to investigate extension behavior. These records are processed locally and subject to the same best-effort sanitization. Disabling the option stops new detailed tracing but does not automatically delete events already recorded.

## 5. Storage, exports, and sharing

Inspector saves diagnostic events in local browser extension storage, including IndexedDB. It does not automatically upload recordings to DragonScript, the Inspector developer, SpicyChat, or a third-party analytics provider.

Users can manually export recordings as sanitized JSON, normally compressed as `.json.gz` where supported. Exports can include the full retained event history rather than just the recent events displayed in the Inspector interface.

The optional **“Pseudonymize IDs and names in exports”** control replaces additional identifiers and labels within that particular exported file. It does **not** alter the locally stored recording, cannot guarantee anonymity, and does not necessarily remove every identifying detail. It is recommended before sharing a diagnostic file.

Exported files are saved through the browser and remain wherever the user or their operating system stores them. Inspector does not control subsequent sharing or deletion of those copies. Review any diagnostic export, particularly one containing an HTML snapshot, before posting it in a public issue or sending it to another person.

## 6. Retention and deletion

Inspector stores a bounded local event history, with an event-count limit and periodic pruning rather than a fixed number of retention days. Pausing recording prevents new events from being recorded but does not erase existing events. The **Clear** control removes captured Inspector events from its local database; browser storage controls or uninstalling the extension may also remove local data. Previously exported files must be deleted separately.

## 7. Site access and third parties

Inspector is scoped to relevant SpicyChat pages and infrastructure, including selected NextDay AI and recommendation endpoints. Browser permissions include local storage, active-tab access, expanded local storage, and limited request observation. Inspector may observe requests to services used by SpicyChat, but it does not independently send its diagnostic recordings to those services. Their normal website requests remain subject to their own privacy policies.

Inspector does not intentionally inspect unrelated browsing activity and does not use diagnostic data for advertising, data brokerage, creditworthiness decisions, or unrelated behavioral profiling.

## 8. Security and limitations

Local browser profiles and exported files can be accessible to someone with access to the device, browser profile, or shared files. No redaction process or local storage system can be guaranteed completely secure. Use caution with recordings from private chats, creator editors, Memories, Lorebooks, Rulebooks, or account pages.

## 9. Changes and contact

This policy may be updated as diagnostic features, browser permissions, or handling practices change. Material changes will update the date above.

Source and support: https://github.com/drachescript/spicychat-inspector

For support, avoid posting private chats, passwords, session tokens, sensitive HTML snapshots, or unreviewed diagnostic exports in public issues.