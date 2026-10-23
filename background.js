const DB_NAME = 'spicychat-inspector';
const DB_VERSION = 2;
const STORE = 'events';
const SETTINGS_KEY = 'sci_settings';
const MIGRATION_KEY = 'sci_redaction_migrated_008';
const SETTINGS_MIGRATION_KEY = 'sci_settings_migrated_004';
const LOREBOOK_PRIVACY_MIGRATION_KEY = 'sci_lorebook_privacy_migrated_0029';
const STATE_SNAPSHOT_PRIVACY_MIGRATION_KEY = 'sci_state_snapshot_privacy_migrated_0033';
const DOM_TEXT_PRIVACY_MIGRATION_KEY = 'sci_dom_text_privacy_migrated_0034';
// Rerun the network migration once for older Rulebook API payloads. Existing
// migration keys cannot be reused after adding endpoint privacy coverage.
const NETWORK_PRIVACY_MIGRATION_KEY = 'sci_network_privacy_migrated_0037_rulebooks';
const REQUEST_IDENTIFIER_PRIVACY_MIGRATION_KEY = 'sci_request_identifier_privacy_migrated_0100';
const NATIVE_MEMORY_PRIVACY_MIGRATION_KEY = 'sci_native_memory_privacy_migrated_0101';

const DEFAULT_SETTINGS = {
  recording: true,
  captureNetworkBodies: true,
  captureDom: true,
  captureWebSocket: true,
  captureStorage: true,
  capturePerformance: true,
  captureErrors: true,
  // Detailed QoL internals are opt-in. Normal Inspector recording stays passive.
  captureQolInternals: false,
  qolTraceLevel: 'off',
  maxBodyChars: 200000,
  maxEvents: 100000
};

const PRIVATE_IDENTIFIER_KEY_RE = /^(?:x)?(?:guestuserid|guestid|userid|visitorid|deviceid|clientid|anonymousid|anonid|installationid|installid|fingerprintid)$/;
function isPrivateIdentifierKey(k) { return PRIVATE_IDENTIFIER_KEY_RE.test(String(k || '').replace(/[-_]/g, '').toLowerCase()); }
const PRIVATE_IDENTIFIER_VALUE_RE = /((?:[\"']?(?:x[-_])?(?:guest[-_]?user[-_]?id|guest[-_]?id|user[-_]?id|visitor[-_]?id|device[-_]?id|client[-_]?id|anon(?:ymous)?[-_]?id|install(?:ation)?[-_]?id|fingerprint[-_]?id)[\"']?)\s*[:=]\s*[\"']?)([A-Za-z0-9._~+/=-]+)/gi;
const SECRET_KEY_RE = /(authorization|cookie|set-cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session|jwt|csrf|xsrf|api[_-]?key|client[_-]?secret|p?_?psid)/i;
function isSecretKey(k) { return k !== 'authInvalidToken' && (SECRET_KEY_RE.test(k) || isPrivateIdentifierKey(k)); }
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
const PSID_VALUE_RE = /\b(psid)([:=])([A-Za-z0-9_-]{8,})/gi;
const URLENC_SECRET_RE = /(^|[?&])(refresh_token|access_token|id_token|token|password|client_secret|session|jwt|api_key|apikey|frontend_sign|p?_?psid)=([^&#]*)/gi;
let eventsSinceCleanup = 0;
let lastCleanupAt = 0;
let settingsCache = null;
let settingsCachePromise = null;
let dbPromise = null;


// Low-volume browser-level observer for SpicyChat recommendation feedback.
// This complements page fetch/XHR hooks and can see rating requests made from
// extension/background contexts. It is deliberately scoped to one Recombee
// endpoint and stores only the bot ID + rating action, never signing material.
const QOL_EXTENSION_ID = 'gkhmjipejmpdmdfiogonloidbijeehmk';
const ratingWebRequests = new Map();
const tabPageRoles = new Map();

// The Test Driver can be observed through both the direct page bridge and an
// auxiliary probe path. Keep the richer direct page marker and suppress only
// the probe mirror. Never dedupe two direct markers: retries with the same
// counter number are real events and must remain visible.
const recentDriverPrimaryMarkers = new Map();
function driverMarkerDedupeKey(event) {
  return [
    event?.subtype || '', event?.action || '', event?.phase || '', event?.role || '',
    event?.driverPageType || '', event?.driverNumber ?? '', event?.driverAttempt ?? '',
    event?.driverTarget ?? '', event?.driverPath ?? ''
  ].join('|');
}
function rememberPrimaryDriverMarker(event) {
  const key = driverMarkerDedupeKey(event);
  const list = recentDriverPrimaryMarkers.get(key) || [];
  list.push({ ts: Number(event?.ts) || Date.now(), seenAt: Date.now() });
  const cutoff = Date.now() - 30000;
  const next = list.filter(x => x.seenAt >= cutoff).slice(-8);
  recentDriverPrimaryMarkers.set(key, next);
  if (recentDriverPrimaryMarkers.size > 500) {
    for (const [k, values] of recentDriverPrimaryMarkers) {
      if (!values.some(x => x.seenAt >= cutoff)) recentDriverPrimaryMarkers.delete(k);
      if (recentDriverPrimaryMarkers.size <= 400) break;
    }
  }
}
function isMirroredDriverDuplicate(event) {
  if (event?.type !== 'driver' || !Number.isFinite(Number(event?.driverTs))) return false;
  const list = recentDriverPrimaryMarkers.get(driverMarkerDedupeKey(event)) || [];
  const targetTs = Number(event.driverTs) || Number(event.ts) || Date.now();
  return list.some(x => Math.abs((Number(x.ts) || 0) - targetTs) <= 15000);
}
function recommendationWorkerRoleFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (u.searchParams.get('dsQolBotStatusWorker') === '1') return 'qol-bot-status-worker';
    if (u.searchParams.get('dsQolRecommendationWorker') === '1') return 'qol-recommendation-worker';
    if (u.searchParams.get('dsQuickDislike') === '1') return 'qol-recommendation-worker';
  } catch (_) {
    const raw = String(url);
    if (/(?:[?&])dsQolBotStatusWorker=1(?:&|$)/.test(raw)) return 'qol-bot-status-worker';
    if (/(?:[?&])dsQolRecommendationWorker=1(?:&|$)/.test(raw) || /(?:[?&])dsQuickDislike=1(?:&|$)/.test(raw)) return 'qol-recommendation-worker';
  }
  return null;
}
function rememberTabPageRole(tabId, pageId, role) {
  if (!Number.isInteger(tabId) || tabId < 0 || !pageId) return;
  if (role) tabPageRoles.set(tabId, { pageId, role, detectedAt: Date.now() });
}
function ratingAttribution(initiator, tabId) {
  const raw = String(initiator || '');
  const role = Number.isInteger(tabId) ? tabPageRoles.get(tabId) : null;
  if (role?.role === 'qol-recommendation-worker') {
    return { source: 'qol', confidence: 'confirmed', executor: 'qol-recommendation-worker', reason: 'tab was positively identified as the QoL shared Recommendation Feedback worker (Less Like or Dislike; exact mode unknown)' };
  }
  if (raw === `chrome-extension://${QOL_EXTENSION_ID}` || raw.startsWith(`chrome-extension://${QOL_EXTENSION_ID}/`)) {
    return { source: 'qol', confidence: 'confirmed', reason: 'browser initiator is SpicyChat QoL extension' };
  }
  if (/^https:\/\/([^.]+\.)?spicychat\.ai(?::\d+)?(?:\/|$)/i.test(raw)) {
    // webRequest exposes the execution origin here, not necessarily the code owner.
    // QoL page-world/injected fetches therefore look identical to native SpicyChat
    // requests at this layer. Keep this deliberately ambiguous and let the page
    // fetch/XHR stack correlation decide native vs QoL when that evidence exists.
    return { source: 'unknown-mixed', confidence: 'context-only', executor: 'spicychat-page', reason: 'Browser initiator identifies SpicyChat page context only; native code and injected QoL code can share this origin.' };
  }
  if (raw.startsWith('chrome-extension://')) return { source: 'other-extension', confidence: 'confirmed', reason: 'browser initiator is another extension' };
  return { source: 'unknown-mixed', confidence: 'weak', reason: raw ? 'unrecognized browser initiator' : 'browser initiator unavailable' };
}
function decodeRatingRequestBody(details) {
  try {
    if (details.requestBody?.raw?.length) {
      const bytes = details.requestBody.raw.flatMap(part => part?.bytes ? Array.from(new Uint8Array(part.bytes)) : []);
      if (bytes.length) {
        const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
        return { itemId: parsed?.itemId ?? null, rating: parsed?.rating ?? null, cascadeCreate: parsed?.cascadeCreate ?? null };
      }
    }
    const fd = details.requestBody?.formData;
    if (fd) return { itemId: fd.itemId?.[0] ?? null, rating: Number(fd.rating?.[0]), cascadeCreate: fd.cascadeCreate?.[0] ?? null };
  } catch (_) {}
  return null;
}
function safeRatingUrl(url) {
  return redactString(String(url || '')).replace(/([?&]frontend_sign=)[^&#]*/i, '$1[REDACTED]');
}
if (chrome.webRequest?.onBeforeRequest) {
  const ratingFilter = { urls: ['https://*.recombee.com/spicychat-prod/ratings/*'] };
  chrome.webRequest.onBeforeRequest.addListener(details => {
    const startedAt = Date.now();
    const requestId = `wr-${details.requestId}`;
    const body = decodeRatingRequestBody(details);
    // Keep request metadata in memory and persist only the completed transaction.
    ratingWebRequests.set(details.requestId, {
      startedAt, requestId, body, initiator: details.initiator || details.originUrl || null,
      method: details.method || 'POST', requestedUrl: safeRatingUrl(details.url),
      tabId: Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null,
      frameId: Number.isInteger(details.frameId) ? details.frameId : null
    });
  }, ratingFilter, ['requestBody']);
  chrome.webRequest.onCompleted.addListener(details => {
    const prior = ratingWebRequests.get(details.requestId);
    const ts = Date.now();
    ratingWebRequests.delete(details.requestId);
    addEvent({
      type: 'network', subtype: 'browser-rating-response', requestId: prior?.requestId || `wr-${details.requestId}`,
      method: details.method || prior?.method || 'POST', requestedUrl: prior?.requestedUrl || safeRatingUrl(details.url), finalUrl: safeRatingUrl(details.url), url: safeRatingUrl(details.url),
      status: details.statusCode, durationMs: prior ? Math.max(0, ts - prior.startedAt) : null,
      requestBody: prior?.body || null, requestStartedAt: prior?.startedAt || null, requestCombined: true,
      browserObserver: true, browserRequestId: details.requestId,
      initiator: details.initiator || prior?.initiator || null,
      attribution: ratingAttribution(details.initiator || prior?.initiator, details.tabId),
      pageRole: Number.isInteger(details.tabId) ? (tabPageRoles.get(details.tabId)?.role || null) : null,
      tabId: Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null,
      frameId: Number.isInteger(details.frameId) ? details.frameId : null,
      ts, pageId: 'browser-webrequest'
    }).catch(() => {});
  }, ratingFilter);
  chrome.webRequest.onErrorOccurred.addListener(details => {
    const prior = ratingWebRequests.get(details.requestId);
    const ts = Date.now();
    ratingWebRequests.delete(details.requestId);
    addEvent({
      type: 'network', subtype: 'browser-rating-response', requestId: prior?.requestId || `wr-${details.requestId}`,
      method: details.method || prior?.method || 'POST', requestedUrl: prior?.requestedUrl || safeRatingUrl(details.url), finalUrl: safeRatingUrl(details.url), url: safeRatingUrl(details.url),
      status: 0, durationMs: prior ? Math.max(0, ts - prior.startedAt) : null,
      error: details.error || 'webRequest error',
      requestBody: prior?.body || null, requestStartedAt: prior?.startedAt || null, requestCombined: true,
      browserObserver: true, browserRequestId: details.requestId,
      initiator: details.initiator || prior?.initiator || null,
      attribution: ratingAttribution(details.initiator || prior?.initiator, details.tabId),
      pageRole: Number.isInteger(details.tabId) ? (tabPageRoles.get(details.tabId)?.role || null) : null,
      tabId: Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null,
      frameId: Number.isInteger(details.frameId) ? details.frameId : null,
      ts, pageId: 'browser-webrequest'
    }).catch(() => {});
  }, ratingFilter);
}


// Native Dislike is NOT proved by a successful Recombee POST. A separate
// SpicyChat `characterRating` event must be confirmed. Keep this low volume:
// observe only /event, persist only allowlisted rating fields + HTTP outcome.
const nativeCharacterEventRequests = new Map();
function nativeEventIsEndpoint(url) {
  try { const u = new URL(url); return u.hostname === 'prod.nd-api.com' && u.pathname === '/event'; }
  catch (_) { return false; }
}
function decodedNativeCharacterEvent(details) {
  try {
    let body = null;
    const raw = details.requestBody?.raw;
    if (Array.isArray(raw) && raw.length) {
      const pieces = raw.filter(x => x?.bytes).map(x => new Uint8Array(x.bytes));
      const total = pieces.reduce((n,x) => n + x.length, 0);
      if (total && total <= 8192) {
        const all = new Uint8Array(total); let offset = 0;
        for (const piece of pieces) { all.set(piece, offset); offset += piece.length; }
        body = JSON.parse(new TextDecoder().decode(all));
      }
    }
    if (!body && details.requestBody?.formData) {
      const f = details.requestBody.formData;
      body = { event_name:f.event_name?.[0], character_id:f.character_id?.[0], rating:f.rating?.[0] };
    }
    if (body?.event_name !== 'characterRating') return null;
    const botId = String(body.character_id || '').toLowerCase();
    // Non-ID payloads are not exported, even if an endpoint was matched.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(botId)) return { eventName:'characterRating', botId:null, rating:null };
    const rating = Number(body.rating);
    return { eventName:'characterRating', botId, rating:Number.isFinite(rating) ? rating : null };
  } catch (_) { return null; }
}
function recordNativeCharacterEventOutcome(details, error = null) {
  const prior = nativeCharacterEventRequests.get(details.requestId);
  nativeCharacterEventRequests.delete(details.requestId);
  if (!prior?.event) return;
  const now = Date.now();
  addEvent({
    type:'network', subtype:'browser-character-rating-response',
    requestId:`native-event-${details.requestId}`, browserRequestId:details.requestId,
    browserObserver:true, requestCombined:true, method:'POST',
    requestedUrl:'https://prod.nd-api.com/event', finalUrl:'https://prod.nd-api.com/event',
    eventName:'characterRating', botId:prior.event.botId, rating:prior.event.rating,
    status:error ? 0 : Number(details.statusCode || 0),
    durationMs:Math.max(0, now-prior.startedAt),
    error:error ? String(error).slice(0,120) : null,
    attribution:ratingAttribution(details.initiator || prior.initiator, details.tabId),
    pageRole:Number.isInteger(details.tabId) ? (tabPageRoles.get(details.tabId)?.role || null) : null,
    tabId:Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null,
    ts:now, pageId:'browser-webrequest'
  }).catch(() => {});
}
if (chrome.webRequest?.onBeforeRequest) {
  const nativeEventFilter = { urls:['https://prod.nd-api.com/event*'] };
  chrome.webRequest.onBeforeRequest.addListener(details => {
    if (details.method !== 'POST' || !nativeEventIsEndpoint(details.url)) return;
    const event = decodedNativeCharacterEvent(details);
    if (!event) return;  // Other native events are outside the diagnostic scope.
    nativeCharacterEventRequests.set(details.requestId,{event,startedAt:Date.now(),initiator:details.initiator || null});
  }, nativeEventFilter, ['requestBody']);
  chrome.webRequest.onCompleted.addListener(details => {
    if (nativeEventIsEndpoint(details.url)) recordNativeCharacterEventOutcome(details);
  }, nativeEventFilter);
  chrome.webRequest.onErrorOccurred.addListener(details => {
    if (nativeEventIsEndpoint(details.url)) recordNativeCharacterEventOutcome(details, details.error || 'request-failed');
  }, nativeEventFilter);
}

const SIGNAL_KEY_RE = /^(is_nsfw|isNsfwEnabled|moderation_status|moderationStatus|aicq_manual_review_required|inference_model|inferenceModel|engine|provider|max_new_tokens|temperature|top_p|top_k|context|context_length|tokens|model)$/i;

function redactString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(JWT_RE, '[REDACTED_JWT]').replace(BEARER_RE, 'Bearer [REDACTED]').replace(URLENC_SECRET_RE, (m, p, k) => `${p}${k}=[REDACTED]`).replace(PSID_VALUE_RE, (m, key, sep) => `${key}${sep}[REDACTED]`).replace(PRIVATE_IDENTIFIER_VALUE_RE, (m, prefix) => `${prefix}[REDACTED]`);
}


function fnv1a32Text(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
function fingerprintDiagnosticValue(value) {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch (_) { text = String(value ?? ''); }
  return fnv1a32Text(text);
}
function summarizeLegacyStorageObject(value) {
  let objectValue = value;
  if (typeof objectValue === 'string') {
    try { objectValue = JSON.parse(objectValue); } catch (_) { objectValue = null; }
  }
  if (!objectValue || typeof objectValue !== 'object' || Array.isArray(objectValue)) {
    const text = typeof value === 'string' ? value : '';
    return { keyCount: 0, totalApproxBytes: text.length * 2, unavailableOrRedacted: true };
  }
  const rows = [];
  let totalApproxBytes = 0;
  for (const [key, item] of Object.entries(objectValue)) {
    let text = '';
    try { text = typeof item === 'string' ? item : JSON.stringify(item); }
    catch (_) { text = String(item ?? ''); }
    const row = {
      key: String(key || '').slice(0, 240),
      chars: text.length,
      approxBytes: text.length * 2,
      type: item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item,
      fingerprint: fingerprintDiagnosticValue(item)
    };
    totalApproxBytes += row.approxBytes;
    rows.push(row);
  }
  rows.sort((a,b)=>b.approxBytes-a.approxBytes);
  return { keyCount: rows.length, totalApproxBytes, largestKeys: rows.slice(0,20), keyMetadata: rows.slice(0,120) };
}
function applyStateSnapshotPrivacy(event) {
  if (!event || event.type !== 'state') return { event, changed: false };
  if (!('localStorage' in event) && !('sessionStorage' in event)) return { event, changed: false };
  const next = { ...event };
  next.pageStorage = {
    local: summarizeLegacyStorageObject(event.localStorage),
    transient: summarizeLegacyStorageObject(event.sessionStorage),
    rawValuesCaptured: false,
    migratedFromLegacySnapshot: true
  };
  delete next.localStorage;
  delete next.sessionStorage;
  if (next.globals && typeof next.globals === 'object') {
    const globals = {};
    for (const [key, item] of Object.entries(next.globals).slice(0,80)) {
      let text = '';
      try { text = typeof item === 'string' ? item : JSON.stringify(item); } catch (_) { text = String(item ?? ''); }
      globals[String(key).slice(0,160)] = { chars:text.length, approxBytes:text.length*2, type:item===null?'null':Array.isArray(item)?'array':typeof item, fingerprint:fingerprintDiagnosticValue(item) };
    }
    next.globals = globals;
  }
  return { event: next, changed: true };
}
function domTextMetaFromLegacy(value) {
  const text = String(value ?? '');
  if (!text) return null;
  return { chars: text.length, fingerprint: fnv1a32Text(text) };
}
function domDescLabel(desc) {
  if (!desc || typeof desc !== 'object') return 'node';
  if (desc.node === '#text') return '#text';
  const cls = String(desc.class || '').trim().split(/\s+/).filter(Boolean).slice(0,3).map(x=>`.${x}`).join('');
  return `${desc.node || 'node'}${desc.id ? `#${desc.id}` : ''}${cls}`.slice(0,180);
}
function scrubLegacyDomDesc(desc) {
  if (!desc || typeof desc !== 'object') return { value: desc, changed: false };
  const out = { ...desc };
  let changed = false;
  if (typeof out.text === 'string') {
    out.textMeta = domTextMetaFromLegacy(out.text);
    delete out.text;
    changed = true;
  }
  return { value: out, changed };
}
function applyDomMutationTextPrivacy(event) {
  if (!event || event.type !== 'dom' || event.subtype !== 'mutation-batch') return { event, changed: false };
  let changed = false;
  const next = { ...event };
  next.changes = (event.changes || []).map(ch => {
    if (!ch || typeof ch !== 'object') return ch;
    const out = { ...ch };
    const td = scrubLegacyDomDesc(ch.target); out.target = td.value; changed ||= td.changed;
    out.added = (ch.added || []).map(d => { const x=scrubLegacyDomDesc(d); changed ||= x.changed; return x.value; });
    out.removed = (ch.removed || []).map(d => { const x=scrubLegacyDomDesc(d); changed ||= x.changed; return x.value; });
    if (typeof out.oldText === 'string') { out.oldTextMeta = domTextMetaFromLegacy(out.oldText); delete out.oldText; changed = true; }
    if (typeof out.newText === 'string') { out.newTextMeta = domTextMetaFromLegacy(out.newText); delete out.newText; changed = true; }
    if (out.kind === 'characterData') {
      if (typeof out.oldValue === 'string') { out.oldTextMeta = domTextMetaFromLegacy(out.oldValue); delete out.oldValue; changed = true; }
      if (typeof out.newValue === 'string') { out.newTextMeta = domTextMetaFromLegacy(out.newValue); delete out.newValue; changed = true; }
    }
    if (typeof out.pattern === 'string' && /(?:children|text)\s+["']/.test(out.pattern)) {
      out.pattern = `${domDescLabel(out.target)} ${out.kind === 'characterData' ? 'text' : 'children text'} changed`;
      changed = true;
    }
    return out;
  });
  if (next.stats?.topPatterns && Array.isArray(next.stats.topPatterns)) {
    const stats = { ...next.stats };
    stats.topPatterns = stats.topPatterns.map(row => {
      if (!row || typeof row !== 'object' || typeof row.value !== 'string') return row;
      if (!/(?:children|text)\s+["']/.test(row.value)) return row;
      changed = true;
      return { ...row, value: 'DOM text changed' };
    });
    next.stats = stats;
  }
  return { event: next, changed };
}
function lorebookUrlFromEvent(event) {
  return event?.finalUrl || event?.responseUrl || event?.requestedUrl || event?.url || event?.networkMeta?.endpoint || '';
}
function isLorebookApiUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url));
    return /(?:^|\/)lorebooks(?:\/|$)/i.test(u.pathname || '');
  } catch (_) {
    return /(?:^|\/)lorebooks(?:[/?#]|$)/i.test(String(url));
  }
}
// Native conversation Memories are private even when returned by a normal GET.
function isNativeMemoryApiUrl(url) {
  if (!isCoreDiagnosticHost(url)) return false;
  const path = networkPathname(url);
  return /(?:^|\/)memories?(?:\/|$)/i.test(path);
}
function isRulebookApiUrl(url) {
  // Do not confuse the frontend /my-creations/rulebooks route with API data.
  // Include the singular form for beta API compatibility.
  const path = networkPathname(url);
  return /^\/(?:api\/)?(?:v\d+\/)?rulebooks?(?:\/|$)/i.test(path) && isCoreDiagnosticHost(url);
}
function isLorebookRedactionPlaceholder(value, kind) {
  return typeof value === 'string' && value === `[REDACTED_LOREBOOK_${kind.toUpperCase()}]`;
}
function redactLorebookPayload(value, depth = 0, stats = { contentFields: 0, keywordFields: 0 }) {
  if (depth > 18 || value == null) return { value, stats };
  if (Array.isArray(value)) {
    return { value: value.map(v => redactLorebookPayload(v, depth + 1, stats).value), stats };
  }
  if (typeof value !== 'object') return { value, stats };
  const out = {};
  let privacy = value._inspectorLorebookPrivacy && typeof value._inspectorLorebookPrivacy === 'object'
    ? { ...value._inspectorLorebookPrivacy }
    : null;
  for (const [k, v] of Object.entries(value)) {
    const lower = String(k).toLowerCase();
    if (lower === 'content') {
      if (isLorebookRedactionPlaceholder(v, 'content')) { out[k] = v; continue; }
      let chars = 0;
      if (typeof v === 'string') chars = v.length;
      else { try { chars = JSON.stringify(v).length; } catch (_) { chars = String(v ?? '').length; } }
      out[k] = '[REDACTED_LOREBOOK_CONTENT]';
      privacy = privacy || {};
      privacy.content = { chars, fingerprint: fingerprintDiagnosticValue(v) };
      stats.contentFields++;
      continue;
    }
    if (lower === 'keywords') {
      if (isLorebookRedactionPlaceholder(v, 'keywords')) { out[k] = v; continue; }
      let count = null, chars = 0;
      if (Array.isArray(v)) {
        count = v.length;
        for (const item of v) chars += typeof item === 'string' ? item.length : (() => { try { return JSON.stringify(item).length; } catch (_) { return String(item ?? '').length; } })();
      } else if (typeof v === 'string') { count = v ? 1 : 0; chars = v.length; }
      else { try { chars = JSON.stringify(v).length; } catch (_) { chars = String(v ?? '').length; } }
      out[k] = '[REDACTED_LOREBOOK_KEYWORDS]';
      privacy = privacy || {};
      privacy.keywords = { count, chars, fingerprint: fingerprintDiagnosticValue(v) };
      stats.keywordFields++;
      continue;
    }
    if (k === '_inspectorLorebookPrivacy') continue;
    out[k] = redactLorebookPayload(v, depth + 1, stats).value;
  }
  if (privacy) out._inspectorLorebookPrivacy = privacy;
  return { value: out, stats };
}
function redactLorebookBodyValue(body) {
  if (body == null) return { value: body, changed: false, stats: { contentFields: 0, keywordFields: 0 }, wholeBodyFallback: false };
  let parsed = body;
  let parsedFromText = false;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); parsedFromText = true; }
    catch (_) {
      return {
        value: { __redacted_lorebook_body__: true, chars: parsed.length, fingerprint: fingerprintDiagnosticValue(parsed) },
        changed: true, stats: { contentFields: null, keywordFields: null }, wholeBodyFallback: true
      };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { value: parsed, changed: parsedFromText, stats: { contentFields: 0, keywordFields: 0 }, wholeBodyFallback: false };
  const stats = { contentFields: 0, keywordFields: 0 };
  const value = redactLorebookPayload(parsed, 0, stats).value;
  return { value, changed: parsedFromText || stats.contentFields > 0 || stats.keywordFields > 0, stats, wholeBodyFallback: false };
}
function applyLorebookNetworkPrivacy(event) {
  if (!event || event.type !== 'network' || !isLorebookApiUrl(lorebookUrlFromEvent(event))) return { event, changed: false };
  const next = { ...event };
  let changed = false;
  let totalContent = 0, totalKeywords = 0, wholeBodyFallback = false;
  for (const field of ['body', 'requestBody']) {
    if (next[field] == null) continue;
    const applied = redactLorebookBodyValue(next[field]);
    if (applied.changed) { next[field] = applied.value; changed = true; }
    if (Number.isFinite(applied.stats?.contentFields)) totalContent += applied.stats.contentFields;
    if (Number.isFinite(applied.stats?.keywordFields)) totalKeywords += applied.stats.keywordFields;
    wholeBodyFallback ||= applied.wholeBodyFallback === true;
  }
  if (changed || next.lorebookPrivacy?.redacted) next.lorebookPrivacy = {
    redacted: true,
    contentFields: wholeBodyFallback ? null : totalContent,
    keywordFields: wholeBodyFallback ? null : totalKeywords,
    wholeBodyFallback,
    policy: 'metadata-structure-only'
  };
  return { event: next, changed };
}

function bodyPrivacyMeta(value, kind = 'private-payload') {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch (_) { text = String(value ?? ''); }
  const out = { redacted: true, kind, chars: text.length, fingerprint: fingerprintDiagnosticValue(value) };
  if (Array.isArray(value)) out.count = value.length;
  else if (value && typeof value === 'object') out.keys = Object.keys(value).slice(0, 80);
  return out;
}
function parsePrivacyBody(value) {
  if (typeof value !== 'string') return { value, parsedFromText: false, parseFailed: false };
  try { return { value: JSON.parse(value), parsedFromText: true, parseFailed: false }; }
  catch (_) { return { value, parsedFromText: false, parseFailed: true }; }
}
function pickObjectFields(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}
function safeInferenceSettings(value) {
  if (!value || typeof value !== 'object') return null;
  return pickObjectFields(value, ['max_new_tokens','temperature','top_p','top_k','min_p','repetition_penalty','frequency_penalty','presence_penalty']);
}
function sanitizeChatRequestPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return bodyPrivacyMeta(value, 'chat-request');
  const v = parsed.value;
  const out = pickObjectFields(v, ['conversation_id','character_id','user_persona_id','language','inference_model','autopilot','continue_chat','alt_message_id']);
  out.inference_settings = safeInferenceSettings(v.inference_settings);
  if (v.message !== undefined) out.message = bodyPrivacyMeta(v.message, 'chat-user-message');
  if (v.prompt !== undefined) out.prompt = bodyPrivacyMeta(v.prompt, 'chat-prompt');
  if (v.messages !== undefined) out.messages = bodyPrivacyMeta(v.messages, 'chat-message-history');
  out._inspectorPrivacy = { redacted: true, policy: 'chat-request-metadata-only' };
  return out;
}
function sanitizeChatResponsePayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return bodyPrivacyMeta(value, 'chat-response');
  const v = parsed.value;
  const out = pickObjectFields(v, ['engine','provider','capped_message_id','finish_reason','model']);
  const m = v.message;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    out.message = pickObjectFields(m, ['conversation_id','character_id','role','id','prev_id','createdAt','updatedAt','is_nsfw','moderation_status']);
    if (m.content !== undefined) out.message.content = bodyPrivacyMeta(m.content, 'chat-generated-content');
  } else if (m !== undefined) out.message = bodyPrivacyMeta(m, 'chat-generated-content');
  if (v.content !== undefined) out.content = bodyPrivacyMeta(v.content, 'chat-generated-content');
  out._inspectorPrivacy = { redacted: true, policy: 'chat-response-metadata-only' };
  return out;
}
function sanitizeMessageHistoryPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object') return bodyPrivacyMeta(value, 'conversation-history');
  const v = parsed.value;
  if (Array.isArray(v)) return { messages: v.map(m => sanitizeOneMessageMeta(m)), count: v.length, _inspectorPrivacy: { redacted: true, policy: 'message-history-metadata-only' } };
  const out = pickObjectFields(v, ['conversation_id','num_messages','createdAt','updatedAt','next_id','last_id']);
  if (v.label !== undefined) out.label = bodyPrivacyMeta(v.label, 'conversation-label');
  if (v.userPersona !== undefined) out.userPersona = sanitizePersonaRecord(v.userPersona);
  if (Array.isArray(v.messages)) out.messages = v.messages.map(m => sanitizeOneMessageMeta(m));
  else if (v.messages !== undefined) out.messages = bodyPrivacyMeta(v.messages, 'conversation-messages');
  out._inspectorPrivacy = { redacted: true, policy: 'message-history-metadata-only' };
  return out;
}
function sanitizeOneMessageMeta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bodyPrivacyMeta(m, 'message');
  const out = pickObjectFields(m, ['conversation_id','character_id','role','id','prev_id','createdAt','updatedAt','is_nsfw','moderation_status']);
  if (m.content !== undefined) out.content = bodyPrivacyMeta(m.content, 'message-content');
  return out;
}
function sanitizePersonaRecord(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bodyPrivacyMeta(p, 'persona');
  const out = pickObjectFields(p, ['id','avatar_url','createdAt','updatedAt']);
  if (p.name !== undefined) out.name = bodyPrivacyMeta(p.name, 'persona-name');
  if (p.highlights !== undefined) out.highlights = bodyPrivacyMeta(p.highlights, 'persona-highlights');
  if (p.description !== undefined) out.description = bodyPrivacyMeta(p.description, 'persona-description');
  out._inspectorPrivacy = { redacted: true, policy: 'persona-metadata-only' };
  return out;
}
function sanitizePersonaPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed) return bodyPrivacyMeta(value, 'persona-payload');
  if (Array.isArray(parsed.value)) return parsed.value.map(sanitizePersonaRecord);
  return sanitizePersonaRecord(parsed.value);
}
function sanitizeUserPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object') return bodyPrivacyMeta(value, 'user-profile');
  const root = parsed.value;
  const user = root.user && typeof root.user === 'object' ? root.user : root;
  const safeUser = pickObjectFields(user, ['id','application_id','default_persona_id','age_verification','subscription']);
  for (const key of ['name','username','email','avatar_url','highlights']) if (user[key] !== undefined) safeUser[key] = bodyPrivacyMeta(user[key], `user-${key}`);
  safeUser._inspectorPrivacy = { redacted: true, policy: 'user-profile-metadata-only' };
  return root.user && typeof root.user === 'object' ? { user: safeUser } : safeUser;
}
function sanitizeUserSettingsPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return bodyPrivacyMeta(value, 'user-settings');
  const v = parsed.value;
  const out = pickObjectFields(v, ['version','show_nsfw','auto_response_enabled','tts_include_narration']);
  if (v.selected_languages !== undefined) out.selected_languages = bodyPrivacyMeta(v.selected_languages, 'selected-languages');
  if (v.selected_tags !== undefined) out.selected_tags = bodyPrivacyMeta(v.selected_tags, 'selected-tags');
  if (v.liked_bots !== undefined) out.liked_bots = { redacted: true, kind: 'liked-bots', count: Array.isArray(v.liked_bots) ? v.liked_bots.length : null, fingerprint: fingerprintDiagnosticValue(v.liked_bots) };
  if (v.userId !== undefined) out.userId = bodyPrivacyMeta(v.userId, 'user-id');
  out._inspectorPrivacy = { redacted: true, policy: 'user-settings-metadata-only', keyCount: Object.keys(v).length };
  return out;
}
const CHARACTER_PRIVATE_FIELD_RE = /^(?:greeting|definition|description|scenario|personality|prompt|system_prompt|post_history_instructions|example_dialogue|mes_example|first_mes|chatText|messageText|messages|content)$/i;
function sanitizeCharacterPayload(value, depth = 0) {
  if (depth > 12 || value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => sanitizeCharacterPayload(v, depth + 1));
  if (typeof value !== 'object') return String(value);
  const out = {};
  for (const [k,v] of Object.entries(value).slice(0, 1500)) {
    if (isSecretKey(k)) out[k] = '[REDACTED]';
    else if (CHARACTER_PRIVATE_FIELD_RE.test(k)) out[k] = bodyPrivacyMeta(v, `character-${String(k).toLowerCase()}`);
    else if (/^(?:email|highlights)$/i.test(k)) out[k] = bodyPrivacyMeta(v, `private-${String(k).toLowerCase()}`);
    else out[k] = sanitizeCharacterPayload(v, depth + 1);
  }
  return out;
}
function sanitizeErrorPayload(value) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return bodyPrivacyMeta(value, 'error-body');
  const v = parsed.value;
  const out = {};
  for (const key of ['errorCode','code','status','statusCode','type']) if (v[key] !== undefined) out[key] = v[key];
  if (typeof v.message === 'string') out.message = redactString(v.message).slice(0, 500);
  else if (typeof v.error === 'string') out.error = redactString(v.error).slice(0, 500);
  else if (v.error && typeof v.error === 'object') out.error = sanitizeCharacterPayload(v.error);
  out._inspectorPrivacy = { redacted: true, policy: 'error-fields-only' };
  return out;
}
function isCoreDiagnosticHost(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'spicychat.ai' || h.endsWith('.spicychat.ai') || h === 'nd-api.com' || h.endsWith('.nd-api.com');
  } catch (_) { return false; }
}
function networkPathname(url) { try { return new URL(String(url)).pathname || ''; } catch (_) { return String(url || ''); } }
function isRatingsApiUrl(url) { return /\/spicychat-prod\/ratings\/?$/i.test(networkPathname(url)); }
const GENERIC_NETWORK_PRIVATE_KEY_RE = /(?:email|e[_-]?mail|phone|highlights|persona(?:text|description)|full[_-]?text|raw[_-]?body)/i;
function scrubGenericNetworkPrivateFields(value, depth = 0) {
  if (depth > 12 || value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => scrubGenericNetworkPrivateFields(v, depth + 1));
  if (typeof value !== 'object') return String(value);
  const out = {};
  for (const [k,v] of Object.entries(value).slice(0,1500)) {
    if (isSecretKey(k)) out[k] = '[REDACTED]';
    else if (GENERIC_NETWORK_PRIVATE_KEY_RE.test(k)) out[k] = bodyPrivacyMeta(v, `private-${String(k).toLowerCase()}`);
    else out[k] = scrubGenericNetworkPrivateFields(v, depth + 1);
  }
  return out;
}

const PRIVATE_RECORD_PASSTHROUGH = new Set([
  'id','character_id','creator_user_id','conversation_id','user_persona_id',
  'last_message_id','prev_id','next_id','application_id','request_id',
  'memory_type','is_pinned',
  'createdAt','updatedAt','created_at','updated_at','deletedAt',
  'type','visibility','language','role','status','state','model',
  'is_nsfw','avatar_is_nsfw','aicq_manual_review_required',
  'has_lorebooks','has_private_lorebook','definition_visible','group_addable',
  'num_messages','message_count','num_entries','token_count','total',
  'version','published_at','num_rules','num_meters','num_hidden_meters',
  'num_attached_characters','num_attached_personas','has_hidden_meters',
  'cover_is_nsfw','cloned_from','errorCode','code','statusCode',
  'rating_score','rating_count','count','limit','offset','page',
  'lastKey','fingerprint','__duplicate_body__','__truncated__'
]);
// Authored strings use arbitrary field names (persona/dialogue/greeting/last_text_message,
// including fields nested under a character or conversation). Preserve only a small
// fixed diagnostic vocabulary; everything else becomes length/fingerprint metadata.
function sanitizePrivateRecord(value, kind = 'authoring', depth = 0) {
  if (depth > 12) return bodyPrivacyMeta(value, `${kind}-depth-limit`);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return bodyPrivacyMeta(value, kind);
  if (Array.isArray(value)) {
    if (value.length && value.every(v => v == null || typeof v !== 'object')) return bodyPrivacyMeta(value, `${kind}-values`);
    const items = value.slice(0, 1500).map(v => sanitizePrivateRecord(v, kind, depth + 1));
    return value.length > items.length ? { count:value.length, items, truncated:true } : items;
  }
  if (typeof value !== 'object') return bodyPrivacyMeta(value, kind);
  if (value.redacted === true && Object.keys(value).every(k => ['redacted','kind','chars','fingerprint','count','keys'].includes(k))) return value;
  const out = {};
  for (const [key, v] of Object.entries(value).slice(0, 1600)) {
    if (isSecretKey(key)) { out[key] = '[REDACTED]'; continue; }
    if (PRIVATE_RECORD_PASSTHROUGH.has(key)) {
      // Only preserve primitive identifiers/numbers/enums. A forged object under a
      // normally harmless key must not become a bypass.
      out[key] = (v == null || typeof v === 'number' || typeof v === 'boolean') ? v
        : (typeof v === 'string' && v.length <= 180 ? redactString(v) : bodyPrivacyMeta(v, `${kind}-${key}`));
    } else if (v && typeof v === 'object' && !Array.isArray(v) && v.redacted === true && Object.keys(v).every(x => ['redacted','kind','chars','fingerprint','count','keys'].includes(x))) {
      // A prior storage/migration pass already replaced this field with safe
      // metadata. Never fingerprint a fingerprint on every subsequent pass.
      out[key] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = sanitizePrivateRecord(v, `${kind}-${key}`, depth + 1);
    } else if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) {
      out[key] = sanitizePrivateRecord(v, `${kind}-${key}`, depth + 1);
    } else {
      out[key] = bodyPrivacyMeta(v, `${kind}-${key}`);
    }
  }
  return out;
}
function sanitizePrivateApiBody(value, kind) {
  const parsed = parsePrivacyBody(value);
  if (parsed.parseFailed) return bodyPrivacyMeta(value, kind);
  return sanitizePrivateRecord(parsed.value, kind);
}

function sanitizeNativeMemoryBody(value) {
  // Allowlisted structure, not a text-field blacklist: new server fields must
  // not accidentally become public. The common authoring scrub retains IDs,
  // dates, booleans, the memory type and redacted content length/fingerprint.
  return sanitizePrivateApiBody(value, 'native-memory');
}
function sanitizeNetworkBodyByEndpoint(value, { url, role, status }) {
  if (value == null) return value;
  const path = networkPathname(url);
  // Rulebooks contain authored instructions in combined_rules, definition,
  // meter labels, conditions, descriptions, and future beta-specific fields.
  // An allowlist-based recursive scrub prevents new fields leaking silently.
  if (isNativeMemoryApiUrl(url)) return sanitizeNativeMemoryBody(value);
  if (isRulebookApiUrl(url)) return sanitizePrivateApiBody(value, 'rulebook');
  if (role === 'response' && Number(status) >= 400) return sanitizeErrorPayload(value);
  if (/(?:^|\/)chat\/?$/i.test(path)) return role === 'request' ? sanitizeChatRequestPayload(value) : sanitizeChatResponsePayload(value);
  if (/\/characters\/[^/]+\/messages(?:\/[^/?]+)?\/?$/i.test(path)) return sanitizeMessageHistoryPayload(value);
  if (/\/personas(?:\/|$)/i.test(path)) return sanitizePersonaPayload(value);
  if (/\/v2\/users\/?$/i.test(path)) return sanitizeUserPayload(value);
  if (/\/users\/settings\/?$/i.test(path)) return sanitizeUserSettingsPayload(value);
  if (/\/(?:v2\/)?(?:users\/)?characters(?:\/|$)/i.test(path) || /\/characters\/suggest_tags\/?$/i.test(path)) return sanitizePrivateApiBody(value, 'character-authoring');
  if (/\/v2\/conversations(?:\/|$)/i.test(path)) return sanitizePrivateApiBody(value, 'conversation-preview');
  if (/\/save-image\/?$/i.test(path)) return bodyPrivacyMeta(value, 'image-upload');
  if (!isCoreDiagnosticHost(url) && !isRatingsApiUrl(url)) return bodyPrivacyMeta(value, role === 'request' ? 'third-party-request' : 'third-party-response');
  return scrubGenericNetworkPrivateFields(value);
}
function applyNetworkPayloadPrivacy(event) {
  if (!event || event.type !== 'network') return { event, changed: false };
  let next = { ...event };
  let changed = false;
  const lore = applyLorebookNetworkPrivacy(next);
  next = lore.event; changed ||= lore.changed;
  const url = lorebookUrlFromEvent(next);
  if (isLorebookApiUrl(url)) return { event: next, changed };
  const subtype = String(next.subtype || '');
  const requestLike = /(?:request|incomplete)$/.test(subtype);
  const responseLike = /response$/.test(subtype) || next.requestCombined === true;
  if (next.requestBody != null) {
    const before = next.requestBody;
    const after = sanitizeNetworkBodyByEndpoint(before, { url, role: 'request', status: next.status });
    if (after !== before) { next.requestBody = after; changed = true; }
  }
  if (next.body != null) {
    const role = requestLike && !/response$/.test(subtype) ? 'request' : 'response';
    const before = next.body;
    const after = sanitizeNetworkBodyByEndpoint(before, { url, role, status: next.status });
    if (after !== before) { next.body = after; changed = true; }
  }
  if (isNativeMemoryApiUrl(url)) {
    // Legacy extracted signals might contain private payload fragments.
    if (Array.isArray(next.signals) && next.signals.length) { next.signals = []; changed = true; }
    next.memoryPrivacy = { redacted: true, policy: 'native-memory-metadata-only' };
  }
  if (isRulebookApiUrl(url)) {
    next.rulebookPrivacy = { redacted: true, policy: 'authored-text-metadata-only' };
    // Pre-migration signals may have captured values from private rule fields.
    if (Array.isArray(next.signals) && next.signals.length) {
      next.signals = next.signals.filter(s => /(?:^|\.)(?:is_nsfw|model|engine|provider|status|version)$/.test(String(s?.path || '')) && (typeof s?.value === 'number' || typeof s?.value === 'boolean'));
      changed = true;
    }
  }
  return { event: next, changed };
}

function sanitizeDeep(value, depth = 0, seen = new WeakSet()) {
  if (depth > 10) return '[MAX_DEPTH]';
  if (value == null || ['number','boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => sanitizeDeep(v, depth + 1, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ > 1500) { out.__truncated__ = true; break; }
      out[k] = isSecretKey(k) ? '[REDACTED]' : sanitizeDeep(v, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function extractSignals(value, path = '$', depth = 0, out = []) {
  if (depth > 10 || out.length >= 150 || value == null) return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 200); i++) extractSignals(value[i], `${path}[${i}]`, depth + 1, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (out.length >= 150) break;
    const p = `${path}.${k}`;
    if (SIGNAL_KEY_RE.test(k) && !isSecretKey(k) && (v == null || ['string','number','boolean'].includes(typeof v))) out.push({ path: p, value: sanitizeDeep(v) });
    extractSignals(v, p, depth + 1, out);
  }
  return out;
}

function enrichEvent(event) {
  let safe = sanitizeDeep(event);
  safe = applyStateSnapshotPrivacy(safe).event;
  safe = applyNetworkPayloadPrivacy(safe).event;
  safe = applyNetworkIdentifierPrivacy(safe).event;
  const signals = extractSignals(safe);
  if (signals.length) safe.signals = signals;
  if (safe.type === 'network') {
    const endpointUrl = safe.finalUrl || safe.responseUrl || safe.requestedUrl || safe.url;
    if (typeof endpointUrl === 'string' && endpointUrl) {
      try {
        const u = new URL(endpointUrl);
        safe.networkMeta = {
          host: u.host,
          pathname: u.pathname,
          endpoint: `${u.origin}${u.pathname}`,
          thirdParty: !(u.hostname === 'spicychat.ai' || u.hostname.endsWith('.spicychat.ai') || u.hostname === 'nd-api.com' || u.hostname.endsWith('.nd-api.com'))
        };
      } catch (_) {}
    }
    if (/response$/.test(safe.subtype || '')) {
      try {
        const bodyText = JSON.stringify(safe.body ?? '');
        const code = safe.body?.errorCode || safe.body?.error?.code || safe.body?.code || null;
        if (code != null) safe.errorCode = String(code).slice(0, 120);
        safe.authInvalidToken = safe.status === 401 && (safe.errorCode === 'SC-001-6004' || /invalid or expired token/i.test(bodyText));
      } catch (_) {
        safe.authInvalidToken = false;
      }
    }
  }
  return safe;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts');
        store.createIndex('type', 'type');
        store.createIndex('pageId', 'pageId');
      } else {
        store = req.transaction.objectStore(STORE);
      }
      if (!store.indexNames.contains('responseFingerprint')) store.createIndex('responseFingerprint', 'responseFingerprint', { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {};
  });
  return dbPromise;
}

async function addEvents(events) {
  const settings = await getSettings();
  const incoming = (Array.isArray(events) ? events : [events])
    .filter(Boolean)
    .filter(event => settings.recording || event.type === 'marker' || event.type === 'marker-context' || event.pinned === true);
  if (!incoming.length) return 0;

  const safeEvents = incoming.map(enrichEvent);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const dedupeIndex = store.indexNames.contains('responseFingerprint') ? store.index('responseFingerprint') : null;
    let index = 0;

    const next = () => {
      if (index >= safeEvents.length) return;
      const safeEvent = safeEvents[index++];
      const addNow = () => {
        try { store.add(safeEvent); } catch (_) {}
        next();
      };
      const endpointForDedupe = safeEvent.networkMeta?.endpoint || safeEvent.finalUrl || safeEvent.requestedUrl || safeEvent.url || '';
      const preserveFullChatBody = /(^|\/)chat$/i.test(String(endpointForDedupe));
      if (!preserveFullChatBody && dedupeIndex && safeEvent.type === 'network' && /response$/.test(safeEvent.subtype || '') && safeEvent.responseFingerprint && safeEvent.body != null) {
        const req = dedupeIndex.get(safeEvent.responseFingerprint);
        req.onsuccess = () => {
          const prior = req.result;
          if (prior?.id && prior.body != null && !prior.body?.__duplicate_body__) {
            safeEvent.body = { __duplicate_body__: true, fingerprint: safeEvent.responseFingerprint };
            safeEvent.bodyDuplicateOf = prior.id;
          }
          addNow();
        };
        req.onerror = ev => { try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {} addNow(); };
      } else addNow();
    };

    next();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Inspector event batch transaction aborted.'));
  });

  eventsSinceCleanup += safeEvents.length;
  const now = Date.now();
  if (eventsSinceCleanup >= 250 || now - lastCleanupAt >= 60000) {
    eventsSinceCleanup = 0;
    lastCleanupAt = now;
    cleanupOldEvents(settings.maxEvents).catch(() => {});
  }
  return safeEvents.length;
}

async function addEvent(event) {
  return addEvents([event]);
}

async function cleanupOldEvents(maxEvents) {
  const db = await openDb();
  const total = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (total <= maxEvents) return;
  const toDelete = total - maxEvents;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    let deleted = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || deleted >= toDelete) return;
      const e = cursor.value || {};
      const preserve = e.type === 'marker' || e.pinned === true || (e.type === 'state' && e.reason === 'marker');
      if (!preserve) { cursor.delete(); deleted++; }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getEvents(limit = 2000) {
  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('ts');
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
      out.push(applyNetworkIdentifierPrivacy(applyNetworkPayloadPrivacy(cursor.value).event).event); cursor.continue();
    };
    tx.oncomplete = () => resolve(out.reverse());
    tx.onerror = () => reject(tx.error);
  });
  return items;
}

async function getEventCount() {
  const db = await openDb();
  const total = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return total;
}

async function clearEvents() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  eventsSinceCleanup = 0;
  lastCleanupAt = Date.now();
}

async function migrateExistingEvents() {
  const state = await chrome.storage.local.get(MIGRATION_KEY);
  if (state[MIGRATION_KEY]) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const safe = enrichEvent(cursor.value);
      safe.id = cursor.value.id;
      cursor.update(safe);
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ [MIGRATION_KEY]: true });
}


async function migrateExistingLorebookPrivacy() {
  const state = await chrome.storage.local.get(LOREBOOK_PRIVACY_MIGRATION_KEY);
  if (state[LOREBOOK_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      scanned++;
      const raw = cursor.value;
      const applied = applyLorebookNetworkPrivacy(raw);
      if (applied.changed) {
        applied.event.id = raw.id;
        cursor.update(applied.event);
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({
    [LOREBOOK_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated }
  });
}

async function migrateExistingStateSnapshotPrivacy() {
  const state = await chrome.storage.local.get(STATE_SNAPSHOT_PRIVACY_MIGRATION_KEY);
  if (state[STATE_SNAPSHOT_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const source = store.indexNames.contains('type') ? store.index('type') : store;
    const req = store.indexNames.contains('type') ? source.openCursor(IDBKeyRange.only('state')) : source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const raw = cursor.value;
      if (!store.indexNames.contains('type') && raw?.type !== 'state') { cursor.continue(); return; }
      scanned++;
      const applied = applyStateSnapshotPrivacy(raw);
      if (applied.changed) {
        applied.event.id = raw.id;
        cursor.update(applied.event);
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({
    [STATE_SNAPSHOT_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated }
  });
}


async function migrateExistingDomTextPrivacy() {
  const state = await chrome.storage.local.get(DOM_TEXT_PRIVACY_MIGRATION_KEY);
  if (state[DOM_TEXT_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const source = store.indexNames.contains('type') ? store.index('type') : store;
    const req = store.indexNames.contains('type') ? source.openCursor(IDBKeyRange.only('dom')) : source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const raw = cursor.value;
      if (!store.indexNames.contains('type') && raw?.type !== 'dom') { cursor.continue(); return; }
      scanned++;
      const applied = applyDomMutationTextPrivacy(raw);
      if (applied.changed) {
        applied.event.id = raw.id;
        cursor.update(applied.event);
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ [DOM_TEXT_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated } });
}


// Scrub persistent user/device identifiers from existing stored network records.
// This is a separate, one-time migration: older network migrations may have
// completed before SpicyChat introduced x-guest-userid in request headers.
function applyNetworkIdentifierPrivacy(event) {
  if (!event || event.type !== 'network') return { event, changed: false };
  let changed = false;
  const visit = (value, depth = 0) => {
    if (depth > 16 || value == null) return value;
    if (typeof value === 'string') {
      const next = redactString(value);
      if (next !== value) changed = true;
      return next;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      let next = null;
      for (let i = 0; i < value.length; i++) {
        const item = visit(value[i], depth + 1);
        if (item !== value[i]) { if (!next) next = value.slice(); next[i] = item; }
      }
      return next || value;
    }
    let next = null;
    for (const [key, item] of Object.entries(value)) {
      const cleaned = isPrivateIdentifierKey(key) ? '[REDACTED]' : visit(item, depth + 1);
      if (cleaned !== item) { if (!next) next = { ...value }; next[key] = cleaned; changed = true; }
    }
    return next || value;
  };
  const safe = visit(event);
  return { event: safe, changed };
}

async function migrateExistingRequestIdentifierPrivacy() {
  const state = await chrome.storage.local.get(REQUEST_IDENTIFIER_PRIVACY_MIGRATION_KEY);
  if (state[REQUEST_IDENTIFIER_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const indexed = store.indexNames.contains('type');
    const source = indexed ? store.index('type') : store;
    const req = indexed ? source.openCursor(IDBKeyRange.only('network')) : source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const raw = cursor.value;
      if (!indexed && raw?.type !== 'network') { cursor.continue(); return; }
      scanned++;
      const applied = applyNetworkIdentifierPrivacy(raw);
      if (applied.changed) {
        applied.event.id = raw.id;
        cursor.update(applied.event);
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ [REQUEST_IDENTIFIER_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated } });
}

// Independent migration; do not reuse the previous network migration key.
// This runs on stored network rows in chunks using IndexedDB cursors and leaves
// original IDs, HTTP status and timing fields intact.
async function migrateExistingNativeMemoryPrivacy() {
  const state = await chrome.storage.local.get(NATIVE_MEMORY_PRIVACY_MIGRATION_KEY);
  if (state[NATIVE_MEMORY_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const indexed = store.indexNames.contains('type');
    const source = indexed ? store.index('type') : store;
    const req = indexed ? source.openCursor(IDBKeyRange.only('network')) : source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const raw = cursor.value;
      if (raw?.type === 'network' && isNativeMemoryApiUrl(lorebookUrlFromEvent(raw))) {
        scanned++;
        const applied = applyNetworkPayloadPrivacy(raw);
        if (applied.changed || !raw.memoryPrivacy?.redacted) {
          applied.event.id = raw.id;
          cursor.update(applied.event);
          updated++;
        }
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ [NATIVE_MEMORY_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated } });
}

async function migrateExistingNetworkPrivacy() {
  const state = await chrome.storage.local.get(NETWORK_PRIVACY_MIGRATION_KEY);
  if (state[NETWORK_PRIVACY_MIGRATION_KEY]) return;
  const db = await openDb();
  let scanned = 0, updated = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const source = store.indexNames.contains('type') ? store.index('type') : store;
    const req = store.indexNames.contains('type') ? source.openCursor(IDBKeyRange.only('network')) : source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const raw = cursor.value;
      if (!store.indexNames.contains('type') && raw?.type !== 'network') { cursor.continue(); return; }
      scanned++;
      const applied = applyNetworkPayloadPrivacy(raw);
      if (applied.changed) {
        applied.event.id = raw.id;
        cursor.update(applied.event);
        updated++;
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.storage.local.set({ [NETWORK_PRIVACY_MIGRATION_KEY]: { completedAt: Date.now(), scanned, updated } });
}

function compactMarkerBody(value, maxChars = 12000) {
  if (value == null) return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return value;
    return { __marker_preview__: true, __originalChars__: text.length, preview: text.slice(0, maxChars) };
  } catch (_) {
    const text = String(value);
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...[TRUNCATED]`;
  }
}

function compactContextEvent(e) {
  const out = { id: e.id, ts: e.ts, type: e.type, subtype: e.subtype || null, url: e.url || null };
  if (e.type === 'network') {
    const endpoint = e.networkMeta?.endpoint || e.finalUrl || e.requestedUrl || e.url || null;
    Object.assign(out, { method: e.method || null, endpoint, status: e.status ?? null, durationMs: e.durationMs ?? null, requestId: e.requestId || null, responseFingerprint: e.responseFingerprint || null, requestFingerprint: e.requestFingerprint || null, signals: (e.signals || []).slice(0, 30) });
    if (/(^|\/)chat$/i.test(String(endpoint || '')) && e.body != null) out.body = compactMarkerBody(e.body);
  } else if (e.type === 'performance') Object.assign(out, { durationMs: e.durationMs ?? null, name: e.name || null, thirdParty: e.thirdParty ?? null });
  else if (e.type === 'storage') Object.assign(out, { key: e.key || null, writes: e.writes || null, valueLength: e.valueLength || e.lastValueLength || null });
  else if (e.type === 'error') Object.assign(out, { message: e.message || null, reason: e.reason || null, resourceUrl: e.resourceUrl || null, likelyNonCriticalTracker: !!e.likelyNonCriticalTracker });
  else if (e.type === 'lifecycle') Object.assign(out, { kind: e.kind || null, from: e.from || null, to: e.to || null, visibilityState: e.visibilityState || null });
  return out;
}

async function attachRecentMarkerContext(event, tabId) {
  const recent = await getEvents(1000);
  const cutoff = (event.ts || Date.now()) - 90000;
  const context = recent.filter(e => e.tabId === tabId && e.ts >= cutoff && e.ts <= (event.ts || Date.now()) && e.type !== 'dom').slice(-50).map(compactContextEvent);
  return { ...event, pinned: true, recentContext: context };
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  if (settingsCachePromise) return settingsCachePromise;
  settingsCachePromise = chrome.storage.local.get(SETTINGS_KEY)
    .then(obj => {
      settingsCache = { ...DEFAULT_SETTINGS, ...(obj[SETTINGS_KEY] || {}) };
      return settingsCache;
    })
    .finally(() => { settingsCachePromise = null; });
  return settingsCachePromise;
}
async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.[SETTINGS_KEY]) return;
    const next = changes[SETTINGS_KEY].newValue || {};
    settingsCache = { ...DEFAULT_SETTINGS, ...next };
    settingsCachePromise = null;
  });
}

async function sendToActiveTab(command, payload = {}) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab.');
  return chrome.tabs.sendMessage(tab.id, { type: 'SCI_COMMAND', command, payload });
}

async function migrateSettingsFor004() {
  const state = await chrome.storage.local.get([SETTINGS_KEY, SETTINGS_MIGRATION_KEY]);
  if (state[SETTINGS_MIGRATION_KEY]) return;
  const stored = state[SETTINGS_KEY];
  if (stored && [15000, 25000, 50000].includes(Number(stored.maxEvents))) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...stored, maxEvents: 100000 }, [SETTINGS_MIGRATION_KEY]: true });
  } else {
    await chrome.storage.local.set({ [SETTINGS_MIGRATION_KEY]: true });
  }
}

chrome.runtime.onInstalled.addListener(() => { migrateExistingEvents().catch(() => {}); migrateExistingLorebookPrivacy().catch(() => {}); migrateExistingStateSnapshotPrivacy().catch(() => {}); migrateExistingDomTextPrivacy().catch(() => {}); migrateExistingNetworkPrivacy().catch(() => {}); migrateExistingRequestIdentifierPrivacy().catch(() => {}); migrateExistingNativeMemoryPrivacy().catch(() => {}); migrateSettingsFor004().catch(() => {}); });
migrateExistingEvents().catch(() => {});
migrateExistingLorebookPrivacy().catch(() => {});
migrateExistingStateSnapshotPrivacy().catch(() => {});
migrateExistingDomTextPrivacy().catch(() => {});
migrateExistingNetworkPrivacy().catch(() => {}); migrateExistingRequestIdentifierPrivacy().catch(() => {}); migrateExistingNativeMemoryPrivacy().catch(() => {});
migrateSettingsFor004().catch(() => {});


if (chrome.tabs?.onRemoved) chrome.tabs.onRemoved.addListener(tabId => { tabPageRoles.delete(tabId); });

async function prepareIncomingEvent(rawEvent, sender) {
  const tabId = sender.tab?.id ?? null;
  let event = {
    ...rawEvent,
    ts: rawEvent?.ts || Date.now(),
    pageId: rawEvent?.pageId || tabId || 'unknown',
    tabId,
    url: rawEvent?.url || sender.tab?.url || ''
  };
  event = applyDomMutationTextPrivacy(event).event;
  const explicitRole = event.pageRole || recommendationWorkerRoleFromUrl(event.href || event.pageUrl || event.url || sender.tab?.url);
  if (event.type === 'lifecycle' && event.subtype === 'page-start' && Number.isInteger(tabId)) {
    const prior = tabPageRoles.get(tabId);
    if (explicitRole) rememberTabPageRole(tabId, event.pageId, explicitRole);
    else if (prior && prior.pageId !== event.pageId) tabPageRoles.delete(tabId);
  } else if (event.pageRole && explicitRole && Number.isInteger(tabId)) {
    rememberTabPageRole(tabId, event.pageId, explicitRole);
  }
  const persistedRole = Number.isInteger(tabId) ? tabPageRoles.get(tabId) : null;
  if (!event.pageRole && persistedRole?.pageId === event.pageId) event.pageRole = persistedRole.role;
  if (event.type === 'marker' || event.type === 'marker-context') event = await attachRecentMarkerContext(event, tabId);
  if (event.type === 'driver') {
    if (isMirroredDriverDuplicate(event)) return null;
    if (!Number.isFinite(Number(event.driverTs))) rememberPrimaryDriverMarker(event);
  }
  return event;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'SCI_EVENT') {
      const event = await prepareIncomingEvent(message.event || {}, sender);
      if (!event) { sendResponse({ ok: true, dedupedDriverMirror: true }); return; }
      await addEvent(event);
      sendResponse({ ok: true }); return;
    }
    if (message?.type === 'SCI_EVENT_BATCH') {
      const prepared = [];
      for (const raw of (Array.isArray(message.events) ? message.events : []).slice(0, 250)) {
        const event = await prepareIncomingEvent(raw || {}, sender);
        if (event) prepared.push(event);
      }
      const stored = await addEvents(prepared);
      sendResponse({ ok: true, stored }); return;
    }
    if (message?.type === 'SCI_GET_SETTINGS') { sendResponse({ ok: true, settings: await getSettings() }); return; }
    if (message?.type === 'SCI_SET_SETTINGS') { sendResponse({ ok: true, settings: await setSettings(message.patch || {}) }); return; }
    if (message?.type === 'SCI_GET_EVENTS') { const events = await getEvents(message.limit || 2000); sendResponse({ ok: true, events, total: await getEventCount() }); return; }
    if (message?.type === 'SCI_CLEAR_EVENTS') { await clearEvents(); sendResponse({ ok: true }); return; }
    // Manual markers are retired. Retain legacy recorded markers for old exports.
    if (message?.type === 'SCI_MARK') { sendResponse({ ok: false, error: 'Manual markers have been retired.' }); return; }
    if (message?.type === 'SCI_ACTIVE_COMMAND') { sendResponse({ ok: true, result: await sendToActiveTab(message.command, message.payload) }); return; }
    if (message?.type === 'SCI_OPEN_INSPECTOR') { await chrome.tabs.create({ url: chrome.runtime.getURL('inspector.html') }); sendResponse({ ok: true }); return; }
    sendResponse({ ok: false, error: 'Unknown message.' });
  })().catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
