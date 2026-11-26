# SpicyChat Inspector — SCT integration foundation

Release: **0.1.14 (unpublished consolidated release)**  
Protocol: **sct.community.v1**, export schema version 1  
Creator Tools origin: `https://spicychat-creatortools.drache.uk` (no endpoint or network access configured)

## Scope and setup

Open **Creator Tools diagnostics (optional)** from Inspector's popup or **Creator Tools** from the ordinary Inspector page. The integration starts disabled; ordinary recording can be paused or enabled independently. Choose a recognized open creation tab or all recognized creation editor/list tabs, a mode, duration, cap, and retention. Optional correlation values must be non-secret UUIDs, not passwords, publication codes or account identifiers. Stop explicitly for a best-effort buffer flush; refresh status to see actual committed counts. Export a local JSON/GZIP snapshot at any point. The browser's final file-save completion is not observable.

| Mode | Scope |
|---|---|
| Disabled | No SCT capture listeners, observers, timers, database writes or transfers from pages. |
| Health | Relevant page lifecycle/visibility/navigation observations, generic error indicators and long tasks of at least 1 second. No editor requests or forms. |
| Editor | Allowlisted creation requests, structural editor states/actions, validation indicators, import progress, long tasks >=100 ms. |
| Publication | Editor scope plus job/release correlation and optional authorized peer markers; not a publisher. |
| Errors | Relevant attempts, writes/outcomes, failed reads, validation and interrupted import observations; long tasks >=500 ms. Successful read requests/responses and ordinary editor state are excluded. |
| Full | All supported structural observations and long tasks >=50 ms; expires in at most one hour. Still metadata-only. |

Editor/publication/error/full modes may accept authorized peer markers if the operator supplies the exact trusted Chromium extension ID. No peer is authorized by default. All modes are local and work without the SCT website. One active SCT recording is supported per browser profile. Use a dedicated profile for `qolcreatortools`; the recorder does not authenticate or infer that account. Do not mix unrelated accounts under one job. A selected tab ID may change after a browser restart; stop and create a new scoped recording if necessary. All-editor scope can resume as eligible documents reattach. Normal extension reload rules apply: refresh already-open site tabs to load the new script. The recording ID and committed local rows survive reloads/restarts; unsent tails may not.

## Observation boundaries

The existing Inspector page network bridge is reused. It already has its ordinary capture behavior; SCT does not turn on additional body capture or change ordinary privacy settings. SCT independently projects a strict allowlist **before its own buffering and persistence**, and applies the projection again in the worker/export. It never stores raw headers, URLs, query values, titles, input values, chat content, authored text, names, keywords, moderation messages, stack traces, auth or publication codes. There is no content-recording switch in this foundation. Normal Inspector recordings remain separate and retain their existing settings/privacy scope; share an SCT export for this project instead of an ordinary export when only SCT evidence is needed.

Recognized editor routes: `/lorebook/edit/:uuid[/entries]`, `/chatbot/edit/:uuid`, analogous `rulebook`/`group` editor routes, known `create`/`new` forms, and `/my-creations/{chatbots,lorebooks,rulebooks,groups}` (optional two-letter locale prefix). Native API metadata covers exact UUID-shaped paths for `lorebooks`, `characters`, `rulebooks`, `groups`, optional version prefix, Lorebook entry routes and selected relationship/publication/visibility/moderation subpaths on known HTTPS hosts. It rejects private chat/history, personal settings, auth, arbitrary endpoints and unexpected hosts. Exact rulebook/group/editor routes and response variants still need real fixtures. Visibility and moderation status are kept only if they match explicit enumerations. Only numeric exposed rate-limit response headers and recognized `SC-xxx-xxxx` codes are retained. Missing values remain absent. Native relationship IDs in recognized path segments may be retained; arbitrary bodies are not inspected to discover relationships.

Evidence levels:
- `isolated-dom-observation`: structural witness or button attempt; `trustedClick` indicates the DOM event's browser flag, not successful submission. Validation indicators are not an exact error diagnosis.
- `page-bridge-untrusted`, `qol-page-untrusted`: page-reported metadata. A page can forge these observations; no authority or job identity is inferred from them. Existing QoL detail telemetry is reused when already enabled, not requested by SCT.
- `browser-lifecycle-observation`, `browser-performance-observation`: local browser witnesses. Absence of a long task/health event is not proof a renderer is healthy.
- `authorized-extension`: identity checked by Chromium's runtime, after explicit authorization. A reported verification is still a peer assertion, not independently verified by Inspector.
- `local-operator`: explicit manual journal marker, not independently verified.

An attempted Save is not a submission. A successful HTTP status is not proof of persistence/publication. The report correlates compatible click/request candidates in the same stream/creation within five seconds, and counts request IDs lacking an observed response. A missing response can reflect an actual pending operation, capture gaps, or navigation. Repeated attempts/sequence duplicates are observations, not proof of duplicate saves. The module never submits, replays, verifies via extra API reads, or retries SpicyChat operations. Real verification must come from an authorized publication journal or manual readback observation.

## QoL / publication journal contract (draft, implemented local interface)

The backend owns all durable publication decisions, job state, authorization and verification. QoL's trusted extension worker can forward **non-secret** journal identifiers and state transitions. Do not forward raw backend or site credentials to Inspector. No webpage `postMessage`, CustomEvent, site DOM field or SCT website origin is accepted as an authenticated SCT operation event. Chromium cross-extension messaging is the only optional peer interface in this build. It is separate from the existing ordinary QoL page telemetry protocol.

Operator steps: start an editor/publication/error/full recording with the exact installed QoL extension ID (IDs can differ for unpacked installs), and optionally its project/release/job UUIDs. The peer may query the active context using the Inspector extension ID supplied by the operator. Only that authorized extension may send markers. The runtime-provided `sender.id` must equal the configured ID; a supplied sender URL/origin must belong to that extension, not a website. A browser-reported extension service worker without URL/origin is accepted only without a tab. No web origin or content-script webpage identity is accepted. No peer can start/stop recordings, fetch stored data, modify settings, send credentials, control browsing, or publish anything. No manifest host permissions are added.

```js
// From the explicitly authorized QoL extension worker, not a website:
const context = await chrome.runtime.sendMessage(inspectorExtensionId, {
  protocol: 'sct.community.v1', type: 'SCT_GET_CONTEXT'
});
// context.ok, protocol, inspectorVersion, recordingId, mode, scope, tabId (selected scope),
// expiresAt, correlation, transfer. Do not use this as proof of live capture or delivery.

const ack = await chrome.runtime.sendMessage(inspectorExtensionId, {
  protocol: 'sct.community.v1',
  type: 'SCT_OPERATION_EVENT',
  recordingId: context.recordingId,
  streamId: 'ab45f219-8270-4fa2-a9da-285d13e6d149', // stable UUID per journal event stream
  sequence: 0, // increment per new event; persist across restart; reuse on a delivery retry
  observedAt: Date.now(),
  tabId: publicationTabId, // actual eligible SpicyChat tab ID
  event: {
    phase: 'verification',
    action: 'save',
    creationType: 'lorebook-entry',
    outcome: 'readback-match',
    correlation: {
      projectId: 'ab45f219-8270-4fa2-a9da-285d13e6d150',
      releaseId: 'ab45f219-8270-4fa2-a9da-285d13e6d151',
      publicationJobId: 'ab45f219-8270-4fa2-a9da-285d13e6d152',
      operationId: 'ab45f219-8270-4fa2-a9da-285d13e6d153',
      internalCreationId: 'ab45f219-8270-4fa2-a9da-285d13e6d154',
      nativeCreationId: 'ab45f219-8270-4fa2-a9da-285d13e6d155',
      internalEntryId: 'ab45f219-8270-4fa2-a9da-285d13e6d156',
      nativeEntryId: 'ab45f219-8270-4fa2-a9da-285d13e6d157'
    },
    counts: {expected: 1, observed: 1},
    durationMs: 420,
    qolVersion: '0.3.1'
  }
});
// ack.ok alone does NOT prove persistence. Inspect ack.stored === 1.
// ack.duplicates === 1 means the same sequence/event was already present.
// ack.conflicts === 1 means that sequence was reused with different evidence;
// do not overwrite. ack.dropped, ack.invalid, ack.notActive indicate no new row.
```

Use `start`, `attempt`, `submission`, `response`, `verification`, `failure`, `interruption`, `recovery`, `completion`, `observation` as phases. `operationId` is required for peer and operator events. Supported actions: `create`, `edit`, `delete`, `save`, `publish`, `unpublish`, `visibility`, `attach`, `detach`, `import`, `export`, `read`, `unknown`. Creation types: `lorebook`, `lorebook-entry`, `chatbot`, `rulebook`, `group`. Use the outcome and reason enums in `sct-event-schema.json` / `sct-core.js`. Unknown fields are discarded; invalid required values are rejected. Non-secret UUIDs are required for correlation; other identifier formats should be agreed before changing the schema. Correlation conflicting with the base recording's project/release/job/creation IDs is rejected. If no correlation is available, local observations remain usable; a peer operation still needs its operation UUID. The backend can join by recording ID, stream ID, sequence, operation ID and job/release/project IDs. Page observation stream IDs and per-export tab references assist chronology but do not create authenticated per-request job associations. A journal marker's `observedAt` is bounded; the recorder separately records `receivedAt`.

## Storage / export

SCT uses its own IndexedDB database `spicychat-inspector-sct-v1`, distinct from ordinary `spicychat-inspector`. Per-recording event cap 1,000–50,000 (default 30,000), global cap 100,000, 24 retained recording records, 1–30 day retention (default 7). The worker drops new rows at capacity and records counts rather than silently overwriting retained evidence. Expired recordings are pruned on subsequent SCT activity/status/start (routine checks are throttled to at most hourly) (not via a persistent idle polling timer). Standard durations 15 minutes–7 days; full mode 15–60 minutes. Only committed rows survive process death. A bounded document buffer holds up to 256 rows, batches up to 64, single in-flight send with at most one delivery retry, idempotent stream/sequence keys and commit counts. On stop, bounded best-effort flushes report acknowledged/unconfirmed tabs. Hard crashes, extension invalidation and lost tail events may not be detectable. Missing sequences, invalid/conflicting events, storage drops and unconfirmed deliveries are not interchangeable with actual API failures.

Export root `{meta, events}`. `meta.protocol` is `sct.community.v1`, `schemaVersion: 1`; `meta.recording` includes recording UUID, mode, scope, start/end/expiry, retention, cap, coarse browser/platform and non-secret correlation. `meta.completeness` separates committed/exported/omitted rows and states observational coverage; `meta.summary` includes event/outcome/phase counts, timing, observed candidate submissions, unmatched requests, operation spans, expected/observed count mismatches, and coverage. Each row contains `recordingId`, `streamId`, `sequence`, `ts` (epoch ms), `receivedAt`, `inspectorVersion`, optional per-export `tabRef`, and allowlisted `event`. Tab references are pseudonyms local to the export (not stable across captures). Authenticated peer/operator marker correlation is under `event.correlation`. Export sorts by time using a bounded snapshot, yields between serialization chunks and uses CompressionStream if available. GZIP exports use `.json.gz`; otherwise `.json`. No download completion is asserted. Keep local original and backend journal separately; ordinary Inspector exports remain unchanged.

## Backend transfer and dedicated browser

`SCTTransport` exposes a fixed destination-origin validator and disabled/not-configured transport status. `sendRecording()` returns a disabled result, performs no fetch and cannot be enabled by a website or peer message. No backend URL endpoint, upload permission, authentication token, retry loop, remote command or server-side polling is implemented. The future contract must explicitly authorize a narrow diagnostic upload endpoint at the exact SCT origin, define authentication outside page telemetry, cap payloads, validate schema/ownership, provide idempotency and bounded backoff/expiry, and expose status/manual export. Do not transmit site credentials. Never use this as a publication channel. Authenticated remote recording start/stop is deferred until a backend/peer authorization design is agreed. Dedicated Chromium can use the same manual controls, durable local store and authorized peer markers; account/session verification, actual unattended deployment and live transport are not part of this release.

## Validation / remaining work

See accompanying test report. The release contains the foundation, not a verified end-to-end SCT publication integration. Confirm real editor selectors/routes and response shapes for chatbot/rulebook/group/publication, role of attachments and moderation, actual browser restart/reload/worker persistence, browser-specific external messaging and large-scale responsiveness before relying on it for publication verification. No live SpicyChat API traffic is used for the tests.
