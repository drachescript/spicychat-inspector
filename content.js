(() => {
  const INSPECTOR_VERSION = (() => { try { return chrome.runtime.getManifest().version || 'unknown'; } catch (_) { return 'unknown'; } })();
  const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // Firefox Android supports recording, but browser Long Task/LoAF APIs may be missing.
  // Keep collection bounded even when a busy chat generates thousands of mutations/traces.
  const IS_FIREFOX_ANDROID = /Android/i.test(navigator.userAgent) && /(?:Firefox|Fennec)/i.test(navigator.userAgent);
  const MOBILE_TRACE_EVENTS_PER_SECOND = 18;
  const MOBILE_TRACE_BATCH_LIMIT = 48;
  let mobileTraceSecond = 0;
  let mobileTraceAccepted = 0;
  let mobileTraceDropped = 0;
  let mobileTraceReportedAt = Date.now();
  function initialPageRole() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('dsQolBotStatusWorker') === '1') return 'qol-bot-status-worker';
      if (u.searchParams.get('dsQolRecommendationWorker') === '1' || u.searchParams.get('dsQuickDislike') === '1') return 'qol-recommendation-worker';
    } catch (_) {}
    return null;
  }
  const PAGE_ROLE = initialPageRole();
  const BRIDGE_SOURCE = 'SPICYCHAT_INSPECTOR_BRIDGE';
  const TEST_DRIVER_SOURCE = 'SPICYCHAT_TEST_DRIVER';
  const TEST_DRIVER_STATUS_SOURCE = 'SPICYCHAT_INSPECTOR_STATUS';
  const QOL_SOURCE_RE = /(?:spicychat[\s._:-]*qol|ds[\s._:-]*qol|dragonscript[\s._:-]*spicychat[\s._:-]*qol)/i;
  const QOL_EVENT_NAMES = ['ds:qol:diagnostic', 'ds:qol:inspector', 'ds-qol-diagnostic', 'spicychat-qol-diagnostic', 'spicychat-qol-inspector', 'dragons-spicychat-qol:diagnostic'];
  const QOL_PROTOCOL_V1 = 'dragon-spicychat-qol-diagnostics-v1';
  const QOL_PROTOCOL_V2 = 'dragon-spicychat-qol-diagnostics-v2';
  const QOL_INSPECTOR_SOURCE = 'dragons-spicychat-diagnostic-extension';
  const QOL_REQUEST_EVENT = 'dragons-spicychat-diagnostic-extension:request';
  const INSPECTOR_SESSION_ID = `sci-${PAGE_ID}`;
  const IDLE_AFTER_MS = 60_000;
  let settings = null;
  let domObserver = null;
  let domQueue = [];
  let domSamplePatterns = new Set();
  const DOM_DETAIL_SAMPLE_CAP = 16;
  let domStats = makeDomStats();
  let domTimer = null;
  let perfObservers = [];
  const seenPerformanceEntries = {
    resource: new Set(),
    'long-task': new Set(),
    'long-animation-frame': new Set()
  };
  let navigationCaptured = false;
  let lastUserActivityAt = Date.now();
  let userIdle = false;
  let windowFocused = document.hasFocus();
  let idleTimer = null;
  let interactionCaptureInstalled = false;
  let errorCaptureInstalled = false;
  const recentQol = [];
  const activeQolOperations = new Map();
  const completedQolOperations = [];
  const completedQolOperationKeys = new Map();
  const qolTraceSequence = new Map();
  let latestQolHandshake = null;
  let qolPresenceTimer = null;
  const recentQolTelemetryFingerprints = new Map();
  const QOL_TELEMETRY_DEDUPE_MS = 250;
  const QOL_HEARTBEAT_DEDUPE_MS = 60_000;
  const PRESSURE_VISIBLE_MS = 120_000;
  const PRESSURE_HIDDEN_MS = 600_000;
  let pressureTimer = null;
  let lastPressureSampleAt = 0;
  let lastFullPressureSnapshot = null;
  let lastFullPressureAt = 0;
  let lastFullPressureRoute = '';
  const PRESSURE_SAMPLER_VERSION = 2;
  const GENERATION_PRESSURE_CACHE_MAX_AGE_MS = 12000;
  const GENERATION_RENDER_WINDOW_MS = 8_000;
  const GENERATION_FOLLOWUP_MAX_LATENESS_MS = 30_000;
  const pendingGenerationRenders = new Map();
  const hiddenGenerationFollowups = new Map();
  const recentLongTasks = [];
  // Lightweight input/scroll windows: collect frame gaps only while the user
  // actively scrolls, never page text, cursor position, or element selectors.
  let lastPhysicalInput = { ts: 0, kind: null };
  let lastScrollInputAt = 0;
  let activeScrollSample = null;
  const recentMessageDomChanges = [];
  let qolHandshakeRequests = 0;
  let qolTracesSeen = 0;
  let qolHandshakeResponses = 0;
  let qolLastTraceTs = 0;
  let qolTraceCheckSerial = 0;
  const QOL_TRACE_CHECK_DELAY_MS = 8_000;

  function interactionPerfContext(at = Date.now()) {
    const scroll = activeScrollSample;
    return {
      inputKind: at - lastPhysicalInput.ts >= -150 && at - lastPhysicalInput.ts <= 1500 ? lastPhysicalInput.kind : null,
      inputAgeMs: at - lastPhysicalInput.ts >= -150 && at - lastPhysicalInput.ts <= 1500 ? Math.max(0, at - lastPhysicalInput.ts) : null,
      scrollBurstId: scroll && at >= scroll.startTs - 250 && at <= scroll.lastTs + 2000 ? scroll.id : null,
      scrollTemporalOverlap: !!(scroll && at >= scroll.startTs - 250 && at <= scroll.lastTs + 2000)
    };
  }

  function finishScrollSample(reason = 'scroll-settled') {
    const s = activeScrollSample;
    if (!s) return;
    activeScrollSample = null;
    if (s.rafId) cancelAnimationFrame(s.rafId);
    if (s.settleTimer) clearTimeout(s.settleTimer);
    if (!settings?.recording || !settings?.capturePerformance || !s.scrollEvents) return;
    emit({ type:'performance', subtype:'scroll-performance-window', scrollBurstId:s.id,
      trigger:s.trigger, reason, humanInputCorrelated:true,
      durationMs:Math.round(Math.max(0, s.lastTs-s.startTs)), scrollEvents:s.scrollEvents,
      sampledFrames:s.frames, framesOver50Ms:s.over50, framesOver100Ms:s.over100,
      worstFrameGapMs:Math.round(s.worstGap*10)/10,
      estimatedMissedFrames:s.missed, nearbyLongTasks:s.longTasks,
      nearbyLongTaskMs:Math.round(s.longTaskMs*10)/10,
      // A scroll burst is a temporal correlation, not proof of causation.
      attribution:{source:'unknown-mixed',confidence:'temporal-correlation',reason:'Frame gaps and Long Tasks overlapped a human-input-correlated scroll window.'}
    });
  }

  function scrollFrameTick(now) {
    const s = activeScrollSample;
    if (!s) return;
    if (s.previousFrameAt) {
      const gap = Math.max(0, now-s.previousFrameAt);
      if (gap > s.worstGap) s.worstGap = gap;
      if (gap > 50) s.over50++;
      if (gap > 100) s.over100++;
      s.missed += Math.max(0, Math.min(120, Math.floor(gap / 16.7) - 1));
    }
    s.previousFrameAt = now;
    s.frames++;
    if (Date.now() - s.lastTs < 420 && s.frames < 300 && Date.now() - s.startTs < 5000 && !document.hidden) {
      s.rafId = requestAnimationFrame(scrollFrameTick);
    } else {
      s.rafId = 0;
      finishScrollSample('scroll-settled');
    }
  }

  function noteScrollActivity() {
    if (!settings?.recording || !settings?.capturePerformance || document.hidden || isQolWorkerPage()) return;
    const now=Date.now();
    // Scripted scrolls cannot be labeled human-caused without recent input.
    if (now - lastScrollInputAt > 750) return;
    let s=activeScrollSample;
    if (!s) {
      s={ id:`scroll-${now.toString(36)}`, startTs:now, lastTs:now,
        trigger:lastPhysicalInput.kind||'unknown', scrollEvents:0, frames:0,
        previousFrameAt:0, worstGap:0, over50:0, over100:0, missed:0,
        longTasks:0, longTaskMs:0, rafId:0, settleTimer:0 };
      activeScrollSample=s;
    }
    s.lastTs=now;
    s.scrollEvents++;
    if (!s.rafId) s.rafId=requestAnimationFrame(scrollFrameTick);
  }

  let lastAutoLagSpikeAt = 0;
  const AUTO_LAG_WINDOW_MS = 10_000;
  const AUTO_LAG_COOLDOWN_MS = 30_000;
  const RESOURCE_TIMING_BUFFER_SIZE = 2000;
  const RESOURCE_TIMING_PROACTIVE_CLEAR_AT = 1500;
  const RESOURCE_TIMING_BUFFER_REPEAT_GUARD_MS = 1_000;
  const STORY_MESSAGE_SELECTOR = 'div.flex-shrink-0.py-0.w-full';
  // Enter lightweight DOM capture before giant chats become pathological. The previous
  // 30k/1k thresholds were too late for the stress-test chat, where browser blocking was
  // already severe well below that point.
  const LARGE_DOM_ELEMENT_THRESHOLD = 20_000;
  const LARGE_DOM_MESSAGE_THRESHOLD = 500;
  const LARGE_DOM_HEAP_THRESHOLD_BYTES = 1_000_000_000;
  const LARGE_LIST_DOM_ELEMENT_THRESHOLD = 12_000;
  const LARGE_MUTATION_BATCH_THRESHOLD = 250;
  // A slow callback blocks the same thread as SpicyChat's renderer. Keep DOM
  // sampling bounded per callback; skipped records are reported as gaps, not 0s.
  const DOM_CALLBACK_MAX_RECORDS = IS_FIREFOX_ANDROID ? 80 : 120;
  const DOM_CALLBACK_BUDGET_MS = IS_FIREFOX_ANDROID ? 3 : 5;
  const DOM_FAST_MODE_HOLD_MS = 30_000;
  let lastKnownDomElements = 0;
  let lastKnownMountedMessages = 0;
  let lastKnownJsHeapUsedBytes = 0;
  let domFastModeUntil = 0;
  let domSlowObserverUntil = 0;
  let driverProbeCount = 0;
  let lastDriverProbeEmitAt = 0;
  let resourceTimingConfigured = false;
  let resourceTimingBufferFullListenerInstalled = false;
  let resourceTimingBufferFullOccurrences = 0;
  let resourceTimingBufferFullSuppressed = 0;
  let lastResourceTimingBufferFullHandledAt = 0;

  // Inspector self-overhead controls. Normal events are batched to reduce
  // content->service-worker IPC and IndexedDB transaction pressure.
  const EVENT_BATCH_MS = 100;
  const EVENT_BATCH_MAX = 40;
  const EVENT_QUEUE_HARD_LIMIT = 500;
  const SELF_THROTTLE_MS = 30_000;
  const DOM_HIGH_DETAIL_WINDOW_MS = 10_000;
  const HEARTBEAT_SUMMARY_MS = 5 * 60_000;
  const AGGREGATE_FLUSH_MS = 60_000;
  const NETWORK_PENDING_TIMEOUT_MS = 60_000;
  let eventQueue = [];
  let eventBatchTimer = null;
  let selfThrottleUntil = 0;
  let selfThrottleReason = null;
  let eventRateWindowStartedAt = Date.now();
  let eventRateCount = 0;
  let lastSelfThrottleNoticeAt = 0;
  let domHighDetailUntil = 0;
  let manualStateSnapshotUntil = 0;
  const pendingNetwork = new Map();
  const chatDraftBursts = new Map();
  const driverHeartbeatSummary = { scheduler: 0, probe: 0, firstAt: 0, lastAt: 0, lastRole: null, lastPageType: null };
  let driverHeartbeatTimer = null;
  const trackerErrorAggregates = new Map();
  let trackerErrorTimer = null;
  const resourceAggregates = new Map();
  let resourceAggregateTimer = null;
  const workerResourceAggregates = new Map();
  let workerResourceAggregateTimer = null;
  let resourceEntriesSinceClear = 0;
  let resourceTimingProactiveClears = 0;

  const PRIVATE_IDENTIFIER_KEY_RE = /^(?:x)?(?:guestuserid|guestid|userid|visitorid|deviceid|clientid|anonymousid|anonid|installationid|installid|fingerprintid)$/;
  function isPrivateIdentifierKey(k) { return PRIVATE_IDENTIFIER_KEY_RE.test(String(k || '').replace(/[-_]/g, '').toLowerCase()); }
  const PRIVATE_IDENTIFIER_VALUE_RE = /((?:[\"']?(?:x[-_])?(?:guest[-_]?user[-_]?id|guest[-_]?id|user[-_]?id|visitor[-_]?id|device[-_]?id|client[-_]?id|anon(?:ymous)?[-_]?id|install(?:ation)?[-_]?id|fingerprint[-_]?id)[\"']?)\s*[:=]\s*[\"']?)([A-Za-z0-9._~+/=-]+)/gi;
  const SECRET_KEY_RE = /(authorization|cookie|set-cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session|jwt|csrf|xsrf|api[_-]?key|client[_-]?secret|p?_?psid)/i;
  function isSecretKey(k) { return SECRET_KEY_RE.test(k) || isPrivateIdentifierKey(k); }
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
  const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
  const PSID_VALUE_RE = /\b(psid)([:=])([A-Za-z0-9_-]{8,})/gi;
  const URLENC_SECRET_RE = /(^|[?&])(refresh_token|access_token|id_token|token|password|client_secret|session|jwt|api_key|apikey|frontend_sign|p?_?psid)=([^&#]*)/gi;


// Query values and URL fragments can contain analytics IDs and page titles.
// Keep only bounded parameter names and explicit non-sensitive worker flags.
const INSPECTOR_SAFE_WORKER_QUERY = new Set([
  'dsQolRecommendationWorker','dsQolBotStatusWorker','dsQuickDislike',
  'dsQolLorebookClone','dsQolWorkerLight','dsListingRefill'
]);
function inspectorSafeUrl(value) {
  const source = String(value || '');
  if (!source || (!source.includes('?') && !source.includes('#') && !/^https?:\/\/[^/]+\/[^?#]*(?:[0-9a-f]{20,}|[0-9]{8,}|@)/i.test(source))) return source;
  try {
    const absolute = /^https?:\/\//i.test(source);
    const url = new URL(source, 'https://spicychat.ai');
    const query = [];
    const seen = new Set();
    for (const [name, originalValue] of url.searchParams) {
      if (query.length >= 24) break;
      const key = /^[a-z][a-z0-9_.-]{0,48}$/i.test(name) ? name : 'parameter';
      if (seen.has(key)) continue;
      seen.add(key);
      const safeValue = INSPECTOR_SAFE_WORKER_QUERY.has(key) && /^[01]$/.test(originalValue)
        ? originalValue : '[REDACTED]';
      query.push(`${key}=${safeValue}`);
    }
    let path = url.pathname;
    if (absolute && !/(?:^|\.)(?:spicychat\.ai|nd-api\.com)$/i.test(url.hostname)) {
      path = path.split('/').map(segment => /^(?:[0-9a-f]{20,}|[0-9]{8,}|[^/]+@[^/]+)$/i.test(segment) ? ':id' : segment).join('/');
    }
    const prefix = absolute ? url.origin + path : source.startsWith('?') ? '' : path;
    return prefix + (query.length ? '?' + query.join('&') : url.search ? '?[REDACTED]' : '')
      + (url.hash ? '#[REDACTED_FRAGMENT]' : '');
  } catch (_) { return source.split(/[?#]/, 1)[0] + (source.includes('?') ? '?[REDACTED]' : '') + (source.includes('#') ? '#[REDACTED_FRAGMENT]' : ''); }
}
function inspectorRedactUrlsInText(value) {
  if (typeof value !== 'string') return value;
  // Trailing punctuation is not part of a URL in a diagnostic error message.
  const safe = value.replace(/https?:\/\/[^\s<>'"\\]+/gi, raw => {
    const match = /([),.;}]+)$/.exec(raw);
    const suffix = match ? match[1] : '';
    return inspectorSafeUrl(suffix ? raw.slice(0, -suffix.length) : raw) + suffix;
  });
  return /^[/?#]/.test(safe) && (safe.includes('?') || safe.includes('#'))
    ? inspectorSafeUrl(safe) : safe;
}

  function redactString(s) {
    if (typeof s !== 'string') return s;
    return inspectorRedactUrlsInText(s.replace(JWT_RE, '[REDACTED_JWT]').replace(BEARER_RE, 'Bearer [REDACTED]').replace(URLENC_SECRET_RE, (m, p, k) => `${p}${k}=[REDACTED]`).replace(PSID_VALUE_RE, (m, key, sep) => `${key}${sep}[REDACTED]`).replace(PRIVATE_IDENTIFIER_VALUE_RE, (m, prefix) => `${prefix}[REDACTED]`));
  }

  function isSpicyChatCoreHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'spicychat.ai' || h.endsWith('.spicychat.ai') || h === 'nd-api.com' || h.endsWith('.nd-api.com');
  }
  function isLikelyNonCriticalTracker(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return /(?:cloudflareinsights|tapfiliate|googletagmanager|google-analytics|facebook|trackjs|announcekit|logr-ingest)/i.test(h);
    } catch (_) { return false; }
  }

  function sanitize(value, depth = 0) {
    if (depth > 9) return '[MAX_DEPTH]';
    if (value == null || ['number','boolean'].includes(typeof value)) return value;
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.slice(0, 600).map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 1200)) out[k] = isSecretKey(k) ? '[REDACTED]' : (/^(?:locationHash|urlHash|fragment)$/i.test(k) || (k==='hash' && typeof v==='string' && v.startsWith('#'))) ? '[REDACTED_FRAGMENT]' : /^(?:search|queryString)$/i.test(k) && typeof v === 'string' ? inspectorSafeUrl(v) : sanitize(v, depth + 1);
      return out;
    }
    return String(value);
  }

  const QOL_PRIVATE_FIELD_RE = /^(?:content|keywords|chatText|messageText|message|prompt|personaText|personaDescription|oocText|definition|scenario|exampleDialogue|requestBody|responseBody|rawBody|html|fullText)$/i;
  function traceFingerprint(value) {
    let text = '';
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch (_) { text = String(value ?? ''); }
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
  function privateTraceSummary(value) {
    let text = '';
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch (_) { text = String(value ?? ''); }
    const out = { redacted: true, chars: text.length, fingerprint: traceFingerprint(value) };
    if (Array.isArray(value)) out.count = value.length;
    return out;
  }
  function sanitizeQolTrace(value, depth = 0) {
    if (depth > 7) return '[MAX_DEPTH]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value).slice(0, 2000);
    if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitizeQolTrace(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 400)) {
        if (isSecretKey(k)) out[k] = '[REDACTED]';
        else if (QOL_PRIVATE_FIELD_RE.test(k)) out[k] = privateTraceSummary(v);
        else out[k] = sanitizeQolTrace(v, depth + 1);
      }
      return out;
    }
    return String(value).slice(0, 500);
  }
  function storageEntrySummary(key, value) {
    let text = '';
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch (_) { text = String(value ?? ''); }
    return {
      key: String(key || '').slice(0, 240),
      chars: text.length,
      approxBytes: text.length * 2,
      type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      fingerprint: traceFingerprint(value)
    };
  }

  function summarizeStorageObject(value, includeSafeValues = false) {
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
    const safeValues = {};
    const safeKeyRe = /^(?:isPartner_|avatar_generator_model_|chat_language$|auto_memory_enabled$|iconify-count$)/i;
    for (const [key, item] of Object.entries(objectValue)) {
      const row = storageEntrySummary(key, item);
      totalApproxBytes += row.approxBytes;
      rows.push(row);
      if (includeSafeValues && safeKeyRe.test(key) && row.chars <= 120 && (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number')) {
        safeValues[String(key).slice(0, 240)] = item;
      }
    }
    rows.sort((a,b) => b.approxBytes - a.approxBytes);
    const out = {
      keyCount: rows.length,
      totalApproxBytes,
      largestKeys: rows.slice(0, 20),
      keyMetadata: rows.slice(0, 120)
    };
    if (includeSafeValues && Object.keys(safeValues).length) out.manualSafeValues = safeValues;
    return out;
  }

  function summarizeWebStorage(storage, includeSafeValues = false) {
    const rows = [];
    const safeValues = {};
    let totalApproxBytes = 0;
    const safeKeyRe = /^(?:isPartner_|avatar_generator_model_|chat_language$|auto_memory_enabled$|iconify-count$)/i;
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key == null) continue;
        let value = '';
        try { value = storage.getItem(key) ?? ''; } catch (_) { value = ''; }
        const row = storageEntrySummary(key, value);
        totalApproxBytes += row.approxBytes;
        rows.push(row);
        if (includeSafeValues && safeKeyRe.test(key) && row.chars <= 120) safeValues[String(key).slice(0, 240)] = value;
      }
    } catch (_) {}
    rows.sort((a,b) => b.approxBytes - a.approxBytes);
    const out = {
      keyCount: rows.length,
      totalApproxBytes,
      largestKeys: rows.slice(0, 20),
      keyMetadata: rows.slice(0, 120)
    };
    if (includeSafeValues && Object.keys(safeValues).length) out.manualSafeValues = safeValues;
    return out;
  }

  async function captureLightweightStateSnapshot(reason = 'automatic', pinned = false, manual = false) {
    const locationInfo = {
      href: redactString(location.href),
      origin: location.origin,
      pathname: location.pathname,
      search: redactString(location.search),
      hash: redactString(location.hash)
    };
    let indexedDbDatabases = [];
    try {
      if (indexedDB?.databases) {
        const dbs = await indexedDB.databases();
        indexedDbDatabases = (dbs || []).slice(0, 80).map(x => ({ name: String(x?.name || '').slice(0, 160), version: Number(x?.version) || null }));
      }
    } catch (_) {}
    emit({
      type: 'state', subtype: 'snapshot', pinned, reason,
      location: locationInfo,
      pageStorage: {
        local: summarizeWebStorage(localStorage, manual),
        transient: summarizeWebStorage(sessionStorage, manual),
        rawValuesCaptured: false,
        manualSafeAllowlistUsed: manual
      },
      documentState: {
        title: document.title,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        focused: document.hasFocus(),
        historyLength: history.length
      },
      indexedDbDatabases,
      qolIdentity: passiveQolIdentity()
    });
  }

  function privacySafeStateSnapshot(event) {
    if (!event || event.type !== 'state') return event;
    const manual = Date.now() <= manualStateSnapshotUntil;
    if (manual) manualStateSnapshotUntil = 0;
    const out = { ...event };
    out.pageStorage = {
      local: summarizeStorageObject(event.localStorage, manual),
      transient: summarizeStorageObject(event.sessionStorage, manual),
      rawValuesCaptured: false,
      manualSafeAllowlistUsed: manual
    };
    delete out.localStorage;
    delete out.sessionStorage;
    if (out.globals && typeof out.globals === 'object') {
      const globals = {};
      for (const [key, value] of Object.entries(out.globals).slice(0, 80)) {
        globals[String(key).slice(0, 160)] = storageEntrySummary(key, value);
      }
      out.globals = globals;
    }
    return out;
  }

  function isCriticalInspectorEvent(event) {
    if (!event) return false;
    if (event.pinned === true || event.type === 'marker' || event.type === 'marker-context') return true;
    if (event.type === 'error' && event.likelyNonCriticalTracker !== true) return true;
    if (event.type === 'lifecycle' && /^(page-hide|page-freeze|network-offline)$/.test(event.subtype || '')) return true;
    if (event.type === 'performance' && event.subtype === 'long-task' && Number(event.durationMs) >= 1000) return true;
    if (event.type === 'performance' && event.subtype === 'long-animation-frame' && Number(event.blockingDurationMs || event.durationMs) >= 1000) return true;
    if (event.type === 'performance' && event.subtype === 'inspector-self-throttle') return true;
    if (event.type === 'performance' && ['generation-dom-match-result','qol-trace-link-status','qol-trace-capture-config'].includes(event.subtype)) return true;
    if (event.type === 'network' && (Number(event.status) >= 400 || Number(event.status) === 0 || /error|incomplete$/.test(event.subtype || ''))) return true;
    return false;
  }

  function directSend(payload) {
    try { return chrome.runtime.sendMessage({ type: 'SCI_EVENT', event: payload }).catch(() => {}); } catch (_) { return null; }
  }

  function flushEventQueue() {
    if (eventBatchTimer) { clearTimeout(eventBatchTimer); eventBatchTimer = null; }
    if (!eventQueue.length) return;
    const batch = eventQueue.splice(0, EVENT_BATCH_MAX * 4);
    try { chrome.runtime.sendMessage({ type: 'SCI_EVENT_BATCH', events: batch }).catch(() => {}); } catch (_) {}
    if (eventQueue.length) eventBatchTimer = setTimeout(flushEventQueue, 0);
  }

  function activateSelfThrottle(reason, extra = {}) {
    const now = Date.now();
    selfThrottleUntil = Math.max(selfThrottleUntil, now + SELF_THROTTLE_MS);
    selfThrottleReason = reason;
    domHighDetailUntil = 0;
    domFastModeUntil = Math.max(domFastModeUntil, selfThrottleUntil);
    if (now - lastSelfThrottleNoticeAt < 10_000) return;
    lastSelfThrottleNoticeAt = now;
    const pageUrl = redactString(location.href);
    directSend(sanitize({
      type: 'performance', subtype: 'inspector-self-throttle', ts: now, pageId: PAGE_ID, pageUrl, url: pageUrl,
      reason, durationMs: SELF_THROTTLE_MS, queuedEvents: eventQueue.length, ...extra,
      interaction: interactionState(), ...(PAGE_ROLE ? { pageRole: PAGE_ROLE } : {})
    }));
  }

  function noteInspectorEventRate() {
    const now = Date.now();
    if (now - eventRateWindowStartedAt >= 1000) {
      eventRateWindowStartedAt = now;
      eventRateCount = 0;
    }
    eventRateCount++;
    if (eventRateCount > 50) activateSelfThrottle('event-rate', { eventsThisSecond: eventRateCount });
    if (eventQueue.length > EVENT_QUEUE_HARD_LIMIT) activateSelfThrottle('event-queue', { queueLength: eventQueue.length });
  }

  function queuePayload(payload) {
    noteInspectorEventRate();
    if (isCriticalInspectorEvent(payload)) {
      flushEventQueue();
      directSend(payload);
      return;
    }
    eventQueue.push(payload);
    if (eventQueue.length >= EVENT_BATCH_MAX) {
      flushEventQueue();
      return;
    }
    if (!eventBatchTimer) eventBatchTimer = setTimeout(flushEventQueue, EVENT_BATCH_MS);
  }

  function emit(event) {
    if (!settings?.recording && event.type !== 'marker' && event.type !== 'marker-context' && event.pinned !== true) return;
    try {
      const pageUrl = redactString(location.href);
      const prepared = privacySafeStateSnapshot(event);
      const payload = { ...prepared, ts: prepared.ts || Date.now(), pageId: PAGE_ID, pageUrl, ...(PAGE_ROLE ? { pageRole: PAGE_ROLE } : {}) };
      if (!payload.url) payload.url = pageUrl;
      queuePayload(sanitize(payload));
    } catch (_) {}
  }

  function currentHighDetailDomMode() {
    return Date.now() < domHighDetailUntil && Date.now() >= selfThrottleUntil;
  }

  function enableHighDetailDom(reason = 'diagnostic-window') {
    domHighDetailUntil = Math.max(domHighDetailUntil, Date.now() + DOM_HIGH_DETAIL_WINDOW_MS);
    return reason;
  }

  function storageValueMetadata(event) {
    if (!event || event.type !== 'storage') return event;
    const out = { ...event };
    if ('value' in out) {
      const row = storageEntrySummary(out.key || '', out.value);
      out.valueLength = Number.isFinite(Number(out.valueLength)) ? Number(out.valueLength) : row.chars;
      out.valueFingerprint = row.fingerprint;
      delete out.value;
    }
    return out;
  }

  function flushChatDraftBurst(key) {
    const state = chatDraftBursts.get(key);
    if (!state) return;
    chatDraftBursts.delete(key);
    clearTimeout(state.timer);
    emit({
      type: 'storage', subtype: 'chatDraft-write-burst', storage: state.storage || 'localStorage',
      key: state.key, writes: state.writes, firstAt: state.firstAt, lastAt: state.lastAt,
      durationMs: Math.max(0, state.lastAt - state.firstAt),
      avgIntervalMs: state.writes > 1 ? Math.round(((state.lastAt - state.firstAt) / (state.writes - 1)) * 10) / 10 : 0,
      maxValueLength: state.maxValueLength, lastValueLength: state.lastValueLength,
      unchangedWrites: state.unchangedWrites, lastValueFingerprint: state.lastFingerprint,
      privacyNote: 'Draft values omitted; only size/fingerprint/count metadata retained.'
    });
  }

  function handleStorageEvent(event) {
    if (!event || event.type !== 'storage') return false;
    const safe = storageValueMetadata(event);
    const key = String(safe.key || '');
    const subtype = String(safe.subtype || '');
    if (/^chatDraft:/i.test(key)) {
      if (/write-burst$/i.test(subtype)) return true; // Inspector creates the canonical draft burst summary below.
      if (/-(?:set|write)$/i.test(subtype)) {
        const now = Number(safe.ts) || Date.now();
        let state = chatDraftBursts.get(key);
        if (!state) {
          state = {
            key, storage: safe.storage || (subtype.startsWith('session') ? 'sessionStorage' : 'localStorage'),
            writes: 0, firstAt: now, lastAt: now, maxValueLength: 0, lastValueLength: 0,
            unchangedWrites: 0, lastFingerprint: null, timer: null
          };
          chatDraftBursts.set(key, state);
          emit({
            type: 'storage', subtype: 'chatDraft-burst-start', storage: state.storage, key,
            valueLength: safe.valueLength || 0, valueFingerprint: safe.valueFingerprint || null,
            privacyNote: 'Draft value omitted.'
          });
        }
        state.writes++;
        state.lastAt = now;
        state.lastValueLength = Number(safe.valueLength || safe.lastValueLength || 0);
        state.maxValueLength = Math.max(state.maxValueLength, state.lastValueLength);
        if (state.lastFingerprint && safe.valueFingerprint && state.lastFingerprint === safe.valueFingerprint) state.unchangedWrites++;
        state.lastFingerprint = safe.valueFingerprint || state.lastFingerprint;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => flushChatDraftBurst(key), 2000);
        return true;
      }
      if (/remove|clear/i.test(subtype)) flushChatDraftBurst(key);
      emit(safe);
      return true;
    }
    emit(safe);
    return true;
  }

  function flushDriverHeartbeatSummary() {
    if (driverHeartbeatTimer) { clearTimeout(driverHeartbeatTimer); driverHeartbeatTimer = null; }
    if (!driverHeartbeatSummary.scheduler && !driverHeartbeatSummary.probe) return;
    emit({
      type: 'driver', subtype: 'heartbeat-summary', phase: 'heartbeat',
      schedulerHeartbeats: driverHeartbeatSummary.scheduler,
      inspectorProbeHeartbeats: driverHeartbeatSummary.probe,
      firstAt: driverHeartbeatSummary.firstAt || null,
      lastAt: driverHeartbeatSummary.lastAt || null,
      role: driverHeartbeatSummary.lastRole,
      driverPageType: driverHeartbeatSummary.lastPageType,
      recording: !!settings?.recording
    });
    driverHeartbeatSummary.scheduler = 0;
    driverHeartbeatSummary.probe = 0;
    driverHeartbeatSummary.firstAt = 0;
    driverHeartbeatSummary.lastAt = 0;
    driverHeartbeatSummary.lastRole = null;
    driverHeartbeatSummary.lastPageType = null;
  }

  function noteDriverHeartbeat(kind, marker = {}) {
    const now = Date.now();
    if (!driverHeartbeatSummary.firstAt) driverHeartbeatSummary.firstAt = now;
    driverHeartbeatSummary.lastAt = now;
    if (kind === 'scheduler') driverHeartbeatSummary.scheduler++;
    else driverHeartbeatSummary.probe++;
    if (marker.role) driverHeartbeatSummary.lastRole = String(marker.role).slice(0, 40);
    if (marker.pageType) driverHeartbeatSummary.lastPageType = String(marker.pageType).slice(0, 120);
    if (!driverHeartbeatTimer) driverHeartbeatTimer = setTimeout(flushDriverHeartbeatSummary, HEARTBEAT_SUMMARY_MS);
  }

  function trackerAggregateKey(src, tag) {
    try {
      const u = new URL(src, location.href);
      return `${u.hostname}|${tag || ''}`;
    } catch (_) { return `${String(src || '').slice(0, 240)}|${tag || ''}`; }
  }

  function flushTrackerErrors() {
    if (trackerErrorTimer) { clearTimeout(trackerErrorTimer); trackerErrorTimer = null; }
    for (const aggregate of trackerErrorAggregates.values()) {
      emit({
        type: 'error', subtype: 'resource-error-summary', likelyNonCriticalTracker: true, thirdParty: true,
        trackerHost: aggregate.host, tag: aggregate.tag, occurrences: aggregate.count,
        firstAt: aggregate.firstAt, lastAt: aggregate.lastAt, sampleResourceUrl: aggregate.sampleResourceUrl,
        interaction: interactionState()
      });
    }
    trackerErrorAggregates.clear();
  }

  function aggregateTrackerError(src, tag) {
    const now = Date.now();
    const key = trackerAggregateKey(src, tag);
    let host = '';
    try { host = new URL(src, location.href).hostname; } catch (_) {}
    const x = trackerErrorAggregates.get(key) || { host, tag: tag || null, count: 0, firstAt: now, lastAt: now, sampleResourceUrl: redactString(src).slice(0, 500) };
    x.count++;
    x.lastAt = now;
    trackerErrorAggregates.set(key, x);
    if (!trackerErrorTimer) trackerErrorTimer = setTimeout(flushTrackerErrors, AGGREGATE_FLUSH_MS);
  }

  function resourceAggregateKey(entry) {
    let host = 'unknown';
    try { host = new URL(entry.name, location.href).hostname; } catch (_) {}
    return `${host}|${entry.initiatorType || 'other'}`;
  }

  function quantile(values, p) {
    if (!values?.length) return 0;
    const a = values.slice().sort((x, y) => x - y);
    const i = Math.min(a.length - 1, Math.max(0, Math.ceil((a.length - 1) * p)));
    return a[i];
  }

  function normalizeWorkerEndpoint(name) {
    try {
      const u = new URL(name, location.href);
      let path = u.pathname
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, ':id')
        .replace(/\/\d{4,}(?=\/|$)/g, '/:n');
      return `${u.hostname}${path}`.slice(0, 300);
    } catch (_) { return String(name || '').slice(0, 300); }
  }

  function workerResourceGroup(entry) {
    if (!isQolWorkerPage()) return null;
    return { workerRole: PAGE_ROLE, endpointGroup: normalizeWorkerEndpoint(entry.name), initiatorType: entry.initiatorType || null };
  }

  function flushWorkerResourceAggregates() {
    if (workerResourceAggregateTimer) { clearTimeout(workerResourceAggregateTimer); workerResourceAggregateTimer = null; }
    for (const x of workerResourceAggregates.values()) {
      const ds = x.durations || [];
      emit({
        type: 'performance', subtype: 'worker-resource-summary', workerRole: x.workerRole,
        endpointGroup: x.endpointGroup, initiatorType: x.initiatorType, requests: x.requests,
        totalDurationMs: Math.round(x.totalDurationMs * 10) / 10,
        avgDurationMs: x.requests ? Math.round((x.totalDurationMs / x.requests) * 10) / 10 : 0,
        medianDurationMs: ds.length ? Math.round(quantile(ds, 0.5) * 10) / 10 : 0,
        p95DurationMs: ds.length ? Math.round(quantile(ds, 0.95) * 10) / 10 : 0,
        maxDurationMs: Math.round(x.maxDurationMs * 10) / 10,
        over500ms: x.over500ms, over1000ms: x.over1000ms,
        totalTransferSize: x.totalTransferSize, firstAt: x.firstAt, lastAt: x.lastAt,
        firstSample: x.firstSample, lastSample: x.lastSample
      });
    }
    workerResourceAggregates.clear();
  }

  function aggregateWorkerResource(entry, group) {
    const now = Date.now();
    const key = `${group.workerRole}|${group.endpointGroup}|${group.initiatorType || 'other'}`;
    const duration = Number(entry.duration || 0);
    const sample = { durationMs: Math.round(duration * 10) / 10, transferSize: Number(entry.transferSize || 0) };
    const x = workerResourceAggregates.get(key) || {
      workerRole: group.workerRole, endpointGroup: group.endpointGroup, initiatorType: group.initiatorType,
      requests: 0, totalDurationMs: 0, maxDurationMs: 0, totalTransferSize: 0,
      over500ms: 0, over1000ms: 0, durations: [], firstAt: now, lastAt: now,
      firstSample: sample, lastSample: sample
    };
    x.requests++;
    x.totalDurationMs += duration;
    x.maxDurationMs = Math.max(x.maxDurationMs, duration);
    x.totalTransferSize += Number(entry.transferSize || 0);
    if (duration >= 500) x.over500ms++;
    if (duration >= 1000) x.over1000ms++;
    if (x.durations.length < 2048) x.durations.push(duration);
    x.lastAt = now;
    x.lastSample = sample;
    workerResourceAggregates.set(key, x);
    if (!workerResourceAggregateTimer) workerResourceAggregateTimer = setTimeout(flushWorkerResourceAggregates, AGGREGATE_FLUSH_MS);
  }

  function flushResourceAggregates() {
    if (resourceAggregateTimer) { clearTimeout(resourceAggregateTimer); resourceAggregateTimer = null; }
    for (const x of resourceAggregates.values()) {
      emit({
        type: 'performance', subtype: 'resource-summary', thirdParty: true,
        host: x.host, initiatorType: x.initiatorType, requests: x.requests,
        totalDurationMs: Math.round(x.totalDurationMs * 10) / 10,
        maxDurationMs: Math.round(x.maxDurationMs * 10) / 10,
        totalTransferSize: x.totalTransferSize, firstAt: x.firstAt, lastAt: x.lastAt
      });
    }
    resourceAggregates.clear();
  }

  function aggregateResource(entry) {
    const now = Date.now();
    const key = resourceAggregateKey(entry);
    let host = 'unknown';
    try { host = new URL(entry.name, location.href).hostname; } catch (_) {}
    const x = resourceAggregates.get(key) || { host, initiatorType: entry.initiatorType || null, requests: 0, totalDurationMs: 0, maxDurationMs: 0, totalTransferSize: 0, firstAt: now, lastAt: now };
    x.requests++;
    x.totalDurationMs += Number(entry.duration || 0);
    x.maxDurationMs = Math.max(x.maxDurationMs, Number(entry.duration || 0));
    x.totalTransferSize += Number(entry.transferSize || 0);
    x.lastAt = now;
    resourceAggregates.set(key, x);
    if (!resourceAggregateTimer) resourceAggregateTimer = setTimeout(flushResourceAggregates, AGGREGATE_FLUSH_MS);
  }

  function importantResourceTiming(entry, thirdParty) {
    const duration = Number(entry.duration || 0);
    const transfer = Number(entry.transferSize || 0);
    let path = '';
    try { path = new URL(entry.name, location.href).pathname; } catch (_) {}
    const diagnosticallyImportant = /\/(?:chat|queue|cms\/banners|characters|conversations|users\/settings|oauth2\/token)(?:\/|$)/i.test(path);
    const nearLag = recentLongTasks.some(x => Date.now() - x.ts <= 1500);
    const generationWindow = pendingGenerationRenders.size > 0;
    if (diagnosticallyImportant || nearLag || generationWindow) return true;
    if (thirdParty) return duration >= 500 || transfer >= 100_000;
    return duration >= 250 || transfer >= 50_000;
  }

  function maybeProactiveClearResourceTimings() {
    resourceEntriesSinceClear++;
    if (resourceEntriesSinceClear < RESOURCE_TIMING_PROACTIVE_CLEAR_AT) return;
    resourceEntriesSinceClear = 0;
    try {
      if (typeof performance.clearResourceTimings === 'function') {
        performance.clearResourceTimings();
        resourceTimingProactiveClears++;
        emit({
          type: 'performance', subtype: 'resource-timing-maintenance', reason: 'proactive-clear',
          configuredSize: RESOURCE_TIMING_BUFFER_SIZE, threshold: RESOURCE_TIMING_PROACTIVE_CLEAR_AT,
          proactiveClears: resourceTimingProactiveClears, interaction: interactionState()
        });
      }
    } catch (_) {}
  }

  function emitIncompleteNetwork(requestId, reason = 'timeout') {
    const pending = pendingNetwork.get(requestId);
    if (!pending) return;
    pendingNetwork.delete(requestId);
    clearTimeout(pending.timer);
    const req = pending.event;
    const out = {
      ...req, subtype: String(req.subtype || '').replace(/request$/, 'incomplete'),
      requestBody: req.body, requestHeaders: req.headers,
      status: 0, ok: false, durationMs: Math.max(0, Date.now() - Number(req.ts || Date.now())),
      requestCombined: true, incompleteReason: reason
    };
    delete out.body;
    delete out.headers;
    emit(out);
  }

  function handleBridgeNetworkEvent(event) {
    if (!event || event.type !== 'network') return false;
    const subtype = String(event.subtype || '');
    const requestId = event.requestId || null;
    if (/request$/.test(subtype) && requestId) {
      const prior = pendingNetwork.get(requestId);
      if (prior) clearTimeout(prior.timer);
      const timer = setTimeout(() => emitIncompleteNetwork(requestId, 'timeout'), NETWORK_PENDING_TIMEOUT_MS);
      pendingNetwork.set(requestId, { event, timer });
      return true;
    }
    if (/(?:response|error)$/.test(subtype) && requestId) {
      const pending = pendingNetwork.get(requestId);
      if (pending) {
        pendingNetwork.delete(requestId);
        clearTimeout(pending.timer);
        const req = pending.event;
        const combined = {
          ...req,
          ...event,
          body: event.body,
          headers: event.headers,
          requestBody: req.body,
          requestHeaders: req.headers,
          requestStartedAt: req.ts || null,
          requestCombined: true,
          requestFingerprint: event.requestFingerprint || req.requestFingerprint || null,
          initiator: event.initiator || req.initiator || null
        };
        emit(combined);
      } else {
        emit(event);
      }
      return true;
    }
    emit(event);
    return true;
  }

  function flushTransientAggregates(reason = 'flush') {
    for (const key of [...chatDraftBursts.keys()]) flushChatDraftBurst(key);
    flushDriverHeartbeatSummary();
    flushTrackerErrors();
    flushResourceAggregates();
    flushWorkerResourceAggregates();
    for (const requestId of [...pendingNetwork.keys()]) emitIncompleteNetwork(requestId, reason);
    flushEventQueue();
  }

  function injectBridge() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('bridge.js');
    script.dataset.sciPageId = PAGE_ID;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.onload = () => script.remove();
  }

  function connectionState() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    return {
      online: navigator.onLine !== false,
      effectiveType: c?.effectiveType || null,
      downlinkMbps: Number.isFinite(c?.downlink) ? c.downlink : null,
      rttMs: Number.isFinite(c?.rtt) ? c.rtt : null,
      saveData: typeof c?.saveData === 'boolean' ? c.saveData : null
    };
  }

  function interactionState() {
    return {
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      windowFocused,
      documentHasFocus: document.hasFocus(),
      userIdle,
      idleForMs: Math.max(0, Date.now() - lastUserActivityAt),
      connectivity: connectionState()
    };
  }

  function noteActivity(kind) {
    const now = Date.now();
    lastUserActivityAt = now;
    if (userIdle) {
      userIdle = false;
      emit({ type: 'lifecycle', subtype: 'user-active', activityKind: kind || null, interaction: interactionState() });
    }
  }

  function installInteractionCapture() {
    if (interactionCaptureInstalled) return;
    interactionCaptureInstalled = true;

    // Only direct human-input signals count as activity. A plain `scroll` event can
    // be generated programmatically by the page, so wheel/touch/pointer/keyboard/input
    // are safer for idle attribution.
    const activeEvents = ['pointerdown', 'keydown', 'input', 'touchstart', 'wheel'];
    for (const name of activeEvents) window.addEventListener(name, e => {
      noteActivity(name);
      lastPhysicalInput = { ts:Date.now(), kind:name };
      if (name === 'wheel' || name === 'touchstart' || (name === 'keydown' && /^(?:ArrowUp|ArrowDown|PageUp|PageDown|Home|End|Space| )$/.test(String(e.key || '')))) lastScrollInputAt = Date.now();
    }, { capture: true, passive: true });
    window.addEventListener('touchmove', () => { if (Date.now()-lastPhysicalInput.ts < 3000) lastScrollInputAt=Date.now(); }, { capture:true, passive:true });
    window.addEventListener('scroll', noteScrollActivity, { capture:true, passive:true });

    // Do not register focus/blur in capture phase. Descendant controls fire focus
    // and blur too; catching those at window level made ordinary input focus look
    // like whole-window focus changes and reset the idle timer.
    window.addEventListener('focus', e => {
      if (e.target !== window) return;
      windowFocused = true;
      noteActivity('window-focus');
      emit({ type: 'lifecycle', subtype: 'window-focus', interaction: interactionState() });
    }, false);
    window.addEventListener('blur', e => {
      if (e.target !== window) return;
      windowFocused = false;
      emit({ type: 'lifecycle', subtype: 'window-blur', interaction: interactionState() });
    }, false);

    document.addEventListener('visibilitychange', () => {
      windowFocused = document.hasFocus();
      emit({ type: 'lifecycle', subtype: 'visibility-change', visibilityState: document.visibilityState, interaction: interactionState() });
    }, true);

    // Page Lifecycle API signals help distinguish a genuinely idle page from a tab
    // that Chrome froze, restored from BFCache, or discarded/reloaded.
    window.addEventListener('pageshow', e => {
      emit({ type: 'lifecycle', subtype: 'page-show', persisted: !!e.persisted, wasDiscarded: !!document.wasDiscarded, interaction: interactionState() });
      setTimeout(() => samplePagePressure('page-show'), 250);
    });
    window.addEventListener('pagehide', e => {
      finalizeAbandonedGenerationWindows('page-hidden-before-dom-check');
      emit({ type: 'lifecycle', subtype: 'page-hide', persisted: !!e.persisted, interaction: interactionState() });
      flushTransientAggregates('pagehide');
    });
    document.addEventListener('freeze', () => {
      finalizeAbandonedGenerationWindows('page-frozen-before-dom-check');
      emit({ type: 'lifecycle', subtype: 'page-freeze', interaction: interactionState() });
      flushTransientAggregates('freeze');
    });
    document.addEventListener('resume', () => {
      emit({ type: 'lifecycle', subtype: 'page-resume', interaction: interactionState() });
      setTimeout(() => samplePagePressure('resume'), 250);
    });

    // Explicit connectivity lifecycle events make short internet outages visible even
    // when no API request happens to be in flight at the time. navigator.onLine is
    // only a browser connectivity hint, so the Inspector keeps this separate from
    // actual request success/failure evidence.
    window.addEventListener('offline', () => {
      emit({ type: 'lifecycle', subtype: 'network-offline', connectivity: connectionState(), interaction: interactionState() });
    });
    window.addEventListener('online', () => {
      emit({ type: 'lifecycle', subtype: 'network-online', connectivity: connectionState(), interaction: interactionState() });
    });
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    connection?.addEventListener?.('change', () => {
      emit({ type: 'lifecycle', subtype: 'network-connection-change', connectivity: connectionState(), interaction: interactionState() });
    });

    idleTimer = setInterval(() => {
      if (!userIdle && Date.now() - lastUserActivityAt >= IDLE_AFTER_MS) {
        userIdle = true;
        emit({ type: 'lifecycle', subtype: 'user-idle', idleThresholdMs: IDLE_AFTER_MS, interaction: interactionState() });
      }
    }, 10_000);
  }

  function makeDomStats() {
    return {
      totalMutations: 0, detailedChanges: 0, qolRelated: 0, qolOwned: 0, noOp: 0,
      formattingSwapsCoalesced: 0, mobileSkippedMutationRecords: 0, mobileChildListOnly: IS_FIREFOX_ANDROID,
      budgetSkippedMutationRecords: 0, budgetExceededCallbacks: 0, recordLimitCallbacks: 0,
      messageNodesAdded: 0, messageNodesRemoved: 0, observerCallbacks: 0,
      inspectorObserverMs: 0, inspectorObserverWallMs: 0,
      observerTimingContaminatedCallbacks: 0, observerTimingContaminatedWallMs: 0,
      fastModeCallbacks: 0, fastModeMutations: 0, fastModeReasons: new Map(),
      maxObserverCallbackMs: 0, observerCallbacksOver16ms: 0, observerCallbacksOver50ms: 0,
      patterns: new Map(), targets: new Map()
    };
  }
  function isLargeDomPressure() {
    return lastKnownDomElements >= LARGE_DOM_ELEMENT_THRESHOLD ||
      lastKnownMountedMessages >= LARGE_DOM_MESSAGE_THRESHOLD ||
      lastKnownJsHeapUsedBytes >= LARGE_DOM_HEAP_THRESHOLD_BYTES;
  }
  function isChatsRoute() { return /^\/chats(?:\/|$)/.test(location.pathname); }
  function domFastModeReason(mutations) {
    const count = mutations?.length || 0;
    if (IS_FIREFOX_ANDROID) return 'firefox-android-lightweight';
    if (isLargeDomPressure()) return 'large-dom-pressure';
    if (Date.now() < domSlowObserverUntil) return 'recent-slow-observer';
    if (count >= LARGE_MUTATION_BATCH_THRESHOLD) return 'large-mutation-batch';
    if (isChatsRoute() && lastKnownDomElements >= LARGE_LIST_DOM_ELEMENT_THRESHOLD) return 'large-chats-list';
    if (Date.now() < domFastModeUntil) return 'recent-large-batch';
    return null;
  }
  function domDetailSampleCap() {
    if (Date.now() < selfThrottleUntil) return 0;
    if (IS_FIREFOX_ANDROID) return 1;
    if (Date.now() < domFastModeUntil) return 2;
    if (currentHighDetailDomMode()) return isLargeDomPressure() ? 8 : DOM_DETAIL_SAMPLE_CAP;
    return isLargeDomPressure() ? 2 : 4;
  }
  function bump(map, key, n = 1) { if (key) map.set(key, (map.get(key) || 0) + n); }
  function topMap(map, limit = 8) { return [...map.entries()].sort((a,b) => b[1] - a[1]).slice(0, limit).map(([value,count]) => ({ value, count })); }

  function elementFor(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }
  function safeAttr(el, name, max = 500) {
    try {
      const value = el?.getAttribute?.(name);
      return typeof value === 'string' ? value.slice(0, max) : null;
    } catch (_) { return null; }
  }
  function qolInfo(node) {
    const el = elementFor(node);
    if (!el) return { related: false, owned: false, feature: null };
    // Generic ds-* ancestry is NOT ownership. QoL intentionally puts a few ds-*
    // state classes on <html>; treating every descendant as QoL made essentially
    // the entire SpicyChat DOM look QoL-related. Only direct ds-* identity/classes
    // count as a generic QoL hint. Explicit data-ds-owned/data-ds-owner may own a
    // subtree and is therefore allowed to propagate through descendants.
    const own = el.closest?.('[data-ds-owned="1"],[data-ds-owner="qol"]') || null;
    const id = safeAttr(el, 'id', 250) || '';
    const cls = safeAttr(el, 'class', 500) || '';
    const directFeature = safeAttr(el, 'data-ds-feature', 160) || null;
    const directRelated = /^ds-/i.test(id) || /(^|\s)ds-/i.test(cls) || !!directFeature;
    return {
      related: !!own || directRelated,
      owned: !!own,
      feature: directFeature || safeAttr(own, 'data-ds-feature', 160) || null
    };
  }
  function isInspectorNoise(node) {
    const el = elementFor(node);
    if (!el) return false;
    const id = safeAttr(el, 'id', 250) || '';
    const cls = safeAttr(el, 'class', 500) || '';
    return /^sci-/i.test(id) || /(^|\s)(darkreader|sci-)/i.test(cls) || /^darkreader/i.test(id);
  }
  function isLowValueHeadNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return node.nodeType === Node.COMMENT_NODE;
    if (['SCRIPT','STYLE','LINK','NOSCRIPT'].includes(el.tagName)) return true;
    if (safeAttr(el, 'id', 250) === 'boot-loader' || el.closest?.('#boot-loader')) return true;
    return !!el.closest?.('head');
  }

  function isNormalChatRoute() { return /^\/chat\//.test(location.pathname); }
  function isStoryRoute() { return /^\/story\//.test(location.pathname); }
  function isQolWorkerPage() { return PAGE_ROLE === 'qol-bot-status-worker' || PAGE_ROLE === 'qol-recommendation-worker'; }
  function mountedMessageKind() { return isStoryRoute() ? 'story' : (isNormalChatRoute() ? 'chat' : null); }

  function domTextMeta(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { chars: text.length, fingerprint: traceFingerprint(text) };
  }

  function boundedNodeText(node, maxChars = 220, maxNodes = 40) {
    if (!node || maxChars <= 0 || maxNodes <= 0) return '';
    let out = '', seen = 0;
    const queue = [node];
    while (queue.length && seen < maxNodes && out.length < maxChars) {
      const cur = queue.shift();
      if (!cur) continue;
      seen++;
      if (cur.nodeType === Node.TEXT_NODE) {
        const value = String(cur.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (value) out += (out ? ' ' : '') + value;
        continue;
      }
      if (cur.nodeType !== Node.ELEMENT_NODE) continue;
      const children = cur.childNodes ? [...cur.childNodes] : [];
      for (const child of children) {
        if (queue.length + seen >= maxNodes) break;
        queue.push(child);
      }
    }
    return out.trim().replace(/\s+/g, ' ').slice(0, maxChars);
  }

  function describeNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const qi = qolInfo(node);
      return { node: '#text', textMeta: domTextMeta(String(node.nodeValue || '').slice(0, 500)), dsRelated: qi.related, dsOwned: qi.owned, dsFeature: qi.feature };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return { node: node.nodeName };
    const el = node;
    const qi = qolInfo(el);
    return {
      node: el.tagName?.toLowerCase(), id: safeAttr(el, 'id', 250),
      class: safeAttr(el, 'class', 250),
      role: safeAttr(el, 'role', 120), testid: safeAttr(el, 'data-testid', 180),
      state: safeAttr(el, 'data-state', 120), status: safeAttr(el, 'data-status', 120),
      dsRelated: qi.related, dsOwned: qi.owned, dsFeature: qi.feature,
      dsReason: safeAttr(el, 'data-ds-reason', 180),
      // Never persist page/message text from DOM mutation samples. Length + a
      // one-way fingerprint is sufficient for change/no-op diagnostics and avoids
      // leaking chat, Story, persona, Lorebook, or other user-authored content.
      textMeta: null
    };
  }
  function nodeLabel(desc) {
    if (!desc) return '(unknown)';
    if (desc.node === '#text') return '#text';
    const cls = String(desc.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map(x => `.${x}`).join('');
    return `${desc.node || 'node'}${desc.id ? `#${desc.id}` : ''}${cls}`.slice(0, 180);
  }
  function nodesTextMeta(nodes) {
    if (isLargeDomPressure()) return null;
    let out = '';
    // Keep text-change fingerprints very shallow. This is intentionally not a
    // content snapshot; it only helps identify same/changed mutation patterns.
    for (const n of [...nodes].slice(0, 6)) {
      if (out.length >= 256) break;
      const text = boundedNodeText(n, 256 - out.length, 8);
      if (text) out += (out ? ' ' : '') + text;
    }
    return domTextMeta(out);
  }

  function storyMessageRoot(el) {
    if (!el || !isStoryRoute()) return null;
    try { return el.matches?.(STORY_MESSAGE_SELECTOR) ? el : (el.closest?.(STORY_MESSAGE_SELECTOR) || null); } catch (_) { return null; }
  }
  function countMessageNodes(node) {
    const el = elementFor(node);
    if (!el) return 0;
    if (isStoryRoute()) {
      let n = el.matches?.(STORY_MESSAGE_SELECTOR) ? 1 : 0;
      try { n += el.querySelectorAll?.(STORY_MESSAGE_SELECTOR).length || 0; } catch (_) {}
      return n;
    }
    if (!isNormalChatRoute()) return 0;
    let n = /^message-/i.test(safeAttr(el, 'id', 250) || '') ? 1 : 0;
    try { n += el.querySelectorAll?.('[id^="message-"]').length || 0; } catch (_) {}
    return n;
  }
  let lastMountedMessageSampleAt = 0, cachedMountedMessageCount = null;
  function sampleMountedMessageCount(force = false) {
    if (!isNormalChatRoute() && !isStoryRoute()) return null;
    const now = Date.now();
    if (!force && cachedMountedMessageCount != null && now - lastMountedMessageSampleAt < 2000) return cachedMountedMessageCount;
    try {
      cachedMountedMessageCount = isStoryRoute()
        ? document.querySelectorAll(STORY_MESSAGE_SELECTOR).length
        : document.querySelectorAll('[id^="message-"]').length;
    } catch (_) { cachedMountedMessageCount = null; }
    lastMountedMessageSampleAt = now;
    return cachedMountedMessageCount;
  }

  function messageRelatedNode(node) {
    const el = elementFor(node);
    if (!el) return false;
    if (isStoryRoute()) return !!storyMessageRoot(el);
    if (!isNormalChatRoute()) return false;
    const id = safeAttr(el, 'id', 250) || '';
    if (/^message-/i.test(id)) return true;
    try { return !!el.closest?.('[id^="message-"]'); } catch (_) { return false; }
  }

  function isSuccessfulChatResponse(event) {
    if (event?.type !== 'network' || !/response$/.test(event.subtype || '')) return false;
    if (String(event.method || '').toUpperCase() !== 'POST' || !(event.status >= 200 && event.status < 300)) return false;
    try { return /\/chat$/.test(new URL(event.finalUrl || event.requestedUrl || event.url || '', location.href).pathname); } catch (_) { return false; }
  }

  function finalizeAbandonedGenerationWindows(reason) {
    if (!pendingGenerationRenders.size) return;
    for (const pending of pendingGenerationRenders.values()) {
      emit({type:'performance',subtype:'generation-dom-match-result',
        relatedRequestId:pending.requestId,generationResponseTs:pending.responseTs,
        status:pending.firstMessageDomTs?'signal-observed':pending.replyPresentAtResponse?'reply-already-present':'not-checked',
        reason,hasReplyId:!!pending.replyId,
        exactReplyPresentAtResponse:!!pending.replyPresentAtResponse,
        postResponseMessageMutationCount:pending.postMessageMutations||0,
        coverageLimited:true,signalConfidence:pending.matchedReplyId?'high':(pending.replyPresentAtResponse?'high':'unverified')});
    }
    pendingGenerationRenders.clear();
  }

  function scheduleGenerationFollowup(delayMs, reason, meta) {
    const scheduledAt = Date.now();

    const emitOrSample = (activeMeta, coalescedGenerations = 1) => {
      const actualDelayMs = Math.max(0, Date.now() - scheduledAt);
      const latenessMs = Math.max(0, actualDelayMs - delayMs);
      if (latenessMs > GENERATION_FOLLOWUP_MAX_LATENESS_MS) {
        emit({
          type: 'performance', subtype: 'generation-followup-skipped-late', reason,
          intendedDelayMs: delayMs, actualDelayMs, latenessMs,
          coalescedGenerations, ...activeMeta, interaction: interactionState()
        });
      } else {
        samplePagePressure(reason, { ...activeMeta, actualDelayMs, coalescedGenerations });
      }
      if (delayMs === GENERATION_RENDER_WINDOW_MS && activeMeta?.relatedRequestId) {
        const pending=pendingGenerationRenders.get(activeMeta.relatedRequestId);
        if (pending) {
          const pre=recentMessageDomChanges.filter(x=>x.ts>=pending.responseTs-1500 && x.ts<pending.responseTs && x.route===pending.route);
          const reason=pending.route!==location.pathname ? 'route-changed-before-dom-check' : pending.firstMessageDomTs ? 'post-response-mutation-observed'
            : pending.replyPresentAtResponse ? 'exact-reply-present-at-response'
            : pre.length ? 'possible-dom-mounted-before-network-response'
            : pending.replyId ? 'exact-reply-not-observed'
            : 'reply-id-unavailable-and-no-message-mutation';
          emit({type:'performance',subtype:'generation-dom-match-result',relatedRequestId:pending.requestId,
            generationResponseTs:pending.responseTs, status:pending.firstMessageDomTs?'signal-observed':pending.replyPresentAtResponse?'reply-already-present':(pending.route!==location.pathname || latenessMs>GENERATION_FOLLOWUP_MAX_LATENESS_MS?'not-checked':'unmatched'),
            reason, hasReplyId:!!pending.replyId, exactReplyPresentAtResponse:!!pending.replyPresentAtResponse,
            priorDomMutationCount:pre.length, postResponseMessageMutationCount:pending.postMessageMutations || 0,
            mountedMessagesAtResponse:pending.mountedMessagesAtResponse,
            lateCheck:latenessMs>GENERATION_FOLLOWUP_MAX_LATENESS_MS, coverageLimited:document.hidden || latenessMs>GENERATION_FOLLOWUP_MAX_LATENESS_MS,
            signalConfidence:pending.firstMessageDomTs?(pending.matchedReplyId?'high':'low'):(pending.replyPresentAtResponse?'high':'unverified')});
        }
        pendingGenerationRenders.delete(activeMeta.relatedRequestId);
      }
    };

    // Hidden tabs may freeze timers for many minutes. Keep at most one pending
    // follow-up per delay while hidden so a resume cannot unleash hundreds of
    // obsolete full-DOM pressure scans.
    if (document.hidden) {
      const key = String(delayMs);
      const existing = hiddenGenerationFollowups.get(key);
      if (existing) {
        existing.count++;
        if (delayMs === GENERATION_RENDER_WINDOW_MS && existing.latestMeta?.relatedRequestId && existing.latestMeta.relatedRequestId !== meta?.relatedRequestId) {
          const replacedId = existing.latestMeta.relatedRequestId;
          const old = pendingGenerationRenders.get(replacedId);
          if (old) {
            emit({type:'performance', subtype:'generation-dom-match-result',
              relatedRequestId:replacedId, generationResponseTs:old.responseTs,
              status:old.firstMessageDomTs?'signal-observed':old.replyPresentAtResponse?'reply-already-present':'not-checked',
              reason:'hidden-tab-followup-coalesced', hasReplyId:!!old.replyId,
              exactReplyPresentAtResponse:!!old.replyPresentAtResponse,
              postResponseMessageMutationCount:old.postMessageMutations||0,
              signalConfidence:old.firstMessageDomTs?(old.matchedReplyId?'high':'low'):(old.replyPresentAtResponse?'high':'unverified'),
              coverageLimited:true, hiddenAtResponse:true });
            pendingGenerationRenders.delete(replacedId);
          }
        }
        existing.latestMeta = meta;
        return;
      }
      const state = { count: 1, latestMeta: meta, timer: null };
      state.timer = setTimeout(() => {
        hiddenGenerationFollowups.delete(key);
        emitOrSample(state.latestMeta || meta, state.count);
      }, delayMs);
      hiddenGenerationFollowups.set(key, state);
      return;
    }

    setTimeout(() => emitOrSample(meta, 1), delayMs);
  }

  function beginGenerationRenderWindow(event) {
    if (!settings?.capturePerformance || !isSuccessfulChatResponse(event)) return;
    enableHighDetailDom('generation-response');
    const requestId = event.requestId || `chat-${Date.now()}`;
    const responseTs = Number.isFinite(event.responseReceivedAt) ? event.responseReceivedAt : Date.now();
    const meta = { relatedRequestId: requestId, generationResponseTs: responseTs, backendDurationMs: event.durationMs || null };
    let replyId = null, precedingId = null;
    try {
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      const message = body?.message;
      if (message && typeof message === 'object') {
        if (/^[a-zA-Z0-9_-]{8,90}$/.test(String(message.id || ''))) replyId = String(message.id);
        if (/^[a-zA-Z0-9_-]{8,90}$/.test(String(message.prev_id || ''))) precedingId = String(message.prev_id);
      }
    } catch (_) {}
    const replyPresentAtResponse = !!(replyId && isNormalChatRoute() && document.getElementById(`message-${replyId}`));
    const pending = { requestId, responseTs, firstMessageDomTs: null,
      replyId, precedingId, replyPresentAtResponse, matchedReplyId:false,
      route:location.pathname, postMessageMutations:0,
      mountedMessagesAtResponse: Number.isFinite(lastKnownMountedMessages) ? lastKnownMountedMessages : null };
    pendingGenerationRenders.set(requestId, pending);
    const responsePressure = samplePagePressure('generation-response', meta);
    if (Number.isFinite(responsePressure?.mountedMessages)) pending.mountedMessagesAtResponse = responsePressure.mountedMessages;
    scheduleGenerationFollowup(2_000, 'generation-followup-2s', meta);
    scheduleGenerationFollowup(GENERATION_RENDER_WINDOW_MS, 'generation-followup-8s', meta);
  }

  function addedReplyNode(mutation, id) {
    if (!id || mutation?.type !== 'childList') return false;
    const targetId = `message-${id}`;
    // Only inspect added elements when a network response supplies an exact ID.
    // Never read their text. The query is scoped to each newly attached subtree.
    for (const node of mutation.addedNodes || []) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.id === targetId) return true;
      try { if (node.querySelector?.(`[id="${targetId}"]`)) return true; } catch (_) {}
    }
    return false;
  }

  function noteGenerationMessageDom(item, mutation) {
    if (!item) return;
    // Retain a bounded, content-free history even if the DOM changes before
    // the network completion signal arrives (common with streamed responses).
    const now=Date.now();
    const meaningful = item.generationContentAdded === true || (item.messageNodesAdded || 0) > 0;
    if (meaningful) {
      recentMessageDomChanges.push({ts:now,route:location.pathname,count:item.messageNodesAdded || 0});
      while (recentMessageDomChanges.length > 30 || (recentMessageDomChanges[0] && now-recentMessageDomChanges[0].ts > 12000)) recentMessageDomChanges.shift();
    }
    if (!pendingGenerationRenders.size) return;
    const storySignal = isStoryRoute() && item.generationContentAdded === true;
    const normalSignal = isNormalChatRoute() && (item.messageNodesAdded || 0) > 0;
    if (!storySignal && !normalSignal) return;
    const candidates = [...pendingGenerationRenders.values()]
      .filter(x => !x.firstMessageDomTs && now >= x.responseTs && now-x.responseTs <= GENERATION_RENDER_WINDOW_MS)
      .sort((a,b) => b.responseTs-a.responseTs);
    const active = candidates[0];
    if (!active) return;
    active.postMessageMutations++;
    const matchedReplyId = normalSignal && addedReplyNode(mutation, active.replyId);
    // Previous-message reinsertion is common during React list reconstruction.
    // The previous user's ID is evidence of a tree transition, not the bot reply.
    const priorOnly = normalSignal && !matchedReplyId && addedReplyNode(mutation, active.precedingId);
    const mountedNow = matchedReplyId || storySignal ? sampleMountedMessageCount(true) : sampleMountedMessageCount();
    const baseline = active.mountedMessagesAtResponse;
    const haveCounts = Number.isFinite(baseline) && Number.isFinite(mountedNow);
    const mountedDelta = haveCounts ? mountedNow-baseline : null;
    const treeTransition = normalSignal && (item.messageNodesAdded || 0) >= 2 && (item.messageNodesRemoved || 0) >= 1;
    // Allow a same-count native message-tree rebuild as a *tentative* signal.
    // Only an exact reply-ID match is strong evidence of the bot reply's DOM node.
    if (!matchedReplyId && !storySignal && !treeTransition && !(mountedDelta > 0 && !priorOnly)) return;
    active.firstMessageDomTs = now;
    active.matchedReplyId=matchedReplyId;
    const signalKind = storySignal ? 'story-content-added-unverified'
      : matchedReplyId ? 'reply-id-node-added'
      : treeTransition ? 'message-tree-reconstructed-unverified' : 'message-count-increased-unverified';
    const signalConfidence = matchedReplyId ? 'high' : (storySignal ? 'medium' : 'low');
    emit({
      type:'performance', subtype:'generation-response-dom-signal', renderSignalVersion:3,
      relatedRequestId:active.requestId, generationResponseTs:active.responseTs,
      latencyMs:Math.max(0,now-active.responseTs), signalKind, signalConfidence,
      matchedReplyId:!!matchedReplyId, priorMessageReinserted:!!priorOnly,
      mutationKind:item.kind||null, messageNodesAdded:item.messageNodesAdded||0,
      messageNodesRemoved:item.messageNodesRemoved||0,
      generationContentAdded:item.generationContentAdded===true,
      mountedMessagesAtResponse:Number.isFinite(baseline)?baseline:null,
      mountedMessages:mountedNow, mountedDelta, mountedMessageKind:mountedMessageKind(),
      interaction:interactionState()
    });
  }

  function noteLongTaskSpike(entry) {
    const now = Date.now();
    const durationMs = Math.round((entry.duration || 0) * 10) / 10;
    recentLongTasks.push({ ts: now, durationMs });
    const scroll=activeScrollSample;
    const taskStarted=Math.round(performance.timeOrigin+(entry.startTime||0));
    const taskEnded=taskStarted+durationMs;
    if (scroll && taskStarted<=scroll.lastTs+1200 && taskEnded>=scroll.startTs-150) { scroll.longTasks++; scroll.longTaskMs+=durationMs; }
    while (recentLongTasks.length && now - recentLongTasks[0].ts > AUTO_LAG_WINDOW_MS) recentLongTasks.shift();
    if (durationMs >= 500) enableHighDetailDom('long-task');
    if (document.hidden) return;
    const rollingMs = recentLongTasks.reduce((n,x)=>n+x.durationMs,0);
    const worstMs = recentLongTasks.reduce((m,x)=>Math.max(m,x.durationMs),0);
    if (now - lastAutoLagSpikeAt < AUTO_LAG_COOLDOWN_MS) return;
    if (durationMs < 1000 && rollingMs < 2000) return;
    lastAutoLagSpikeAt = now;
    enableHighDetailDom('auto-lag-spike');
    const spikeId = `lag-${now.toString(36)}`;
    emit({ type: 'performance', subtype: 'auto-lag-spike', spikeId, rollingWindowMs: AUTO_LAG_WINDOW_MS, rollingLongTaskMs: Math.round(rollingMs*10)/10, longTaskCount: recentLongTasks.length, worstLongTaskMs: Math.round(worstMs*10)/10, interaction: interactionState() });
    samplePagePressure('auto-lag-spike', { spikeId });
    if (qolInternalsEnabled()) {
      // Flush already-queued QoL spans shortly AFTER the busy interval,
      // without turning on tracing or running a synchronous metrics scan.
      setTimeout(() => {
        if (qolInternalsEnabled()) dispatchQolDiagnosticRequest(QOL_PROTOCOL_V2,'request-trace-flush','auto-lag-spike');
      },750);
    }
    setTimeout(() => samplePagePressure('auto-lag-followup-10s', { spikeId }), 10_000);
  }

  function passiveQolIdentity() {
    const root = document.documentElement;
    if (!root) return null;
    const version = String(root.dataset?.dsQolVersion || '').trim();
    const build = String(root.dataset?.dsQolBuild || '').trim();
    const revision = String(root.dataset?.dsQolRevision || '').trim();
    const protocol = String(root.dataset?.dsQolDiagnosticProtocol || '').trim();
    if (!version && !build && !revision && !protocol) return null;
    return {
      version: version || null,
      build: build || null,
      revision: revision || null,
      protocol: protocol || null
    };
  }

  function pagePressureSnapshot(reason = 'periodic', extra = {}) {
    // Once a hidden stress chat is very large, avoid re-walking the entire DOM
    // for every single generation response. Mutation batches still keep the
    // mounted-message count fresh; periodic/marker/resume snapshots continue to
    // take the full DOM/Resource Timing sample.
    const lightweightLargeDom = document.hidden && isLargeDomPressure() && /^generation-/.test(reason);
    let domElements = lightweightLargeDom ? lastKnownDomElements : null;
    if (!lightweightLargeDom) { try { domElements = document.getElementsByTagName('*').length; } catch (_) {} }
    const mountedMessages = lightweightLargeDom ? sampleMountedMessageCount(false) : sampleMountedMessageCount(true);
    const mem = performance.memory || null;
    return {
      type: 'performance', subtype: 'page-pressure', reason,
      pressureSampleMode: lightweightLargeDom ? 'large-dom-lightweight' : 'full',
      domElements,
      mountedMessages,
      mountedMessageKind: mountedMessageKind(),
      jsHeapUsedBytes: Number.isFinite(mem?.usedJSHeapSize) ? mem.usedJSHeapSize : null,
      jsHeapTotalBytes: Number.isFinite(mem?.totalJSHeapSize) ? mem.totalJSHeapSize : null,
      jsHeapLimitBytes: Number.isFinite(mem?.jsHeapSizeLimit) ? mem.jsHeapSizeLimit : null,
      resourceEntries: lightweightLargeDom ? null : (() => { try { return performance.getEntriesByType('resource').length; } catch (_) { return null; } })(),
      resourceTimingCapacityHint: RESOURCE_TIMING_BUFFER_SIZE,
      interaction: interactionState(),
      qolIdentity: passiveQolIdentity(),
      ...extra
    };
  }
  function samplePagePressure(reason = 'periodic', extra = {}) {
    if (!settings?.capturePerformance) return null;
    lastPressureSampleAt = Date.now();
    const now = Date.now();
    // Generation stress tests can request three snapshots per reply. Reuse
    // recent DOM/resource measurements instead of synchronously walking the
    // whole page again; keep a distinct event and request ID for correlation.
    const generation = /^generation-(?:response|followup-2s|followup-8s)$/.test(reason);
    const age = now - lastFullPressureAt;
    const sameRoute = lastFullPressureRoute === location.pathname;
    const hasFreshCache = !!lastFullPressureSnapshot && lastFullPressureAt > 0 &&
      age >= 0 && age <= GENERATION_PRESSURE_CACHE_MAX_AGE_MS && sameRoute;
    // Cached DOM elements are intentionally approximate; mounted-message count,
    // heap use, and the request correlation remain fresh. Do not scan the full
    // document three times for every generation in sustained stress tests.
    const reuse = generation && hasFreshCache;
    const sampleDecision = reuse ? 'reused' : !generation ? 'normal-full'
      : !lastFullPressureSnapshot ? 'cold-start'
      : !sameRoute ? 'route-changed' : age > GENERATION_PRESSURE_CACHE_MAX_AGE_MS
        ? 'expired' : 'clock-reset';
    const snapshot = reuse ? {
      ...lastFullPressureSnapshot, reason, ...extra,
      pressureSampleMode: 'generation-recent-cache',
      pressureSamplerVersion: PRESSURE_SAMPLER_VERSION,
      pressureCacheDecision: sampleDecision,
      cachedMeasurementAgeMs: age,
      // Never carry over request IDs or event timing from another generation.
      mountedMessages: sampleMountedMessageCount(false),
      jsHeapUsedBytes: Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : lastKnownJsHeapUsedBytes,
      resourceEntries: null, interaction: interactionState(), qolIdentity: passiveQolIdentity()
    } : {
      ...pagePressureSnapshot(reason, extra),
      pressureSamplerVersion: PRESSURE_SAMPLER_VERSION,
      pressureCacheDecision: sampleDecision
    };
    if (!reuse) { lastFullPressureSnapshot = snapshot; lastFullPressureAt = now; lastFullPressureRoute = location.pathname; }
    if (Number.isFinite(snapshot.domElements)) lastKnownDomElements = snapshot.domElements;
    if (Number.isFinite(snapshot.mountedMessages)) lastKnownMountedMessages = snapshot.mountedMessages;
    if (Number.isFinite(snapshot.jsHeapUsedBytes)) lastKnownJsHeapUsedBytes = snapshot.jsHeapUsedBytes;
    emit(snapshot);
    return snapshot;
  }
  function startPressureSampling() {
    if (pressureTimer) return;
    pressureTimer = setInterval(() => {
      if (!settings?.capturePerformance) return;
      const now = Date.now();
      const interval = document.hidden ? PRESSURE_HIDDEN_MS : PRESSURE_VISIBLE_MS;
      if (now - lastPressureSampleAt >= interval) samplePagePressure(document.hidden ? 'periodic-hidden' : 'periodic-visible');
    }, 30_000);
    setTimeout(() => samplePagePressure('startup'), 3000);
  }

  function captureMutation(m) {
    if (isInspectorNoise(m.target) || isLowValueHeadNode(m.target)) return null;
    const target = describeNode(m.target);
    const item = { kind: m.type, target, added: [], removed: [], attribute: m.attributeName || null, messageRelated: messageRelatedNode(m.target) };
    let related = !!target?.dsRelated;
    let owned = !!target?.dsOwned;
    let noOp = false;
    let pattern = `${m.type}:${nodeLabel(target)}`;

    if (m.type === 'attributes') {
      item.oldValue = redactString(m.oldValue == null ? null : String(m.oldValue).slice(0, 500));
      const current = elementFor(m.target)?.getAttribute?.(m.attributeName);
      item.newValue = redactString(current == null ? null : String(current).slice(0, 500));
      noOp = item.oldValue === item.newValue;
      pattern = `${nodeLabel(target)} @${m.attributeName} ${JSON.stringify(item.oldValue)}â†’${JSON.stringify(item.newValue)}`;
    } else if (m.type === 'characterData') {
      item.oldTextMeta = domTextMeta(String(m.oldValue || ''));
      item.newTextMeta = domTextMeta(String(m.target?.data || ''));
      noOp = !!item.oldTextMeta && !!item.newTextMeta && item.oldTextMeta.fingerprint === item.newTextMeta.fingerprint;
      pattern = `${nodeLabel(target)} text ${noOp ? 'same' : 'changed'}`;
    } else if (m.type === 'childList') {
      const addedAll = [...m.addedNodes].filter(n => !isInspectorNoise(n) && !isLowValueHeadNode(n));
      const removedAll = [...m.removedNodes].filter(n => !isInspectorNoise(n) && !isLowValueHeadNode(n));
      item.added = addedAll.slice(0, 10).map(describeNode);
      item.removed = removedAll.slice(0, 10).map(describeNode);
      item.addedCount = addedAll.length;
      item.removedCount = removedAll.length;
      if (!addedAll.length && !removedAll.length) return null;
      // Attribute against every changed node, not only the bounded detail sample.
      for (const n of [...addedAll, ...removedAll]) {
        const qi = qolInfo(n);
        related ||= qi.related;
        owned ||= qi.owned;
      }
      item.messageNodesAdded = addedAll.reduce((n, x) => n + countMessageNodes(x), 0);
      item.messageNodesRemoved = removedAll.reduce((n, x) => n + countMessageNodes(x), 0);
      item.messageRelated ||= item.messageNodesAdded > 0 || item.messageNodesRemoved > 0 || addedAll.some(messageRelatedNode) || removedAll.some(messageRelatedNode);
      const oldTextMeta = nodesTextMeta(removedAll);
      const newTextMeta = nodesTextMeta(addedAll);
      if (oldTextMeta || newTextMeta) {
        item.oldTextMeta = oldTextMeta;
        item.newTextMeta = newTextMeta;
        noOp = !!oldTextMeta && !!newTextMeta && oldTextMeta.fingerprint === newTextMeta.fingerprint;
        pattern = `${nodeLabel(target)} children text ${noOp ? 'same' : 'changed'} +${addedAll.length}/-${removedAll.length}`;
      } else pattern = `${nodeLabel(target)} children +${addedAll.length}/-${removedAll.length}`;
      if (isStoryRoute() && addedAll.length && storyMessageRoot(elementFor(m.target))) item.generationContentAdded = true;
    }

    item.dsRelated = related;
    item.dsOwned = owned;
    item.dsFeature = target?.dsFeature || [...item.added, ...item.removed].find(x => x?.dsFeature)?.dsFeature || null;
    item.noOp = noOp;
    item.pattern = redactString(pattern).slice(0, 500);
    return item;
  }

  function qolInfoFast(node, budget) {
    const el = elementFor(node);
    if (!el) return { related: false, owned: false, feature: null };
    const id = safeAttr(el, 'id', 180) || '';
    const cls = safeAttr(el, 'class', 240) || '';
    const feature = safeAttr(el, 'data-ds-feature', 120) || null;
    const directOwned = safeAttr(el, 'data-ds-owned', 20) === '1' || safeAttr(el, 'data-ds-owner', 30) === 'qol';
    let owned = directOwned;
    let inheritedFeature = null;
    // Ancestor ownership is useful evidence but `closest()` on every one of thousands
    // of native list mutations defeats the point of fast mode. Spend a tiny shared
    // budget per callback, then rely on direct ds-* identity for the rest.
    if (!owned && budget && budget.qolAncestorScans > 0) {
      budget.qolAncestorScans--;
      try {
        const own = el.closest?.('[data-ds-owned="1"],[data-ds-owner="qol"]') || null;
        owned = !!own;
        inheritedFeature = safeAttr(own, 'data-ds-feature', 120) || null;
      } catch (_) {}
    }
    const directRelated = /^ds-/i.test(id) || /(^|\s)ds-/i.test(cls) || !!feature;
    return { related: owned || directRelated, owned, feature: feature || inheritedFeature };
  }

  function describeNodeFast(node, budget) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const qi = qolInfoFast(node, budget);
      return { node: '#text', dsRelated: qi.related, dsOwned: qi.owned, dsFeature: qi.feature };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return { node: node.nodeName };
    const el = node;
    const qi = qolInfoFast(el, budget);
    return {
      node: el.tagName?.toLowerCase(), id: safeAttr(el, 'id', 180), class: safeAttr(el, 'class', 180),
      role: safeAttr(el, 'role', 80), testid: safeAttr(el, 'data-testid', 120),
      dsRelated: qi.related, dsOwned: qi.owned, dsFeature: qi.feature,
      dsReason: safeAttr(el, 'data-ds-reason', 120), text: null
    };
  }

  function fastCountMessageNodes(node, budget) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (isStoryRoute()) {
      let count = node.matches?.(STORY_MESSAGE_SELECTOR) ? 1 : 0;
      if (count || !budget || budget.messageDescendantScans <= 0) return count;
      try {
        if ((node.childElementCount || 0) <= 160) {
          budget.messageDescendantScans--;
          count += node.querySelectorAll?.(STORY_MESSAGE_SELECTOR).length || 0;
        }
      } catch (_) {}
      return count;
    }
    if (!isNormalChatRoute()) return 0;
    const id = safeAttr(node, 'id', 180) || '';
    let count = /^message-/i.test(id) ? 1 : 0;
    if (count || !budget || budget.messageDescendantScans <= 0) return count;
    // Preserve generation/message-count evidence without recursively scanning every
    // changed subtree in giant mutation bursts. A small shared budget is enough for
    // the handful of wrapper insertions that may contain a message node.
    try {
      if ((node.childElementCount || 0) <= 160) {
        budget.messageDescendantScans--;
        count += node.querySelectorAll?.('[id^="message-"]').length || 0;
      }
    } catch (_) {}
    return count;
  }

  function captureMutationFast(m, budget) {
    if (isInspectorNoise(m.target) || isLowValueHeadNode(m.target)) return null;
    const target = describeNodeFast(m.target, budget);
    const item = { kind: m.type, target, added: [], removed: [], attribute: m.attributeName || null, messageRelated: (isNormalChatRoute() || isStoryRoute()) ? messageRelatedNode(m.target) : false, fastSummary: true };
    let related = !!target?.dsRelated;
    let owned = !!target?.dsOwned;
    let noOp = false;
    let pattern = `${m.type}:${nodeLabel(target)}`;

    if (m.type === 'attributes') {
      item.oldValue = redactString(m.oldValue == null ? null : String(m.oldValue).slice(0, 240));
      const current = elementFor(m.target)?.getAttribute?.(m.attributeName);
      item.newValue = redactString(current == null ? null : String(current).slice(0, 240));
      noOp = item.oldValue === item.newValue;
      pattern = `${nodeLabel(target)} @${m.attributeName} ${noOp ? 'same' : 'changed'}`;
    } else if (m.type === 'characterData') {
      const oldValue = String(m.oldValue || '');
      const newValue = String(m.target?.data || '');
      noOp = oldValue === newValue;
      pattern = `${nodeLabel(target)} text ${noOp ? 'same' : 'changed'}`;
    } else if (m.type === 'childList') {
      const addedAll = [...m.addedNodes].filter(n => !isInspectorNoise(n) && !isLowValueHeadNode(n));
      const removedAll = [...m.removedNodes].filter(n => !isInspectorNoise(n) && !isLowValueHeadNode(n));
      if (!addedAll.length && !removedAll.length) return null;
      item.addedCount = addedAll.length;
      item.removedCount = removedAll.length;
      // Only sample a few changed nodes in fast mode. Full child text/identity walking
      // is intentionally skipped because native /chats rerenders can deliver thousands
      // of records in one callback.
      item.added = addedAll.slice(0, 3).map(n => describeNodeFast(n, budget));
      item.removed = removedAll.slice(0, 3).map(n => describeNodeFast(n, budget));
      for (const n of [...addedAll.slice(0, 3), ...removedAll.slice(0, 3)]) {
        const qi = qolInfoFast(n, budget);
        related ||= qi.related;
        owned ||= qi.owned;
      }
      item.messageNodesAdded = addedAll.reduce((n, x) => n + fastCountMessageNodes(x, budget), 0);
      item.messageNodesRemoved = removedAll.reduce((n, x) => n + fastCountMessageNodes(x, budget), 0);
      item.messageRelated ||= item.messageNodesAdded > 0 || item.messageNodesRemoved > 0;
      if (isStoryRoute() && addedAll.length && storyMessageRoot(elementFor(m.target))) item.generationContentAdded = true;
      pattern = `${nodeLabel(target)} children +${addedAll.length}/-${removedAll.length}`;
    }

    item.dsRelated = related;
    item.dsOwned = owned;
    item.dsFeature = target?.dsFeature || [...item.added, ...item.removed].find(x => x?.dsFeature)?.dsFeature || null;
    item.noOp = noOp;
    item.pattern = redactString(pattern).slice(0, 320);
    return item;
  }

  function isKnownDialogueFormattingSwap(m) {
    // Exact high-volume pattern from QoL native-format-dialogue-fix: text <->
    // formatted span. Recognize by direct node identity; never walk descendants,
    // serialize message text, or call costly ownership/selector helpers for it.
    if (m.type !== 'childList' || m.addedNodes?.length !== 1 || m.removedNodes?.length !== 1) return false;
    const t = m.target;
    if (t?.nodeType !== Node.ELEMENT_NODE || t.tagName !== 'SPAN') return false;
    const cls = t.className;
    if (typeof cls !== 'string' || !cls.includes('leading-6') || !cls.includes('mb-[10px]') || !cls.includes('last:mb-0')) return false;
    const added = m.addedNodes[0], removed = m.removedNodes[0];
    if (!added || !removed) return false;
    const wrapper = added.nodeType === Node.ELEMENT_NODE && removed.nodeType === Node.TEXT_NODE ? added
      : removed.nodeType === Node.ELEMENT_NODE && added.nodeType === Node.TEXT_NODE ? removed : null;
    return !!(wrapper?.classList?.contains('ds-native-format-dialogue-fix'));
  }
  function startDomObserver() {
    if (domObserver || !settings?.captureDom || isQolWorkerPage()) return;
    const begin = () => {
      if (!document.documentElement || domObserver) return;
      domObserver = new MutationObserver(mutations => {
        const observerStarted = performance.now();
        const fastReason = domFastModeReason(mutations);
        if (fastReason) {
          domFastModeUntil = Math.max(domFastModeUntil, Date.now() + DOM_FAST_MODE_HOLD_MS);
          domStats.fastModeCallbacks++;
          domStats.fastModeMutations += mutations.length;
          bump(domStats.fastModeReasons, fastReason);
        }
        const highDetail = currentHighDetailDomMode();
        // A single childList record can replace hundreds of children even when
        // there are fewer than 80 total records. Detect that cheaply and use
        // summary-only capture instead of deep subtree/text traversal.
        const highFanout = mutations.some(m => m.type === 'childList' &&
          ((m.addedNodes?.length || 0) + (m.removedNodes?.length || 0)) > 48);
        const useFastCapture = !!fastReason || highFanout || !highDetail || mutations.length > 80 || Date.now() < selfThrottleUntil;
        const fastBudget = { messageDescendantScans: IS_FIREFOX_ANDROID ? 2 : (highDetail ? 12 : 8), qolAncestorScans: IS_FIREFOX_ANDROID ? 2 : (highDetail ? 16 : 6) };
        let formattingSwaps = 0;
        const maxRecords = Math.min(mutations.length, DOM_CALLBACK_MAX_RECORDS);
        const timeBudget = DOM_CALLBACK_BUDGET_MS + (highDetail && !IS_FIREFOX_ANDROID ? 2 : 0);
        if (mutations.length > maxRecords) {
          domStats.budgetSkippedMutationRecords += mutations.length - maxRecords;
          domStats.recordLimitCallbacks++;
          if (IS_FIREFOX_ANDROID) domStats.mobileSkippedMutationRecords += mutations.length - maxRecords;
        }
        for (let i = 0; i < maxRecords; i++) {
          // Check elapsed time every fourth record, rather than inspecting a
          // giant burst to completion while chat rendering is stalled.
          if (i >= 4 && (i & 3) === 0 && performance.now() - observerStarted > timeBudget) {
            domStats.budgetSkippedMutationRecords += maxRecords - i;
            if (IS_FIREFOX_ANDROID) domStats.mobileSkippedMutationRecords += maxRecords - i;
            domStats.budgetExceededCallbacks++;
            domSlowObserverUntil = Math.max(domSlowObserverUntil, Date.now() + 30_000);
            break;
          }
          const m = mutations[i];
          if (isKnownDialogueFormattingSwap(m)) {
            formattingSwaps++;
            continue;
          }
          const item = useFastCapture ? captureMutationFast(m, fastBudget) : captureMutation(m);
          if (!item) continue;
          domStats.totalMutations++;
          if (item.dsRelated) domStats.qolRelated++;
          if (item.dsOwned) domStats.qolOwned++;
          if (item.noOp) domStats.noOp++;
          noteGenerationMessageDom(item, m);
          domStats.messageNodesAdded += item.messageNodesAdded || 0;
          domStats.messageNodesRemoved += item.messageNodesRemoved || 0;
          bump(domStats.patterns, item.pattern);
          bump(domStats.targets, nodeLabel(item.target));
          // Keep one representative example per unique mutation pattern. The aggregate
          // stats below still count every mutation, but repeated no-op writes no longer
          // balloon long captures by hundreds of MB.
          if (domQueue.length < domDetailSampleCap() && !domSamplePatterns.has(item.pattern)) {
            domSamplePatterns.add(item.pattern);
            domQueue.push(item);
          }
        }
        if (formattingSwaps) {
          // Aggregate all occurrences accurately without individually describing,
          // pattern-hashing, ancestor-checking, or saving three million examples.
          const pattern = 'span.leading-6.mb-[10px].last:mb-0 children +1/-1 [dialogue-fix swap]';
          domStats.totalMutations += formattingSwaps;
          domStats.qolRelated += formattingSwaps;
          domStats.formattingSwapsCoalesced += formattingSwaps;
          bump(domStats.patterns, pattern, formattingSwaps);
          bump(domStats.targets, 'span.leading-6.mb-[10px].last:mb-0', formattingSwaps);
          if (domQueue.length < domDetailSampleCap() && !domSamplePatterns.has(pattern)) {
            domSamplePatterns.add(pattern);
            domQueue.push({ kind:'childList', pattern, addedCount:1, removedCount:1,
              dsRelated:true, dsOwned:false, dsFeature:'native-format-dialogue-fix',
              fastSummary:true, collapsedCount:formattingSwaps, noOp:null,
              target:{node:'span',class:'leading-6 mb-[10px] last:mb-0'} });
          }
        }
        domStats.observerCallbacks++;
        const observerWallMs = Math.max(0, performance.now() - observerStarted);
        domStats.inspectorObserverWallMs += observerWallMs;
        // Hidden tabs can be descheduled in the middle of a callback. A multi-second
        // wall interval for only a handful of mutation records is not credible as
        // continuous Inspector CPU, so preserve it separately instead of inflating
        // self-overhead totals.
        const timingContaminated = (observerWallMs >= 1_000 && mutations.length <= 25) || (document.hidden && observerWallMs >= 5_000);
        if (timingContaminated) {
          domStats.observerTimingContaminatedCallbacks++;
          domStats.observerTimingContaminatedWallMs += observerWallMs;
        } else {
          domStats.inspectorObserverMs += observerWallMs;
          domStats.maxObserverCallbackMs = Math.max(domStats.maxObserverCallbackMs, observerWallMs);
          if (observerWallMs >= 16) domStats.observerCallbacksOver16ms++;
          if (observerWallMs >= 8) activateSelfThrottle('observer-callback', { observerWallMs: Math.round(observerWallMs * 1000) / 1000, mutationRecords: mutations.length });
          if (observerWallMs >= 50) {
            domStats.observerCallbacksOver50ms++;
            // A genuinely slow Inspector callback is itself a pressure signal. Keep the
            // lightweight capture path active for subsequent callbacks rather than
            // repeatedly paying the full-detail cost while the page is overloaded.
            domSlowObserverUntil = Math.max(domSlowObserverUntil, Date.now() + 120_000);
          }
        }
        if (!domTimer && domStats.totalMutations) domTimer = setTimeout(flushDom, 500);
      });
      // Lite diagnostics: track structural churn and a compact set of state/class
      // changes. Avoid character-data and Inspector/QoL ownership attributes so the
      // observer measures page pressure without becoming part of that pressure.
      const observerOptions = IS_FIREFOX_ANDROID
        ? { subtree: true, childList: true }
        : { subtree: true, childList: true, attributes: true,
            attributeFilter: ['class','id','hidden','disabled','aria-hidden','aria-disabled','aria-expanded','aria-pressed','data-state','data-status','data-testid'] };
      domObserver.observe(document.documentElement, observerOptions);
    };
    if (document.documentElement) begin(); else document.addEventListener('DOMContentLoaded', begin, { once: true });
  }
  function stopDomObserver() { domObserver?.disconnect(); domObserver = null; }
  function flushDom() {
    domTimer = null;
    if (!domStats.totalMutations) return;
    const flushStarted = performance.now();
    const stats = {
      totalMutations: domStats.totalMutations,
      formattingSwapsCoalesced: domStats.formattingSwapsCoalesced,
      mobileSkippedMutationRecords: domStats.mobileSkippedMutationRecords,
      budgetSkippedMutationRecords: domStats.budgetSkippedMutationRecords,
      budgetExceededCallbacks: domStats.budgetExceededCallbacks,
      recordLimitCallbacks: domStats.recordLimitCallbacks,
      mobileChildListOnly: domStats.mobileChildListOnly,
      formattingSwapNoOpCountUnknown: domStats.formattingSwapsCoalesced,
      detailedChanges: domQueue.length,
      summarizedChanges: Math.max(0, domStats.totalMutations - domQueue.length),
      detailSampling: 'unique-pattern',
      detailSampleCap: domDetailSampleCap(),
      qolRelated: domStats.qolRelated,
      qolOwned: domStats.qolOwned,
      noOp: domStats.noOp,
      messageNodesAdded: domStats.messageNodesAdded,
      messageNodesRemoved: domStats.messageNodesRemoved,
      observerCallbacks: domStats.observerCallbacks,
      inspectorObserverMs: Math.round(domStats.inspectorObserverMs * 1000) / 1000,
      inspectorObserverWallMs: Math.round(domStats.inspectorObserverWallMs * 1000) / 1000,
      observerTimingContaminatedCallbacks: domStats.observerTimingContaminatedCallbacks,
      observerTimingContaminatedWallMs: Math.round(domStats.observerTimingContaminatedWallMs * 1000) / 1000,
      largeDomMode: isLargeDomPressure(),
      fastModeUsed: domStats.fastModeCallbacks > 0,
      fastModeCallbacks: domStats.fastModeCallbacks,
      fastModeMutations: domStats.fastModeMutations,
      fastModeReasons: topMap(domStats.fastModeReasons, 6),
      maxObserverCallbackMs: Math.round(domStats.maxObserverCallbackMs * 1000) / 1000,
      observerCallbacksOver16ms: domStats.observerCallbacksOver16ms,
      observerCallbacksOver50ms: domStats.observerCallbacksOver50ms,
      mountedMessages: sampleMountedMessageCount(),
      topPatterns: topMap(domStats.patterns, 8),
      topTargets: topMap(domStats.targets, 8)
    };
    if (Number.isFinite(stats.mountedMessages)) lastKnownMountedMessages = stats.mountedMessages;
    let attribution = { source: 'unknown-mixed', confidence: 'unknown', reason: 'DOM batch has no explicit owner signal.' };
    if (stats.qolOwned > 0) attribution = { source: 'qol', confidence: 'confirmed', reason: 'Mutation touched QoL-owned DOM (data-ds-owned/data-ds-owner).' };
    else if (stats.qolRelated > 0) attribution = { source: 'qol', confidence: 'likely', reason: 'Mutation touched ds-* DOM without explicit owner metadata.' };
    const active = qolContextFor(Date.now());
    if (active.activeOperations.length && attribution.source !== 'qol') attribution = { source: 'unknown-mixed', confidence: 'correlated', triggerSource: 'qol', executor: 'page/dom', reason: 'Native/unknown DOM changed while a QoL operation was active.', qol: active };
    stats.inspectorFlushMs = Math.round(Math.max(0, performance.now() - flushStarted) * 1000) / 1000;
    emit({ type: 'dom', subtype: 'mutation-batch', changes: domQueue, stats, interaction: interactionState(), attribution });
    domQueue = [];
    domSamplePatterns = new Set();
    domStats = makeDomStats();
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of keys) if (obj[key] != null && obj[key] !== '') return obj[key];
    return null;
  }
  function looksLikeQolTelemetry(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.source === BRIDGE_SOURCE || data.source === 'SPICYCHAT_INSPECTOR_CONTENT' || data.source === QOL_INSPECTOR_SOURCE) return false;
    const ids = [data.source, data.channel, data.origin, data.namespace, data.protocol, data.name, data.__source].filter(v => typeof v === 'string');
    return ids.some(v => QOL_SOURCE_RE.test(v));
  }
  function normalizedTraceNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function traceField(inner, data, keys) {
    return pick(inner, keys) ?? pick(data, keys);
  }
  function normalizeTraceOutcome(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).slice(0, 80);
      return text === '[object Object]' ? null : text;
    }
    if (typeof value === 'object') {
      for (const key of ['outcome','status','state','result','message']) {
        const nested = value?.[key];
        if (nested != null && ['string','number','boolean'].includes(typeof nested)) return String(nested).slice(0, 80);
      }
      if (typeof value.ok === 'boolean') return value.ok ? 'ok' : 'failed';
      if (typeof value.success === 'boolean') return value.success ? 'success' : 'failed';
    }
    return null;
  }
  function normalizeQolTelemetry(data, transport = 'postMessage', inherited = {}) {
    const inner = data.detail && typeof data.detail === 'object' ? data.detail : (data.payload && typeof data.payload === 'object' ? data.payload : data);
    const subtypeRaw = pick(inner, ['subtype','kind','event','action','eventType','type','phase']) || pick(data, ['subtype','kind','event','action','eventType','type']) || 'telemetry';
    const phase = pick(inner, ['phase','state','status']) || null;
    const sourceName = pick(inner, ['source','namespace','channel']) || pick(data, ['source','namespace','channel']) || null;
    const derivedFeature = typeof sourceName === 'string' && /^spicychat-qol-/i.test(sourceName) ? sourceName.replace(/^spicychat-qol-/i, '') : null;
    const feature = pick(inner, ['feature','featureId','featureName','ownerFeature']) || inherited.feature || derivedFeature || null;
    const moduleName = pick(inner, ['module','moduleId','component','area']) || inherited.module || null;
    const operation = pick(inner, ['operation','operationName','op','task']) || inherited.operation || null;
    const operationId = pick(inner, ['operationId','opId','traceId','spanId','id']) || inherited.operationId || null;
    const parentOperationId = pick(inner, ['parentOperationId','parentOpId','parentSpanId','triggerOperationId']) || inherited.parentOperationId || null;
    const requestId = pick(inner, ['requestId','networkRequestId','reqId']) || inherited.requestId || null;
    const url = pick(inner, ['url','requestedUrl','endpoint']) || inherited.requestedUrl || null;
    const requestFingerprint = pick(inner, ['requestFingerprint','fingerprint']) || inherited.requestFingerprint || null;
    const version = pick(inner, ['qolVersion','extensionVersion','version']) || pick(data, ['qolVersion','extensionVersion','version']) || inherited.qolVersion || null;
    const build = pick(inner, ['build','buildProfile','technicalVersion','manifestVersion']) || pick(data, ['build']) || inherited.build || null;
    const buildLabel = build && typeof build === 'object'
      ? [build.id, build.label].filter(Boolean).map(v => String(v).trim()).filter(Boolean).join(' / ')
      : (build != null ? String(build) : null);
    const sessionId = pick(inner, ['sessionId','pageSessionId','runtimeId','instanceId']) || pick(data, ['pageSessionId','sessionId']) || inherited.qolSessionId || null;
    const traceSessionId = pick(inner, ['traceSessionId','traceRunId','runtimeSessionId']) || inherited.traceSessionId || sessionId || null;
    const workerSessionId = pick(inner, ['workerSessionId','workerId','helperSessionId']) || inherited.workerSessionId || null;
    const protocol = String(data.protocol || inner.protocol || inherited.traceProtocol || '').slice(0, 120) || null;
    const subtype = `${subtypeRaw}${phase && !String(subtypeRaw).toLowerCase().includes(String(phase).toLowerCase()) ? `-${phase}` : ''}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 120);
    const sourceTs = normalizedTraceNumber(traceField(inner, data, ['ts','timestamp','time']));
    const monoMs = normalizedTraceNumber(traceField(inner, data, ['monoMs','performanceNow','perfNow','monotonicMs']));
    const seq = normalizedTraceNumber(traceField(inner, data, ['seq','sequence','sequenceNumber']));
    const durationMs = normalizedTraceNumber(traceField(inner, data, ['durationMs','elapsedMs','ms']));
    const queueDelayMs = normalizedTraceNumber(traceField(inner, data, ['queueDelayMs','waitMs','scheduledDelayMs']));
    const counts = inner?.counts && typeof inner.counts === 'object' ? sanitizeQolTrace(inner.counts) : null;
    const meta = inner?.meta && typeof inner.meta === 'object' ? sanitizeQolTrace(inner.meta) : null;
    return {
      type: 'qol', subtype: subtype || 'telemetry', transport,
      feature: feature ? String(feature).slice(0, 160) : null,
      module: moduleName ? String(moduleName).slice(0, 160) : null,
      operation: operation ? String(operation).slice(0, 160) : null,
      operationId: operationId ? String(operationId).slice(0, 200) : null,
      parentOperationId: parentOperationId ? String(parentOperationId).slice(0, 200) : null,
      requestId: requestId ? String(requestId).slice(0, 200) : null,
      requestFingerprint: requestFingerprint ? String(requestFingerprint).slice(0, 200) : null,
      requestedUrl: url ? redactString(String(url)).slice(0, 2000) : null,
      qolVersion: version ? String(version).slice(0, 120) : null,
      qolBuild: buildLabel ? buildLabel.slice(0, 160) : null,
      qolSessionId: sessionId ? String(sessionId).slice(0, 200) : null,
      traceSessionId: traceSessionId ? String(traceSessionId).slice(0, 200) : null,
      workerSessionId: workerSessionId ? String(workerSessionId).slice(0, 200) : null,
      traceProtocol: protocol,
      traceSeq: seq,
      sourceTs,
      monoMs,
      durationMs,
      queueDelayMs,
      category: traceField(inner, data, ['category','traceCategory']) ? String(traceField(inner, data, ['category','traceCategory'])).slice(0, 80) : null,
      lane: traceField(inner, data, ['lane','schedulerLane']) ? String(traceField(inner, data, ['lane','schedulerLane'])).slice(0, 80) : null,
      priority: traceField(inner, data, ['priority']) ? String(traceField(inner, data, ['priority'])).slice(0, 60) : null,
      outcome: normalizeTraceOutcome(traceField(inner, data, ['outcome','result'])),
      status: normalizedTraceNumber(traceField(inner, data, ['httpStatus','statusCode','status'])),
      storageKey: traceField(inner, data, ['storageKey','key']) ? String(traceField(inner, data, ['storageKey','key'])).slice(0, 180) : null,
      storageBackend: traceField(inner, data, ['storageBackend','backend']) ? String(traceField(inner, data, ['storageBackend','backend'])).slice(0, 80) : null,
      approxBytes: normalizedTraceNumber(traceField(inner, data, ['approxBytes','bytes','sizeBytes'])),
      records: normalizedTraceNumber(traceField(inner, data, ['records','recordCount','items'])),
      settingName: traceField(inner, data, ['settingName','setting','keyName']) ? String(traceField(inner, data, ['settingName','setting','keyName'])).slice(0, 160) : null,
      counts,
      meta,
      attribution: { source: 'qol', confidence: 'confirmed', reason: 'Explicit QoL diagnostic telemetry.' },
      payload: sanitizeQolTrace(inner)
    };
  }
  function expandQolTelemetry(data, transport = 'postMessage') {
    const payload = data?.payload && typeof data.payload === 'object' ? data.payload : null;
    const candidates = payload?.events || payload?.traceEvents || payload?.batch || data?.events || data?.traceEvents;
    const isBatch = Array.isArray(candidates) && /(?:trace-?batch|batch|events)/i.test(String(data?.type || payload?.type || 'trace-batch'));
    if (!isBatch) return [normalizeQolTelemetry(data, transport)];
    const inherited = {
      qolVersion: data.qolVersion || payload?.qolVersion || null,
      build: data.build || payload?.build || null,
      qolSessionId: data.pageSessionId || data.sessionId || payload?.pageSessionId || payload?.sessionId || null,
      traceSessionId: data.traceSessionId || payload?.traceSessionId || null,
      traceProtocol: data.protocol || payload?.protocol || null
    };
    // Cap normalization cost before creating/sanitizing hundreds of trace objects.
    const limit = IS_FIREFOX_ANDROID ? MOBILE_TRACE_BATCH_LIMIT : 1000;
    if (IS_FIREFOX_ANDROID && candidates.length > limit) mobileTraceDropped += candidates.length - limit;
    return candidates.slice(0, limit).map((raw, index) => {
      const child = raw && typeof raw === 'object' ? raw : { type: 'trace-value', value: raw };
      const childData = {
        source: data.source,
        protocol: data.protocol,
        qolVersion: data.qolVersion || payload?.qolVersion,
        build: data.build || payload?.build,
        pageSessionId: data.pageSessionId || payload?.pageSessionId,
        ts: child.ts ?? data.ts,
        payload: child
      };
      const normalized = normalizeQolTelemetry(childData, `${transport}:batch`, inherited);
      normalized.traceBatchIndex = index;
      normalized.traceBatchSize = candidates.length;
      return normalized;
    });
  }
  function operationKey(e) { return e.operationId || [e.feature,e.module,e.operation].filter(Boolean).join(':') || null; }
  function traceEventTs(e, fallback = Date.now()) {
    const source = Number(e?.sourceTs);
    if (Number.isFinite(source) && source > 1_500_000_000_000 && Math.abs(source - Date.now()) < 7 * 24 * 60 * 60 * 1000) return source;
    return Number(e?.ts) || fallback;
  }
  function noteQolTraceSequence(e) {
    if (!Number.isFinite(e.traceSeq)) return e;
    const key = `${e.traceSessionId || e.qolSessionId || 'session'}|${e.qolSessionId || PAGE_ID}`;
    const previous = qolTraceSequence.get(key);
    if (Number.isFinite(previous) && e.traceSeq > previous + 1) e.traceSequenceGapBefore = Math.max(0, e.traceSeq - previous - 1);
    if (!Number.isFinite(previous) || e.traceSeq > previous) qolTraceSequence.set(key, e.traceSeq);
    return e;
  }
  function pruneCompletedQolOperations(now = Date.now()) {
    while (completedQolOperations.length > 800 || (completedQolOperations[0] && now - completedQolOperations[0].endTs > 10 * 60_000)) completedQolOperations.shift();
    for (const [key, ts] of completedQolOperationKeys) {
      if (now - ts > 10 * 60_000) completedQolOperationKeys.delete(key);
    }
  }
  function qolTelemetryDedupeIdentity(e, eventTs) {
    const strong = [];
    const session = String(e.traceSessionId || e.qolSessionId || PAGE_ID || 'session');
    const subtype = String(e.subtype || 'telemetry');
    const boundaryLike = /(?:^|[-_:])(?:operation-?|op-?)?(?:start|begin|started|enter|end|finish|finished|complete|completed|stop|stopped|exit)(?:$|[-_:])/.test(`-${subtype}-`);
    const hasSeq = Number.isFinite(e.traceSeq);
    // A real v2 sequence number is the canonical identity. Operation/request
    // aliases are only for legacy/no-seq compatibility copies; otherwise two
    // distinct v2 events in the same operation could be collapsed.
    if (!hasSeq && e.operationId && boundaryLike) strong.push(`op|${session}|${e.operationId}|${subtype}`);
    if (!hasSeq && e.requestId && /network|request|response/.test(subtype)) strong.push(`req|${session}|${e.requestId}|${subtype}`);
    if (hasSeq) strong.push(`seq|${session}|${e.traceSeq}`);
    // The fallback joins v1 compatibility copies to their v2 counterpart. It is
    // never allowed to collapse two different sequence-numbered v2 events.
    const sourceBucket = Number.isFinite(Number(e.sourceTs)) ? Math.round(Number(e.sourceTs)) : Math.round(Number(eventTs) || 0);
    const fallback = [
      'evt', session, subtype, e.feature || '', e.module || '', e.operation || '',
      e.operationId || '', e.requestId || '', e.requestFingerprint || '', sourceBucket
    ].join('|');
    return { strong:[...new Set(strong)], fallback, hasSeq };
  }
  function shouldDedupeQolTelemetry(e, eventTs, receivedAt) {
    const heartbeatLike = /handshake|hello|presence|ready|initialized|init|heartbeat/.test(e.subtype || '');
    const dedupeMs = heartbeatLike ? QOL_HEARTBEAT_DEDUPE_MS : Math.max(QOL_TELEMETRY_DEDUPE_MS, 5000);
    const identity = qolTelemetryDedupeIdentity(e, eventTs);
    for (const key of identity.strong) {
      const prev = recentQolTelemetryFingerprints.get(key);
      if (prev && receivedAt - prev.ts <= dedupeMs) return true;
    }
    const fallbackPrev = recentQolTelemetryFingerprints.get(identity.fallback);
    if (fallbackPrev && receivedAt - fallbackPrev.ts <= dedupeMs && (!identity.hasSeq || !fallbackPrev.hasSeq)) return true;

    const record = { ts:receivedAt, hasSeq:identity.hasSeq };
    for (const key of identity.strong) recentQolTelemetryFingerprints.set(key, record);
    // Preserve the first sequence-numbered owner of a fallback alias. A later
    // distinct v2 event may legitimately have the same timestamp/shape.
    if (!fallbackPrev || !fallbackPrev.hasSeq || !identity.hasSeq) recentQolTelemetryFingerprints.set(identity.fallback, record);
    if (recentQolTelemetryFingerprints.size > 4096) {
      for (const [key, value] of recentQolTelemetryFingerprints) {
        if (receivedAt - Number(value?.ts || 0) > 120_000) recentQolTelemetryFingerprints.delete(key);
      }
      if (recentQolTelemetryFingerprints.size > 4096) {
        const oldest = [...recentQolTelemetryFingerprints.entries()].sort((a,b) => Number(a[1]?.ts||0)-Number(b[1]?.ts||0)).slice(0,1024);
        for (const [key] of oldest) recentQolTelemetryFingerprints.delete(key);
      }
    }
    return false;
  }
  // An eventual background Memory Probe bridge event must never turn into a
  // second channel for private Memory content. Only a fixed aggregate schema
  // survives, even if a future QoL release accidentally sends more fields.
  function sanitizeMemoryProbeDiagnostic(e) {
    const signal = `${e.feature || ''} ${e.operation || ''} ${e.subtype || ''}`.toLowerCase();
    if (!/(?:native[-_]?memory[-_]?probe|memory[-_]?quality[-_]?probe|memory[-_]?check)/.test(signal)) return e;
    const input = {...(e.payload && typeof e.payload === 'object' ? e.payload : {}),
      ...(e.meta && typeof e.meta === 'object' ? e.meta : {})};
    const safe = {};
    for (const key of ['status','probeStatus','outcome']) {
      if (typeof input[key] === 'string' && /^[a-z0-9 -]{1,65}$/i.test(input[key])) safe[key] = input[key].slice(0,65);
    }
    for (const key of ['ok','baseline','changed']) if (typeof input[key] === 'boolean') safe[key] = input[key];
    for (const key of ['count','added','removed','updated','httpStatus','durationMs','elapsedMs']) {
      const v = input[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 120000) safe[key] = v;
    }
    e.meta = safe;
    e.payload = { ...safe };
    e.counts = null;
    e.requestedUrl = null;
    e.storageKey = null;
    e.requestId = null;
    e.requestFingerprint = null;
    e.operationId = null;
    e.parentOperationId = null;
    return e;
  }

  function trackQolTelemetry(e) {
    const receivedAt = Date.now();
    const eventTs = traceEventTs(e, receivedAt);
    e = sanitizeMemoryProbeDiagnostic(noteQolTraceSequence({ ...e, ts: eventTs, receivedAt }));
    if (shouldDedupeQolTelemetry(e, eventTs, receivedAt)) return;

    recentQol.push(e);
    while (recentQol.length > 500 || (recentQol[0] && receivedAt - recentQol[0].receivedAt > 120_000)) recentQol.shift();
    if (/handshake|hello|presence|ready|initialized|init/.test(e.subtype)) latestQolHandshake = { ts: eventTs, version: e.qolVersion, build: e.qolBuild, sessionId: e.qolSessionId, feature: e.feature, module: e.module, protocol: e.traceProtocol };
    const key = operationKey(e);
    const sessionKey = `${e.traceSessionId || e.qolSessionId || PAGE_ID}|${key || ''}`;
    const isStart = /(?:^|[-_:])(start|begin|started|enter)(?:$|[-_:])/.test(`-${e.subtype}-`);
    const isEnd = /(?:^|[-_:])(end|finish|finished|complete|completed|stop|stopped|exit)(?:$|[-_:])/.test(`-${e.subtype}-`);
    if (key && isStart) {
      // A delayed duplicate start from a compatibility transport must not
      // reopen an operation already completed via the canonical v2 path.
      if (!completedQolOperationKeys.has(sessionKey)) activeQolOperations.set(key, { ...e, startTs: eventTs });
    }
    if (key && isEnd) {
      const started = activeQolOperations.get(key);
      activeQolOperations.delete(key);
      if (!completedQolOperationKeys.has(sessionKey)) {
        const endTs = eventTs;
        const durationMs = Number.isFinite(e.durationMs) ? Math.max(0, e.durationMs) : (started ? Math.max(0, endTs - started.startTs) : null);
        const startTs = started?.startTs ?? (Number.isFinite(durationMs) ? endTs - durationMs : endTs);
        completedQolOperations.push({
          key, pageId: PAGE_ID, startTs, endTs, durationMs,
          feature: e.feature || started?.feature || null,
          module: e.module || started?.module || null,
          operation: e.operation || started?.operation || null,
          operationId: e.operationId || started?.operationId || null,
          parentOperationId: e.parentOperationId || started?.parentOperationId || null,
          outcome: e.outcome || null
        });
        completedQolOperationKeys.set(sessionKey, receivedAt);
        pruneCompletedQolOperations(receivedAt);
      }
    }
    emit(e);
  }
  function qolOperationsOverlapping(startTs, endTs) {
    const result = [];
    for (const op of activeQolOperations.values()) {
      const s = Number(op.startTs ?? op.ts) || 0;
      // Open operations are only a provisional correlation signal. Bound them
      // so a lost/late end marker cannot make later native tasks look QoL-related.
      if (s <= endTs && endTs - s <= 30_000) result.push({ feature:op.feature, module:op.module, operation:op.operation, operationId:op.operationId, startTs:s, endTs:null, active:true });
    }
    for (let i = completedQolOperations.length - 1; i >= 0; i--) {
      const op = completedQolOperations[i];
      if (op.endTs < startTs - 2500) break;
      if (op.startTs <= endTs && op.endTs >= startTs) result.push({ ...op, active:false, overlapMs: Math.max(0, Math.min(endTs, op.endTs) - Math.max(startTs, op.startTs)) });
      if (result.length >= 12) break;
    }
    return result.slice(0,12);
  }
  function qolContextFor(now = Date.now()) {
    const recent = recentQol.filter(e => now - (e.receivedAt || e.ts) <= 2500).slice(-12).map(e => ({ ts: e.ts, subtype: e.subtype, feature: e.feature, module: e.module, operation: e.operation, operationId: e.operationId, parentOperationId:e.parentOperationId, requestId: e.requestId, requestedUrl: e.requestedUrl, traceSeq:e.traceSeq }));
    const activeOperations = [...activeQolOperations.values()].filter(e => now - (e.receivedAt || e.ts) <= 120_000).slice(-12).map(e => ({ ts: e.ts, startTs:e.startTs, feature: e.feature, module: e.module, operation: e.operation, operationId: e.operationId, parentOperationId:e.parentOperationId }));
    return { handshake: latestQolHandshake, recent, activeOperations };
  }
  function correlateQolRequest(event, now = Date.now()) {
    const target = String(event.requestedUrl || event.finalUrl || event.url || '');
    const requestId = event.requestId || null;
    const fp = event.requestFingerprint || null;
    return recentQol.slice().reverse().find(q => {
      if (now - q.ts > 4000) return false;
      if (requestId && q.requestId && requestId === q.requestId) return true;
      if (fp && q.requestFingerprint && fp === q.requestFingerprint) return true;
      if (target && q.requestedUrl && target === q.requestedUrl) return true;
      return false;
    }) || null;
  }
  function knownQolStack(stack) {
    return /(?:card-token-main|spicychat[-_/ ]?qol|dragonscript|\bds[-_/][a-z0-9_-]+\.js)/i.test(String(stack || ''));
  }
  function stackHasSpicyNativeFrame(stack) {
    return /https:\/\/spicychat\.ai\/(?:assets\/)?(?:vendor|common|index)[^\s)]*\.js/i.test(String(stack || ''));
  }
  function stackLooksLikeQolObserverWrapper(stack) {
    const text = String(stack || '');
    return /(?:observedFetch|observedXHR|observedXhr|card-token-main\.js)/i.test(text) && stackHasSpicyNativeFrame(text);
  }
  function classifyNetwork(event) {
    const now = Date.now();
    const match = correlateQolRequest(event, now);
    if (match) return { source: 'qol', confidence: 'confirmed', reason: 'Matched explicit QoL network telemetry.', feature: match.feature, module: match.module, operationId: match.operationId, qolRequestId: match.requestId };
    const stack = String(event.initiator || '');
    if (/chrome-extension:\/\//i.test(stack)) {
      if (stackLooksLikeQolObserverWrapper(stack)) {
        return { source: 'spicychat-native', confidence: 'strong-stack-attribution', observedBy: 'qol', reason: 'QoL observer wrapper is present, but the deeper initiator frame is SpicyChat native page code.' };
      }
      if (knownQolStack(stack)) return { source: 'qol', confidence: 'likely', reason: 'Extension initiator stack matches a known QoL script/path.' };
      return { source: 'other-extension', confidence: 'confirmed', reason: 'Request initiator stack is an extension, but not explicitly matched to QoL.' };
    }
    try {
      const host = new URL(event.finalUrl || event.requestedUrl || event.url || '', location.href).hostname;
      if (!isSpicyChatCoreHost(host)) {
        const pageTriggered = /https:\/\/spicychat\.ai\/(?:assets\/)?/i.test(stack) || event.initiatorSourceHint === 'spicychat-page';
        return { source: 'third-party', confidence: 'confirmed', triggerSource: pageTriggered ? 'spicychat-native' : null, reason: pageTriggered ? 'Third-party destination requested by SpicyChat page code.' : 'Network destination is outside SpicyChat core hosts; no QoL correlation found.' };
      }
    } catch (_) {}
    if (/https:\/\/spicychat\.ai\/(?:assets\/)?/i.test(stack) || event.initiatorSourceHint === 'spicychat-page') return { source: 'spicychat-native', confidence: 'confirmed', reason: 'Initiator stack points to SpicyChat page code and destination is SpicyChat core.' };
    return { source: 'unknown-mixed', confidence: 'unknown', reason: 'No reliable initiator or QoL correlation.' };
  }
  function enrichBridgeEvent(event) {
    const e = { ...event };
    if (e.type === 'network') e.attribution = classifyNetwork(e);
    if (e.type === 'performance') {
      e.interaction = interactionState();
      if (e.subtype === 'long-task' || e.subtype === 'long-animation-frame') {
        const startTs=Number(e.entryStartTs) || Date.now()-Number(e.durationMs||0);
        e.inputCorrelation=interactionPerfContext(startTs);
      }
      if (e.subtype === 'long-task' && qolInternalsEnabled()) {
        const ctx = qolContextFor(Date.now());
        const startTs = Number(e.entryStartTs) || (Date.now() - Number(e.durationMs || 0));
        const endTs = Number(e.entryEndTs) || (startTs + Number(e.durationMs || 0));
        const overlap = qolOperationsOverlapping(startTs, endTs);
        if (overlap.length) e.attribution = { source: 'unknown-mixed', confidence: 'strong-correlation', triggerSource: 'qol', executor: 'main-thread/page', reason: 'Long Task time interval overlapped an explicit QoL operation.', qol: { ...ctx, overlappingOperations: overlap } };
        else if (ctx.activeOperations.length || ctx.recent.length) e.attribution = { source: 'unknown-mixed', confidence: 'correlated', triggerSource: 'qol', executor: 'main-thread/page', reason: 'QoL telemetry was active/nearby, but no completed QoL interval overlap was verified at capture time.', qol: ctx };
      }
    }
    return e;
  }
  function qolInternalsEnabled() {
    return !!(settings?.recording && settings?.captureQolInternals);
  }
  function onQolMessage(data, transport) {
    if (!qolInternalsEnabled()) return;
    if (!looksLikeQolTelemetry(data)) return;
    try {
      const events=expandQolTelemetry(data, transport);
      const accepted = [];
      const now = Date.now();
      if (IS_FIREFOX_ANDROID && now - mobileTraceSecond >= 1000) {
        mobileTraceSecond = now;
        mobileTraceAccepted = 0;
      }
      for (const event of events) {
        // Keep only a bounded sample of high-frequency trace data on mobile.
        // Privacy rules and the detailed-tracing setting still apply unchanged.
        if (IS_FIREFOX_ANDROID && mobileTraceAccepted >= MOBILE_TRACE_EVENTS_PER_SECOND &&
            !/^(handshake|hello|presence|error|operation-failed)/.test(event.subtype || '')) {
          mobileTraceDropped++;
          continue;
        }
        if (IS_FIREFOX_ANDROID) mobileTraceAccepted++;
        accepted.push(event);
        trackQolTelemetry(event);
      }
      if (IS_FIREFOX_ANDROID && now - mobileTraceReportedAt >= 10000 && mobileTraceDropped) {
        emit({ type: 'performance', subtype: 'mobile-trace-sampling',
          droppedEvents: mobileTraceDropped, batchLimit: MOBILE_TRACE_BATCH_LIMIT,
          maxEventsPerSecond: MOBILE_TRACE_EVENTS_PER_SECOND,
          coverage: 'sampled', reason: 'Firefox Android trace budget; missing sequences here are deliberate sampling, not proven QoL delivery failures.' });
        mobileTraceDropped = 0;
        mobileTraceReportedAt = now;
      }
      const traceCount=accepted.filter(e=>Number.isFinite(e.traceSeq) || Number.isFinite(e.traceBatchSize) || /^(operation-start|operation-end|operation-profile|scheduler|storage|worker)/.test(e.subtype||'')).length;
      const handshakes=accepted.filter(e=>/handshake|hello|presence|ready|initialized/.test(e.subtype||'')).length;
      qolHandshakeResponses+=handshakes;
      const previouslyReceived=qolTracesSeen;
      qolTracesSeen+=traceCount;
      if (traceCount) qolLastTraceTs=Date.now();
      if (traceCount && !previouslyReceived) emit({type:'performance',subtype:'qol-trace-link-status',status:'trace-received',received:traceCount,handshakes:qolHandshakeResponses,traceLevel:effectiveQolTraceLevel(),qolIdentity:passiveQolIdentity()});
    } catch (_) {}
  }
  function effectiveQolTraceLevel() {
    if (!qolInternalsEnabled()) return 'off';
    // Android requests normal (not deep) from QoL to avoid generating enormous
    // telemetry streams on a device already handling a busy chat.
    if (IS_FIREFOX_ANDROID) return 'normal';
    const level = String(settings?.qolTraceLevel || 'deep').toLowerCase();
    return ['normal','deep'].includes(level) ? level : 'deep';
  }
  function dispatchQolDiagnosticRequest(protocol, type, reason = '') {
    const message = {
      protocol,
      source: QOL_INSPECTOR_SOURCE,
      type,
      ts: Date.now(),
      payload: {
        inspectorVersion: INSPECTOR_VERSION,
        inspectorSessionId: INSPECTOR_SESSION_ID,
        recording: !!settings?.recording,
        traceLevel: effectiveQolTraceLevel(),
        reason: String(reason || type).slice(0,80),
        requestedProtocols: [QOL_PROTOCOL_V2, QOL_PROTOCOL_V1],
        capabilities: ['trace-batch','operation-spans','scheduler','storage','workers','settings','background-forwarding','sequence-gap-detection','performance-correlation']
      }
    };
    try { window.postMessage(message, '*'); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent(QOL_REQUEST_EVENT, { detail: JSON.stringify(message) })); } catch (_) {}
  }
  function announceInspectorToQol(reason = 'hello') {
    if (qolInternalsEnabled()) {
      qolHandshakeRequests++;
      const serial=++qolTraceCheckSerial;
      if (reason !== 'presence') setTimeout(() => {
        if (serial !== qolTraceCheckSerial || !qolInternalsEnabled()) return;
        emit({type:'performance',subtype:'qol-trace-link-status',status:qolTracesSeen?'trace-received':(qolHandshakeResponses?'handshake-only':'no-response'),
          handshakes:qolHandshakeRequests,handshakeResponses:qolHandshakeResponses,received:qolTracesSeen,lastTraceAgeMs:qolLastTraceTs?Date.now()-qolLastTraceTs:null,
          traceLevel:effectiveQolTraceLevel(),qolIdentity:passiveQolIdentity(),
          reason:qolTracesSeen?'detailed-telemetry-received':qolHandshakeResponses?'Protocol handshake received, but no detailed operation traces; check trace activity and QoL instrumentation.':'No protocol response observed; check QoL availability, listener timing, and enabled trace settings.'});
      },QOL_TRACE_CHECK_DELAY_MS);
    }
    dispatchQolDiagnosticRequest(QOL_PROTOCOL_V2, 'hello', reason);
    dispatchQolDiagnosticRequest(QOL_PROTOCOL_V1, 'hello', reason);
  }
  function requestQolMetrics(reason = 'snapshot') {
    dispatchQolDiagnosticRequest(QOL_PROTOCOL_V2, 'request-metrics', reason);
    dispatchQolDiagnosticRequest(QOL_PROTOCOL_V1, 'request-metrics', reason);
  }
  function startQolPresence() {
    if (!qolInternalsEnabled() || qolPresenceTimer) return;
    qolPresenceTimer = setInterval(() => {
      if (qolInternalsEnabled() && document.visibilityState === 'visible') announceInspectorToQol('presence');
    }, 60_000);
  }
  function stopQolPresence() {
    if (!qolPresenceTimer) return;
    clearInterval(qolPresenceTimer);
    qolPresenceTimer = null;
  }
  function installQolCompatibilityListeners() {
    for (const name of QOL_EVENT_NAMES) document.addEventListener(name, e => {
      let detail = e?.detail;
      if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) {} }
      if (detail && typeof detail === 'object' && (detail.protocol || detail.source || detail.payload)) onQolMessage(detail, `CustomEvent:${name}`);
      else onQolMessage({ source: name, detail: { value: detail } }, `CustomEvent:${name}`);
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (qolInternalsEnabled() && document.visibilityState === 'visible') announceInspectorToQol('visible');
    }, true);
  }

  function perfEntryKey(kind, e) { return `${kind}|${e.name || ''}|${Math.round((e.startTime || 0) * 10) / 10}|${Math.round((e.duration || 0) * 10) / 10}`; }
  function firstPerformanceEntry(kind, e) {
    const bucket = seenPerformanceEntries[kind] || (seenPerformanceEntries[kind] = new Set());
    const key = perfEntryKey(kind, e);
    if (bucket.has(key)) return false;
    bucket.add(key);

    // Resource timing is high-volume, so keep it bounded. Long-task and LoAF keys
    // are low-volume enough to retain for the lifetime of the page; this prevents
    // old buffered entries from reappearing after observer restarts.
    if (kind === 'resource' && bucket.size > 20000) {
      const keep = [...bucket].slice(-10000);
      bucket.clear();
      keep.forEach(x => bucket.add(x));
    }
    return true;
  }

  function scriptSourceKind(sourceURL) {
    const src = String(sourceURL || '');
    if (!src) return 'unknown-mixed';
    if (/^chrome-extension:\/\//i.test(src)) {
      if (src.includes(`chrome-extension://${chrome.runtime.id}/`)) return 'inspector-self';
      if (knownQolStack(src)) return 'qol';
      return 'other-extension';
    }
    try {
      const parsed = new URL(src, location.href);
      const host = parsed.hostname;
      // Cloudflare's injected /cdn-cgi/ runtime is site infrastructure, not
      // SpicyChat application code. Treating it as native made LoAF attribution
      // over-credit SpicyChat bundles simply because Rocket Loader is served
      // from the same origin.
      if (/^\/cdn-cgi\//i.test(parsed.pathname)) return 'third-party';
      if (isSpicyChatCoreHost(host)) return 'spicychat-native';
      return 'third-party';
    } catch (_) {
      return 'unknown-mixed';
    }
  }

  function loafScripts(entry) {
    return Array.from(entry.scripts || []).map(s => ({
      sourceURL: redactString(s.sourceURL || ''),
      functionName: s.sourceFunctionName || s.functionName || null,
      invoker: s.invoker || null,
      invokerType: s.invokerType || null,
      durationMs: Math.round((s.duration || 0) * 10) / 10,
      forcedStyleAndLayoutMs: Math.round((s.forcedStyleAndLayoutDuration || 0) * 10) / 10,
      pauseMs: Math.round((s.pauseDuration || 0) * 10) / 10,
      executionStartMs: Math.round((s.executionStart || 0) * 10) / 10,
      windowAttribution: s.windowAttribution || null,
      sourceKind: scriptSourceKind(s.sourceURL || '')
    })).sort((a,b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 8);
  }

  function classifyLoafScripts(scripts) {
    const useful = scripts.filter(s => s.sourceKind && s.sourceKind !== 'inspector-self' && s.sourceKind !== 'unknown-mixed');
    if (!useful.length) return { source: 'unknown-mixed', confidence: 'unknown', reason: 'Long Animation Frame exposed no attributable non-Inspector script URL.' };

    const totals = new Map();
    for (const s of useful) totals.set(s.sourceKind, (totals.get(s.sourceKind) || 0) + (s.durationMs || 0));
    const ranked = [...totals.entries()].sort((a,b) => b[1] - a[1]);
    const [topSource, topMs] = ranked[0];
    const allMs = ranked.reduce((n, x) => n + x[1], 0);
    const share = allMs ? topMs / allMs : 0;

    if (ranked.length === 1 || share >= 0.8) {
      return {
        source: topSource,
        confidence: 'strong-script-attribution',
        reason: `Long Animation Frame script timings are dominated by ${topSource} (${Math.round(share * 100)}%).`,
        scriptShare: share
      };
    }
    return {
      source: 'unknown-mixed',
      confidence: 'mixed-script-attribution',
      reason: 'Long Animation Frame contains material work from multiple script sources.',
      contributors: ranked.slice(0, 5).map(([source, ms]) => ({ source, ms: Math.round(ms * 10) / 10 }))
    };
  }

  function configureResourceTimingBuffer() {
    if (resourceTimingConfigured) return;
    resourceTimingConfigured = true;
    try {
      if (typeof performance.setResourceTimingBufferSize === 'function') performance.setResourceTimingBufferSize(RESOURCE_TIMING_BUFFER_SIZE);
    } catch (_) {}
    try {
      if (!resourceTimingBufferFullListenerInstalled && performance.addEventListener) {
        resourceTimingBufferFullListenerInstalled = true;
        performance.addEventListener('resourcetimingbufferfull', () => {
          resourceTimingBufferFullOccurrences++;
          resourceEntriesSinceClear = 0;
          const now = Date.now();
          const resourceEntries = (() => { try { return performance.getEntriesByType('resource').length; } catch (_) { return null; } })();
          // Once full, Chromium can fire this event repeatedly for every later resource
          // until somebody clears the buffer. Harvesting is handled by PerformanceObserver,
          // so clear the retained browser buffer here instead of recording thousands of
          // identical "still full" events in long helper/API scans.
          let clearAttempted = false;
          let cleared = false;
          let clearError = null;
          try {
            if (typeof performance.clearResourceTimings === 'function') {
              clearAttempted = true;
              performance.clearResourceTimings();
              cleared = true;
            }
          } catch (err) { clearError = String(err?.message || err || 'clearResourceTimings failed').slice(0, 300); }
          if (now - lastResourceTimingBufferFullHandledAt < RESOURCE_TIMING_BUFFER_REPEAT_GUARD_MS) {
            resourceTimingBufferFullSuppressed++;
            return;
          }
          const suppressedSinceLast = resourceTimingBufferFullSuppressed;
          resourceTimingBufferFullSuppressed = 0;
          lastResourceTimingBufferFullHandledAt = now;
          emit({
            type: 'performance', subtype: 'resource-timing-buffer-full',
            configuredSize: RESOURCE_TIMING_BUFFER_SIZE, resourceEntries, clearAttempted, cleared, clearError,
            occurrence: resourceTimingBufferFullOccurrences, suppressedSinceLast,
            interaction: interactionState()
          });
        });
      }
    } catch (_) {}
  }

  function startPerformanceObservers() {
    stopPerformanceObservers();
    if (!settings?.capturePerformance || !window.PerformanceObserver) return;
    configureResourceTimingBuffer();
    if (IS_FIREFOX_ANDROID) {
      const supported = PerformanceObserver.supportedEntryTypes || [];
      emit({type:'performance',subtype:'mobile-browser-capabilities',
        longTaskSupported:supported.includes('longtask'),
        longAnimationFrameSupported:supported.includes('long-animation-frame'),
        eventTimingSupported:supported.includes('event'),
        domCapture:'child-list-only', qosTraceSampling:true,
        note:'Unsupported browser timing APIs cannot be interpreted as zero long tasks.'});
    }
    try {
      const resourceObserver = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (!firstPerformanceEntry('resource', e)) continue;
          maybeProactiveClearResourceTimings();
          const thirdParty = (() => { try { return !isSpicyChatCoreHost(new URL(e.name).hostname); } catch (_) { return false; } })();
          const workerGroup = workerResourceGroup(e);
          const workerOutlier = Number(e.duration || 0) >= 1500 || recentLongTasks.some(x => Date.now() - x.ts <= 1500);
          if (workerGroup && !workerOutlier) {
            aggregateWorkerResource(e, workerGroup);
            continue;
          }
          if (!importantResourceTiming(e, thirdParty) || Date.now() < selfThrottleUntil) {
            if (thirdParty) aggregateResource(e);
            continue;
          }
          emit({ type: 'performance', subtype: 'resource', name: redactString(e.name), initiatorType: e.initiatorType, durationMs: Math.round(e.duration * 10) / 10, transferSize: e.transferSize || 0, encodedBodySize: e.encodedBodySize || 0, decodedBodySize: e.decodedBodySize || 0, startTimeMs: Math.round(e.startTime * 10) / 10, thirdParty, protocol: e.nextHopProtocol || null, workerRole: workerGroup?.workerRole || null, endpointGroup: workerGroup?.endpointGroup || null, interaction: interactionState() });
        }
      });
      resourceObserver.observe({ type: 'resource', buffered: true });
      perfObservers.push(resourceObserver);
    } catch (_) {}
    try {
      const longTaskObserver = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (!firstPerformanceEntry('long-task', e)) continue;
          noteLongTaskSpike(e);
          const entryStartTs = Math.round((performance.timeOrigin + e.startTime) * 10) / 10;
          const entryEndTs = Math.round((entryStartTs + e.duration) * 10) / 10;
          emit(enrichBridgeEvent({ type: 'performance', subtype: 'long-task', durationMs: Math.round(e.duration * 10) / 10, startTimeMs: Math.round(e.startTime * 10) / 10, entryStartTs, entryEndTs }));
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true });
      perfObservers.push(longTaskObserver);
    } catch (_) {}
    try {
      if (PerformanceObserver.supportedEntryTypes?.includes('event')) {
        try {
          const eventObserver=new PerformanceObserver(list=>{
            for(const e of list.getEntries()) {
              if (!/^(click|pointerdown|pointerup|mousedown|mouseup|keydown|wheel|touchstart|touchmove)$/.test(String(e.name||''))) continue;
              if (e.duration < 120 || document.hidden) continue;
              emit({type:'performance',subtype:'slow-input-event',eventKind:e.name,
                durationMs:Math.round(e.duration*10)/10,
                inputDelayMs:Math.round(Math.max(0,(e.processingStart||0)-(e.startTime||0))*10)/10,
                processingMs:Math.round(Math.max(0,(e.processingEnd||0)-(e.processingStart||0))*10)/10,
                entryStartTs:Math.round(performance.timeOrigin+(e.startTime||0)),
                // Event Timing excludes input contents/target; threshold is high.
                attribution:{source:'unknown-mixed',confidence:'temporal-correlation',reason:'Slow browser Event Timing entry; no owning script identified.'}});
            }
          });
          eventObserver.observe({type:'event',durationThreshold:120,buffered:false});
          perfObservers.push(eventObserver);
        } catch (_) {}
      }
      if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
        const loafObserver = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (!firstPerformanceEntry('long-animation-frame', e)) continue;
            const scripts = loafScripts(e);
            emit({
              type: 'performance',
              subtype: 'long-animation-frame',
              durationMs: Math.round((e.duration || 0) * 10) / 10,
              blockingDurationMs: Math.round((e.blockingDuration || 0) * 10) / 10,
              startTimeMs: Math.round((e.startTime || 0) * 10) / 10,
              entryStartTs: Math.round((performance.timeOrigin + (e.startTime || 0)) * 10) / 10,
              entryEndTs: Math.round((performance.timeOrigin + (e.startTime || 0) + (e.duration || 0)) * 10) / 10,
              renderStartMs: Math.round((e.renderStart || 0) * 10) / 10,
              styleAndLayoutStartMs: Math.round((e.styleAndLayoutStart || 0) * 10) / 10,
              scripts,
              inputCorrelation:interactionPerfContext(Math.round(performance.timeOrigin + (e.startTime || 0))),
              attribution: classifyLoafScripts(scripts),
              interaction: interactionState()
            });
          }
        });
        loafObserver.observe({ type: 'long-animation-frame', buffered: true });
        perfObservers.push(loafObserver);
      }
    } catch (_) {}
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && !navigationCaptured) { navigationCaptured = true; emit({ type: 'performance', subtype: 'navigation', durationMs: Math.round(nav.duration * 10) / 10, domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd * 10) / 10, loadMs: Math.round(nav.loadEventEnd * 10) / 10, transferSize: nav.transferSize || 0, encodedBodySize: nav.encodedBodySize || 0, decodedBodySize: nav.decodedBodySize || 0, protocol: nav.nextHopProtocol || null, interaction: interactionState() }); }
    } catch (_) {}
  }
  function stopPerformanceObservers() { for (const o of perfObservers) try { o.disconnect(); } catch (_) {} perfObservers = []; }

  function installErrorCapture() {
    if (errorCaptureInstalled) return;
    errorCaptureInstalled = true;
    window.addEventListener('error', e => {
      if (!settings?.captureErrors) return;
      const target = e.target;
      if (target && target !== window && target.nodeType === Node.ELEMENT_NODE) {
        const src = target.currentSrc || target.src || target.href || '';
        const tag = target.tagName?.toLowerCase() || null;
        if (isLikelyNonCriticalTracker(src)) {
          aggregateTrackerError(src, tag);
          return;
        }
        emit({ type: 'error', subtype: 'resource-error', tag, resourceUrl: redactString(src), thirdParty: (() => { try { return !isSpicyChatCoreHost(new URL(src, location.href).hostname); } catch (_) { return null; } })(), likelyNonCriticalTracker: false, interaction: interactionState() });
        return;
      }
      const message = redactString(e.message || '');
      const filename = redactString(e.filename || '');
      const error = redactString(e.error?.stack || String(e.error || ''));
      if (!message && !filename && !error) return;
      emit({ type: 'error', subtype: 'window-error', message, filename, line: e.lineno || null, col: e.colno || null, error, interaction: interactionState() });
    }, true);
    window.addEventListener('unhandledrejection', e => {
      if (!settings?.captureErrors) return;
      emit({ type: 'error', subtype: 'unhandled-rejection', reason: redactString(e.reason?.stack || String(e.reason || '')), interaction: interactionState() });
    });
  }

  function requestBridge(command, payload = {}) { window.postMessage({ source: 'SPICYCHAT_INSPECTOR_CONTENT', pageId: PAGE_ID, command, payload }, '*'); }
  function htmlSnapshot() {
    const root = document.documentElement?.cloneNode(true);
    if (!root) return;
    root.querySelectorAll('input,textarea,select').forEach(el => { if ('value' in el) el.setAttribute('value', '[REDACTED_FORM_VALUE]'); if (el.tagName === 'TEXTAREA') el.textContent = '[REDACTED_FORM_VALUE]'; });
    root.querySelectorAll('script').forEach(s => { if (!s.src) s.textContent = '[INLINE_SCRIPT_OMITTED]'; });
    let html = root.outerHTML;
    const max = 2_000_000;
    if (html.length > max) html = html.slice(0, max) + '\n<!-- TRUNCATED -->';
    emit({ type: 'dom', subtype: 'html-snapshot', html: redactString(html), title: document.title });
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    if (e.data.source === BRIDGE_SOURCE && e.data.pageId === PAGE_ID) {
      const event = enrichBridgeEvent(e.data.event || {});
      beginGenerationRenderWindow(event);
      if (event.type === 'network') handleBridgeNetworkEvent(event);
      else if (event.type === 'storage') handleStorageEvent(event);
      else emit(event);
      return;
    }

    // Optional SpicyChat Test Driver bridge. Inspector remains completely
    // independent: with no Driver installed these messages simply never occur.
    if (e.data.source === TEST_DRIVER_SOURCE) {
      if (e.data.type === 'probe-inspector') {
        driverProbeCount++;
        const now = Date.now();
        if (!lastDriverProbeEmitAt || now - lastDriverProbeEmitAt >= 60_000) {
          noteDriverHeartbeat('probe');
          driverProbeCount = 0;
          lastDriverProbeEmitAt = now;
        }
        try {
          window.postMessage({
            source: TEST_DRIVER_STATUS_SOURCE,
            nonce: e.data.nonce || null,
            ready: !!settings,
            recording: !!settings?.recording,
            version: INSPECTOR_VERSION
          }, '*');
        } catch (_) {}
        return;
      }

      if (e.data.type === 'driver-marker') {
        const m = sanitize(e.data.marker || {});
        const action = String(m.action || m.subtype || 'action').slice(0, 120);
        if (action === 'scheduler-heartbeat' || action === 'inspector-probe-heartbeat') {
          noteDriverHeartbeat(action === 'scheduler-heartbeat' ? 'scheduler' : 'probe', m);
          return;
        }
        emit({
          type: 'driver',
          subtype: action,
          action,
          phase: String(m.phase || 'event').slice(0, 80),
          role: String(m.role || '').slice(0, 40),
          driverPageType: String(m.pageType || '').slice(0, 120),
          driverTarget: m.target ?? null,
          driverLabel: m.label ?? null,
          driverPath: m.path ?? null,
          driverNumber: Number.isFinite(Number(m.number)) ? Number(m.number) : null,
          driverAttempt: Number.isFinite(Number(m.attempt)) ? Number(m.attempt) : null,
          driverDurationMs: Number.isFinite(Number(m.durationMs)) ? Number(m.durationMs) : null,
          driverHref: m.href ? redactString(String(m.href)).slice(0, 500) : null,
          interaction: interactionState()
        });
        return;
      }
    }

    onQolMessage(e.data, 'postMessage');
  });
  installQolCompatibilityListeners();
  installInteractionCapture();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'SCI_COMMAND') return;
    if (message.command === 'snapshot-html') { htmlSnapshot(); sendResponse({ ok: true }); return; }
    if (message.command === 'request-qol-trace' && qolInternalsEnabled()) {
      announceInspectorToQol('manual-request'); requestQolMetrics('manual-request');
      sendResponse({ ok: true }); return;
    }
    // Manual markers and manual state snapshots are retired. Do not silently
    // claim success when an old popup or another extension sends their commands.
    sendResponse({ ok: false, error: 'This Inspector command is disabled or unavailable.' });
  });

  chrome.runtime.sendMessage({ type: 'SCI_GET_SETTINGS' }).then(res => {
    settings = res?.settings || { recording: true, captureDom: true, capturePerformance: true, captureErrors: true, captureQolInternals: false };
    injectBridge(); startDomObserver(); startPerformanceObservers(); installErrorCapture(); startPressureSampling();
    emit({type:'performance',subtype:'qol-trace-capture-config',enabled:qolInternalsEnabled(),traceLevel:effectiveQolTraceLevel(),qolIdentity:passiveQolIdentity()});
    if (qolInternalsEnabled()) {
      startQolPresence();
      setTimeout(() => announceInspectorToQol('startup'), 50);
      setTimeout(() => announceInspectorToQol('startup-retry'), 1000);
      setTimeout(() => { announceInspectorToQol('startup-settled'); requestQolMetrics('startup-settled'); }, 3000);
    }
    emit({ type: 'lifecycle', subtype: 'page-start', title: document.title, href: redactString(location.href), userAgent: navigator.userAgent, wasDiscarded: !!document.wasDiscarded, interaction: interactionState(), inspectorVersion: INSPECTOR_VERSION, qolIdentity: passiveQolIdentity(), captureProfile: isQolWorkerPage() ? 'qol-worker-lite' : IS_FIREFOX_ANDROID ? 'firefox-android-lightweight' : 'adaptive-lite' });
    if (isQolWorkerPage()) emit({ type: 'performance', subtype: 'worker-capture-profile', workerRole: PAGE_ROLE, domObserver: false, resourceTiming: 'aggregated-with-outliers', interaction: interactionState() });
    emit({ type: 'lifecycle', subtype: 'network-connectivity', connectivity: connectionState(), interaction: interactionState() });
    setTimeout(() => captureLightweightStateSnapshot('page-start', false, false).catch(() => {}), 1200);
  }).catch(() => {
    settings = { recording: true, captureDom: true, capturePerformance: true, captureErrors: true, captureQolInternals: false };
    injectBridge(); startDomObserver(); startPerformanceObservers(); installErrorCapture(); startPressureSampling();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sci_settings) return;
    const wasQolInternals = qolInternalsEnabled();
    const wasRecording = settings?.recording !== false;
    const nextSettings = { ...(settings || {}), ...(changes.sci_settings.newValue || {}) };
    if (wasRecording && nextSettings.recording === false) flushTransientAggregates('recording-stopped');
    settings = nextSettings;
    if (wasQolInternals !== qolInternalsEnabled()) {
      qolTracesSeen=0; qolHandshakeResponses=0; qolLastTraceTs=0; qolHandshakeRequests=0; qolTraceCheckSerial++;
      emit({type:'performance',subtype:'qol-trace-capture-config',enabled:qolInternalsEnabled(),traceLevel:effectiveQolTraceLevel(),qolIdentity:passiveQolIdentity()});
    }
    if (!settings.capturePerformance) finishScrollSample('capture-disabled');
    if (settings.captureDom) startDomObserver(); else stopDomObserver();
    startPerformanceObservers();
    const nowQolInternals = qolInternalsEnabled();
    if (nowQolInternals) {
      startQolPresence();
      announceInspectorToQol('settings-change');
      setTimeout(() => requestQolMetrics('settings-change'), 100);
    } else {
      stopQolPresence();
      // If detailed tracing was active, send one explicit OFF handshake so QoL
      // stops immediately instead of waiting for its peer TTL to expire.
      if (wasQolInternals) announceInspectorToQol('settings-change-off');
      activeQolOperations.clear();
      completedQolOperations.length = 0;
      recentQol.length = 0;
    }
  });
})();

/* <SCI_DRIVER_SUPPORT_V2> */
(() => {
  'use strict';

  // Additive support probe for SpicyChat Inspector + Test Driver.
  // Appended to the CURRENT Inspector content script by the installer so the
  // user's installed Inspector build/version is preserved exactly.
  const BRIDGE_SOURCE = 'SPICYCHAT_INSPECTOR_BRIDGE';
  const SETTINGS_KEY = 'sci_settings';
  const HEARTBEAT_MS = 5_000;
  const STORY_SAMPLE_MS = 15_000;
  const REQUEST_TTL_MS = 120_000;

  const ATTR = {
    present: 'data-sci-inspector-present',
    ready: 'data-sci-inspector-ready',
    recording: 'data-sci-inspector-recording',
    version: 'data-sci-inspector-version',
    heartbeat: 'data-sci-inspector-heartbeat',
    heartbeatSeq: 'data-sci-inspector-heartbeat-seq',
    instance: 'data-sci-inspector-instance',
    storyMounted: 'data-sci-inspector-story-mounted',
    netSeq: 'data-sci-inspector-story-net-seq',
    netAt: 'data-sci-inspector-story-net-at',
    netStatus: 'data-sci-inspector-story-net-status',
    netConversation: 'data-sci-inspector-story-net-conversation',
    netPrevId: 'data-sci-inspector-story-net-prev-id',
    netMessageId: 'data-sci-inspector-story-net-message-id',
    netKind: 'data-sci-inspector-story-net-kind',
    netChainCount: 'data-sci-inspector-story-net-chain-count',
    dailyAt: 'data-sci-inspector-story-daily-limit-at',
    dailyConversation: 'data-sci-inspector-story-daily-limit-conversation',
    dailyCode: 'data-sci-inspector-story-daily-limit-code'
  };

  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const requests = new Map();
  const chainCounts = new Map();
  let heartbeatSeq = 0;
  let storyNetSeq = 0;
  let recording = false;
  let lastStorySampleAt = 0;

  function root() { return document.documentElement || null; }
  function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  function isStoryRoute() { return /^\/story\/[0-9a-f-]+\/[0-9a-f-]+(?:\/|$)/i.test(location.pathname); }
  function isChatEndpoint(url) {
    try { return new URL(String(url || ''), location.href).pathname.replace(/\/+$/, '') === '/chat'; }
    catch (_) { return /\/chat(?:\?|$)/.test(String(url || '')); }
  }

  function blockFromNode(node) {
    let cur = node;
    for (let i = 0; cur && i < 14; i++, cur = cur.parentElement) {
      try { if (cur.matches?.('div.w-full.flex.mb-lg.bg-transparent')) return cur; } catch (_) {}
    }
    try { return node?.closest?.('div[class*="mb-lg"][class*="bg-transparent"]') || null; }
    catch (_) { return null; }
  }

  function blockHasMessage(block) {
    if (!block) return false;
    try {
      if (block.querySelector('.generation-stats,[data-message-id],[data-messageid],[id^="message-"]')) return true;
      const direct = block.querySelector('div.break-words.relative.cursor-text, div[class*="break-words"][class*="cursor-text"]');
      if (norm(direct?.textContent)) return true;
    } catch (_) {}
    return false;
  }

  function storyMountedMessages() {
    if (!isStoryRoute()) return null;
    const seen = new Set();
    const add = node => {
      const block = blockFromNode(node);
      if (block && blockHasMessage(block)) seen.add(block);
    };
    try {
      for (const button of document.querySelectorAll('button[aria-label="message-dropdown"]')) add(button);
      for (const stats of document.querySelectorAll('.generation-stats')) add(stats);
      for (const button of document.querySelectorAll('button')) {
        if (norm(button.textContent) === 'Continue Story') add(button);
      }
    } catch (_) {}
    return seen.size;
  }

  async function readRecording() {
    let next = null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SCI_GET_SETTINGS' });
      if (response?.ok && response.settings) next = !!response.settings.recording;
    } catch (_) {}
    if (next == null) {
      try {
        const stored = await chrome.storage.local.get(SETTINGS_KEY);
        next = !!stored?.[SETTINGS_KEY]?.recording;
      } catch (_) { next = false; }
    }
    recording = !!next;
    return recording;
  }

  function setAttr(name, value) {
    const el = root();
    if (!el) return;
    try {
      if (value == null || value === '') el.removeAttribute(name);
      else el.setAttribute(name, String(value));
    } catch (_) {}
  }

  function publishHeartbeat() {
    const el = root();
    if (!el) return;
    const mounted = storyMountedMessages();
    setAttr(ATTR.present, '1');
    setAttr(ATTR.ready, '1');
    setAttr(ATTR.recording, recording ? '1' : '0');
    setAttr(ATTR.version, chrome.runtime.getManifest().version || 'unknown');
    setAttr(ATTR.heartbeat, Date.now());
    setAttr(ATTR.heartbeatSeq, ++heartbeatSeq);
    setAttr(ATTR.instance, instanceId);
    setAttr(ATTR.storyMounted, mounted == null ? null : mounted);
  }

  function heapMetric(key) {
    try {
      const n = Number(performance?.memory?.[key]);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function emit(event) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({
        type: 'SCI_EVENT',
        event: {
          ...event,
          ts: event.ts || Date.now(),
          url: location.href,
          pageUrl: location.href,
          inspectorAddon: 'driver-support-v2'
        }
      }).catch(() => {});
    } catch (_) {}
  }

  function emitStoryPressure(now = Date.now()) {
    if (!recording || !isStoryRoute() || now - lastStorySampleAt < STORY_SAMPLE_MS) return;
    lastStorySampleAt = now;
    const mountedMessages = storyMountedMessages();
    if (!Number.isFinite(mountedMessages)) return;
    let domElements = null;
    let resourceEntries = null;
    try { domElements = document.getElementsByTagName('*').length; } catch (_) {}
    try { resourceEntries = performance.getEntriesByType('resource').length; } catch (_) {}
    emit({
      type: 'performance', subtype: 'page-pressure', reason: 'story-mode-driver-support-sample',
      domElements: Number.isFinite(domElements) ? domElements : null,
      mountedMessages,
      jsHeapUsedBytes: heapMetric('usedJSHeapSize'),
      jsHeapTotalBytes: heapMetric('totalJSHeapSize'),
      resourceEntries: Number.isFinite(resourceEntries) ? resourceEntries : null,
      interaction: {
        visibilityState: document.visibilityState || null,
        windowFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : null
      }
    });
  }

  function pruneRequests(now = Date.now()) {
    for (const [id, value] of requests) {
      if (now - Number(value?.ts || 0) > REQUEST_TTL_MS) requests.delete(id);
    }
    if (chainCounts.size > 1000) chainCounts.clear();
  }

  function requestBodyOf(event) {
    const body = event?.body;
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  }

  function handleBridgeNetwork(event) {
    if (!event || event.type !== 'network') return;
    const subtype = String(event.subtype || '');
    const requestId = String(event.requestId || '');
    const url = event.requestedUrl || event.url || event.finalUrl || '';

    if ((subtype === 'xhr-request' || subtype === 'fetch-request') && requestId && isChatEndpoint(url)) {
      const body = requestBodyOf(event);
      if (body?.story_mode === true) {
        requests.set(requestId, { body, ts: Date.now(), url });
        pruneRequests();
      }
      return;
    }

    if (subtype !== 'xhr-response' && subtype !== 'fetch-response') return;
    const req = requestId ? requests.get(requestId) : null;
    if (!req && !isChatEndpoint(url)) return;
    const reqBody = req?.body || {};
    if (reqBody.story_mode !== true) return;
    if (requestId) requests.delete(requestId);

    const status = Number(event.status);
    const responseBody = requestBodyOf(event) || {};
    const message = responseBody?.message && typeof responseBody.message === 'object' ? responseBody.message : null;
    const conversationId = String(reqBody.conversation_id || message?.conversation_id || '');
    const prevId = String(message?.prev_id || reqBody.prev_id || reqBody.alt_message_id || '');
    const messageId = String(message?.id || '');
    const kind = reqBody.prev_id ? 'regen' : 'initial';
    let chainCount = 1;
    if (status >= 200 && status < 300 && prevId) {
      const chainKey = `${conversationId}|${prevId}`;
      chainCount = (chainCounts.get(chainKey) || 0) + 1;
      chainCounts.set(chainKey, chainCount);
    }

    const now = Date.now();
    storyNetSeq += 1;
    setAttr(ATTR.netSeq, storyNetSeq);
    setAttr(ATTR.netAt, now);
    setAttr(ATTR.netStatus, Number.isFinite(status) ? status : 0);
    setAttr(ATTR.netConversation, conversationId || null);
    setAttr(ATTR.netPrevId, prevId || null);
    setAttr(ATTR.netMessageId, messageId || null);
    setAttr(ATTR.netKind, kind);
    setAttr(ATTR.netChainCount, chainCount);

    const errorCode = String(responseBody?.errorCode || '');
    if (status === 429 || errorCode === 'SC-001-5201') {
      setAttr(ATTR.dailyAt, now);
      setAttr(ATTR.dailyConversation, conversationId || null);
      setAttr(ATTR.dailyCode, errorCode || 'SC-001-5201');
    }

    emit({
      type: 'driver-support', subtype: 'story-chat-network',
      requestId: requestId || null,
      status: Number.isFinite(status) ? status : null,
      conversationId: conversationId || null,
      prevId: prevId || null,
      messageId: messageId || null,
      generationKind: kind,
      chainCount,
      dailyLimit: status === 429 || errorCode === 'SC-001-5201',
      errorCode: errorCode || null
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.source !== BRIDGE_SOURCE) return;
    try { handleBridgeNetwork(event.data.event || {}); } catch (_) {}
  }, true);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes?.[SETTINGS_KEY]) return;
      recording = !!changes[SETTINGS_KEY].newValue?.recording;
      publishHeartbeat();
    });
  } catch (_) {}

  async function tick() {
    await readRecording();
    publishHeartbeat();
    emitStoryPressure();
  }

  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), HEARTBEAT_MS);
})();
/* </SCI_DRIVER_SUPPORT_V2> */
