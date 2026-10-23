(() => {
  if (window.__SPICYCHAT_INSPECTOR_BRIDGE__) return;
  window.__SPICYCHAT_INSPECTOR_BRIDGE__ = true;

  const script = document.currentScript;
  const PAGE_ID = script?.dataset?.sciPageId || 'unknown';
  const SOURCE = 'SPICYCHAT_INSPECTOR_BRIDGE';
  const MAX_BODY = 200000;
  const PREVIEW_BODY = 14000;
  let requestSeq = 0;
  let lastPageHideAt = 0;
  const storageBursts = new Map();

  const PRIVATE_IDENTIFIER_KEY_RE = /^(?:x)?(?:guestuserid|guestid|userid|visitorid|deviceid|clientid|anonymousid|anonid|installationid|installid|fingerprintid)$/;
  function isPrivateIdentifierKey(k) { return PRIVATE_IDENTIFIER_KEY_RE.test(String(k || '').replace(/[-_]/g, '').toLowerCase()); }
  const PRIVATE_IDENTIFIER_VALUE_RE = /((?:[\"']?(?:x[-_])?(?:guest[-_]?user[-_]?id|guest[-_]?id|user[-_]?id|visitor[-_]?id|device[-_]?id|client[-_]?id|anon(?:ymous)?[-_]?id|install(?:ation)?[-_]?id|fingerprint[-_]?id)[\"']?)\s*[:=]\s*[\"']?)([A-Za-z0-9._~+/=-]+)/gi;
  const SECRET_KEY_RE = /(authorization|cookie|set-cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session|jwt|csrf|xsrf|api[_-]?key|client[_-]?secret|p?_?psid)/i;
  function isSecretKey(k) { return SECRET_KEY_RE.test(k) || isPrivateIdentifierKey(k); }
  const INTEREST_RE = /(sfw|nsfw|safe|safety|moder|filter|restrict|flag|feature|experiment|model|engine|provider|token|context|prompt|memory|lore|generation|temperature|top[_-]?[pk]|preset|queue|rate|limit|image|error|warning|status)/i;
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
  const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
  const PSID_VALUE_RE = /\b(psid)([:=])([A-Za-z0-9_-]{8,})/gi;
  const URLENC_SECRET_RE = /(^|[?&])(refresh_token|access_token|id_token|token|password|client_secret|session|jwt)=([^&]*)/gi;
  const QUERY_SECRET_RE = /([?&])(refresh_token|access_token|id_token|token|password|client_secret|session|jwt|api_key|apikey|frontend_sign|p?_?psid)=([^&#]*)/gi;

  function redactString(s) {
    if (typeof s !== 'string') return s;
    return s
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(BEARER_RE, 'Bearer [REDACTED]')
      .replace(URLENC_SECRET_RE, (m, prefix, key) => `${prefix}${key}=[REDACTED]`)
      .replace(QUERY_SECRET_RE, (m, prefix, key) => `${prefix}${key}=[REDACTED]`)
      .replace(PSID_VALUE_RE, (m, key, sep) => `${key}${sep}[REDACTED]`)
      .replace(PRIVATE_IDENTIFIER_VALUE_RE, (m, prefix) => `${prefix}[REDACTED]`);
  }

  function redactUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      for (const key of [...u.searchParams.keys()]) {
        if (isSecretKey(key) || /(^|_)(token|key|secret|password|session)(_|$)/i.test(key)) u.searchParams.set(key, '[REDACTED]');
      }
      return u.href;
    } catch (_) {
      return redactString(String(url || ''));
    }
  }


  function fingerprintText(value) {
    const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch (_) { return String(value ?? ''); } })();
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
  }

  function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8) return '[MAX_DEPTH]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value.length > MAX_BODY ? value.slice(0, MAX_BODY) + '...[TRUNCATED]' : value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (Array.isArray(value)) return value.slice(0, 500).map(v => sanitize(v, depth + 1, seen));
    if (typeof value === 'object') {
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);
      const out = {};
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ > 700) { out.__truncated__ = true; break; }
        let v;
        try { v = value[key]; } catch (_) { continue; }
        out[key] = isSecretKey(key) ? '[REDACTED]' : sanitize(v, depth + 1, seen);
      }
      return out;
    }
    return String(value);
  }

  function extractInteresting(value, path = '$', depth = 0, out = []) {
    if (depth > 8 || out.length >= 250 || value == null) return out;
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 120); i++) extractInteresting(value[i], `${path}[${i}]`, depth + 1, out);
      return out;
    }
    if (typeof value !== 'object') return out;
    for (const [key, val] of Object.entries(value)) {
      if (out.length >= 250) break;
      const p = `${path}.${key}`;
      if (INTEREST_RE.test(key) && !isSecretKey(key)) {
        if (val == null || ['string','number','boolean'].includes(typeof val)) out.push({ path: p, value: sanitize(val) });
        else if (Array.isArray(val) && val.length <= 20) out.push({ path: p, value: sanitize(val) });
      }
      extractInteresting(val, p, depth + 1, out);
    }
    return out;
  }

  function isNativeMemoryUrl(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      if (!(u.hostname === 'nd-api.com' || u.hostname.endsWith('.nd-api.com') || u.hostname === 'spicychat.ai' || u.hostname.endsWith('.spicychat.ai'))) return false;
      return /(?:^|\/)memories?(?:\/|$)/i.test(u.pathname);
    } catch (_) { return false; }
  }
  function nativeMemoryMeta(value) {
    let text = '';
    try { text = typeof value === 'string' ? value : JSON.stringify(value); }
    catch (_) { text = String(value ?? ''); }
    return { redacted: true, kind: 'native-memory-content', chars: text.length, fingerprint: fingerprintText(value) };
  }
  const MEMORY_SAFE_FIELDS = new Set(['id', 'conversation_id', 'memory_type', 'type', 'is_pinned', 'createdAt', 'updatedAt', 'created_at', 'updated_at', 'deletedAt']);
  function scrubNativeMemoryBody(value, depth = 0) {
    if (depth > 14) return nativeMemoryMeta(value);
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { return nativeMemoryMeta(value); }
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 1000).map(v => scrubNativeMemoryBody(v, depth + 1));
    if (typeof value !== 'object') return nativeMemoryMeta(value);
    // Recognize already-redacted snapshots and preserve their original meta.
    if (value.redacted === true && Object.keys(value).every(k => ['redacted','kind','chars','fingerprint','count','keys'].includes(k))) return value;
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 1200)) {
      if (key === 'content' || key === 'text' || key === 'description' || key === 'summary') {
        out[key] = item && typeof item === 'object' && item.redacted === true
          ? scrubNativeMemoryBody(item, depth + 1) : nativeMemoryMeta(item);
      } else if (MEMORY_SAFE_FIELDS.has(key)) {
        out[key] = item == null || typeof item === 'boolean' || typeof item === 'number'
          ? item : (typeof item === 'string' && item.length <= 180 ? redactString(item) : nativeMemoryMeta(item));
      } else if (['data','memories','items','results'].includes(key) && item && typeof item === 'object') {
        out[key] = scrubNativeMemoryBody(item, depth + 1);
      } else if (key === '__duplicate_body__' && typeof item === 'boolean') out[key] = item;
      else if (key === 'fingerprint' && typeof item === 'string' && /^fnv1a-/.test(item)) out[key] = item;
      else out[key] = nativeMemoryMeta(item);
    }
    return out;
  }
  function scrubNativeMemoryEvent(event) {
    if (event?.type !== 'network' || !isNativeMemoryUrl(event.finalUrl || event.requestedUrl || event.url)) return event;
    const safe = { ...event };
    for (const field of ['body','requestBody']) if (safe[field] != null) safe[field] = scrubNativeMemoryBody(safe[field]);
    safe.memoryPrivacy = { redacted: true, policy: 'native-memory-metadata-only' };
    return safe;
  }
  function emit(event) {
    window.postMessage({ source: SOURCE, pageId: PAGE_ID, event: sanitize(scrubNativeMemoryEvent({ ...event, ts: Date.now() })) }, '*');
  }

  function headersToObject(headers) {
    const out = {};
    try {
      new Headers(headers || {}).forEach((v, k) => {
        out[k] = isSecretKey(k) ? '[REDACTED]' : redactString(v);
      });
    } catch (_) {}
    return out;
  }

  function contentLength(headers) {
    try {
      const n = Number(new Headers(headers || {}).get('content-length'));
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function parseBodyText(text, contentType = '') {
    if (typeof text !== 'string') return text;
    // Parse the original JSON before masking inline IDs: replacing a bare
    // numeric userId inside JSON text would otherwise invalidate the JSON.
    const trimmed = text.trim();
    if (!trimmed) return '';
    let parsed;
    if (/json|graphql/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch (_) {}
    }
    const safeParsed = parsed === undefined ? undefined : sanitize(parsed);
    const safeText = redactString(text);
    if (safeText.length > MAX_BODY) {
      return {
        __truncated__: true,
        __originalChars__: safeText.length,
        __preview__: safeText.slice(0, PREVIEW_BODY),
        __interesting__: safeParsed ? extractInteresting(safeParsed) : []
      };
    }
    return safeParsed ?? safeText;
  }

  function bodyFromInit(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseBodyText(body, 'application/json');
      if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
        try {
          const out = {};
          for (const [k, v] of new URLSearchParams(trimmed)) out[k] = isSecretKey(k) ? '[REDACTED]' : redactString(v);
          return out;
        } catch (_) {}
      }
      return redactString(body.length > MAX_BODY ? body.slice(0, MAX_BODY) + '...[TRUNCATED]' : body);
    }
    if (body instanceof URLSearchParams) {
      const out = {};
      for (const [k, v] of body.entries()) out[k] = isSecretKey(k) ? '[REDACTED]' : redactString(v);
      return out;
    }
    if (body instanceof FormData) {
      const out = {};
      for (const [k, v] of body.entries()) out[k] = isSecretKey(k) ? '[REDACTED]' : (typeof v === 'string' ? redactString(v) : `[File ${v?.name || ''}]`);
      return out;
    }
    return `[${body?.constructor?.name || typeof body}]`;
  }

  function nextRequestId(kind) {
    requestSeq += 1;
    return `${kind}-${Date.now().toString(36)}-${requestSeq}`;
  }

  function shortInitiatorStack() {
    try {
      return String(new Error().stack || '').split('\n').slice(3, 10).join('\n').slice(0, 2400);
    } catch (_) { return ''; }
  }

  function initiatorSourceHint(stack) {
    const s = String(stack || '');
    if (/chrome-extension:\/\//i.test(s)) return 'extension';
    if (/https:\/\/spicychat\.ai\/(?:assets\/)?/i.test(s)) return 'spicychat-page';
    return null;
  }
  function keepInitiator(stack, status, durationMs) {
    return /chrome-extension:\/\//i.test(String(stack || '')) || status >= 400 || durationMs >= 750 || status === 0;
  }

  function resourceTimingFor(url, startedAt) {
    try {
      const entries = performance.getEntriesByName(url, 'resource');
      if (!entries.length) return null;
      let best = entries[entries.length - 1];
      if (Number.isFinite(startedAt)) {
        best = entries.slice().reverse().find(e => Math.abs((e.startTime || 0) - startedAt) < 5000) || best;
      }
      return {
        initiatorType: best.initiatorType || null,
        startTimeMs: Math.round((best.startTime || 0) * 10) / 10,
        durationMs: Math.round((best.duration || 0) * 10) / 10,
        transferSize: best.transferSize || 0,
        encodedBodySize: best.encodedBodySize || 0,
        decodedBodySize: best.decodedBodySize || 0,
        protocol: best.nextHopProtocol || null
      };
    } catch (_) { return null; }
  }

  function statusZeroHint(meta) {
    if (meta?.aborted) return 'xhr-abort';
    if (lastPageHideAt && Date.now() - lastPageHideAt < 2500) return 'page-navigation/unload';
    if (document.visibilityState === 'hidden') return 'page-hidden/navigation';
    return null;
  }

  addEventListener('pagehide', () => { lastPageHideAt = Date.now(); }, true);
  addEventListener('beforeunload', () => { lastPageHideAt = Date.now(); }, true);

  // fetch
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = async function(input, init) {
      const started = performance.now();
      const rawUrl = typeof input === 'string' ? input : input?.url;
      const requestedUrl = redactUrl(rawUrl);
      const method = init?.method || input?.method || 'GET';
      const requestId = nextRequestId('f');
      const initiator = shortInitiatorStack();
      const requestBody = bodyFromInit(init?.body);
      const initiatorHint = initiatorSourceHint(initiator);
      emit({ type: 'network', subtype: 'fetch-request', requestId, method, url: requestedUrl, requestedUrl, headers: headersToObject(init?.headers || input?.headers), body: requestBody, requestFingerprint: fingerprintText(`${method}|${requestedUrl}|${JSON.stringify(requestBody ?? null)}`), initiator: initiatorHint === 'extension' ? initiator : null, initiatorSourceHint: initiatorHint });
      try {
        const response = await nativeFetch.apply(this, arguments);
        const responseReceivedAt = Date.now();
        const meta = {
          type: 'network', subtype: 'fetch-response', requestId, method,
          url: redactUrl(response.url || requestedUrl), requestedUrl, finalUrl: redactUrl(response.url || requestedUrl),
          status: response.status, ok: response.ok,
          responseReceivedAt,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
          headers: headersToObject(response.headers),
          contentType: response.headers.get('content-type') || '',
          contentLength: contentLength(response.headers)
        };
        meta.resourceTiming = resourceTimingFor(meta.finalUrl, started);
        meta.initiatorSourceHint = initiatorSourceHint(initiator);
        if (keepInitiator(initiator, meta.status, meta.durationMs)) meta.initiator = initiator;
        try {
          const clone = response.clone();
          const ct = meta.contentType;
          if (/json|text|javascript|graphql|xml|html/i.test(ct)) {
            clone.text().then(text => emit({ ...meta, responseChars: text.length, responseFingerprint: fingerprintText(redactString(text)), body: parseBodyText(text, ct) })).catch(() => emit(meta));
          } else emit(meta);
        } catch (_) { emit(meta); }
        return response;
      } catch (err) {
        emit({ type: 'network', subtype: 'fetch-error', requestId, method, url: requestedUrl, requestedUrl, error: String(err), errorName: err?.name || null, likelyAbort: err?.name === 'AbortError' || (lastPageHideAt && Date.now() - lastPageHideAt < 2500), initiator, initiatorSourceHint: initiatorSourceHint(initiator), durationMs: Math.round(performance.now() - started) });
        throw err;
      }
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    const nativeSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function(method, url) {
      this.__sci = { method, rawUrl: String(url), requestedUrl: redactUrl(url), url: redactUrl(url), headers: {}, started: 0, startedAt: 0, requestId: nextRequestId('x'), aborted: false, initiator: shortInitiatorStack() };
      return nativeOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function(k, v) {
      if (this.__sci) this.__sci.headers[k] = isSecretKey(k) ? '[REDACTED]' : redactString(String(v));
      return nativeSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function(body) {
      const meta = this.__sci || { method: 'GET', url: '', requestId: nextRequestId('x') };
      meta.started = performance.now();
      meta.startedAt = meta.started;
      this.addEventListener('abort', () => { meta.aborted = true; }, { once: true });
      const requestBody = bodyFromInit(body);
      const xhrInitiatorHint = initiatorSourceHint(meta.initiator);
      emit({ type: 'network', subtype: 'xhr-request', requestId: meta.requestId, method: meta.method, url: meta.url, requestedUrl: meta.requestedUrl || meta.url, headers: meta.headers, body: requestBody, requestFingerprint: fingerprintText(`${meta.method}|${meta.requestedUrl || meta.url}|${JSON.stringify(requestBody ?? null)}`), initiator: xhrInitiatorHint === 'extension' ? meta.initiator : null, initiatorSourceHint: xhrInitiatorHint });
      this.addEventListener('loadend', () => {
        let responseBody = null;
        let responseChars = null;
        let responseFingerprint = null;
        let ct = '';
        let responseHeaders = {};
        try {
          ct = this.getResponseHeader('content-type') || '';
          const rawHeaders = this.getAllResponseHeaders() || '';
          rawHeaders.trim().split(/[\r\n]+/).forEach(line => {
            const i = line.indexOf(':');
            if (i <= 0) return;
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1).trim();
            responseHeaders[k] = isSecretKey(k) ? '[REDACTED]' : redactString(v);
          });
          if (!this.responseType || this.responseType === 'text') {
            const text = this.responseText || '';
            responseChars = text.length;
            responseFingerprint = fingerprintText(redactString(text));
            responseBody = parseBodyText(text, ct);
          } else if (this.responseType === 'json') {
            responseBody = this.response;
            responseFingerprint = fingerprintText(sanitize(this.response));
          }
          else responseBody = `[${this.responseType || 'unknown'} response]`;
        } catch (_) {}
        const finalUrl = redactUrl(this.responseURL || meta.url || meta.requestedUrl || '');
        const responseReceivedAt = Date.now();
        const durationMs = Math.round((performance.now() - meta.started) * 10) / 10;
        const zeroHint = this.status === 0 ? statusZeroHint(meta) : null;
        emit({
          type: 'network', subtype: 'xhr-response', requestId: meta.requestId, method: meta.method,
          url: finalUrl, requestedUrl: meta.requestedUrl || meta.url, finalUrl,
          endpointCorrected: !!finalUrl && !!meta.requestedUrl && finalUrl !== meta.requestedUrl,
          status: this.status, durationMs, responseReceivedAt,
          statusZeroHint: zeroHint, aborted: !!meta.aborted,
          contentType: ct, contentLength: contentLength(responseHeaders), responseChars, responseFingerprint,
          resourceTiming: resourceTimingFor(finalUrl, meta.startedAt),
          initiator: keepInitiator(meta.initiator, this.status, durationMs) ? meta.initiator : null,
          initiatorSourceHint: initiatorSourceHint(meta.initiator),
          headers: responseHeaders, body: responseBody
        });
      }, { once: true });
      return nativeSend.apply(this, arguments);
    };
  }

  // WebSocket
  const NativeWS = window.WebSocket;
  if (NativeWS) {
    function WrappedWebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      const wsUrl = redactUrl(url);
      emit({ type: 'websocket', subtype: 'open-attempt', url: wsUrl });
      ws.addEventListener('open', () => emit({ type: 'websocket', subtype: 'open', url: wsUrl }));
      ws.addEventListener('close', e => emit({ type: 'websocket', subtype: 'close', url: wsUrl, code: e.code, reason: redactString(e.reason || '') }));
      ws.addEventListener('error', () => emit({ type: 'websocket', subtype: 'error', url: wsUrl }));
      ws.addEventListener('message', e => emit({ type: 'websocket', subtype: 'message-in', url: wsUrl, data: typeof e.data === 'string' ? parseBodyText(e.data) : `[${e.data?.constructor?.name || 'binary'}]` }));
      const nativeSend = ws.send;
      ws.send = function(data) {
        emit({ type: 'websocket', subtype: 'message-out', url: wsUrl, data: typeof data === 'string' ? parseBodyText(data) : `[${data?.constructor?.name || 'binary'}]` });
        return nativeSend.apply(this, arguments);
      };
      return ws;
    }
    WrappedWebSocket.prototype = NativeWS.prototype;
    Object.setPrototypeOf(WrappedWebSocket, NativeWS);
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) WrappedWebSocket[k] = NativeWS[k];
    window.WebSocket = WrappedWebSocket;
  }

  // SPA navigation. Useful when correlating network/state changes with a screen/action.
  const nativePushState = history.pushState;
  const nativeReplaceState = history.replaceState;
  function routeEvent(kind, from) { emit({ type: 'lifecycle', subtype: 'route-change', kind, from, to: location.href }); }
  history.pushState = function() { const from = location.href; const r = nativePushState.apply(this, arguments); routeEvent('pushState', from); return r; };
  history.replaceState = function() { const from = location.href; const r = nativeReplaceState.apply(this, arguments); routeEvent('replaceState', from); return r; };
  addEventListener('popstate', () => routeEvent('popstate', null));
  addEventListener('hashchange', e => emit({ type: 'lifecycle', subtype: 'route-change', kind: 'hashchange', from: e.oldURL, to: e.newURL }));

  // localStorage/sessionStorage change interception. High-frequency writes are coalesced
  // so long captures preserve write counts without logging every keystroke-sized draft update.
  function flushStorageBurst(id) {
    const b = storageBursts.get(id);
    if (!b) return;
    clearTimeout(b.timer);
    storageBursts.delete(id);
    if (b.suppressed <= 0) return;
    const windowMs = Math.max(0, b.lastTs - b.firstTs);
    emit({
      type: 'storage', subtype: `${b.label}-write-burst`, storage: b.label, key: b.key,
      writes: b.suppressed, suppressedWrites: b.suppressed, totalWritesIncludingInitial: b.suppressed + 1, windowMs,
      avgIntervalMs: b.suppressed ? Math.round((windowMs / b.suppressed) * 10) / 10 : null,
      lastValueLength: b.lastValueLength,
      privacyNote: /^chatDraft:/i.test(b.key) ? 'draft-value-omitted' : null
    });
  }

  function recordStorageSet(label, key, value) {
    const id = `${label}::${key}`;
    const now = Date.now();
    const existing = storageBursts.get(id);
    if (existing && now - existing.lastTs <= 350) {
      existing.suppressed += 1;
      existing.lastTs = now;
      existing.lastValueLength = String(value ?? '').length;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushStorageBurst(id), 900);
      return;
    }
    if (existing) flushStorageBurst(id);
    const omitDraftValue = /^chatDraft:/i.test(key);
    emit({
      type: 'storage', subtype: `${label}-set`, key,
      value: isSecretKey(key) ? '[REDACTED]' : (omitDraftValue ? '[DRAFT_VALUE_OMITTED]' : redactString(String(value).slice(0, MAX_BODY))),
      valueLength: String(value ?? '').length
    });
    storageBursts.set(id, { label, key, firstTs: now, lastTs: now, suppressed: 0, lastValueLength: String(value ?? '').length, timer: setTimeout(() => flushStorageBurst(id), 900) });
  }

  function patchStoragePrototype() {
    let proto;
    try { proto = Object.getPrototypeOf(localStorage); } catch (_) { return; }
    if (!proto || proto.__sciPatched) return;
    const set = proto.setItem;
    const remove = proto.removeItem;
    const clear = proto.clear;
    const labelFor = obj => { try { if (obj === sessionStorage) return 'sessionStorage'; } catch (_) {} return 'localStorage'; };
    proto.setItem = function(k, v) {
      const label = labelFor(this);
      recordStorageSet(label, String(k), v);
      return set.apply(this, arguments);
    };
    proto.removeItem = function(k) { const label = labelFor(this); flushStorageBurst(`${label}::${k}`); emit({ type: 'storage', subtype: `${label}-remove`, key: k }); return remove.apply(this, arguments); };
    proto.clear = function() { for (const id of [...storageBursts.keys()]) if (id.startsWith(`${labelFor(this)}::`)) flushStorageBurst(id); emit({ type: 'storage', subtype: `${labelFor(this)}-clear` }); return clear.apply(this, arguments); };
    try { Object.defineProperty(proto, '__sciPatched', { value: true }); } catch (_) {}
  }
  patchStoragePrototype();

  function snapshotStorage(storage) {
    const out = {};
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;
        const v = storage.getItem(k);
        out[k] = isSecretKey(k) ? '[REDACTED]' : parseBodyText(v || '');
      }
    } catch (err) { out.__error__ = String(err); }
    return out;
  }

  function snapshotInterestingGlobals() {
    const hits = {};
    let names = [];
    try { names = Object.getOwnPropertyNames(window); } catch (_) {}
    for (const name of names) {
      if (!INTEREST_RE.test(name) || isSecretKey(name)) continue;
      try {
        const v = window[name];
        if (['string','number','boolean'].includes(typeof v) || (v && typeof v === 'object')) hits[name] = sanitize(v, 0, new WeakSet());
      } catch (_) {}
      if (Object.keys(hits).length >= 120) break;
    }
    return hits;
  }

  async function snapshotState(options = {}) {
    const payload = {
      type: 'state', subtype: 'snapshot',
      pinned: !!options.pinned, reason: options.reason || null, markerSubtype: options.markerSubtype || null,
      location: { href: redactUrl(location.href), pathname: location.pathname, search: redactString(location.search) },
      localStorage: snapshotStorage(localStorage),
      sessionStorage: snapshotStorage(sessionStorage),
      globals: snapshotInterestingGlobals(),
      indexedDbDatabases: []
    };
    try { if (indexedDB.databases) payload.indexedDbDatabases = await indexedDB.databases(); } catch (_) {}
    emit(payload);
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'SPICYCHAT_INSPECTOR_CONTENT' || d.pageId !== PAGE_ID) return;
    if (d.command === 'snapshot-state') snapshotState(d.payload || {});
  });

  emit({ type: 'lifecycle', subtype: 'bridge-installed', href: redactUrl(location.href) });
})();
