const $ = s => document.querySelector(s);
let allEvents = [], filtered = [], selectedId = null, storedTotal = 0;
const INTEREST_RE = /(sfw|nsfw|safe|safety|moder|filter|restrict|flag|feature|experiment|model|engine|provider|token|context|prompt|memory|lore|generation|temperature|preset|queue|rate|limit|image|warning|blocked|error|slow|performance)/i;
const SECRET_KEY_RE = /(authorization|cookie|set-cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session|jwt|csrf|xsrf|api[_-]?key|client[_-]?secret|p?_?psid)/i;
function isSecretKey(k) { return k !== 'authInvalidToken' && SECRET_KEY_RE.test(k); }
const PSID_VALUE_RE = /\b(psid)([:=])([A-Za-z0-9_-]{8,})/gi;
const SECRET_VALUE_RE = /(Bearer\s+[A-Za-z0-9._~+/=-]{10,}|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|(^|[?&])(refresh_token|access_token|id_token|token|password|client_secret|session|jwt|api_key|apikey|frontend_sign|p?_?psid)=([^&#]*))/gi;
function redactExportString(value) { return String(value ?? '').replace(SECRET_VALUE_RE, '[REDACTED]').replace(PSID_VALUE_RE, (m, key, sep) => `${key}${sep}[REDACTED]`); }

async function msg(data) { const res = await chrome.runtime.sendMessage(data); if (!res?.ok) throw new Error(res?.error || 'Request failed'); return res; }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function decodeEscapedText(v) {
  return String(v ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp:'&', lt:'<', gt:'>', quot:'"', '#39':"'" }[name] || _));
}
function appendSafeInlineMarkup(parent, markup) {
  const tokens = String(markup ?? '').split(/(<\/?(?:strong|em)>)/i);
  const stack = [parent];
  for (const token of tokens) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === '<strong>' || lower === '<em>') {
      const el = document.createElement(lower === '<strong>' ? 'strong' : 'em');
      stack[stack.length - 1].appendChild(el);
      stack.push(el);
      continue;
    }
    if (lower === '</strong>' || lower === '</em>') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    stack[stack.length - 1].appendChild(document.createTextNode(decodeEscapedText(token)));
  }
}
function appendOverviewExtra(parent, markup) {
  const div = document.createElement('div');
  const m = /^<div>([\s\S]*)<\/div>$/.exec(String(markup ?? ''));
  appendSafeInlineMarkup(div, m ? m[1] : markup);
  parent.appendChild(div);
}
function appendHighlightedJson(parent, json) {
  let raw = '';
  try { raw = JSON.stringify(json, null, 2); } catch (_) { raw = String(json ?? ''); }
  const re = /(sfw|nsfw|safe|safety|moder\w*|filter\w*|restrict\w*|flag\w*|model\w*|engine\w*|token\w*|context\w*|memory\w*|lore\w*|generation\w*|durationMs|transferSize|error)/gi;
  let last = 0;
  for (const match of raw.matchAll(re)) {
    const idx = match.index ?? 0;
    if (idx > last) parent.appendChild(document.createTextNode(raw.slice(last, idx)));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    parent.appendChild(mark);
    last = idx + match[0].length;
  }
  if (last < raw.length) parent.appendChild(document.createTextNode(raw.slice(last)));
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }
function endpointUrl(e) { return e.finalUrl || e.responseUrl || e.requestedUrl || e.url || ''; }
function endpointLabel(e) { try { const u = new URL(endpointUrl(e)); return `${u.host}${u.pathname}`; } catch (_) { return e.networkMeta?.pathname || endpointUrl(e); } }
function isNetworkRequestEvent(e) { return !!(e?.type === 'network' && (/request$/.test(e.subtype || '') || e.requestCombined === true)); }
function requestBodyOf(e) {
  if (!e || e.type !== 'network') return null;
  if (e.requestCombined === true && e.requestBody != null) return e.requestBody;
  return /request$/.test(e.subtype || '') ? (e.body ?? null) : null;
}
function requestHeadersOf(e) {
  if (!e || e.type !== 'network') return null;
  if (e.requestCombined === true && e.requestHeaders != null) return e.requestHeaders;
  return /request$/.test(e.subtype || '') ? (e.headers ?? null) : null;
}
function requestStartTs(e) { return Number.isFinite(Number(e?.requestStartedAt)) ? Number(e.requestStartedAt) : eventTs(e); }
function recommendationWorkerKindFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (u.searchParams.get('dsQolBotStatusWorker') === '1') return 'bot-status-worker';
    if (u.searchParams.get('dsQolRecommendationWorker') === '1') return 'recommendation-worker';
    if (u.searchParams.get('dsQuickDislike') === '1') return 'legacy-quick-dislike';
  } catch (_) {
    const raw = String(url);
    if (/(?:[?&])dsQolBotStatusWorker=1(?:&|$)/.test(raw)) return 'bot-status-worker';
    if (/(?:[?&])dsQolRecommendationWorker=1(?:&|$)/.test(raw)) return 'recommendation-worker';
    if (/(?:[?&])dsQuickDislike=1(?:&|$)/.test(raw)) return 'legacy-quick-dislike';
  }
  return null;
}
function isQuickDislikePageUrl(url) { return recommendationWorkerKindFromUrl(url) === 'legacy-quick-dislike'; }
function isRecommendationWorkerPageUrl(url) { const kind=recommendationWorkerKindFromUrl(url); return kind === 'recommendation-worker' || kind === 'legacy-quick-dislike'; }
function buildPageRoleIndex(events) {
  const pageRoles = new Map();
  const startsByTab = new Map();
  for (const e of events) {
    const markerKind = recommendationWorkerKindFromUrl(e.href || e.pageUrl || e.to || e.url);
    const explicitRole = e.pageRole || (markerKind === 'bot-status-worker' ? 'qol-bot-status-worker' : (markerKind ? 'qol-recommendation-worker' : null));
    const canSeedPageRole = (e.type === 'lifecycle' && e.subtype === 'page-start') || !!e.pageRole;
    if (explicitRole && canSeedPageRole && e.pageId && e.pageId !== 'browser-webrequest' && e.browserObserver !== true && !pageRoles.has(e.pageId)) pageRoles.set(e.pageId, { role: explicitRole, kind: markerKind || 'persisted', pageId: e.pageId, tabId: e.tabId ?? null, startTs: eventTs(e) });
    if (e.type === 'lifecycle' && e.subtype === 'page-start' && Number.isInteger(e.tabId)) {
      const arr = startsByTab.get(e.tabId) || [];
      arr.push({ ts:eventTs(e), pageId:e.pageId || null, tabId:e.tabId, role:explicitRole, kind:markerKind || (explicitRole ? 'persisted' : null) });
      startsByTab.set(e.tabId, arr);
    }
  }
  const intervalsByTab = new Map();
  for (const [tabId, starts0] of startsByTab) {
    const starts = starts0.slice().sort((a,b)=>a.ts-b.ts);
    const intervals=[];
    for (let i=0;i<starts.length;i++) {
      const x=starts[i]; if (!x.role) continue;
      intervals.push({ ...x, endTs:i+1<starts.length ? starts[i+1].ts : Infinity });
    }
    if (intervals.length) intervalsByTab.set(tabId, intervals);
  }
  function roleForEvent(e) {
    const direct = e?.pageId ? pageRoles.get(e.pageId) : null;
    if (direct) return direct;
    if (Number.isInteger(e?.tabId)) {
      const ts=eventTs(e), list=intervalsByTab.get(e.tabId) || [];
      for (let i=list.length-1;i>=0;i--) if (ts>=list[i].ts && ts<list[i].endTs) return list[i];
    }
    if (e?.pageRole) return { role:e.pageRole, kind:'persisted', pageId:e.pageId && e.pageId!=='browser-webrequest' ? e.pageId : null, tabId:e.tabId ?? null };
    return null;
  }
  const workerPages=[...pageRoles.values()].filter(x=>x.role==='qol-recommendation-worker'||x.role==='qol-bot-status-worker');
  return { pageRoles, intervalsByTab, workerPages, roleForEvent };
}
function isListingRefillPageUrl(url) {
  if (!url) return false;
  try { return new URL(url).searchParams.get('dsListingRefill') === '1'; }
  catch (_) { return /(?:[?&])dsListingRefill=1(?:&|$)/.test(String(url)); }
}
function listingRefillPageNumber(url) {
  try {
    const u = new URL(url || '');
    for (const [k,v] of u.searchParams.entries()) if (/\[page\]$/i.test(k)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  } catch (_) {}
  return null;
}
function median(values) {
  if (!values.length) return 0;
  const a = values.slice().sort((x,y)=>x-y), m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const a = values.slice().sort((x,y)=>x-y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((a.length - 1) * p)));
  return a[i];
}
function eventTs(e) { return Number.isFinite(e?.ts) ? e.ts : 0; }
function routeLabel(url) {
  try {
    const u = new URL(url || '');
    let out = u.pathname || '/';
    if (u.searchParams.get('dsQolBotStatusWorker') === '1') out += '?dsQolBotStatusWorker=1';
    else if (u.searchParams.get('dsQolRecommendationWorker') === '1') out += '?dsQolRecommendationWorker=1';
    else if (u.searchParams.get('dsQuickDislike') === '1') out += '?dsQuickDislike=1';
    else if (u.searchParams.get('dsListingRefill') === '1') out += '?dsListingRefill=1';
    return out;
  } catch (_) { return String(url || '(unknown)'); }
}
function linearFit(rows, xKey, yKey) {
  const pts = rows.filter(r => Number.isFinite(r?.[xKey]) && Number.isFinite(r?.[yKey]));
  if (pts.length < 3) return null;
  const xs = pts.map(r=>Number(r[xKey])), ys = pts.map(r=>Number(r[yKey]));
  const mx = xs.reduce((a,b)=>a+b,0)/xs.length, my = ys.reduce((a,b)=>a+b,0)/ys.length;
  let sxx=0,sxy=0,syy=0;
  for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxx+=dx*dx;sxy+=dx*dy;syy+=dy*dy;}
  if (!sxx || !syy) return null;
  const slope=sxy/sxx, intercept=my-slope*mx;
  let sse=0; for(let i=0;i<xs.length;i++){const d=ys[i]-(intercept+slope*xs[i]);sse+=d*d;}
  return { samples:pts.length, slope:Math.round(slope*10)/10, intercept:Math.round(intercept*10)/10, r2:Math.round((1-sse/syy)*1000)/1000 };
}
function rangeForSorted(items, startTs, endTs) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (eventTs(items[m]) < startTs) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < items.length; i++) { const ts = eventTs(items[i]); if (ts > endTs) break; out.push(items[i]); }
  return out;
}
function isChatSuccessResponse(e) {
  return e?.type === 'network' && /response$/.test(e.subtype || '') && String(e.method || '').toUpperCase() === 'POST' && e.status >= 200 && e.status < 300 && /(^|\/)chat$/.test(endpointLabel(e));
}
function buildGenerationRenderDiagnostics(events, windowMs = 8000) {
  const byPage = new Map();
  for (const e of events) {
    if (!e.pageId) continue;
    const arr = byPage.get(e.pageId) || [];
    arr.push(e); byPage.set(e.pageId, arr);
  }
  for (const arr of byPage.values()) arr.sort((a,b)=>eventTs(a)-eventTs(b));
  const generations = events.filter(isChatSuccessResponse).slice().sort((a,b)=>eventTs(a)-eventTs(b));
  // The 8s follow-up timer can fire later than the analysis window, especially
  // in throttled/hidden tabs. Join the result by request ID, not by timestamp.
  const domMatchByRequest=new Map();
  for(const e of events){
    if(e.type==='performance'&&e.subtype==='generation-dom-match-result'&&e.relatedRequestId){
      domMatchByRequest.set(`${e.pageId||''}|${e.relatedRequestId}`,e);
    }
  }
  const rows = [];
  for (const g of generations) {
    const responseTs = Number.isFinite(g.responseReceivedAt) ? g.responseReceivedAt : eventTs(g);
    const arr = byPage.get(g.pageId) || [];
    const win = rangeForSorted(arr, responseTs, responseTs + windowMs);
    const dom = win.filter(e => e.type === 'dom' && e.subtype === 'mutation-batch');
    const lts = win.filter(e => e.type === 'performance' && e.subtype === 'long-task');
    const loafs = win.filter(e => e.type === 'performance' && e.subtype === 'long-animation-frame');
    const renderSignal = win.find(e => e.type === 'performance' && e.subtype === 'generation-response-dom-signal' && (!g.requestId || e.relatedRequestId === g.requestId));
    const domMatchResult = g.requestId ? domMatchByRequest.get(`${g.pageId||''}|${g.requestId}`) : null;
    const legacyFirstMessage = win.find(e => e.type === 'performance' && e.subtype === 'generation-first-message-dom' && (!g.requestId || e.relatedRequestId === g.requestId));
    const firstDom = dom[0] || null;
    const pressures = win.filter(e => e.type === 'performance' && e.subtype === 'page-pressure' && (!g.requestId || e.relatedRequestId === g.requestId));
    const startPressure = pressures.find(e => e.reason === 'generation-response') || pressures[0] || null;
    const endPressure = [...pressures].reverse().find(e => e.reason === 'generation-followup-8s') || pressures[pressures.length - 1] || null;
    const topScripts = new Map();
    for (const f of loafs) for (const sc of (f.scripts || [])) {
      const key = sc.sourceURL || sc.sourceKind || '(unknown script)';
      const x = topScripts.get(key) || { source:key, sourceKind:sc.sourceKind || 'unknown-mixed', totalMs:0, count:0 };
      x.totalMs += sc.durationMs || 0; x.count++; topScripts.set(key,x);
    }
    const rankedScripts = [...topScripts.values()].sort((a,b)=>b.totalMs-a.totalMs).slice(0,3).map(x=>({...x,totalMs:Math.round(x.totalMs*10)/10}));
    const longTaskMs = lts.reduce((n,e)=>n+(e.durationMs||0),0);
    const loafBlockingMs = loafs.reduce((n,e)=>n+(e.blockingDurationMs||0),0);
    const domMutations = dom.reduce((n,e)=>n+(e.stats?.totalMutations||0),0);
    const qolRelated = dom.reduce((n,e)=>n+(e.stats?.qolRelated||0),0);
    const noOp = dom.reduce((n,e)=>n+(e.stats?.noOp||0),0);
    rows.push({
      requestId:g.requestId || null, pageId:g.pageId || null, pageUrl:g.pageUrl || g.url || null,
      routeKind:/\/story\//.test(String(g.pageUrl || g.url || '')) ? 'story' : 'chat', responseTs,
      backendMs:g.durationMs || null, windowMs,
      responseDomSignalMs:renderSignal ? (renderSignal.latencyMs ?? Math.max(0,eventTs(renderSignal)-responseTs)) : null,
      responseDomSignalKind:renderSignal?.signalKind || null,
      domMatchStatus:domMatchResult?.status || 'not-recorded',
      domMatchReason:domMatchResult?.reason || (renderSignal?'signal-without-final-check':'not-recorded'),
      domMatchHasReplyId:domMatchResult?.hasReplyId === true,
      domMatchPriorMutations:domMatchResult?.priorDomMutationCount || 0,
      domMatchLateCheck:domMatchResult?.lateCheck === true,
      responseDomSignalConfidence:renderSignal?.signalConfidence || null,
      // Confirmed reply timing requires an exact generated reply ID node.
      // A growing/reconstructed message list is not proof of reply rendering.
      firstMessageDomMs:renderSignal?.signalConfidence === 'high' && renderSignal?.matchedReplyId === true && renderSignal?.signalKind === 'reply-id-node-added'
        ? (renderSignal.latencyMs ?? Math.max(0,eventTs(renderSignal)-responseTs)) : null,
      legacyFirstMessageDomMs:legacyFirstMessage ? (legacyFirstMessage.latencyMs ?? Math.max(0,eventTs(legacyFirstMessage)-responseTs)) : null,
      firstDomBatchMs:firstDom ? Math.max(0,eventTs(firstDom)-responseTs) : null,
      longTasks:lts.length, longTaskMs:Math.round(longTaskMs*10)/10, maxLongTaskMs:Math.round(lts.reduce((m,e)=>Math.max(m,e.durationMs||0),0)*10)/10,
      longAnimationFrames:loafs.length, loafBlockingMs:Math.round(loafBlockingMs*10)/10, maxLoafBlockingMs:Math.round(loafs.reduce((m,e)=>Math.max(m,e.blockingDurationMs||0),0)*10)/10,
      domBatches:dom.length, domMutations, qolRelated, noOp, messageNodesAdded:dom.reduce((n,e)=>n+(e.stats?.messageNodesAdded||0),0),
      mountedMessagesStart:Number.isFinite(startPressure?.mountedMessages)?startPressure.mountedMessages:null,
      mountedMessagesEnd:Number.isFinite(endPressure?.mountedMessages)?endPressure.mountedMessages:null,
      domElementsStart:Number.isFinite(startPressure?.domElements)?startPressure.domElements:null,
      domElementsEnd:Number.isFinite(endPressure?.domElements)?endPressure.domElements:null,
      heapStartBytes:Number.isFinite(startPressure?.jsHeapUsedBytes)?startPressure.jsHeapUsedBytes:null,
      heapEndBytes:Number.isFinite(endPressure?.jsHeapUsedBytes)?endPressure.jsHeapUsedBytes:null,
      topScripts:rankedScripts,
      autoLagSpikes:win.filter(e=>e.type==='performance'&&e.subtype==='auto-lag-spike').length
    });
  }
  const lt = rows.map(x=>x.longTaskMs), loaf = rows.map(x=>x.loafBlockingMs);
  const first = rows.map(x=>x.responseDomSignalMs).filter(Number.isFinite);
  const confirmedFirst = rows.map(x=>x.firstMessageDomMs).filter(Number.isFinite);
  const legacyFirst = rows.map(x=>x.legacyFirstMessageDomMs).filter(Number.isFinite);
  const worst = rows.slice().sort((a,b)=>b.longTaskMs-a.longTaskMs)[0] || null;
  const messageRanges = [[0,9,'0-9'],[10,19,'10-19'],[20,29,'20-29'],[30,39,'30-39'],[40,49,'40-49'],[50,Infinity,'50+']];
  const mountedMessageBuckets = [];
  for (const [min,max,label] of messageRanges) {
    const list = rows.filter(x=>Number.isFinite(x.mountedMessagesStart) && x.mountedMessagesStart>=min && x.mountedMessagesStart<=max);
    if (!list.length) continue;
    const l=list.map(x=>x.longTaskMs), b=list.map(x=>x.loafBlockingMs);
    mountedMessageBuckets.push({ label, min, max:Number.isFinite(max)?max:null, count:list.length, avgLongTaskMs:Math.round(l.reduce((a,v)=>a+v,0)/l.length*10)/10, medianLongTaskMs:Math.round(median(l)*10)/10, p95LongTaskMs:Math.round(percentile(l,0.95)*10)/10, avgLoafBlockingMs:Math.round(b.reduce((a,v)=>a+v,0)/b.length*10)/10, avgDomMutations:Math.round(list.reduce((a,x)=>a+x.domMutations,0)/list.length*10)/10, avgQolRelated:Math.round(list.reduce((a,x)=>a+x.qolRelated,0)/list.length*10)/10, avgNoOp:Math.round(list.reduce((a,x)=>a+x.noOp,0)/list.length*10)/10 });
  }
  const mountedMessageScaling = linearFit(rows.filter(x=>Number.isFinite(x.mountedMessagesStart)), 'mountedMessagesStart', 'longTaskMs');
  const pageScaling = [];
  const byGenPage = new Map();
  for (const row of rows) { const a=byGenPage.get(row.pageId)||[]; a.push(row); byGenPage.set(row.pageId,a); }
  for (const [pageId,list] of byGenPage) {
    if (list.length < 5) continue;
    const fit = linearFit(list.filter(x=>Number.isFinite(x.mountedMessagesStart)), 'mountedMessagesStart', 'longTaskMs');
    if (!fit) continue;
    pageScaling.push({ pageId, route:routeLabel(list[0]?.pageUrl), generations:list.length, minMounted:Math.min(...list.map(x=>x.mountedMessagesStart).filter(Number.isFinite)), maxMounted:Math.max(...list.map(x=>x.mountedMessagesStart).filter(Number.isFinite)), ...fit });
  }
  pageScaling.sort((a,b)=>b.r2-a.r2 || b.samples-a.samples);
  const routeSummaries = ['chat','story'].map(routeKind => {
    const list = rows.filter(x => x.routeKind === routeKind);
    if (!list.length) return null;
    const l = list.map(x=>x.longTaskMs), b = list.map(x=>x.loafBlockingMs), fm = list.map(x=>x.responseDomSignalMs).filter(Number.isFinite), confirmedFm = list.map(x=>x.firstMessageDomMs).filter(Number.isFinite), legacyFm = list.map(x=>x.legacyFirstMessageDomMs).filter(Number.isFinite);
    const fit = linearFit(list.filter(x=>Number.isFinite(x.mountedMessagesStart)), 'mountedMessagesStart', 'longTaskMs');
    return {
      routeKind, count:list.length,
      avgLongTaskMs:Math.round(l.reduce((a,v)=>a+v,0)/list.length*10)/10,
      medianLongTaskMs:Math.round(median(l)*10)/10,
      p95LongTaskMs:Math.round(percentile(l,0.95)*10)/10,
      avgLoafBlockingMs:Math.round(b.reduce((a,v)=>a+v,0)/list.length*10)/10,
      responseDomSignalSamples:fm.length,
      medianResponseDomSignalMs:fm.length?Math.round(median(fm)*10)/10:null,
      firstMessageDomSamples:confirmedFm.length,
      medianFirstMessageDomMs:confirmedFm.length?Math.round(median(confirmedFm)*10)/10:null,
      legacyFirstMessageDomSamples:legacyFm.length,
      generationsOver1sPostBlock:list.filter(x=>x.longTaskMs>=1000).length,
      minMounted:list.some(x=>Number.isFinite(x.mountedMessagesStart))?Math.min(...list.map(x=>x.mountedMessagesStart).filter(Number.isFinite)):null,
      maxMounted:list.some(x=>Number.isFinite(x.mountedMessagesStart))?Math.max(...list.map(x=>x.mountedMessagesStart).filter(Number.isFinite)):null,
      mountedMessageScaling:fit
    };
  }).filter(Boolean);
  return {
    windowMs, count:rows.length,
    avgLongTaskMs:rows.length?Math.round(lt.reduce((a,b)=>a+b,0)/rows.length*10)/10:0,
    medianLongTaskMs:Math.round(median(lt)*10)/10,
    p95LongTaskMs:Math.round(percentile(lt,0.95)*10)/10,
    avgLoafBlockingMs:rows.length?Math.round(loaf.reduce((a,b)=>a+b,0)/rows.length*10)/10:0,
    medianLoafBlockingMs:Math.round(median(loaf)*10)/10,
    responseDomSignalSamples:first.length,
    medianResponseDomSignalMs:first.length?Math.round(median(first)*10)/10:null,
    firstMessageDomSamples:confirmedFirst.length,
    medianFirstMessageDomMs:confirmedFirst.length?Math.round(median(confirmedFirst)*10)/10:null,
    legacyFirstMessageDomSamples:legacyFirst.length,
    generationsOver1sPostBlock:rows.filter(x=>x.longTaskMs>=1000).length,
    missingResponseDomSignal:rows.filter(x=>!Number.isFinite(x.responseDomSignalMs)).length,
    missingFirstMessageDom:rows.filter(x=>!Number.isFinite(x.firstMessageDomMs)).length,
    domMatchOutcomes:Object.entries(rows.reduce((a,x)=>{const k=x.domMatchStatus+' · '+x.domMatchReason;a[k]=(a[k]||0)+1;return a;},{})).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count})).slice(0,10),
    mountedMessageBuckets, mountedMessageScaling, pageScaling:pageScaling.slice(0,8), routeSummaries,
    worst,
    recent:rows.slice(-50)
  };
}
function buildRecentPerformanceComparison(events, windowMs = 20*60*1000) {
  if (!events.length) return { available:false, windowMs };
  const maxTs = events.reduce((m,e)=>Math.max(m,eventTs(e)),0), minTs = events.reduce((m,e)=>Math.min(m,eventTs(e)||Infinity),Infinity);
  const summarize = (start,end) => {
    const list = events.filter(e=>eventTs(e)>=start&&eventTs(e)<=end);
    const long=list.filter(e=>e.type==='performance'&&e.subtype==='long-task');
    const loaf=list.filter(e=>e.type==='performance'&&e.subtype==='long-animation-frame');
    const dom=list.filter(e=>e.type==='dom'&&e.subtype==='mutation-batch');
    const gens=list.filter(isChatSuccessResponse);
    const pageMs=new Map();
    for(const e of long){const k=e.pageId||'(unknown)';const x=pageMs.get(k)||{pageId:k,totalMs:0,count:0,pageUrl:e.pageUrl||e.url||''};x.totalMs+=e.durationMs||0;x.count++;pageMs.set(k,x);}
    const topPage=[...pageMs.values()].sort((a,b)=>b.totalMs-a.totalMs)[0]||null;
    return {startTs:start,endTs:end,coverageMs:Math.max(0,Math.min(end,maxTs)-Math.max(start,minTs)),events:list.length,longTasks:long.length,longTaskMs:Math.round(long.reduce((n,e)=>n+(e.durationMs||0),0)*10)/10,maxLongTaskMs:Math.round(long.reduce((m,e)=>Math.max(m,e.durationMs||0),0)*10)/10,loafBlockingMs:Math.round(loaf.reduce((n,e)=>n+(e.blockingDurationMs||0),0)*10)/10,domMutations:dom.reduce((n,e)=>n+(e.stats?.totalMutations||0),0),noOp:dom.reduce((n,e)=>n+(e.stats?.noOp||0),0),qolRelated:dom.reduce((n,e)=>n+(e.stats?.qolRelated||0),0),generations:gens.length,autoLagSpikes:list.filter(e=>e.type==='performance'&&e.subtype==='auto-lag-spike').length,topPage};
  };
  const recent=summarize(maxTs-windowMs,maxTs), previous=summarize(maxTs-windowMs*2,maxTs-windowMs);
  return {available:previous.coverageMs>=Math.min(windowMs,5*60*1000),windowMs,recent,previous,longTaskRatio:previous.longTaskMs>0?Math.round((recent.longTaskMs/previous.longTaskMs)*100)/100:null,loafRatio:previous.loafBlockingMs>0?Math.round((recent.loafBlockingMs/previous.loafBlockingMs)*100)/100:null};
}
function buildPageInstanceHotspots(events) {
  const pages=new Map();
  for(const e of events){
    if(!e.pageId)continue;
    const currentUrl=e.pageUrl||e.url||'';
    const x=pages.get(e.pageId)||{pageId:e.pageId,firstUrl:currentUrl,lastUrl:currentUrl,firstTs:eventTs(e),lastTs:eventTs(e),longTasks:0,longTaskMs:0,maxLongTaskMs:0,domMutations:0,noOp:0,qolRelated:0,generations:0,routeChanges:0,routeWork:new Map()};
    x.firstTs=Math.min(x.firstTs,eventTs(e));x.lastTs=Math.max(x.lastTs,eventTs(e));if(!x.firstUrl)x.firstUrl=currentUrl;if(currentUrl)x.lastUrl=currentUrl;
    if(e.type==='lifecycle'&&e.subtype==='route-change')x.routeChanges++;
    const r=routeLabel(currentUrl); const rw=x.routeWork.get(r)||{route:r,longTaskMs:0,longTasks:0,domMutations:0};
    if(e.type==='performance'&&e.subtype==='long-task'){x.longTasks++;x.longTaskMs+=e.durationMs||0;x.maxLongTaskMs=Math.max(x.maxLongTaskMs,e.durationMs||0);rw.longTasks++;rw.longTaskMs+=e.durationMs||0;}
    if(e.type==='dom'&&e.subtype==='mutation-batch'){x.domMutations+=e.stats?.totalMutations||0;x.noOp+=e.stats?.noOp||0;x.qolRelated+=e.stats?.qolRelated||0;rw.domMutations+=e.stats?.totalMutations||0;}
    if(isChatSuccessResponse(e))x.generations++;
    x.routeWork.set(r,rw); pages.set(e.pageId,x);
  }
  return [...pages.values()].map(x=>{
    const routes=[...x.routeWork.values()].sort((a,b)=>b.longTaskMs-a.longTaskMs||b.domMutations-a.domMutations);
    return {pageId:x.pageId,pageUrl:x.firstUrl,firstUrl:x.firstUrl,lastUrl:x.lastUrl,dominantRoute:routes[0]?.route||routeLabel(x.lastUrl),routes:routes.slice(0,5).map(r=>({...r,longTaskMs:Math.round(r.longTaskMs*10)/10})),routeChanges:x.routeChanges,firstTs:x.firstTs,lastTs:x.lastTs,longTasks:x.longTasks,longTaskMs:Math.round(x.longTaskMs*10)/10,maxLongTaskMs:Math.round(x.maxLongTaskMs*10)/10,domMutations:x.domMutations,noOp:x.noOp,qolRelated:x.qolRelated,generations:x.generations,durationMs:Math.max(0,x.lastTs-x.firstTs)};
  }).sort((a,b)=>b.longTaskMs-a.longTaskMs).slice(0,8);
}
function buildListingRefillDiagnostics(events) {
  const workers = new Map();
  const maxCaptureTs = events.reduce((m,e)=>Math.max(m,eventTs(e)),0);
  for (const e of events) {
    if (e.type !== 'lifecycle' || e.subtype !== 'page-start' || !isListingRefillPageUrl(e.pageUrl || e.url)) continue;
    const fullUrl = e.pageUrl || e.url || '';
    workers.set(e.pageId, {
      pageId:e.pageId, tabId:e.tabId ?? null, startTs:eventTs(e), endTs:eventTs(e), pageHideTs:null,
      route:routeLabel(fullUrl).replace('?dsListingRefill=1',''), pageNumber:listingRefillPageNumber(fullUrl),
      networkResponses:0, bannerResponses:0, appConfigResponses:0, authResponses:0, userResponses:0,
      personaResponses:0, settingsResponses:0, queueResponses:0,
      searchRequests:0, searchResponses:0, search2xx:0, searchStatusZero:0, searchNon2xx:0,
      searchEvents:[], longTasks:0, longTaskMs:0, statuses:new Set()
    });
  }
  if (!workers.size) return {
    workerPages:0, uniqueTabs:0, reusedTabNavigations:0, networkResponses:0, bannerResponses:0,
    searchRequests:0, searchResponses:0, searchRecoveredFailovers:0, unresolvedSearchFailures:0,
    incompleteAtExport:0, repeatedPageFetches:0, pageBacktracks:0, batches:[]
  };

  for (const e of events) {
    const w=workers.get(e.pageId); if(!w) continue;
    w.endTs=Math.max(w.endTs,eventTs(e));
    if(e.type==='lifecycle'&&e.subtype==='page-hide') {
      w.pageHideTs=eventTs(e);
      w.endTs=Math.max(w.endTs,eventTs(e));
    }
    if(e.type==='performance'&&e.subtype==='long-task'){w.longTasks++;w.longTaskMs+=e.durationMs||0;}

    if(e.type==='network'&&/(?:request|response)$/.test(e.subtype||'')){
      const ep=endpointLabel(e);
      const isResponse=/response$/.test(e.subtype||'');
      const isRequest=isNetworkRequestEvent(e);
      const isSearch=/\/multi_search$/.test(ep);
      if(isResponse){
        w.networkResponses++; if(Number.isFinite(e.status))w.statuses.add(e.status);
        if(/\/cms\/banners$/.test(ep))w.bannerResponses++;
        if(/\/v2\/applications\/spicychat$/.test(ep))w.appConfigResponses++;
        if(/auth\.spicychat\.ai\/oauth2\/token$/.test(ep))w.authResponses++;
        if(/prod\.nd-api\.com\/v2\/users$/.test(ep))w.userResponses++;
        if(/prod\.nd-api\.com\/personas$/.test(ep))w.personaResponses++;
        if(/prod\.nd-api\.com\/users\/settings$/.test(ep))w.settingsResponses++;
        if(/prod\.nd-api\.com\/queue$/.test(ep))w.queueResponses++;
      }
      if(isSearch){
        let host=''; try{host=new URL(endpointUrl(e)).host;}catch(_){}
        w.searchEvents.push({ts:eventTs(e),subtype:e.subtype||'',requestId:e.requestId||null,host,status:Number.isFinite(e.status)?e.status:null,durationMs:e.durationMs||0});
        if(isRequest) w.searchRequests++;
        if(isResponse){
          w.searchResponses++;
          if(e.status>=200&&e.status<300) w.search2xx++;
          else if(e.status===0) w.searchStatusZero++;
          else w.searchNon2xx++;
        }
      }
    }
  }

  const list=[...workers.values()].sort((a,b)=>a.startTs-b.startTs);
  let recoveredFailovers=0, unresolvedSearchFailures=0, noSearchResponseWorkers=0;
  for(const w of list){
    const responses=w.searchEvents.filter(x=>/response$/.test(x.subtype)).sort((a,b)=>a.ts-b.ts);
    let recovered=0, unresolved=0;
    for(const r of responses.filter(x=>x.status===0)){
      const later=responses.find(x=>x.ts>r.ts && x.ts-r.ts<=10000 && x.status>=200&&x.status<300);
      if(later) recovered++; else unresolved++;
    }
    recoveredFailovers+=recovered; unresolvedSearchFailures+=unresolved;
    if(w.searchRequests>0 && w.searchResponses===0) noSearchResponseWorkers++;
    w.recoveredFailovers=recovered;
    w.unresolvedSearchFailures=unresolved;
    w.searchOutcome = recovered ? 'recovered-failover'
      : (w.search2xx>0 ? 'success'
      : (w.searchRequests>0 && w.searchResponses===0 ? 'no-response'
      : (w.searchStatusZero||w.searchNon2xx ? 'failed' : 'no-search')));
    w.searchHosts=[...new Set(w.searchEvents.map(x=>x.host).filter(Boolean))];
    w.openAtExportCandidate = !w.pageHideTs && maxCaptureTs>0 && (maxCaptureTs-w.endTs)<=5000;
  }

  const completed=list.filter(w=>!w.openAtExportCandidate);
  const lifetimes=completed.map(w=>Math.max(0,w.endTs-w.startTs));
  const tabs=new Set(list.map(w=>w.tabId).filter(x=>x!==null&&x!==undefined));
  const batches=[]; let cur=[];
  const flush=()=>{
    if(!cur.length)return;
    const routes=[...new Set(cur.map(w=>w.route))];
    const pages=cur.map(w=>w.pageNumber).filter(Number.isFinite);
    let backtracks=0; for(let i=1;i<pages.length;i++) if(pages[i]<pages[i-1]) backtracks++;
    const uniquePages=new Set(pages);
    batches.push({
      route:routes.length===1?routes[0]:'(mixed)',workers:cur.length,
      uniqueTabs:new Set(cur.map(w=>w.tabId).filter(x=>x!==null&&x!==undefined)).size,
      startTs:cur[0].startTs,endTs:cur[cur.length-1].endTs,
      durationMs:Math.max(0,cur[cur.length-1].endTs-cur[0].startTs),
      pages:pages.slice(),minPage:pages.length?Math.min(...pages):null,maxPage:pages.length?Math.max(...pages):null,
      uniquePages:uniquePages.size,repeatedPageFetches:Math.max(0,pages.length-uniquePages.size),pageBacktracks:backtracks,
      networkResponses:cur.reduce((n,w)=>n+w.networkResponses,0),
      bannerResponses:cur.reduce((n,w)=>n+w.bannerResponses,0),
      searchRequests:cur.reduce((n,w)=>n+w.searchRequests,0),
      searchResponses:cur.reduce((n,w)=>n+w.searchResponses,0),
      search2xx:cur.reduce((n,w)=>n+w.search2xx,0),
      recoveredFailovers:cur.reduce((n,w)=>n+w.recoveredFailovers,0),
      unresolvedSearchFailures:cur.reduce((n,w)=>n+w.unresolvedSearchFailures,0),
      incompleteAtExport:cur.filter(w=>w.openAtExportCandidate).length
    });
    cur=[];
  };
  for(const w of list){
    if(!cur.length||(w.route===cur[cur.length-1].route&&w.startTs-cur[cur.length-1].startTs<=5*60*1000))cur.push(w);
    else{flush();cur=[w];}
  }
  flush();

  return {
    workerPages:list.length, uniqueTabs:tabs.size, reusedTabNavigations:Math.max(0,list.length-tabs.size),
    networkResponses:list.reduce((n,w)=>n+w.networkResponses,0), bannerResponses:list.reduce((n,w)=>n+w.bannerResponses,0),
    appConfigResponses:list.reduce((n,w)=>n+w.appConfigResponses,0), authResponses:list.reduce((n,w)=>n+w.authResponses,0),
    userResponses:list.reduce((n,w)=>n+w.userResponses,0), personaResponses:list.reduce((n,w)=>n+w.personaResponses,0),
    settingsResponses:list.reduce((n,w)=>n+w.settingsResponses,0), queueResponses:list.reduce((n,w)=>n+w.queueResponses,0),
    searchRequests:list.reduce((n,w)=>n+w.searchRequests,0), searchResponses:list.reduce((n,w)=>n+w.searchResponses,0),
    search2xx:list.reduce((n,w)=>n+w.search2xx,0), searchStatusZero:list.reduce((n,w)=>n+w.searchStatusZero,0),
    searchRecoveredFailovers:recoveredFailovers, unresolvedSearchFailures, noSearchResponseWorkers,
    longTasks:list.reduce((n,w)=>n+w.longTasks,0),
    longTaskMs:Math.round(list.reduce((n,w)=>n+w.longTaskMs,0)*10)/10,
    avgLifetimeMs:lifetimes.length?Math.round(lifetimes.reduce((a,b)=>a+b,0)/lifetimes.length*10)/10:0,
    medianLifetimeMs:Math.round(median(lifetimes)*10)/10,
    longLivedWorkers:completed.filter(w=>Math.max(0,w.endTs-w.startTs)>=20000).length,
    incompleteAtExport:list.filter(w=>w.openAtExportCandidate).length,
    networkAll2xx:list.every(w=>[...w.statuses].every(s=>s>=200&&s<300)),
    all2xx:list.every(w=>[...w.statuses].every(s=>s>=200&&s<300)),
    successfulSearchWorkers:list.filter(w=>w.searchOutcome==='success'||w.searchOutcome==='recovered-failover').length,
    repeatedPageFetches:batches.reduce((n,b)=>n+b.repeatedPageFetches,0),
    pageBacktracks:batches.reduce((n,b)=>n+b.pageBacktracks,0),
    searchHosts:[...new Set(list.flatMap(w=>w.searchHosts||[]))],
    batches
  };
}
function buildPagePressureGrowthDiagnostics(events) {
  const byPage=new Map();
  for(const e of events){if(e.type!=='performance'||e.subtype!=='page-pressure'||!e.pageId)continue;const a=byPage.get(e.pageId)||[];a.push(e);byPage.set(e.pageId,a);}
  const out=[];
  for(const [pageId,list0] of byPage){
    const list=list0.slice().sort((a,b)=>eventTs(a)-eventTs(b)); if(!list.length)continue;
    const baseline=list.find(e=>e.reason==='startup'&&Number.isFinite(e.domElements))||list.find(e=>Number.isFinite(e.domElements))||list[0];
    const doms=list.filter(e=>Number.isFinite(e.domElements)); if(!doms.length)continue;
    const maxEvent=doms.reduce((a,b)=>(b.domElements||0)>(a.domElements||0)?b:a,doms[0]); const end=doms[doms.length-1];
    let largestJump={delta:0,from:null,to:null,fromTs:null,toTs:null};
    for(let i=1;i<doms.length;i++){const delta=(doms[i].domElements||0)-(doms[i-1].domElements||0);if(delta>largestJump.delta)largestJump={delta,from:doms[i-1].domElements,to:doms[i].domElements,fromTs:doms[i-1].ts,toTs:doms[i].ts};}
    const maxMounted=Math.max(...list.map(e=>Number.isFinite(e.mountedMessages)?e.mountedMessages:0));
    const maxHeap=Math.max(...list.map(e=>Number.isFinite(e.jsHeapUsedBytes)?e.jsHeapUsedBytes:0));
    const maxResources=Math.max(...list.map(e=>Number.isFinite(e.resourceEntries)?e.resourceEntries:0));
    const baselineDom=Number.isFinite(baseline?.domElements)?baseline.domElements:0, maxDom=maxEvent.domElements||0;
    out.push({pageId,baselineDom,maxDom,endDom:end.domElements||0,growth:maxDom-baselineDom,growthRatio:baselineDom?Math.round(maxDom/baselineDom*100)/100:null,largestJump,maxMountedMessages:maxMounted,maxJsHeapUsedBytes:maxHeap,maxResourceEntries:maxResources,maxRoute:routeLabel(maxEvent.pageUrl||maxEvent.url),firstTs:eventTs(list[0]),lastTs:eventTs(list[list.length-1])});
  }
  return out.filter(x=>x.maxDom>=5000||x.growth>=2000||x.maxMountedMessages>=40).sort((a,b)=>b.maxDom-a.maxDom||b.growth-a.growth).slice(0,10);
}
function buildQuickDislikeDiagnostics(events) {
  const workers = new Map();
  for (const e of events) {
    if (e.type === 'lifecycle' && e.subtype === 'page-start' && isQuickDislikePageUrl(e.pageUrl || e.url)) {
      workers.set(e.pageId, {
        pageId: e.pageId, startTs: e.ts || 0, lastTs: e.ts || 0,
        ratingRequests: 0, ratingResponses: 0, rating2xx: 0, eventRequests: 0, eventResponses: 0, event2xx: 0,
        ratingRequestTs: null, ratingResponseTs: null, eventResponseTs: null,
        networkResponses: 0, bannerResponses: 0, appConfigResponses: 0, authResponses: 0,
        userResponses: 0, personaResponses: 0, settingsResponses: 0, queueResponses: 0,
        longTasks: 0, longTaskMs: 0
      });
    }
  }
  for (const e of events) {
    const w = workers.get(e.pageId); if (!w) continue;
    w.lastTs = Math.max(w.lastTs, e.ts || 0);
    if (e.type === 'performance' && e.subtype === 'long-task') { w.longTasks++; w.longTaskMs += e.durationMs || 0; }
    if (e.type !== 'network') continue;
    const ep = endpointLabel(e);
    const isReq = isNetworkRequestEvent(e), isRes = /response$/.test(e.subtype || '');
    const isRating = /recombee\.com\/spicychat-prod\/ratings\/$/.test(ep);
    const isEvent = /prod\.nd-api\.com\/event$/.test(ep);
    if (isRating && isReq) { w.ratingRequests++; if (w.ratingRequestTs == null) w.ratingRequestTs = e.ts || 0; }
    if (isRating && isRes) { w.ratingResponses++; if (e.status >= 200 && e.status < 300) w.rating2xx++; if (w.ratingResponseTs == null) w.ratingResponseTs = e.ts || 0; }
    if (isEvent && isReq) w.eventRequests++;
    if (isEvent && isRes) { w.eventResponses++; if (e.status >= 200 && e.status < 300) w.event2xx++; if (w.eventResponseTs == null) w.eventResponseTs = e.ts || 0; }
    if (!isRes) continue;
    w.networkResponses++;
    if (/prod\.nd-api\.com\/cms\/banners$/.test(ep)) w.bannerResponses++;
    if (/prod\.nd-api\.com\/v2\/applications\/spicychat$/.test(ep)) w.appConfigResponses++;
    if (/auth\.spicychat\.ai\/oauth2\/token$/.test(ep)) w.authResponses++;
    if (/prod\.nd-api\.com\/v2\/users$/.test(ep)) w.userResponses++;
    if (/prod\.nd-api\.com\/personas$/.test(ep)) w.personaResponses++;
    if (/prod\.nd-api\.com\/users\/settings$/.test(ep)) w.settingsResponses++;
    if (/prod\.nd-api\.com\/queue$/.test(ep)) w.queueResponses++;
  }
  const list = [...workers.values()].sort((a,b)=>a.startTs-b.startTs);
  const groups = [];
  for (const w of list) {
    const prev = groups[groups.length-1];
    if (!prev || w.startTs - prev.lastStartTs > 30000) groups.push({ workers:[w], firstStartTs:w.startTs, lastStartTs:w.startTs });
    else { prev.workers.push(w); prev.lastStartTs = w.startTs; }
  }
  const batches = groups.map(g => {
    const ws = g.workers;
    const reqDelays = ws.filter(w=>w.ratingRequestTs != null).map(w=>w.ratingRequestTs-w.startTs);
    const confirmDelays = ws.filter(w=>w.ratingResponseTs != null).map(w=>w.ratingResponseTs-w.startTs);
    const confirmedAt = ws.map(w=>Math.max(w.ratingResponseTs || 0, w.eventResponseTs || 0, w.lastTs || 0));
    const fullConfirmed = ws.filter(w=>w.rating2xx > 0 && w.event2xx > 0).length;
    const endTs = confirmedAt.length ? Math.max(...confirmedAt) : g.lastStartTs;
    const sum = key => ws.reduce((n,w)=>n+(w[key]||0),0);
    return {
      workers: ws.length, firstStartTs: g.firstStartTs, lastStartTs: g.lastStartTs, endTs,
      durationMs: Math.max(0,endTs-g.firstStartTs), fullConfirmed,
      ratingRequests: sum('ratingRequests'), ratingResponses: sum('ratingResponses'), rating2xx: sum('rating2xx'),
      eventRequests: sum('eventRequests'), eventResponses: sum('eventResponses'), event2xx: sum('event2xx'),
      missingRatingConfirmation: ws.filter(w=>!w.rating2xx).length, missingEventConfirmation: ws.filter(w=>!w.event2xx).length,
      avgStartToRatingRequestMs: reqDelays.length ? Math.round(reqDelays.reduce((a,b)=>a+b,0)/reqDelays.length*10)/10 : 0,
      medianStartToRatingRequestMs: reqDelays.length ? Math.round(median(reqDelays)*10)/10 : 0,
      avgStartToRatingResponseMs: confirmDelays.length ? Math.round(confirmDelays.reduce((a,b)=>a+b,0)/confirmDelays.length*10)/10 : 0,
      medianStartToRatingResponseMs: confirmDelays.length ? Math.round(median(confirmDelays)*10)/10 : 0,
      networkResponses: sum('networkResponses'), bannerResponses: sum('bannerResponses'), appConfigResponses: sum('appConfigResponses'),
      authResponses: sum('authResponses'), userResponses: sum('userResponses'), personaResponses: sum('personaResponses'), settingsResponses: sum('settingsResponses'), queueResponses: sum('queueResponses'),
      longTasks: sum('longTasks'), longTaskMs: Math.round(sum('longTaskMs')*10)/10
    };
  });
  return {
    workerPages: list.length,
    fullyConfirmedWorkers: list.filter(w=>w.rating2xx > 0 && w.event2xx > 0).length,
    rating2xx: list.reduce((n,w)=>n+w.rating2xx,0), event2xx: list.reduce((n,w)=>n+w.event2xx,0),
    networkResponses: list.reduce((n,w)=>n+w.networkResponses,0), bannerResponses: list.reduce((n,w)=>n+w.bannerResponses,0),
    batches
  };
}
function summary(e) {
  if (e.type === 'marker' || e.type === 'marker-context') return [e.label || e.subtype || 'marker', e.detail].filter(Boolean).join(' · ');
  if (e.type === 'network') return `${e.method || ''} ${endpointLabel(e)} ${e.status ?? ''}${e.statusZeroHint ? ` · ${e.statusZeroHint}` : ''}`.trim();
  if (e.type === 'performance') {
    let base;
    if (e.subtype === 'resource') base = `${e.durationMs || 0} ms ${e.name || ''}`;
    else if (e.subtype === 'resource-summary') base = `resource summary · ${e.host || 'third-party'} · ${e.requests || 0} request(s) · max ${Math.round(Number(e.maxDurationMs || 0))} ms · ${formatBytes(Number(e.totalTransferSize || 0))}`;
    else if (e.subtype === 'worker-resource-summary') base = `${e.workerRole || 'QoL worker'} resources · ${e.endpointGroup || 'endpoint'} · ${e.requests || 0} request(s) · median ${Math.round(Number(e.medianDurationMs || 0))} ms · p95 ${Math.round(Number(e.p95DurationMs || 0))} ms · max ${Math.round(Number(e.maxDurationMs || 0))} ms`;
    else if (e.subtype === 'resource-timing-maintenance') base = `Resource Timing proactive clear · ${e.proactiveClears || 0} total`;
    else if (e.subtype === 'worker-capture-profile') base = `worker capture profile · ${e.workerRole || 'QoL worker'} · DOM observer ${e.domObserver === false ? 'off' : 'on'}`;
    else if (e.subtype === 'scroll-performance-window') base = `scroll window · ${e.scrollEvents||0} scroll events · worst frame gap ${e.worstFrameGapMs||0} ms · ${e.framesOver100Ms||0} gaps >100ms` ;
    else if (e.subtype === 'generation-dom-match-result') base = `generation DOM check · ${e.status||'unknown'} · ${e.reason||'unspecified'}`;
    else if (e.subtype === 'slow-input-event') base = `slow ${e.eventKind||'input'} event · ${e.durationMs||0} ms`;
    else if (e.subtype === 'qol-trace-link-status') base = `QoL trace connection · ${e.status||'unknown'} · ${e.traceLevel||'unknown'}`;
    else if (e.subtype === 'inspector-self-throttle') base = `Inspector self-protection · ${e.reason || 'pressure'} · ${Math.round(Number(e.durationMs || 0) / 1000)}s summary mode`;
    else if (e.subtype === 'page-pressure') base = `page-pressure · ${e.domElements ?? '?'} DOM element(s)${Number.isFinite(e.mountedMessages) ? ` · ${e.mountedMessages} mounted msg` : ''}${Number.isFinite(e.jsHeapUsedBytes) ? ` · ${formatBytes(e.jsHeapUsedBytes)} JS heap` : ''} · ${e.reason || 'sample'}`;
    else if (e.subtype === 'long-animation-frame') {
      const top = e.scripts?.[0];
      base = `long-animation-frame ${e.durationMs || 0} ms · blocking ${e.blockingDurationMs || 0} ms${top?.sourceURL ? ` · ${top.sourceKind || 'script'} ${top.sourceURL}` : ''}`;
    } else if (e.subtype === 'generation-response-dom-signal') base = `generation DOM signal · ${e.latencyMs ?? '?'} ms after response · ${e.signalConfidence || 'unknown confidence'} · ${e.mountedMessages ?? '?'} mounted msg`;
    else if (e.subtype === 'generation-first-message-dom') base = `legacy generation DOM sample · ${e.latencyMs ?? '?'} ms after response · unverified · ${e.mountedMessages ?? '?'} mounted msg`;
    else if (e.subtype === 'auto-lag-spike') base = `AUTO lag spike · ${(e.rollingLongTaskMs || 0)} ms Long Tasks / ${(e.rollingWindowMs || 0)/1000}s · worst ${e.worstLongTaskMs || 0} ms`;
    else base = `${e.subtype || ''} ${e.durationMs || ''} ms`;
    const a = e.attribution?.source && e.attribution.source !== 'unknown-mixed' ? ` · ${e.attribution.source}` : (e.attribution?.triggerSource ? ` · trigger:${e.attribution.triggerSource}` : '');
    return `${base}${a}`;
  }
  if (e.type === 'error') {
    if (e.subtype === 'resource-error-summary') return `tracker/resource errors · ${e.trackerHost || 'third-party'} · ${e.occurrences || 0} occurrence(s)`;
    return e.message || e.reason || e.subtype || 'error';
  }
  if (e.type === 'websocket') return `${e.subtype || ''} ${e.url || ''}`.trim();
  if (e.type === 'dom') {
    if (e.subtype === 'mutation-batch' && e.stats) {
      const p = e.stats.topPatterns?.[0];
      const bits = [`${e.stats.totalMutations || 0} changes`];
      if (e.stats.qolOwned) bits.push(`${e.stats.qolOwned} QoL-owned`);
      else if (e.stats.qolRelated) bits.push(`${e.stats.qolRelated} ds-*`);
      if (e.stats.noOp) bits.push(`${e.stats.noOp} no-op`);
      if (Number.isFinite(e.stats.mountedMessages)) bits.push(`${e.stats.mountedMessages} mounted msg`);
      if (e.stats.messageNodesAdded || e.stats.messageNodesRemoved) bits.push(`msg +${e.stats.messageNodesAdded || 0}/-${e.stats.messageNodesRemoved || 0}`);
      if (e.stats.fastModeUsed) bits.push(`fast summary${e.stats.fastModeMutations ? ` ${e.stats.fastModeMutations}` : ''}`);
      if (p) bits.push(`${p.value} ×${p.count}`);
      return `mutation-batch · ${bits.join(' · ')}`;
    }
    return e.subtype || 'DOM change';
  }
  if (e.type === 'qol') return `${e.subtype || 'telemetry'}${e.feature ? ` · ${e.feature}` : ''}${e.operation ? ` · ${e.operation}` : ''}${e.module ? ` · ${e.module}` : ''}`;
  if (e.type === 'state') return e.subtype || 'state snapshot';
  if (e.type === 'storage') {
    if (e.subtype === 'chatDraft-write-burst') return `chatDraft burst · ${e.writes || 0} write(s) / ${Math.round(Number(e.durationMs || 0))} ms${e.unchangedWrites ? ` · ${e.unchangedWrites} unchanged` : ''}`;
    return `${e.subtype || ''} ${e.key || ''}`.trim();
  }
  if (e.type === 'driver' && e.subtype === 'heartbeat-summary') return `Driver heartbeat summary · scheduler ${e.schedulerHeartbeats || 0} · Inspector ${e.inspectorProbeHeartbeats || 0}`;
  return e.subtype || e.type || 'event';
}
function isInteresting(e) { if (e.type === 'marker' || e.type === 'marker-context' || e.type === 'error' || e.type === 'qol') return true; if (e.signals?.length) return true; try { return INTEREST_RE.test(JSON.stringify(e)); } catch (_) { return false; } }
function classFor(e) { if (e.type === 'marker' || e.type === 'marker-context') return 'marker'; if (e.type === 'error' && e.likelyNonCriticalTracker) return 'interesting'; if (e.type === 'error' || (e.type === 'network' && e.status >= 400)) return 'error'; if (e.type === 'performance' && (e.durationMs || 0) >= 1000) return 'slow'; if (isInteresting(e)) return 'interesting'; return ''; }

function buildLongTaskAttributionDiagnostics(events) {
  const tasks=events.filter(e=>e.type==='performance' && e.subtype==='long-task');
  const framesByPage=new Map();
  for(const e of events){
    if(e.type!=='performance'||e.subtype!=='long-animation-frame')continue;
    const page=e.pageId||'unknown';
    if(!framesByPage.has(page))framesByPage.set(page,[]);
    framesByPage.get(page).push(e);
  }
  for(const frames of framesByPage.values())frames.sort((a,b)=>(a.entryStartTs||eventTs(a))-(b.entryStartTs||eventTs(b)));
  let withFrames=0, withScriptDetail=0, explicitQolOverlap=0;
  const sources=new Map(), worst=[];
  for(const task of tasks){
    const start=Number(task.entryStartTs)||((Number(task.ts)||0)-(Number(task.durationMs)||0));
    const end=Number(task.entryEndTs)||start+(Number(task.durationMs)||0);
    if(!(start>0&&end>=start))continue;
    const frames=(framesByPage.get(task.pageId||'unknown')||[]).filter(e=>{
      const fs=Number(e.entryStartTs)||eventTs(e)-(Number(e.durationMs)||0);
      const fe=Number(e.entryEndTs)||fs+(Number(e.durationMs)||0);
      return fs<=end && fe>=start;
    });
    if(frames.length)withFrames++;
    const kinds=[...new Set(frames.flatMap(e=>(e.scripts||[]).map(x=>String(x.sourceKind||'unknown-mixed'))))];
    if(kinds.length)withScriptDetail++;
    // LoAF script entries are candidates only; their presence does not show
    // which part of the frame was responsible for a browser Long Task.
    const label=kinds.length===0?'unattributed':(kinds.length===1?kinds[0]:'multiple-script-sources');
    const group=sources.get(label)||{source:label,count:0,longTaskMs:0};
    group.count++;group.longTaskMs+=Number(task.durationMs)||0;sources.set(label,group);
    if(task.attribution?.qol?.overlappingOperations?.length)explicitQolOverlap++;
    if(Number(task.durationMs||0)>=500) worst.push({ts:task.ts,pageId:task.pageId,route:routeLabel(task.pageUrl||task.url),durationMs:task.durationMs,scriptCandidates:kinds.slice(0,5),inputKind:task.inputCorrelation?.inputKind||null,scrollOverlap:task.inputCorrelation?.scrollTemporalOverlap===true,qolOperationOverlap:!!task.attribution?.qol?.overlappingOperations?.length});
  }
  return {longTasks:tasks.length,loafFrameOverlap:withFrames,loafScriptCandidates:withScriptDetail,explicitQolOperationOverlap:explicitQolOverlap,unattributedTasks:tasks.length-withScriptDetail,sourceCandidates:[...sources.values()].sort((a,b)=>b.longTaskMs-a.longTaskMs).map(x=>({...x,longTaskMs:Math.round(x.longTaskMs*10)/10})),worstCorrelations:worst.sort((a,b)=>b.durationMs-a.durationMs).slice(0,15),note:'LoAF script sources, nearby input and QoL operation overlap are evidence of temporal proximity, never proof of who caused a Long Task.'};
}
function buildScrollAndInputDiagnostics(events) {
  const scroll=events.filter(e=>e.type==='performance'&&e.subtype==='scroll-performance-window');
  const inputs=events.filter(e=>e.type==='performance'&&e.subtype==='slow-input-event');
  const long=events.filter(e=>e.type==='performance'&&e.subtype==='long-task');
  const linkedLong=long.filter(e=>e.inputCorrelation?.scrollTemporalOverlap===true);
  const worst=scroll.slice().sort((a,b)=>(b.worstFrameGapMs||0)-(a.worstFrameGapMs||0)).slice(0,12).map(e=>({ts:e.ts,pageId:e.pageId,route:routeLabel(e.pageUrl||e.url),burstId:e.scrollBurstId,trigger:e.trigger,scrollEvents:e.scrollEvents,worstFrameGapMs:e.worstFrameGapMs,framesOver100Ms:e.framesOver100Ms,nearbyLongTaskMs:e.nearbyLongTaskMs}));
  const scriptSources=new Map();
  for(const e of events){if(e.type!=='performance'||e.subtype!=='long-animation-frame')continue;for(const sc of e.scripts||[]){const source=sc.sourceKind||'unknown-mixed';const x=scriptSources.get(source)||{source,scriptTimeMs:0,count:0};x.scriptTimeMs+=Number(sc.durationMs||0);x.count++;scriptSources.set(source,x);}}
  return {scrollWindows:scroll.length,scrollFrameSamples:scroll.reduce((n,e)=>n+(e.sampledFrames||0),0),scrollFrameGapsOver50ms:scroll.reduce((n,e)=>n+(e.framesOver50Ms||0),0),scrollFrameGapsOver100ms:scroll.reduce((n,e)=>n+(e.framesOver100Ms||0),0),scrollLinkedLongTasks:linkedLong.length,scrollLinkedLongTaskMs:Math.round(linkedLong.reduce((n,e)=>n+(e.durationMs||0),0)*10)/10,slowInputEvents:inputs.length,slowInputByKind:Object.entries(inputs.reduce((a,e)=>{const k=e.eventKind||'unknown';a[k]=(a[k]||0)+1;return a;},{})).map(([kind,count])=>({kind,count})),worstScrollWindows:worst,scriptSources:[...scriptSources.values()].sort((a,b)=>b.scriptTimeMs-a.scriptTimeMs).slice(0,8),attributionNote:'Input/scroll proximity and LoAF script entries are correlations, not proof that an extension caused a freeze.'};
}
function buildCaptureHealthDiagnostics(events) {
  const pressure = events.filter(e => e.type === 'performance' && e.subtype === 'page-pressure');
  const lifecycle = events.filter(e => e.type === 'lifecycle');
  const domBatches = events.filter(e => e.type === 'dom' && e.subtype === 'mutation-batch');
  const resourceBufferFull = events.filter(e=>e.type==='performance'&&e.subtype==='resource-timing-buffer-full');
  const selfThrottle = events.filter(e=>e.type==='performance'&&e.subtype==='inspector-self-throttle');
  const throttleByPage=new Map();
  for(const e of selfThrottle){const page=e.pageId||'(unknown)';if(!throttleByPage.has(page))throttleByPage.set(page,[]);throttleByPage.get(page).push([Number(e.ts)||0,(Number(e.ts)||0)+Math.max(0,Number(e.durationMs)||0)]);}
  const mergedThrottle=[];
  for(const [page,rows] of throttleByPage){rows.sort((a,b)=>a[0]-b[0]);for(const [start,end] of rows){const last=mergedThrottle[mergedThrottle.length-1];if(last&&last.page===page&&start<=last.end) last.end=Math.max(last.end,end);else mergedThrottle.push({page,start,end});}}
  const captureCoverageNotes=events.filter(e=>e.type==='performance'&&['generation-dom-match-result','qol-trace-capture-config','qol-trace-link-status'].includes(e.subtype));
  const resourceSummaries = events.filter(e=>e.type==='performance'&&e.subtype==='resource-summary');
  const workerResourceSummaries = events.filter(e=>e.type==='performance'&&e.subtype==='worker-resource-summary');
  const resourceMaintenance = events.filter(e=>e.type==='performance'&&e.subtype==='resource-timing-maintenance');
  const trackerErrorSummaries = events.filter(e=>e.type==='error'&&e.subtype==='resource-error-summary');
  const maxFinite = (items, getter) => items.reduce((m,e) => { const v = getter(e); return Number.isFinite(v) ? Math.max(m, v) : m; }, 0);
  const reasonCounts = {};
  for (const e of pressure) reasonCounts[e.reason || 'unknown'] = (reasonCounts[e.reason || 'unknown'] || 0) + 1;
  const fastReasonCounts = {};
  for (const e of domBatches) for (const r of (e.stats?.fastModeReasons || [])) fastReasonCounts[r.value || 'unknown'] = (fastReasonCounts[r.value || 'unknown'] || 0) + (r.count || 0);
  return {
    pressureSnapshots: pressure.length,
    maxDomElements: maxFinite(pressure, e => e.domElements),
    maxMountedMessages: maxFinite(pressure, e => e.mountedMessages),
    maxJsHeapUsedBytes: maxFinite(pressure, e => e.jsHeapUsedBytes),
    maxJsHeapTotalBytes: maxFinite(pressure, e => e.jsHeapTotalBytes),
    pressureReasons: reasonCounts,
    pageShows: lifecycle.filter(e => e.subtype === 'page-show').length,
    pageHides: lifecycle.filter(e => e.subtype === 'page-hide').length,
    pageFreezes: lifecycle.filter(e => e.subtype === 'page-freeze').length,
    pageResumes: lifecycle.filter(e => e.subtype === 'page-resume').length,
    discardedPageStarts: lifecycle.filter(e => e.subtype === 'page-start' && e.wasDiscarded === true).length,
    discardedStarts: lifecycle.filter(e => e.subtype === 'page-start' && e.wasDiscarded === true).slice(-12).map(e=>({ts:e.ts,pageId:e.pageId,route:routeLabel(e.pageUrl||e.url)})),
    maxResourceEntries: Math.max(maxFinite(pressure, e => e.resourceEntries), maxFinite(resourceBufferFull, e => e.resourceEntries)),
    resourceTimingBufferFullEvents: resourceBufferFull.length,
    resourceTimingBufferFullOccurrences: resourceBufferFull.length + resourceBufferFull.reduce((n,e)=>n+(e.suppressedSinceLast || 0),0),
    resourceTimingBufferFullSuppressed: resourceBufferFull.reduce((n,e)=>n+(e.suppressedSinceLast || 0),0),
    resourceTimingBufferClearAttempts: resourceBufferFull.filter(e=>e.clearAttempted === true || typeof e.cleared === 'boolean').length,
    resourceTimingBufferClears: resourceBufferFull.filter(e=>e.cleared === true).length,
    resourceTimingBufferClearFailures: resourceBufferFull.filter(e=>(e.clearAttempted === true || typeof e.cleared === 'boolean') && e.cleared !== true).length,
    inspectorSelfThrottleEvents: selfThrottle.length,
    inspectorSelfThrottleMs: selfThrottle.reduce((n,e)=>n+(Number(e.durationMs)||0),0),
    inspectorSelfThrottleUnionMs: mergedThrottle.reduce((n,x)=>n+Math.max(0,x.end-x.start),0),
    inspectorSelfThrottleWindows: mergedThrottle.slice(-30).map(x=>({pageId:x.page,startTs:x.start,endTs:x.end,durationMs:x.end-x.start})),
    captureChecks:{generationResults:captureCoverageNotes.filter(e=>e.subtype==='generation-dom-match-result').length,qolCaptureOn:captureCoverageNotes.filter(e=>e.subtype==='qol-trace-capture-config'&&e.enabled===true).length,qolCaptureOff:captureCoverageNotes.filter(e=>e.subtype==='qol-trace-capture-config'&&e.enabled===false).length,qolNoTrace:captureCoverageNotes.filter(e=>e.subtype==='qol-trace-link-status'&&e.status==='no-response').length,qolHandshakeOnly:captureCoverageNotes.filter(e=>e.subtype==='qol-trace-link-status'&&e.status==='handshake-only').length,qolTracesReceived:captureCoverageNotes.filter(e=>e.subtype==='qol-trace-link-status'&&e.status==='trace-received').length},
    inspectorSelfThrottleReasons: Object.entries(selfThrottle.reduce((acc,e)=>{ const k=e.reason||'unknown'; acc[k]=(acc[k]||0)+1; return acc; },{})).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
    aggregatedThirdPartyResourceRequests: resourceSummaries.reduce((n,e)=>n+(Number(e.requests)||0),0),
    aggregatedWorkerResourceRequests: workerResourceSummaries.reduce((n,e)=>n+(Number(e.requests)||0),0),
    workerResourceSummaryEvents: workerResourceSummaries.length,
    resourceTimingProactiveClears: resourceMaintenance.length ? Math.max(...resourceMaintenance.map(e=>Number(e.proactiveClears)||0)) : 0,
    aggregatedTrackerErrors: trackerErrorSummaries.reduce((n,e)=>n+(Number(e.occurrences)||0),0),
    observerCallbacks: domBatches.reduce((n,e)=>n+(e.stats?.observerCallbacks || 0),0),
    observerFastModeCallbacks: domBatches.reduce((n,e)=>n+(e.stats?.fastModeCallbacks || 0),0),
    observerFastModeMutations: domBatches.reduce((n,e)=>n+(e.stats?.fastModeMutations || 0),0),
    observerFastModeReasons: Object.entries(fastReasonCounts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([value,count])=>({value,count})),
    maxObserverCallbackMs: Math.round(maxFinite(domBatches, e => e.stats?.maxObserverCallbackMs || 0)*1000)/1000,
    observerCallbacksOver16ms: domBatches.reduce((n,e)=>n+(e.stats?.observerCallbacksOver16ms || 0),0),
    observerCallbacksOver50ms: domBatches.reduce((n,e)=>n+(e.stats?.observerCallbacksOver50ms || 0),0),
    inspectorObserverMs: Math.round(domBatches.reduce((n,e)=>n+(e.stats?.inspectorObserverMs || 0),0)*1000)/1000,
    inspectorObserverWallMs: Math.round(domBatches.reduce((n,e)=>n+(e.stats?.inspectorObserverWallMs ?? e.stats?.inspectorObserverMs ?? 0),0)*1000)/1000,
    observerTimingContaminatedCallbacks: domBatches.reduce((n,e)=>n+(e.stats?.observerTimingContaminatedCallbacks || 0),0),
    observerTimingContaminatedWallMs: Math.round(domBatches.reduce((n,e)=>n+(e.stats?.observerTimingContaminatedWallMs || 0),0)*1000)/1000,
    staleGenerationFollowupsSkipped: events.filter(e=>e.type==='performance'&&e.subtype==='generation-followup-skipped-late').length,
    inspectorFlushMs: Math.round(domBatches.reduce((n,e)=>n+(e.stats?.inspectorFlushMs || 0),0)*1000)/1000,
    maxObserverBatchMs: Math.round(maxFinite(domBatches, e => e.stats?.inspectorObserverMs || 0)*1000)/1000,
    maxObserverWallBatchMs: Math.round(maxFinite(domBatches, e => e.stats?.inspectorObserverWallMs ?? e.stats?.inspectorObserverMs ?? 0)*1000)/1000,
    observerBatchesOver16ms: domBatches.filter(e => (e.stats?.inspectorObserverMs || 0) >= 16).length,
    observerBatchesOver50ms: domBatches.filter(e => (e.stats?.inspectorObserverMs || 0) >= 50).length,
    avgObserverCallbackMs: (() => {
      const callbacks = domBatches.reduce((n,e)=>n+(e.stats?.observerCallbacks || 0),0);
      const ms = domBatches.reduce((n,e)=>n+(e.stats?.inspectorObserverMs || 0),0);
      return callbacks ? Math.round((ms/callbacks)*1000)/1000 : 0;
    })()
  };
}

function normalizedQolIdentity(e) {
  if (!e || typeof e !== 'object') return { version:null, build:null, revision:null, protocol:null, sessionId:null };
  const q = e.qolIdentity && typeof e.qolIdentity === 'object' ? e.qolIdentity : {};
  const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
  return {
    version: String(e.qolVersion ?? p.qolVersion ?? q.version ?? '').trim() || null,
    build: String(e.qolBuild ?? p.qolBuild ?? q.build ?? '').trim() || null,
    revision: String(e.qolRevision ?? p.qolRevision ?? q.revision ?? '').trim() || null,
    protocol: String(e.traceProtocol ?? p.protocolVersion ?? q.protocol ?? '').trim() || null,
    sessionId: String(e.qolSessionId ?? p.qolSessionId ?? '').trim() || null
  };
}

function compareVersionStrings(a, b) {
  const pa=String(a||'').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb=String(b||'').split(/[^0-9]+/).filter(Boolean).map(Number);
  const n=Math.max(pa.length,pb.length);
  for(let i=0;i<n;i++){const da=pa[i]||0,db=pb[i]||0;if(da!==db)return da-db;}
  return String(a||'').localeCompare(String(b||''));
}

function buildVersionDiagnostics(events) {
  const qolByVersion = new Map();
  const pageVersion = new Map();
  const qEvents = events.filter(e => !!normalizedQolIdentity(e).version);
  for (const e of qEvents.slice().sort((a,b)=>(a.ts||0)-(b.ts||0))) {
    const identity = normalizedQolIdentity(e);
    const version = identity.version;
    if (!version) continue;
    const x = qolByVersion.get(version) || { version, events: 0, pageIds: new Set(), firstTs: e.ts || 0, lastTs: e.ts || 0, builds: new Set(), revisions: new Set() };
    x.events++; if (e.pageId) x.pageIds.add(e.pageId); if (identity.build) x.builds.add(identity.build); if (identity.revision) x.revisions.add(identity.revision);
    x.firstTs = Math.min(x.firstTs, e.ts || x.firstTs); x.lastTs = Math.max(x.lastTs, e.ts || x.lastTs);
    qolByVersion.set(version, x);
    if (e.pageId) pageVersion.set(e.pageId, version);
  }
  const qolVersions = [...qolByVersion.values()].sort((a,b)=>compareVersionStrings(a.version,b.version) || a.firstTs-b.firstTs).map(x => ({ version: x.version, events: x.events, pages: x.pageIds.size, firstTs: x.firstTs, lastTs: x.lastTs, builds:[...x.builds], revisions:[...x.revisions] }));

  const inspectorByVersion = new Map();
  for (const e of events) {
    if (e.type !== 'lifecycle' || e.subtype !== 'page-start' || !e.inspectorVersion) continue;
    const version = String(e.inspectorVersion);
    const x = inspectorByVersion.get(version) || { version, pageStarts: 0, firstTs: e.ts || 0, lastTs: e.ts || 0 };
    x.pageStarts++; x.firstTs = Math.min(x.firstTs, e.ts || x.firstTs); x.lastTs = Math.max(x.lastTs, e.ts || x.lastTs);
    inspectorByVersion.set(version, x);
  }
  const inspectorVersions = [...inspectorByVersion.values()].sort((a,b)=>a.firstTs-b.firstTs);

  const byVersion = new Map();
  const bucket = version => {
    const key = version || 'unknown';
    if (!byVersion.has(key)) byVersion.set(key, { version: key, pageStarts: 0, domBatches: 0, totalMutations: 0, qolRelated: 0, noOp: 0, longTasks: 0, longTaskMs: 0, longAnimationFrames: 0, loafBlockingMs: 0 });
    return byVersion.get(key);
  };
  for (const e of events) {
    const v = pageVersion.get(e.pageId) || null;
    if (!v) continue;
    const x = bucket(v);
    if (e.type === 'lifecycle' && e.subtype === 'page-start') x.pageStarts++;
    if (e.type === 'dom' && e.subtype === 'mutation-batch') {
      const st = e.stats || {}; x.domBatches++; x.totalMutations += st.totalMutations || 0; x.qolRelated += st.qolRelated || 0; x.noOp += st.noOp || 0;
    }
    if (e.type === 'performance' && e.subtype === 'long-task') { x.longTasks++; x.longTaskMs += e.durationMs || 0; }
    if (e.type === 'performance' && e.subtype === 'long-animation-frame') { x.longAnimationFrames++; x.loafBlockingMs += e.blockingDurationMs || 0; }
  }
  const performanceByQolVersion = [...byVersion.values()].sort((a,b) => {
    const ai = qolVersions.findIndex(x=>x.version===a.version), bi = qolVersions.findIndex(x=>x.version===b.version); return ai-bi;
  }).map(x => ({ ...x, longTaskMs: Math.round(x.longTaskMs*10)/10, loafBlockingMs: Math.round(x.loafBlockingMs*10)/10, noOpPct: x.totalMutations ? Math.round((x.noOp/x.totalMutations)*1000)/10 : 0, qolRelatedPct: x.totalMutations ? Math.round((x.qolRelated/x.totalMutations)*1000)/10 : 0 }));

  let overlap = null;
  if (qolVersions.length > 1) {
    const newest = qolVersions[qolVersions.length - 1];
    const older = new Set(qolVersions.slice(0,-1).map(x=>x.version));
    const oldAfter = qEvents.filter(e => older.has(normalizedQolIdentity(e).version || '') && (e.ts || 0) >= newest.firstTs);
    if (oldAfter.length) {
      const lastOldTs = Math.max(...oldAfter.map(e=>e.ts||0));
      overlap = { newestVersion: newest.version, firstNewestTs: newest.firstTs, lastOlderTs: lastOldTs, durationMs: Math.max(0,lastOldTs-newest.firstTs), olderVersions: [...older], olderTelemetryEventsAfterNewest: oldAfter.length };
    }
  }
  return { qolVersions, inspectorVersions, performanceByQolVersion, mixedQolVersionOverlap: overlap };
}

function compactInteractionState(i) {
  if (!i || typeof i !== 'object') return undefined;
  const out = {};
  if (typeof i.visibilityState === 'string') out.visibilityState = i.visibilityState;
  if (typeof i.hidden === 'boolean') out.hidden = i.hidden;
  if (typeof i.windowFocused === 'boolean') out.windowFocused = i.windowFocused;
  if (typeof i.documentHasFocus === 'boolean') out.documentHasFocus = i.documentHasFocus;
  if (typeof i.userIdle === 'boolean') out.userIdle = i.userIdle;
  if (Number.isFinite(i.idleForMs)) out.idleForMs = i.idleForMs;
  return Object.keys(out).length ? out : undefined;
}
function compactAttribution(a) {
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  for (const key of ['source','confidence','triggerSource','executor','reason']) if (a[key] != null) out[key] = a[key];
  return Object.keys(out).length ? out : undefined;
}
function decorateCompactProjection(e, out) {
  const interaction = compactInteractionState(e.interaction);
  const attribution = compactAttribution(e.attribution);
  const qi = normalizedQolIdentity(e);
  if (interaction) out.interaction = interaction;
  if (attribution) out.attribution = attribution;
  if (qi.version || qi.build || qi.revision || qi.protocol) out.qolIdentity = { version:qi.version, build:qi.build, revision:qi.revision, protocol:qi.protocol };
  return out;
}

function compactVersionProjection(e) {
  if (e.type === 'qol') return decorateCompactProjection(e, {
    type:e.type, subtype:e.subtype, ts:e.ts, sourceTs:e.sourceTs, receivedAt:e.receivedAt, pageId:e.pageId, tabId:e.tabId, pageUrl:e.pageUrl||e.url,
    qolVersion:e.qolVersion, qolBuild:e.qolBuild, qolSessionId:e.qolSessionId, traceSessionId:e.traceSessionId, traceProtocol:e.traceProtocol,
    traceSeq:e.traceSeq, traceSequenceGapBefore:e.traceSequenceGapBefore, traceBatchIndex:e.traceBatchIndex, traceBatchSize:e.traceBatchSize,
    feature:e.feature, module:e.module, category:e.category, operation:e.operation, operationId:e.operationId, parentOperationId:e.parentOperationId,
    workerSessionId:e.workerSessionId, requestId:e.requestId, requestFingerprint:e.requestFingerprint, requestedUrl:e.requestedUrl,
    monoMs:e.monoMs, durationMs:e.durationMs, queueDelayMs:e.queueDelayMs, lane:e.lane, priority:e.priority, outcome:e.outcome, status:e.status,
    storageKey:e.storageKey, storageBackend:e.storageBackend, approxBytes:e.approxBytes, records:e.records, settingName:e.settingName,
    counts:e.counts, meta:e.meta,
    payload:e.payload && typeof e.payload==='object' ? {
      qolVersion:e.payload.qolVersion, protocolVersion:e.payload.protocolVersion, reason:e.payload.reason, traceLevel:e.payload.traceLevel,
      endpoint:e.payload.endpoint, requestedUrl:e.payload.requestedUrl, durationMs:e.payload.durationMs, status:e.payload.status, ok:e.payload.ok,
      outcome:e.payload.outcome, counts:e.payload.counts, key:e.payload.key, storageKey:e.payload.storageKey, backend:e.payload.backend,
      approxBytes:e.payload.approxBytes, records:e.payload.records, workerType:e.payload.workerType, origin:e.payload.origin
    } : undefined
  });
  if (e.type === 'lifecycle' && e.subtype === 'page-start') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, inspectorVersion:e.inspectorVersion, wasDiscarded:e.wasDiscarded===true, href:e.href, pageUrl:e.pageUrl || e.url };
  if (e.type === 'lifecycle' && e.subtype === 'route-change') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, pageUrl:e.pageUrl || e.to || e.url, from:e.from, to:e.to };
  if (e.type === 'lifecycle' && /^(page-show|page-hide|page-freeze|page-resume)$/.test(e.subtype || '')) return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, persisted:e.persisted===true };
  if (e.type === 'performance' && e.subtype === 'page-pressure') return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, pageUrl:e.pageUrl || e.url, reason:e.reason, relatedRequestId:e.relatedRequestId, generationResponseTs:e.generationResponseTs, backendDurationMs:e.backendDurationMs, spikeId:e.spikeId, domElements:e.domElements, mountedMessages:e.mountedMessages, mountedMessageKind:e.mountedMessageKind, jsHeapUsedBytes:e.jsHeapUsedBytes, jsHeapTotalBytes:e.jsHeapTotalBytes, resourceEntries:e.resourceEntries, resourceTimingCapacityHint:e.resourceTimingCapacityHint });
  if (e.type === 'performance' && e.subtype === 'resource-timing-buffer-full') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, pageUrl:e.pageUrl || e.url, configuredSize:e.configuredSize, resourceEntries:e.resourceEntries, clearAttempted:e.clearAttempted, cleared:e.cleared, clearError:e.clearError, occurrence:e.occurrence, suppressedSinceLast:e.suppressedSinceLast };
  if (e.type === 'dom' && e.subtype === 'mutation-batch') return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, pageUrl:e.pageUrl || e.url, stats:{ totalMutations:e.stats?.totalMutations||0, qolRelated:e.stats?.qolRelated||0, qolOwned:e.stats?.qolOwned||0, noOp:e.stats?.noOp||0, messageNodesAdded:e.stats?.messageNodesAdded||0, messageNodesRemoved:e.stats?.messageNodesRemoved||0, mountedMessages:e.stats?.mountedMessages, observerCallbacks:e.stats?.observerCallbacks||0, inspectorObserverMs:e.stats?.inspectorObserverMs||0, inspectorObserverWallMs:e.stats?.inspectorObserverWallMs, observerTimingContaminatedCallbacks:e.stats?.observerTimingContaminatedCallbacks||0, observerTimingContaminatedWallMs:e.stats?.observerTimingContaminatedWallMs||0, inspectorFlushMs:e.stats?.inspectorFlushMs||0, largeDomMode:e.stats?.largeDomMode===true, fastModeUsed:e.stats?.fastModeUsed===true, fastModeCallbacks:e.stats?.fastModeCallbacks||0, fastModeMutations:e.stats?.fastModeMutations||0, fastModeReasons:(e.stats?.fastModeReasons||[]).slice(0,6), maxObserverCallbackMs:e.stats?.maxObserverCallbackMs||0, observerCallbacksOver16ms:e.stats?.observerCallbacksOver16ms||0, observerCallbacksOver50ms:e.stats?.observerCallbacksOver50ms||0, topPatterns:(e.stats?.topPatterns||[]).slice(0,8) } });
  if (e.type === 'performance' && (e.subtype === 'long-task' || e.subtype === 'long-animation-frame')) return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, entryStartTs:e.entryStartTs, entryEndTs:e.entryEndTs, startTimeMs:e.startTimeMs, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, durationMs:e.durationMs||0, blockingDurationMs:e.blockingDurationMs||0, scripts:e.subtype==='long-animation-frame'?(e.scripts||[]).slice(0,3):undefined, inputCorrelation:e.inputCorrelation||null, attribution:e.attribution||null, pageUrl:e.pageUrl || e.url, url:e.url || e.pageUrl });
  if (e.type === 'performance' && (e.subtype === 'generation-response-dom-signal' || e.subtype === 'generation-first-message-dom' || e.subtype === 'auto-lag-spike' || e.subtype === 'generation-followup-skipped-late')) return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, pageUrl:e.pageUrl || e.url, relatedRequestId:e.relatedRequestId, generationResponseTs:e.generationResponseTs, latencyMs:e.latencyMs, signalKind:e.signalKind, signalConfidence:e.signalConfidence, renderSignalVersion:e.renderSignalVersion, mountedMessagesAtResponse:e.mountedMessagesAtResponse, mountedMessages:e.mountedMessages, mountedDelta:e.mountedDelta, mountedMessageKind:e.mountedMessageKind, generationContentAdded:e.generationContentAdded===true, matchedReplyId:e.matchedReplyId===true, priorMessageReinserted:e.priorMessageReinserted===true, spikeId:e.spikeId, rollingWindowMs:e.rollingWindowMs, rollingLongTaskMs:e.rollingLongTaskMs, longTaskCount:e.longTaskCount, worstLongTaskMs:e.worstLongTaskMs, reason:e.reason, intendedDelayMs:e.intendedDelayMs, actualDelayMs:e.actualDelayMs, latenessMs:e.latenessMs, coalescedCount:e.coalescedCount });
  if (e.type === 'performance' && e.subtype === 'resource') return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, name:e.name, durationMs:e.durationMs||0, transferSize:e.transferSize||0, encodedBodySize:e.encodedBodySize||0, thirdParty:e.thirdParty===true });
  if (e.type === 'performance' && e.subtype === 'resource-summary') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, host:e.host, initiatorType:e.initiatorType, requests:e.requests||0, totalDurationMs:e.totalDurationMs||0, maxDurationMs:e.maxDurationMs||0, totalTransferSize:e.totalTransferSize||0 };
  if (e.type === 'performance' && e.subtype === 'worker-resource-summary') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, pageRole:e.pageRole||null, workerRole:e.workerRole, endpointGroup:e.endpointGroup, initiatorType:e.initiatorType, requests:e.requests||0, totalDurationMs:e.totalDurationMs||0, avgDurationMs:e.avgDurationMs||0, medianDurationMs:e.medianDurationMs||0, p95DurationMs:e.p95DurationMs||0, maxDurationMs:e.maxDurationMs||0, over500ms:e.over500ms||0, over1000ms:e.over1000ms||0, totalTransferSize:e.totalTransferSize||0, firstAt:e.firstAt, lastAt:e.lastAt };
  if (e.type === 'performance' && e.subtype === 'resource-timing-maintenance') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, configuredSize:e.configuredSize, threshold:e.threshold, proactiveClears:e.proactiveClears||0 };
  if (e.type === 'performance' && e.subtype === 'worker-capture-profile') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, pageRole:e.pageRole||null, workerRole:e.workerRole, domObserver:e.domObserver, resourceTiming:e.resourceTiming };
  if (e.type === 'performance' && e.subtype === 'generation-dom-match-result') return {type:e.type,subtype:e.subtype,ts:e.ts,pageId:e.pageId,relatedRequestId:e.relatedRequestId,generationResponseTs:e.generationResponseTs,status:e.status,reason:e.reason,hasReplyId:e.hasReplyId===true,exactReplyPresentAtResponse:e.exactReplyPresentAtResponse===true,priorDomMutationCount:e.priorDomMutationCount||0,postResponseMessageMutationCount:e.postResponseMessageMutationCount||0,lateCheck:e.lateCheck===true,signalConfidence:e.signalConfidence};
  if (e.type === 'performance' && e.subtype === 'scroll-performance-window') return {type:e.type,subtype:e.subtype,ts:e.ts,pageId:e.pageId,pageUrl:e.pageUrl||e.url,scrollBurstId:e.scrollBurstId,trigger:e.trigger,durationMs:e.durationMs,scrollEvents:e.scrollEvents,sampledFrames:e.sampledFrames,framesOver50Ms:e.framesOver50Ms,framesOver100Ms:e.framesOver100Ms,worstFrameGapMs:e.worstFrameGapMs,estimatedMissedFrames:e.estimatedMissedFrames,nearbyLongTasks:e.nearbyLongTasks,nearbyLongTaskMs:e.nearbyLongTaskMs,attribution:e.attribution};
  if (e.type === 'performance' && e.subtype === 'slow-input-event') return {type:e.type,subtype:e.subtype,ts:e.ts,pageId:e.pageId,pageUrl:e.pageUrl||e.url,eventKind:e.eventKind,durationMs:e.durationMs,inputDelayMs:e.inputDelayMs,processingMs:e.processingMs,entryStartTs:e.entryStartTs,attribution:e.attribution};
  if (e.type === 'performance' && (e.subtype === 'qol-trace-link-status' || e.subtype === 'qol-trace-capture-config')) return {type:e.type,subtype:e.subtype,ts:e.ts,pageId:e.pageId,status:e.status,enabled:e.enabled,traceLevel:e.traceLevel,handshakes:e.handshakes,received:e.received,lastTraceAgeMs:e.lastTraceAgeMs,handshakeResponses:e.handshakeResponses,qolIdentity:e.qolIdentity,reason:e.reason};
  if (e.type === 'performance' && e.subtype === 'inspector-self-throttle') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, reason:e.reason, durationMs:e.durationMs||0, queuedEvents:e.queuedEvents||0, eventsThisSecond:e.eventsThisSecond||0, observerWallMs:e.observerWallMs||0, mutationRecords:e.mutationRecords||0 };
  if (e.type === 'lifecycle' && /^(network-offline|network-online)$/.test(e.subtype || '')) return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageUrl:e.pageUrl||e.url };
  if (e.type === 'storage') return { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, key:e.key, writes:e.writes, valueLength:e.valueLength, lastValueLength:e.lastValueLength };
  if (e.type === 'error') return decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, message:e.message, reason:e.reason, likelyNonCriticalTracker:e.likelyNonCriticalTracker===true, resourceUrl:e.resourceUrl, trackerHost:e.trackerHost, occurrences:e.occurrences||0, sampleResourceUrl:e.sampleResourceUrl });
  if (e.type === 'marker' || e.type === 'marker-context') return { type:e.type, subtype:e.subtype, ts:e.ts, id:e.id, label:e.label, pageId:e.pageId, pageUrl:e.pageUrl||e.url, captureWindow:e.captureWindow, relatedMarkerTs:e.relatedMarkerTs, recentContext:Array.isArray(e.recentContext)?new Array(e.recentContext.length):undefined };
  if (e.type === 'driver') return decorateCompactProjection(e, {
    type:e.type, subtype:e.subtype, ts:e.ts, pageId:e.pageId, tabId:e.tabId, pageUrl:e.pageUrl||e.url, url:e.url||e.pageUrl,
    action:e.action, phase:e.phase, role:e.role, driverPageType:e.driverPageType, driverTarget:e.driverTarget, driverLabel:e.driverLabel,
    driverPath:e.driverPath, driverNumber:e.driverNumber, driverAttempt:e.driverAttempt, driverDurationMs:e.driverDurationMs,
    driverHref:e.driverHref, driverTs:e.driverTs, inspectorProbeVersion:e.inspectorProbeVersion, qolExtensionId:e.qolExtensionId,
    probesSinceLast:e.probesSinceLast, schedulerHeartbeats:e.schedulerHeartbeats, inspectorProbeHeartbeats:e.inspectorProbeHeartbeats,
    firstAt:e.firstAt, lastAt:e.lastAt, recording:e.recording
  });
  if (e.type === 'network' && (/(?:request|response|error|incomplete)$/.test(e.subtype || '') || e.requestCombined === true)) {
    const out = decorateCompactProjection(e, { type:e.type, subtype:e.subtype, ts:e.ts, responseReceivedAt:e.responseReceivedAt, requestStartedAt:e.requestStartedAt, requestCombined:e.requestCombined===true, requestId:e.requestId, pageId:e.pageId, tabId:e.tabId, pageRole:e.pageRole||null, pageUrl:e.pageUrl, url:e.url, finalUrl:e.finalUrl, requestedUrl:e.requestedUrl, method:e.method, status:e.status, durationMs:e.durationMs||0, responseChars:e.responseChars||0, contentLength:e.contentLength||0, responseFingerprint:e.responseFingerprint, requestFingerprint:e.requestFingerprint, errorCode:e.errorCode, authInvalidToken:e.authInvalidToken===true, statusZeroHint:e.statusZeroHint, browserObserver:e.browserObserver===true, initiator:e.initiator, networkMeta:e.networkMeta, signals:(e.signals||[]).slice(0,30) });
    const label = endpointLabel(e);
    const reqBody = requestBodyOf(e);
    if (/(?:^|\/)chat$/.test(label) && reqBody && typeof reqBody==='object') out.requestBody={ inference_model:reqBody.inference_model??null, inference_settings:reqBody.inference_settings||null, conversation_id:reqBody.conversation_id??null, character_id:reqBody.character_id??null, alt_message_id:reqBody.alt_message_id??null, continue_chat:reqBody.continue_chat??null };
    else if (/\/spicychat-prod\/ratings\/?$/i.test(label) && reqBody && typeof reqBody==='object') out.requestBody={ itemId:reqBody.itemId??null, rating:reqBody.rating??null, cascadeCreate:reqBody.cascadeCreate??null };
    if (/\/characters\/[^/]+\/messages(?:\/[^/?]+)?$/i.test(label) && /response$/.test(e.subtype||'') && e.body && typeof e.body==='object') out.body={ num_messages:e.body.num_messages??null };
    else if ((e.status===401 || e.authInvalidToken) && e.body && typeof e.body==='object') out.body={ errorCode:e.body.errorCode??e.body?.error?.code??null, message:e.body.message??e.body.error??null };
    return out;
  }
  return null;
}

async function scanFullCaptureVersionSummary(db, total, button) {
  const projected = [];
  let firstTs = null, lastTs = null, scanned = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const source = store.indexNames.contains('ts') ? store.index('ts') : store;
    const req = source.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const e = cursor.value || {};
      if (Number.isFinite(e.ts)) { firstTs = firstTs == null ? e.ts : Math.min(firstTs,e.ts); lastTs = lastTs == null ? e.ts : Math.max(lastTs,e.ts); }
      const p = compactVersionProjection(e); if (p) projected.push(p);
      scanned++; if (button && (scanned % 1000 === 0 || scanned === total)) button.textContent = `Scanning diagnostics ${scanned.toLocaleString()} / ${total.toLocaleString()}…`;
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  const summary = buildSummary(projected);
  return { eventCount: total, firstTs, lastTs, durationMs: firstTs != null && lastTs != null ? Math.max(0,lastTs-firstTs) : 0, ...buildVersionDiagnostics(projected), quickDislike: summary.quickDislike, recommendationFeedback: summary.recommendationFeedback, diagnosticConsistencyWarnings: summary.diagnosticConsistencyWarnings, listingRefill: buildListingRefillDiagnostics(projected), captureHealth: summary.captureHealth, scrollAndInput: summary.scrollAndInput, longTaskAttribution: summary.longTaskAttribution, generationRender: buildGenerationRenderDiagnostics(projected), recentPerformance: buildRecentPerformanceComparison(projected), pageHotspots: buildPageInstanceHotspots(projected), pagePressureGrowth: buildPagePressureGrowthDiagnostics(projected), autoLagSpikes: projected.filter(e=>e.type==='performance'&&e.subtype==='auto-lag-spike').length, summary };
}


function buildAuthRefreshRaceDiagnostics(events, invalidToken401) {
  const requests = events.filter(e=>e.type==='network'&&isNetworkRequestEvent(e)&&/auth\.spicychat\.ai\/oauth2\/token$/i.test(endpointLabel(e)));
  const responses = events.filter(e=>e.type==='network'&&/response$/.test(e.subtype||'')&&/auth\.spicychat\.ai\/oauth2\/token$/i.test(endpointLabel(e))&&e.status>=200&&e.status<300);
  const responseById = new Map(responses.filter(e=>e.requestId).map(e=>[e.requestId,e]));
  const pairs = requests.map(req=>({req:{...req,ts:requestStartTs(req)},res:responseById.get(req.requestId) || (req.requestCombined===true && /response$/.test(req.subtype||'') ? req : null)})).filter(x=>x.res&&Number.isFinite(x.req.ts)&&Number.isFinite(x.res.ts));
  const races=[];
  for(const failure of invalidToken401){
    let best=null;
    for(const pair of pairs){
      if(pair.req.ts>failure.ts || pair.res.ts<failure.ts) continue;
      if(failure.ts-pair.req.ts>30000 || pair.res.ts-failure.ts>30000) continue;
      const samePage = pair.req.pageId && failure.pageId && pair.req.pageId===failure.pageId;
      const score=(samePage?0:100000)+(failure.ts-pair.req.ts)+(pair.res.ts-failure.ts);
      if(!best || score<best.score) best={...pair,score,samePage};
    }
    if(best) races.push({
      failureTs:failure.ts, endpoint:endpointLabel(failure), pageId:failure.pageId||null,
      attribution:failure.attribution?.source||'unknown-mixed', refreshRequestId:best.req.requestId||null,
      refreshStartedBefore401Ms:Math.max(0,failure.ts-best.req.ts), refreshCompletedAfter401Ms:Math.max(0,best.res.ts-failure.ts), samePage:best.samePage
    });
  }
  return { count:races.length, races:races.slice(-20) };
}

function buildRecommendationFeedbackDiagnostics(events, roleIndex = buildPageRoleIndex(events)) {
  const isRatingEndpoint = e => /\/spicychat-prod\/ratings\/?$/i.test(endpointLabel(e));
  const terminalById = new Map();
  for (const e of events) {
    if (e.type !== 'network' || !e.requestId || !isRatingEndpoint(e)) continue;
    if (/response$/.test(e.subtype || '') || /error$/.test(e.subtype || '')) terminalById.set(e.requestId, e);
  }

  function classifyRatingCause(req) {
    const pageUrl = req.pageUrl || req.url || '';
    const worker = roleIndex.roleForEvent(req);
    const a = req.attribution || {};
    if (worker?.role === 'qol-recommendation-worker') {
      return {
        source:'qol', action:worker.kind === 'legacy-quick-dislike' ? 'quick-dislike' : 'qol-negative-rating-unknown-mode',
        confidence:'confirmed', reason:'Recommendation worker is confirmed; Less Like vs Dislike is not distinguishable from the worker URL.',
        workerRole:worker.role, workerKind:worker.kind || null, workerPageId:worker.pageId || null
      };
    }
    if (isRecommendationWorkerPageUrl(pageUrl)) {
      const kind = recommendationWorkerKindFromUrl(pageUrl);
      return { source:'qol', action:kind === 'legacy-quick-dislike' ? 'quick-dislike' : 'qol-negative-rating-unknown-mode', confidence:'confirmed', reason:'Recommendation worker URL marker.', workerRole:'qol-recommendation-worker', workerKind:kind, workerPageId:req.pageId||null };
    }
    if (a.source === 'qol' || a.triggerSource === 'qol') return { source:'qol', action:'qol-negative-rating-unknown-mode', confidence:a.confidence || 'correlated', reason:a.reason || 'Page-level QoL attribution.' };
    if (a.source === 'spicychat-native' || a.triggerSource === 'spicychat-native') return { source:'spicychat-native', action:'native-negative-rating-unknown-mode', confidence:a.confidence || 'correlated', reason:a.reason || 'Page-level SpicyChat attribution.' };
    if (a.source === 'other-extension') return { source:'other-extension', action:'other-extension-negative-feedback', confidence:a.confidence || 'confirmed', reason:a.reason || 'Other extension initiator.' };
    if (a.source === 'third-party' && a.triggerSource === 'spicychat-native') return { source:'spicychat-native', action:'native-negative-rating-unknown-mode', confidence:'correlated', reason:'Third-party Recombee request was triggered by SpicyChat page code.' };
    if (req.browserObserver && (a.confidence === 'context-only' || a.executor === 'spicychat-page')) {
      return { source:'unknown-mixed', action:'less-like-or-negative-feedback', confidence:'context-only', reason:a.reason || 'Browser observer only identifies SpicyChat page context.' };
    }
    return { source:a.source || 'unknown-mixed', action:'less-like-or-negative-feedback', confidence:a.confidence || 'unknown', reason:a.reason || 'No stronger initiator evidence.' };
  }

  const raw = events.filter(e => e.type==='network' && isNetworkRequestEvent(e) && String(e.method || '').toUpperCase() === 'POST' && isRatingEndpoint(e) && Number(requestBodyOf(e)?.rating) === -1)
    .map(req => {
      const terminal = terminalById.get(req.requestId) || (req.requestCombined === true && /(?:response|error)$/.test(req.subtype || '') ? req : null);
      const cause = classifyRatingCause(req);
      const terminalIsError = !!(terminal && /error$/.test(terminal.subtype || ''));
      const status = terminal?.status ?? (terminalIsError ? 0 : null);
      const reqBody = requestBodyOf(req) || {};
      const startTs = requestStartTs(req);
      return {
        ts:startTs, lastTs:terminal?.ts ?? req.ts, requestId:req.requestId||null, itemId:reqBody?.itemId||null,
        source:cause.source, action:cause.action, confidence:cause.confidence, attributionReason:cause.reason,
        workerRole:cause.workerRole||null, workerKind:cause.workerKind||null, workerPageId:cause.workerPageId||null,
        browserObserver:req.browserObserver===true, initiator:req.initiator||null, status,
        durationMs:terminal?.durationMs??null, ok:Number.isFinite(status) && status>=200 && status<300,
        pageUrl:req.pageUrl||null, pageId:req.pageId||null, tabId:req.tabId??null,
        error:terminal?.error||null
      };
    }).sort((a,b)=>a.ts-b.ts);

  // Pair the page fetch/XHR observation with the browser webRequest observation so
  // one physical POST remains one attempt while retaining the strongest ownership
  // evidence plus the authoritative browser completion status.
  const pageByItem = new Map();
  const browserByItem = new Map();
  for (const x of raw) {
    const key = x.itemId || '(unknown)';
    const map = x.browserObserver ? browserByItem : pageByItem;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(x);
  }
  const physicalAttempts = [];
  const keys = new Set([...pageByItem.keys(), ...browserByItem.keys()]);
  for (const key of keys) {
    const page = (pageByItem.get(key) || []).slice().sort((a,b)=>a.ts-b.ts);
    const browser = (browserByItem.get(key) || []).slice().sort((a,b)=>a.ts-b.ts);
    const n = Math.max(page.length, browser.length);
    for (let i=0;i<n;i++) {
      const p = page[i] || null;
      const b = browser[i] || null;
      if (p && b) {
        const pageResolved = p.source !== 'unknown-mixed' && p.source !== 'third-party';
        const workerEvidence = p.workerRole ? p : (b.workerRole ? b : null);
        physicalAttempts.push({
          ...(pageResolved ? b : p),
          ...(pageResolved ? p : b),
          ts:Math.min(p.ts,b.ts), lastTs:Math.max(p.lastTs||p.ts,b.lastTs||b.ts),
          requestId:p.requestId || b.requestId,
          browserRequestId:b.requestId || null,
          source:workerEvidence ? 'qol' : (pageResolved ? p.source : (b.source !== 'unknown-mixed' ? b.source : p.source)),
          action:workerEvidence ? (workerEvidence.action || 'qol-negative-rating-unknown-mode') : (pageResolved ? p.action : (b.action !== 'less-like-or-negative-feedback' ? b.action : p.action)),
          confidence:workerEvidence ? 'confirmed' : (pageResolved ? p.confidence : (b.confidence || p.confidence)),
          attributionReason:workerEvidence ? workerEvidence.attributionReason : (pageResolved ? p.attributionReason : (b.attributionReason || p.attributionReason)),
          workerRole:workerEvidence?.workerRole || null,
          workerKind:workerEvidence?.workerKind || null,
          workerPageId:workerEvidence?.workerPageId || null,
          status:b.status ?? p.status,
          durationMs:b.durationMs ?? p.durationMs,
          ok:(b.status ?? p.status) >= 200 && (b.status ?? p.status) < 300,
          error:b.error || p.error || null,
          duplicateObservation:true,
          pageRequestId:p.requestId || null
        });
      } else physicalAttempts.push({...(p||b), duplicateObservation:false});
    }
  }
  physicalAttempts.sort((a,b)=>a.ts-b.ts);

  // Collapse only rapid retry attempts for the same bot into one user-level action.
  const transactions=[];
  const lastByItem=new Map();
  for (const a of physicalAttempts) {
    const key=a.itemId || '(unknown)';
    let tx=lastByItem.get(key);
    if (!tx || a.ts - tx.lastTs > 2000 || a.source !== tx.source || a.action !== tx.action) {
      tx={
        itemId:a.itemId||null, source:a.source, action:a.action, confidence:a.confidence,
        workerRole:a.workerRole||null, workerKind:a.workerKind||null, workerPageId:a.workerPageId||null,
        firstTs:a.ts, lastTs:a.lastTs||a.ts, attempts:0, successes:0, failures:0, noResponse:0,
        finalStatus:null, finalError:null, pageUrl:a.pageUrl||null, pageId:a.pageId||null, tabId:a.tabId??null, requestIds:[]
      };
      transactions.push(tx); lastByItem.set(key,tx);
    }
    tx.attempts++;
    tx.lastTs=Math.max(tx.lastTs,a.lastTs||a.ts);
    if (a.ok) tx.successes++;
    else if (a.status == null) tx.noResponse++;
    else tx.failures++;
    tx.finalStatus=a.status;
    tx.finalError=a.error||null;
    if (a.requestId) tx.requestIds.push(a.requestId);
    if (!tx.pageUrl && a.pageUrl) tx.pageUrl=a.pageUrl;
    if (tx.tabId==null && a.tabId!=null) tx.tabId=a.tabId;
    if (!tx.workerRole && a.workerRole) { tx.workerRole=a.workerRole; tx.workerKind=a.workerKind||null; tx.workerPageId=a.workerPageId||null; }
  }
  for (const tx of transactions) tx.ok = tx.successes > 0;

  const itemTxCounts={};
  for (const x of transactions) if(x.itemId) itemTxCounts[x.itemId]=(itemTxCounts[x.itemId]||0)+1;
  const duplicates=Object.entries(itemTxCounts).filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([itemId,count])=>({itemId,count}));
  const bySource={}; for(const x of transactions) bySource[x.source]=(bySource[x.source]||0)+1;
  const byAction={}; for(const x of transactions) byAction[x.action]=(byAction[x.action]||0)+1;
  const attemptBySource={}; for(const x of physicalAttempts) attemptBySource[x.source]=(attemptBySource[x.source]||0)+1;
  const attemptCounts=transactions.map(x=>x.attempts).sort((a,b)=>a-b);
  const medianAttempts=attemptCounts.length ? median(attemptCounts) : 0;

  const preflights = events.filter(e => e.type==='network' && isNetworkRequestEvent(e) && String(e.method || '').toUpperCase()==='OPTIONS' && isRatingEndpoint(e) && (e.browserObserver===true || e.pageId==='browser-webrequest'));
  const workerAttempts = physicalAttempts.filter(x=>x.workerRole==='qol-recommendation-worker');
  const workerTransactions = transactions.filter(x=>x.workerRole==='qol-recommendation-worker');
  const workerLatencies = workerAttempts.map(x=>Number(x.durationMs)).filter(Number.isFinite);
  const workerSpacing=[];
  for(let i=1;i<workerAttempts.length;i++) workerSpacing.push(Math.max(0,workerAttempts[i].ts-workerAttempts[i-1].ts));
  const medianSpacing = workerSpacing.length ? median(workerSpacing) : 0;
  const cooldownThreshold = medianSpacing ? Math.max(3000, medianSpacing*2.5) : 3000;
  const cooldowns = workerSpacing.filter(ms=>ms>=cooldownThreshold && ms<=30000);
  const workerStatuses={};
  for(const x of workerAttempts){const k=x.status==null?'no-response':String(x.status);workerStatuses[k]=(workerStatuses[k]||0)+1;}

  const jobs=[];
  let current=null;
  for(const tx of workerTransactions.slice().sort((a,b)=>a.firstTs-b.firstTs)){
    const pageKey=tx.workerPageId || (tx.tabId!=null ? `tab:${tx.tabId}` : '(unknown-worker)');
    if(!current || current.pageKey!==pageKey || tx.firstTs-current.lastActionTs>5*60*1000){
      current={pageKey,startTs:tx.firstTs,endTs:tx.lastTs,lastActionTs:tx.lastTs,actions:0,attempts:0,successes:0,failures:0,retries:0};
      jobs.push(current);
    }
    current.actions++; current.attempts+=tx.attempts; current.successes+=tx.ok?1:0; current.failures+=tx.ok?0:1; current.retries+=Math.max(0,tx.attempts-1);
    current.endTs=Math.max(current.endTs,tx.lastTs); current.lastActionTs=tx.lastTs;
  }
  for(const j of jobs){j.durationMs=Math.max(0,j.endTs-j.startTs);delete j.lastActionTs;}

  const perfByPage=new Map();
  const ensurePerf=(role,e)=>{
    const pageId=role?.pageId || e.pageId || (e.tabId!=null?`tab:${e.tabId}`:'(unknown-worker)');
    if(!perfByPage.has(pageId)) perfByPage.set(pageId,{pageId,tabId:role?.tabId??e.tabId??null,kind:role?.kind||null,firstTs:eventTs(e),lastTs:eventTs(e),longTasks:0,longTaskMs:0,longAnimationFrames:0,loafBlockingMs:0,domMin:null,domMax:null,heapMin:null,heapMax:null,observerCallbacks:0,inspectorObserverMs:0});
    const x=perfByPage.get(pageId); x.firstTs=Math.min(x.firstTs,eventTs(e)); x.lastTs=Math.max(x.lastTs,eventTs(e)); return x;
  };
  for(const seed of roleIndex.workerPages){
    if(!perfByPage.has(seed.pageId)) perfByPage.set(seed.pageId,{pageId:seed.pageId,tabId:seed.tabId??null,kind:seed.kind||null,firstTs:seed.startTs||0,lastTs:seed.startTs||0,longTasks:0,longTaskMs:0,longAnimationFrames:0,loafBlockingMs:0,domMin:null,domMax:null,heapMin:null,heapMax:null,observerCallbacks:0,inspectorObserverMs:0});
  }
  for(const e of events){
    const role=roleIndex.roleForEvent(e); if(role?.role!=='qol-recommendation-worker') continue;
    const x=ensurePerf(role,e);
    if(e.type==='performance'&&e.subtype==='long-task'){x.longTasks++;x.longTaskMs+=e.durationMs||0;}
    if(e.type==='performance'&&e.subtype==='long-animation-frame'){x.longAnimationFrames++;x.loafBlockingMs+=e.blockingDurationMs||0;}
    if(e.type==='performance'&&e.subtype==='page-pressure'){
      if(Number.isFinite(e.domElements)){x.domMin=x.domMin==null?e.domElements:Math.min(x.domMin,e.domElements);x.domMax=x.domMax==null?e.domElements:Math.max(x.domMax,e.domElements);}
      if(Number.isFinite(e.jsHeapUsedBytes)){x.heapMin=x.heapMin==null?e.jsHeapUsedBytes:Math.min(x.heapMin,e.jsHeapUsedBytes);x.heapMax=x.heapMax==null?e.jsHeapUsedBytes:Math.max(x.heapMax,e.jsHeapUsedBytes);}
    }
    if(e.type==='dom'&&e.subtype==='mutation-batch'){x.observerCallbacks+=e.stats?.observerCallbacks||0;x.inspectorObserverMs+=e.stats?.inspectorObserverMs||0;}
  }
  const workerPagesDetail=[...perfByPage.values()].map(x=>({...x,durationMs:Math.max(0,x.lastTs-x.firstTs),longTaskMs:Math.round(x.longTaskMs*10)/10,loafBlockingMs:Math.round(x.loafBlockingMs*10)/10,inspectorObserverMs:Math.round(x.inspectorObserverMs*1000)/1000}));
  const finiteVals=(key)=>workerPagesDetail.map(x=>x[key]).filter(Number.isFinite);
  const domMins=finiteVals('domMin'),domMaxs=finiteVals('domMax'),heapMins=finiteVals('heapMin'),heapMaxs=finiteVals('heapMax');
  const workerPerformance={
    longTasks:workerPagesDetail.reduce((n,x)=>n+x.longTasks,0),
    longTaskMs:Math.round(workerPagesDetail.reduce((n,x)=>n+x.longTaskMs,0)*10)/10,
    longAnimationFrames:workerPagesDetail.reduce((n,x)=>n+x.longAnimationFrames,0),
    loafBlockingMs:Math.round(workerPagesDetail.reduce((n,x)=>n+x.loafBlockingMs,0)*10)/10,
    domElementsMin:domMins.length?Math.min(...domMins):null, domElementsMax:domMaxs.length?Math.max(...domMaxs):null,
    jsHeapUsedMinBytes:heapMins.length?Math.min(...heapMins):null, jsHeapUsedMaxBytes:heapMaxs.length?Math.max(...heapMaxs):null,
    observerCallbacks:workerPagesDetail.reduce((n,x)=>n+x.observerCallbacks,0),
    inspectorObserverMs:Math.round(workerPagesDetail.reduce((n,x)=>n+x.inspectorObserverMs,0)*1000)/1000
  };

  const workerStart = workerAttempts.length ? workerAttempts[0].ts : null;
  const workerEnd = workerAttempts.length ? Math.max(...workerAttempts.map(x=>x.lastTs||x.ts)) : null;
  const uniqueWorkerBotIds = new Set(workerTransactions.map(x=>x.itemId).filter(Boolean));
  return {
    count:transactions.length,
    successes:transactions.filter(x=>x.ok).length,
    failures:transactions.filter(x=>!x.ok && x.failures>0).length,
    noResponse:transactions.filter(x=>!x.ok && x.failures===0).length,
    bySource, byAction, duplicateItems:duplicates,
    attempts:physicalAttempts.length,
    attemptSuccesses:physicalAttempts.filter(x=>x.ok).length,
    attemptFailures:physicalAttempts.filter(x=>x.status!=null&&!x.ok).length,
    attemptNoResponse:physicalAttempts.filter(x=>x.status==null).length,
    attemptBySource,
    retriedTransactions:transactions.filter(x=>x.attempts>1).length,
    retries:transactions.reduce((n,x)=>n+Math.max(0,x.attempts-1),0),
    medianAttempts,
    maxAttempts:attemptCounts.length ? attemptCounts.at(-1) : 0,
    ratingActions:transactions.length,
    ratingPosts:physicalAttempts.length,
    corsPreflights:preflights.length,
    ratingSuccesses:transactions.filter(x=>x.ok).length,
    ratingFailures:transactions.filter(x=>!x.ok && x.failures>0).length,
    ratingNoResponse:transactions.filter(x=>!x.ok && x.failures===0).length,
    workerPages:roleIndex.workerPages.length,
    jobCount:jobs.length,
    jobs,
    workerRatingActions:workerTransactions.length,
    workerRatingPosts:workerAttempts.length,
    workerSuccesses:workerTransactions.filter(x=>x.ok).length,
    workerFailures:workerTransactions.filter(x=>!x.ok && x.failures>0).length,
    workerNoResponse:workerTransactions.filter(x=>!x.ok && x.failures===0).length,
    workerRetries:workerTransactions.reduce((n,x)=>n+Math.max(0,x.attempts-1),0),
    uniqueBotIds:uniqueWorkerBotIds.size,
    duplicateBotIds:Object.values(itemTxCounts).filter(n=>n>1).length,
    startTs:workerStart,
    endTs:workerEnd,
    wallClockMs:workerStart!=null&&workerEnd!=null?Math.max(0,workerEnd-workerStart):0,
    postLatencyAvgMs:workerLatencies.length?Math.round(workerLatencies.reduce((a,b)=>a+b,0)/workerLatencies.length*10)/10:0,
    postLatencyMedianMs:workerLatencies.length?Math.round(median(workerLatencies)*10)/10:0,
    postLatencyP95Ms:workerLatencies.length?Math.round(percentile(workerLatencies,.95)*10)/10:0,
    postLatencyMaxMs:workerLatencies.length?Math.round(Math.max(...workerLatencies)*10)/10:0,
    requestSpacingMedianMs:workerSpacing.length?Math.round(medianSpacing*10)/10:0,
    detectedCooldownPauses:cooldowns.length,
    cooldownThresholdMs:Math.round(cooldownThreshold*10)/10,
    httpStatusDistribution:workerStatuses,
    status429:workerAttempts.filter(x=>x.status===429).length,
    status5xx:workerAttempts.filter(x=>x.status>=500&&x.status<600).length,
    workerPerformance,
    workerPagesDetail,
    recent:transactions.slice(-30),
    recentAttempts:physicalAttempts.slice(-50)
  };
}

function buildQuickDislikeCompatibilityDiagnostics(events, recommendationFeedback) {
  const legacy = buildQuickDislikeDiagnostics(events);
  if (!recommendationFeedback?.workerPages) return { ...legacy, deprecated:true, canonicalField:'recommendationFeedback' };
  return {
    ...legacy,
    deprecated:true,
    canonicalField:'recommendationFeedback',
    workerPages:Math.max(legacy.workerPages||0,recommendationFeedback.workerPages||0),
    fullyConfirmedWorkers:recommendationFeedback.workerFailures===0&&recommendationFeedback.workerNoResponse===0?recommendationFeedback.workerPages:0,
    rating2xx:recommendationFeedback.workerSuccesses,
    currentRecommendationWorkerPages:recommendationFeedback.workerPages,
    note:'Compatibility alias only. Use recommendationFeedback for shared Less Like / Dislike worker diagnostics.'
  };
}


function isKnownDailyMessageLimitEvent(e) {
  if (!e || e.type !== 'network' || Number(e.status) !== 429) return false;
  const code = e.errorCode || e.body?.errorCode || e.body?.error?.code || null;
  return code === 'SC-001-5201';
}

function buildCounterDriverDiagnostics(events) {
  const raw = events.filter(e => e.type === 'driver' && e.subtype !== 'inspector-probe-heartbeat');
  const primaries = raw.filter(e => typeof e.pageId === 'string' || !Number.isFinite(Number(e.driverTs)));
  const mirrors = raw.filter(e => typeof e.pageId !== 'string' && Number.isFinite(Number(e.driverTs)));

  const keyOf = e => [
    e.subtype || '', e.action || '', e.phase || '', e.role || '',
    e.driverPageType || '', e.driverNumber ?? '', e.driverAttempt ?? '',
    e.driverTarget ?? '', e.driverPath ?? ''
  ].join('|');

  const primaryByKey = new Map();
  for (const e of primaries) {
    const k = keyOf(e);
    if (!primaryByKey.has(k)) primaryByKey.set(k, []);
    primaryByKey.get(k).push(e);
  }
  for (const list of primaryByKey.values()) list.sort((a,b)=>(a.id||0)-(b.id||0) || (a.ts||0)-(b.ts||0));

  const mirroredIds = new Set();
  let mirroredDuplicates = 0;
  const orphanMirrors = [];
  for (const m of mirrors) {
    const list = primaryByKey.get(keyOf(m)) || [];
    let best = null, bestScore = Infinity;
    const targetTs = Number(m.driverTs) || Number(m.ts) || 0;
    for (const p of list) {
      if (mirroredIds.has(p.id)) continue;
      // The duplicate path can be delayed by a blocked main thread. Prefer the
      // same logical marker immediately preceding the mirror, but allow up to
      // 15 seconds so severe stress does not create false extra actions.
      const idGap = Number.isFinite(Number(m.id)) && Number.isFinite(Number(p.id)) ? Number(m.id) - Number(p.id) : 0;
      if (idGap < 0 || idGap > 100) continue;
      const timeGap = Math.abs((Number(p.ts)||0) - targetTs);
      if (timeGap > 15000) continue;
      const score = timeGap + Math.max(0,idGap) * 5;
      if (score < bestScore) { best = p; bestScore = score; }
    }
    if (best) {
      mirroredIds.add(best.id);
      mirroredDuplicates++;
    } else {
      orphanMirrors.push(m);
    }
  }

  // Primary page-bridge events carry richer interaction state. Keep them as the
  // canonical copy, but preserve any unpaired mirror event so diagnostics never
  // silently lose a real Driver marker.
  const logical = [...primaries, ...orphanMirrors].sort((a,b)=>(a.ts||0)-(b.ts||0) || (a.id||0)-(b.id||0));
  const bySubtype = {};
  for (const e of logical) bySubtype[e.subtype || '(unknown)'] = (bySubtype[e.subtype || '(unknown)'] || 0) + 1;

  const sends = logical.filter(e => e.subtype === 'counter-send');
  const confirms = logical.filter(e => e.subtype === 'counter-confirmed');
  const sendErrors = logical.filter(e => e.subtype === 'counter-send-error');
  const maintenanceReloads = logical.filter(e => e.subtype === 'counter-maintenance-reload');
  const dailyLimits = logical.filter(e => e.subtype === 'counter-daily-limit');
  const stalls = logical.filter(e => e.subtype === 'driver-stalled');
  const heartbeatSummaries = logical.filter(e => e.subtype === 'heartbeat-summary');
  const schedulerHeartbeats = heartbeatSummaries.reduce((n,e)=>n+(Number(e.schedulerHeartbeats)||0),0);
  const inspectorProbeHeartbeats = heartbeatSummaries.reduce((n,e)=>n+(Number(e.inspectorProbeHeartbeats)||0),0);
  const nums = arr => arr.map(e => Number(e.driverNumber)).filter(Number.isFinite);
  const sendNums = nums(sends), confirmNums = nums(confirms);
  const sendCountByNumber = {};
  for (const n of sendNums) sendCountByNumber[n] = (sendCountByNumber[n] || 0) + 1;
  const retriedNumbers = Object.entries(sendCountByNumber).filter(([,n])=>n>1).map(([n,count])=>({number:Number(n),attempts:count})).sort((a,b)=>a.number-b.number);
  const lastConfirmed = confirmNums.length ? Math.max(...confirmNums) : null;

  return {
    rawEvents: raw.length,
    logicalEvents: logical.length,
    mirroredDuplicates,
    orphanMirrors: orphanMirrors.length,
    bySubtype,
    sendAttempts: sends.length,
    uniqueSendNumbers: new Set(sendNums).size,
    confirmed: confirms.length,
    uniqueConfirmedNumbers: new Set(confirmNums).size,
    sendErrors: sendErrors.length,
    maintenanceReloads: maintenanceReloads.length,
    dailyLimits: dailyLimits.length,
    stalls: stalls.length,
    heartbeatSummaries: heartbeatSummaries.length,
    schedulerHeartbeats,
    inspectorProbeHeartbeats,
    startTs: logical.length ? logical[0].ts : null,
    endTs: logical.length ? logical[logical.length-1].ts : null,
    wallClockMs: logical.length > 1 ? Math.max(0,(logical[logical.length-1].ts||0)-(logical[0].ts||0)) : 0,
    firstSendNumber: sendNums.length ? Math.min(...sendNums) : null,
    lastSendNumber: sendNums.length ? Math.max(...sendNums) : null,
    lastConfirmed,
    nextNumber: lastConfirmed == null ? null : lastConfirmed + 1,
    retriedNumbers: retriedNumbers.slice(-50),
    recent: logical.slice(-30).map(e=>({ subtype:e.subtype, ts:e.ts, number:e.driverNumber??null, attempt:e.driverAttempt??null, pageId:e.pageId }))
  };
}

function buildDiagnosticConsistencyWarnings(events, facts) {
  const warnings=[];
  const push=(code, expected, actual, detail='')=>warnings.push({code,expected,actual,detail});
  const rawLong=events.filter(e=>e.type==='performance'&&e.subtype==='long-task');
  const rawLongMs=Math.round(rawLong.reduce((n,e)=>n+(e.durationMs||0),0)*10)/10;
  if(facts.longTasks!==rawLong.length) push('long-task-count-mismatch',rawLong.length,facts.longTasks,'Headline Long Task count must match stored long-task events.');
  if(Math.abs((facts.longTaskTotalMs||0)-rawLongMs)>0.2) push('long-task-duration-mismatch',rawLongMs,facts.longTaskTotalMs,'Headline Long Task duration must match stored long-task events within rounding tolerance.');
  const rawLoaf=events.filter(e=>e.type==='performance'&&e.subtype==='long-animation-frame');
  if(facts.longAnimationFrames!==rawLoaf.length) push('loaf-count-mismatch',rawLoaf.length,facts.longAnimationFrames,'Headline LoAF count must match stored LoAF events.');
  const rawResponses=events.filter(e=>e.type==='network'&&/response$/.test(e.subtype||''));
  if(facts.networkResponses!==rawResponses.length) push('network-response-count-mismatch',rawResponses.length,facts.networkResponses,'Network response count must match stored response events.');
  const rawClears=events.filter(e=>e.type==='performance'&&e.subtype==='resource-timing-buffer-full'&&e.cleared===true).length;
  if((facts.captureHealth?.resourceTimingBufferClears||0)!==rawClears) push('resource-timing-clear-count-mismatch',rawClears,facts.captureHealth?.resourceTimingBufferClears||0,'Capture health clear count must reflect successful clear events.');
  const roleIndex=facts.pageRoleIndex || buildPageRoleIndex(events);
  if((facts.recommendationFeedback?.workerPages||0)!==roleIndex.workerPages.length) push('recommendation-worker-page-count-mismatch',roleIndex.workerPages.length,facts.recommendationFeedback?.workerPages||0,'Recommendation worker count must match persistent page-role detection.');
  const browserRatingPosts=events.filter(e=>e.type==='network'&&isNetworkRequestEvent(e)&&e.browserObserver===true&&String(e.method||'').toUpperCase()==='POST'&&/\/spicychat-prod\/ratings\/?$/i.test(endpointLabel(e))&&Number(requestBodyOf(e)?.rating)===-1).length;
  if(browserRatingPosts>0 && (facts.recommendationFeedback?.ratingPosts||0)!==browserRatingPosts) push('rating-post-count-mismatch',browserRatingPosts,facts.recommendationFeedback?.ratingPosts||0,'When browser-level rating observation is available, canonical physical POST count should match it.');
  const r=facts.recommendationFeedback;
  if(r && r.ratingActions!==(r.ratingSuccesses+r.ratingFailures+r.ratingNoResponse)) push('recommendation-action-total-mismatch',r.ratingActions,r.ratingSuccesses+r.ratingFailures+r.ratingNoResponse,'Recommendation actions must partition into success/failure/no-response.');
  const d=facts.counterDriver;
  if(d && d.rawEvents && d.logicalEvents+d.mirroredDuplicates!==d.rawEvents) push('driver-dedupe-total-mismatch',d.rawEvents,d.logicalEvents+d.mirroredDuplicates,'Counter Driver raw markers must partition into canonical logical events plus mirrored duplicates.');
  const qt=facts.qolTrace;
  if(qt?.sequenceGaps>0) push('qol-trace-sequence-gap',0,qt.sequenceGaps,'QoL Trace sequence numbers indicate one or more detailed trace events were not observed. High-level Inspector capture remains usable, but QoL operation accounting may be incomplete.');
  return warnings;
}


function normalizedQolOutcome(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0,80);
  if (typeof value === 'object') {
    for (const key of ['outcome','status','state','result','message']) {
      const nested=value?.[key];
      if (nested != null && ['string','number','boolean'].includes(typeof nested)) return String(nested).slice(0,80);
    }
    if (typeof value.ok === 'boolean') return value.ok ? 'ok' : 'failed';
    if (typeof value.success === 'boolean') return value.success ? 'success' : 'failed';
  }
  return null;
}
function qolEventRichness(e) {
  let score=0;
  if (Number.isFinite(Number(e.traceSeq))) score+=20;
  if (String(e.transport||'').includes(':batch')) score+=8;
  if (e.traceProtocol) score+=6;
  if (e.category) score+=4;
  if (e.parentOperationId) score+=4;
  if (e.counts) score+=3;
  if (e.meta) score+=2;
  if (e.workerSessionId) score+=2;
  if (e.queueDelayMs != null) score+=2;
  if (e.outcome && e.outcome !== '[object Object]') score+=2;
  return score;
}
function qolDedupeIdentity(e) {
  const page=String(e.pageId||'');
  const session=String(e.traceSessionId||e.qolSessionId||'');
  const subtype=String(e.subtype||'telemetry');
  const strong=[];
  const boundaryLike=/(?:^|[-_:])(?:operation-?|op-?)?(?:start|begin|started|enter|end|finish|finished|complete|completed|stop|stopped|exit)(?:$|[-_:])/.test(`-${subtype}-`);
  const hasSeq=Number.isFinite(Number(e.traceSeq));
  if (!hasSeq && e.operationId && boundaryLike) strong.push(`op|${page}|${session}|${e.operationId}|${subtype}`);
  if (!hasSeq && e.requestId && /network|request|response/.test(subtype)) strong.push(`req|${page}|${session}|${e.requestId}|${subtype}`);
  if (hasSeq) strong.push(`seq|${page}|${session}|${Number(e.traceSeq)}`);
  const sourceTs=Number(e.sourceTs);
  const bucket=Number.isFinite(sourceTs) ? Math.round(sourceTs) : Math.round(eventTs(e)||0);
  const fallback=['evt',page,session,subtype,e.feature||'',e.module||'',e.operation||'',e.operationId||'',e.requestId||'',bucket].join('|');
  return {strong:[...new Set(strong)],fallback,hasSeq};
}
function dedupeQolDiagnosticEvents(events) {
  const chosen=[];
  const strongToIndex=new Map();
  const fallbackToIndex=new Map();
  for (const e of events) {
    const identity=qolDedupeIdentity(e);
    let existingIndex=null;
    for (const key of identity.strong) {
      if (strongToIndex.has(key)) { existingIndex=strongToIndex.get(key); break; }
    }
    if (existingIndex == null && fallbackToIndex.has(identity.fallback)) {
      const candidateIndex=fallbackToIndex.get(identity.fallback);
      const candidate=chosen[candidateIndex];
      const candidateHasSeq=Number.isFinite(Number(candidate?.traceSeq));
      // Same timestamp/shape can represent several distinct v2 events. Only use
      // the fallback to join a no-seq compatibility copy to a seq-bearing event,
      // or to collapse two no-seq legacy copies.
      if (!identity.hasSeq || !candidateHasSeq) existingIndex=candidateIndex;
    }
    if (existingIndex == null) {
      const index=chosen.length;
      chosen.push(e);
      for (const key of identity.strong) strongToIndex.set(key,index);
      if (!fallbackToIndex.has(identity.fallback)) fallbackToIndex.set(identity.fallback,index);
      continue;
    }
    const existing=chosen[existingIndex];
    if (qolEventRichness(e)>qolEventRichness(existing)) chosen[existingIndex]=e;
    for (const key of identity.strong) strongToIndex.set(key,existingIndex);
    const owner=fallbackToIndex.has(identity.fallback) ? chosen[fallbackToIndex.get(identity.fallback)] : null;
    const ownerHasSeq=Number.isFinite(Number(owner?.traceSeq));
    if (!fallbackToIndex.has(identity.fallback) || !ownerHasSeq || !identity.hasSeq) fallbackToIndex.set(identity.fallback,existingIndex);
  }
  return chosen;
}
function computeFinalQolSequenceGaps(events) {
  const streams=new Map();
  for (const e of events) {
    const seq=Number(e.traceSeq);
    if (!Number.isInteger(seq) || seq < 0) continue;
    const key=`${e.pageId||''}|${e.traceSessionId||e.qolSessionId||'session'}`;
    let set=streams.get(key);
    if (!set) { set=new Set(); streams.set(key,set); }
    set.add(seq);
  }
  let missing=0,gapRuns=0;
  const details=[];
  for (const [stream,set] of streams) {
    const seqs=[...set].sort((a,b)=>a-b);
    let streamMissing=0,streamGapRuns=0;
    for (let i=1;i<seqs.length;i++) {
      const gap=seqs[i]-seqs[i-1]-1;
      if (gap>0) { streamMissing+=gap;streamGapRuns++; }
    }
    missing+=streamMissing;gapRuns+=streamGapRuns;
    if(streamMissing)details.push({stream,first:seqs[0],last:seqs.at(-1),observed:seqs.length,missing:streamMissing,gapRuns:streamGapRuns});
  }
  return {missing,gapRuns,streams:streams.size,details:details.slice(0,20)};
}
function intervalUnionMs(intervals) {
  if (!intervals.length) return 0;
  const sorted=intervals.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let total=0,start=sorted[0][0],end=sorted[0][1];
  for(let i=1;i<sorted.length;i++){
    const [s,e]=sorted[i];
    if(s<=end){end=Math.max(end,e);}
    else{total+=Math.max(0,end-start);start=s;end=e;}
  }
  return total+Math.max(0,end-start);
}
function qolOutcomeIsError(value) {
  const outcome=normalizedQolOutcome(value);
  return !!(outcome && /^(?:fail(?:ed|ure)?|error|exception|timeout|timed-out|abort(?:ed)?|cancel(?:led|ed)?|rejected)$/i.test(outcome));
}

function buildQolTraceDiagnostics(events) {
  const qRaw = events.filter(e => e.type === 'qol');
  const q = dedupeQolDiagnosticEvents(qRaw);
  if (!q.length) return {
    events:0, explicitTraceEvents:0, protocols:[], sequenceGaps:0, sequenceGapEvents:0,
    operations:{count:0,totalMs:0,slow50:0,slow200:0,slow1000:0,top:[]},
    scheduler:{events:0,deferred:0,coalesced:0,skipped:0,ran:0,queueDelaySamples:0,avgQueueDelayMs:0,p95QueueDelayMs:0},
    storage:{events:0,reads:0,writes:0,totalMs:0,top:[]}, network:{events:0,completed:0,errors:0,totalMs:0,top:[]},
    workers:{events:0,starts:0,ready:0,jobs:0,heartbeats:0,throttled:0,restarts:0,closed:0,top:[]},
    settingsChanges:0,userActions:0,performanceActions:0,errorEvents:0,backgroundEvents:0,
    longTaskCorrelation:{supported:false,longTasksChecked:0,longTasksOverlappingQol:0,totalOverlapMs:0,topFeatures:[]},
    traceBatches:{events:0,maxBatchSize:0}, traceLevel:null
  };

  const protocolCounts = new Map();
  let explicitTraceEvents = 0, traceLevel = null;
  let traceBatchEvents = 0, maxBatchSize = 0;
  for (const e of q) {
    const protocol = String(e.traceProtocol || e.payload?.protocol || '').trim();
    if (protocol) protocolCounts.set(protocol, (protocolCounts.get(protocol) || 0) + 1);
    if (e.traceProtocol || Number.isFinite(e.traceSeq) || e.parentOperationId || e.category || e.workerSessionId || e.queueDelayMs != null || e.traceBatchSize) explicitTraceEvents++;
    if (e.traceBatchSize) { traceBatchEvents++; maxBatchSize = Math.max(maxBatchSize, Number(e.traceBatchSize) || 0); }
    const maybeLevel = e.payload?.traceLevel || e.payload?.requestedTraceLevel || e.meta?.traceLevel;
    if (maybeLevel) traceLevel = String(maybeLevel);
  }
  // Recompute gaps from the final unique sequence set. Capture-time "gap before"
  // markers are only provisional because a delayed/out-of-order batch can fill
  // them later.
  const sequence = computeFinalQolSequenceGaps(q);
  const sequenceGaps = sequence.missing;
  const sequenceGapEvents = sequence.gapRuns;

  const active = new Map();
  const spans = [];
  const isStart = e => /(?:^|[-_:])(operation-?start|op-?start|start|begin|started|enter)(?:$|[-_:])/.test(`-${String(e.subtype||'')}-`) && !/profile/.test(String(e.subtype||''));
  const isEnd = e => /(?:^|[-_:])(operation-?end|op-?end|end|finish|finished|complete|completed|stop|stopped|exit)(?:$|[-_:])/.test(`-${String(e.subtype||'')}-`) && !/profile/.test(String(e.subtype||''));
  for (const e of q.slice().sort((a,b)=>eventTs(a)-eventTs(b))) {
    const opId = e.operationId || null;
    if (!opId) continue;
    const key = `${e.pageId || ''}|${e.traceSessionId || e.qolSessionId || ''}|${opId}`;
    if (isStart(e)) {
      active.set(key, e);
      continue;
    }
    if (isEnd(e)) {
      const start = active.get(key);
      if (start) active.delete(key);
      const endTs = Number(e.sourceTs) || eventTs(e);
      const explicitDuration = Number(e.durationMs ?? e.payload?.durationMs);
      const durationMs = Number.isFinite(explicitDuration) ? Math.max(0, explicitDuration) : (start ? Math.max(0, endTs - (Number(start.sourceTs) || eventTs(start))) : null);
      const startTs = start ? (Number(start.sourceTs) || eventTs(start)) : (Number.isFinite(durationMs) ? endTs - durationMs : endTs);
      spans.push({
        pageId:e.pageId || start?.pageId || null, operationId:opId,
        parentOperationId:e.parentOperationId || start?.parentOperationId || null,
        feature:e.feature || start?.feature || 'unknown', module:e.module || start?.module || null,
        operation:e.operation || start?.operation || 'operation', startTs,endTs,durationMs,
        outcome:normalizedQolOutcome(e.outcome ?? e.payload?.outcome ?? e.payload?.result),
        counts:e.counts || e.payload?.counts || null
      });
    }
  }
  // Preserve completed operation-profile events from older QoL/Inspector combinations
  // only when there was no explicit start/end span with the same operation ID.
  const explicitIds = new Set(spans.map(x=>`${x.pageId||''}|${x.operationId}`));
  for (const e of q) {
    if (e.subtype !== 'operation-profile' || !Number.isFinite(Number(e.durationMs))) continue;
    const key = `${e.pageId||''}|${e.operationId||''}`;
    if (e.operationId && explicitIds.has(key)) continue;
    const endTs = eventTs(e), durationMs = Math.max(0,Number(e.durationMs)||0);
    spans.push({pageId:e.pageId||null,operationId:e.operationId||null,parentOperationId:e.parentOperationId||null,feature:e.feature||'unknown',module:e.module||null,operation:e.operation||'operation',startTs:endTs-durationMs,endTs,durationMs,outcome:normalizedQolOutcome(e.outcome),counts:e.counts||null,profileOnly:true});
  }

  const opGroups = new Map();
  for (const op of spans) {
    if (!Number.isFinite(op.durationMs)) continue;
    const label = `${op.feature || 'unknown'} · ${op.operation || 'operation'}`;
    const x = opGroups.get(label) || {label,feature:op.feature||'unknown',operation:op.operation||'operation',runs:0,totalMs:0,maxMs:0,durations:[],errors:0,scanned:0,changed:0};
    x.runs++; x.totalMs += op.durationMs; x.maxMs = Math.max(x.maxMs, op.durationMs); x.durations.push(op.durationMs);
    if (qolOutcomeIsError(op.outcome)) x.errors++;
    const c=op.counts||{}; x.scanned += Number(c.scanned||0); x.changed += Number(c.changed||0);
    opGroups.set(label,x);
  }
  const topOps=[...opGroups.values()].map(x=>({
    label:x.label,feature:x.feature,operation:x.operation,runs:x.runs,totalMs:Math.round(x.totalMs*10)/10,
    avgMs:x.runs?Math.round(x.totalMs/x.runs*10)/10:0,medianMs:Math.round(median(x.durations)*10)/10,
    p95Ms:Math.round(percentile(x.durations,0.95)*10)/10,maxMs:Math.round(x.maxMs*10)/10,
    errors:x.errors,scanned:x.scanned,changed:x.changed
  })).sort((a,b)=>b.totalMs-a.totalMs || b.maxMs-a.maxMs).slice(0,20);
  const operationTotalMs=spans.reduce((n,x)=>n+(Number.isFinite(x.durationMs)?x.durationMs:0),0);

  const schedulerEvents = q.filter(e => e.category === 'scheduler' || /schedule|scheduler|defer|coalesce|queue|lane|idle-slice/i.test(`${e.subtype||''} ${e.operation||''}`));
  const queueDelays=schedulerEvents.map(e=>Number(e.queueDelayMs ?? e.payload?.queueDelayMs)).filter(Number.isFinite);
  const scheduler = {
    events:schedulerEvents.length,
    deferred:schedulerEvents.filter(e=>/defer|deferred/i.test(`${e.subtype||''} ${e.outcome||''}`)).length,
    coalesced:schedulerEvents.filter(e=>/coalesc/i.test(`${e.subtype||''} ${e.outcome||''}`)).length,
    skipped:schedulerEvents.filter(e=>/skip|skipped/i.test(`${e.subtype||''} ${e.outcome||''}`)).length,
    ran:schedulerEvents.filter(e=>/run|execute|executed|complete|end/i.test(`${e.subtype||''} ${e.outcome||''}`)).length,
    queueDelaySamples:queueDelays.length,
    avgQueueDelayMs:queueDelays.length?Math.round(queueDelays.reduce((a,b)=>a+b,0)/queueDelays.length*10)/10:0,
    p95QueueDelayMs:queueDelays.length?Math.round(percentile(queueDelays,0.95)*10)/10:0
  };

  const storageEvents=q.filter(e=>e.category==='storage'||/^storage[-_:]/i.test(e.subtype||'')||/storage/i.test(e.operation||''));
  const storageGroups=new Map();
  let storageReads=0,storageWrites=0,storageTotalMs=0;
  for(const e of storageEvents){
    const action=/read|get/i.test(`${e.subtype||''} ${e.operation||''}`)?'read':(/write|set|put|flush|delete/i.test(`${e.subtype||''} ${e.operation||''}`)?'write':'other');
    if(action==='read')storageReads++; if(action==='write')storageWrites++;
    const ms=Number(e.durationMs??e.payload?.durationMs)||0;storageTotalMs+=ms;
    const key=e.storageKey||e.payload?.key||e.payload?.storageKey||'(unknown)';
    const backend=e.storageBackend||e.payload?.backend||e.payload?.storageBackend||'unknown';
    const gkey=`${backend}|${key}`; const x=storageGroups.get(gkey)||{key,backend,events:0,reads:0,writes:0,totalMs:0,maxMs:0,bytes:0,records:0};
    x.events++; if(action==='read')x.reads++; if(action==='write')x.writes++;x.totalMs+=ms;x.maxMs=Math.max(x.maxMs,ms);x.bytes+=Number(e.approxBytes||e.payload?.approxBytes||0);x.records+=Number(e.records||e.payload?.records||0);storageGroups.set(gkey,x);
  }
  const storageTop=[...storageGroups.values()].map(x=>({...x,totalMs:Math.round(x.totalMs*10)/10,maxMs:Math.round(x.maxMs*10)/10})).sort((a,b)=>b.totalMs-a.totalMs||b.events-a.events).slice(0,12);

  const networkEvents=q.filter(e=>e.category==='network'||/^network[-_:]/i.test(e.subtype||''));
  const networkEnds=networkEvents.filter(e=>/end|response|complete|completed|failed/i.test(e.subtype||''));
  const networkGroups=new Map();let networkErrors=0,networkTotalMs=0;
  for(const e of networkEnds){
    const endpoint=e.requestedUrl||e.payload?.endpoint||e.payload?.requestedUrl||'(unknown)';const feature=e.feature||'unknown';const ms=Number(e.durationMs??e.payload?.durationMs)||0;networkTotalMs+=ms;
    const status=Number((e.status ?? e.payload?.status) || 0);const bad=(status>=400)||qolOutcomeIsError(e.outcome ?? e.payload?.outcome ?? e.payload?.result)||e.payload?.ok===false;if(bad)networkErrors++;
    const key=`${feature}|${endpoint}`;const x=networkGroups.get(key)||{feature,endpoint,count:0,errors:0,totalMs:0,maxMs:0};x.count++;x.errors+=bad?1:0;x.totalMs+=ms;x.maxMs=Math.max(x.maxMs,ms);networkGroups.set(key,x);
  }
  const networkTop=[...networkGroups.values()].map(x=>({...x,totalMs:Math.round(x.totalMs*10)/10,avgMs:x.count?Math.round(x.totalMs/x.count*10)/10:0,maxMs:Math.round(x.maxMs*10)/10})).sort((a,b)=>b.totalMs-a.totalMs||b.count-a.count).slice(0,12);

  const workerEvents=q.filter(e=>e.category==='worker'||/worker|heartbeat|helper/i.test(`${e.subtype||''} ${e.operation||''} ${e.feature||''}`));
  const workerGroups=new Map();
  const workers={events:workerEvents.length,starts:0,ready:0,jobs:0,heartbeats:0,throttled:0,restarts:0,closed:0,top:[]};
  for(const e of workerEvents){
    const text=`${e.subtype||''} ${e.operation||''}`.toLowerCase();
    if(/create|start|spawn/.test(text))workers.starts++;if(/ready/.test(text))workers.ready++;if(/job|item|request/.test(text))workers.jobs++;if(/heartbeat/.test(text))workers.heartbeats++;if(/throttl|background-delay|timer-gap/.test(text))workers.throttled++;if(/restart|replace/.test(text))workers.restarts++;if(/close|closed|stop|complete/.test(text))workers.closed++;
    const label=e.feature||e.payload?.workerType||e.workerSessionId||'worker'; const x=workerGroups.get(label)||{label,events:0,jobs:0,throttled:0,restarts:0};x.events++;if(/job|item|request/.test(text))x.jobs++;if(/throttl|background-delay|timer-gap/.test(text))x.throttled++;if(/restart|replace/.test(text))x.restarts++;workerGroups.set(label,x);
  }
  workers.top=[...workerGroups.values()].sort((a,b)=>b.events-a.events).slice(0,10);

  const longTasks=events.filter(e=>e.type==='performance'&&e.subtype==='long-task'&&Number.isFinite(Number(e.entryStartTs))&&Number.isFinite(Number(e.entryEndTs)));
  const byPage=new Map();for(const op of spans){if(!op.pageId||!Number.isFinite(op.startTs)||!Number.isFinite(op.endTs))continue;const a=byPage.get(op.pageId)||[];a.push(op);byPage.set(op.pageId,a);}for(const a of byPage.values())a.sort((x,y)=>x.startTs-y.startTs);
  let ltOverlapCount=0,totalOverlapMs=0;const overlapFeatures=new Map();
  for(const lt of longTasks){
    const list=byPage.get(lt.pageId)||[];
    const allIntervals=[];
    const featureIntervals=new Map();
    for(const op of list){
      if(op.startTs>lt.entryEndTs)break;
      if(op.endTs<lt.entryStartTs)continue;
      const start=Math.max(op.startTs,lt.entryStartTs),end=Math.min(op.endTs,lt.entryEndTs);
      if(end<=start)continue;
      allIntervals.push([start,end]);
      const k=op.feature||'unknown';const a=featureIntervals.get(k)||[];a.push([start,end]);featureIntervals.set(k,a);
    }
    if(allIntervals.length){
      ltOverlapCount++;
      totalOverlapMs+=intervalUnionMs(allIntervals);
      for(const [feature,intervals] of featureIntervals) overlapFeatures.set(feature,(overlapFeatures.get(feature)||0)+intervalUnionMs(intervals));
    }
  }
  const overlapTop=[...overlapFeatures.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([feature,ms])=>({feature,overlapMs:Math.round(ms*10)/10}));

  return {
    events:q.length,rawEvents:qRaw.length,deduplicatedEvents:Math.max(0,qRaw.length-q.length),explicitTraceEvents,protocols:[...protocolCounts.entries()].map(([protocol,count])=>({protocol,count})).sort((a,b)=>b.count-a.count),
    sequenceGaps,sequenceGapEvents,sequenceStreams:sequence.streams,sequenceGapDetails:sequence.details,traceLevel,
    traceBatches:{events:traceBatchEvents,maxBatchSize},
    operations:{count:spans.length,totalMs:Math.round(operationTotalMs*10)/10,slow50:spans.filter(x=>(x.durationMs||0)>=50).length,slow200:spans.filter(x=>(x.durationMs||0)>=200).length,slow1000:spans.filter(x=>(x.durationMs||0)>=1000).length,top:topOps},
    scheduler,
    storage:{events:storageEvents.length,reads:storageReads,writes:storageWrites,totalMs:Math.round(storageTotalMs*10)/10,top:storageTop},
    network:{events:networkEvents.length,completed:networkEnds.length,errors:networkErrors,totalMs:Math.round(networkTotalMs*10)/10,top:networkTop},
    workers,
    settingsChanges:q.filter(e=>e.category==='settings'||/setting-change|settings-change/i.test(e.subtype||'')).length,
    userActions:q.filter(e=>e.category==='user-action'||/user-action/i.test(e.subtype||'')).length,
    performanceActions:q.filter(e=>e.category==='performance'||/performance-mode|quiet-(?:start|end)|pressure|startup-quiet|reply-quiet/i.test(e.subtype||'')).length,
    errorEvents:q.filter(e=>e.category==='error'||/error|failed|failure|exception/i.test(e.subtype||'')||e.outcome==='failed').length,
    backgroundEvents:q.filter(e=>e.category==='background'||e.module==='background'||e.payload?.origin==='background'||e.meta?.origin==='background').length,
    longTaskCorrelation:{supported:longTasks.length>0,longTasksChecked:longTasks.length,longTasksOverlappingQol:ltOverlapCount,totalOverlapMs:Math.round(totalOverlapMs*10)/10,topFeatures:overlapTop}
  };
}

function buildSummary(events) {
  const netResponses = events.filter(e => e.type === 'network' && /response$/.test(e.subtype || ''));
  const allErrors = events.filter(e => e.type === 'error' || (e.type === 'network' && e.status >= 400));
  const trackerNoiseErrors = allErrors.filter(e => e.type === 'error' && e.likelyNonCriticalTracker);
  const dailyMessageLimitEvents = allErrors.filter(isKnownDailyMessageLimitEvent);
  const errors = allErrors.filter(e => !(e.type === 'error' && e.likelyNonCriticalTracker) && !isKnownDailyMessageLimitEvent(e));
  const slow = netResponses.filter(e => (e.durationMs || 0) >= 1000);
  // Canonical Long Task set: every stored PerformanceObserver long-task event.
  // Earlier builds deduplicated by pageId/startTime/duration only in this headline
  // summary, which made it disagree with page/version diagnostics from the same
  // capture. Capture-time PerformanceObserver de-duplication already prevents
  // duplicate delivery, so summary-time dropping is both unnecessary and lossy.
  const longTasks = events.filter(e => e.type === 'performance' && e.subtype === 'long-task');
  const longAnimationFrames = events.filter(e => e.type === 'performance' && e.subtype === 'long-animation-frame');
  const loafScriptCounts = new Map();
  for (const e of longAnimationFrames) {
    for (const script of (e.scripts || [])) {
      const key = script.sourceURL || script.sourceKind || '(unknown script)';
      const x = loafScriptCounts.get(key) || { count: 0, totalMs: 0, sourceKind: script.sourceKind || 'unknown-mixed' };
      x.count++;
      x.totalMs += script.durationMs || 0;
      loafScriptCounts.set(key, x);
    }
  }
  const topLongAnimationFrameScripts = [...loafScriptCounts.entries()]
    .sort((a,b) => b[1].totalMs - a[1].totalMs)
    .slice(0, 8)
    .map(([source,x]) => ({ source, ...x, totalMs: Math.round(x.totalMs * 10) / 10 }));
  const thirdParty = events.filter(e => e.type === 'performance' && e.subtype === 'resource' && e.thirdParty);
  const workerResourceSummaryEvents = events.filter(e => e.type === 'performance' && e.subtype === 'worker-resource-summary');
  const workerResourceGroups = new Map();
  for (const e of workerResourceSummaryEvents) {
    const key = `${e.workerRole || 'worker'}|${e.endpointGroup || 'endpoint'}`;
    const x = workerResourceGroups.get(key) || { workerRole:e.workerRole||'worker', endpointGroup:e.endpointGroup||'endpoint', requests:0, totalDurationMs:0, maxDurationMs:0, over500ms:0, over1000ms:0 };
    x.requests += Number(e.requests)||0; x.totalDurationMs += Number(e.totalDurationMs)||0; x.maxDurationMs = Math.max(x.maxDurationMs, Number(e.maxDurationMs)||0); x.over500ms += Number(e.over500ms)||0; x.over1000ms += Number(e.over1000ms)||0;
    workerResourceGroups.set(key,x);
  }
  const workerResources = {
    summaryEvents: workerResourceSummaryEvents.length,
    requests: workerResourceSummaryEvents.reduce((n,e)=>n+(Number(e.requests)||0),0),
    top:[...workerResourceGroups.values()].map(x=>({...x,avgDurationMs:x.requests?Math.round(x.totalDurationMs/x.requests*10)/10:0,totalDurationMs:Math.round(x.totalDurationMs*10)/10,maxDurationMs:Math.round(x.maxDurationMs*10)/10})).sort((a,b)=>b.requests-a.requests||b.totalDurationMs-a.totalDurationMs).slice(0,10)
  };
  const storage = events.filter(e => e.type === 'storage');
  const nsfw = { true: 0, false: 0 };
  const models = new Set();
  for (const e of events) for (const s of (e.signals || [])) {
    if (/is_nsfw$/i.test(s.path)) nsfw[String(!!s.value)]++;
    if (/(inference_model|engine|provider|\.model)$/i.test(s.path) && typeof s.value === 'string') models.add(s.value);
  }

  const domainBytes = {};
  for (const e of thirdParty) {
    let h = '';
    try { h = new URL(e.name).host; } catch (_) { continue; }
    domainBytes[h] = (domainBytes[h] || 0) + (e.transferSize || e.encodedBodySize || 0);
  }
  const topThirdParty = Object.entries(domainBytes).sort((a,b)=>b[1]-a[1]).slice(0,8);

  const endpointStats = {};
  for (const e of netResponses) {
    const label = endpointLabel(e) || '(unknown)';
    const x = endpointStats[label] ||= { count: 0, errors: 0, totalMs: 0, maxMs: 0, chars: 0 };
    x.count++; x.errors += e.status >= 400 ? 1 : 0; x.totalMs += e.durationMs || 0; x.maxMs = Math.max(x.maxMs, e.durationMs || 0); x.chars += e.responseChars || 0;
  }
  const topEndpoints = Object.entries(endpointStats).sort((a,b)=>b[1].count-a[1].count).slice(0,12).map(([endpoint,x])=>({ endpoint, ...x, avgMs: x.count ? Math.round((x.totalMs/x.count)*10)/10 : 0 }));

  const invalidToken401 = netResponses.filter(e => e.status === 401 && (e.authInvalidToken === true || e.errorCode === 'SC-001-6004' || e.body?.errorCode === 'SC-001-6004' || /invalid or expired token/i.test(JSON.stringify(e.body || ''))));
  const authStorms = [];
  let storm = [];
  for (const e of invalidToken401.slice().sort((a,b)=>a.ts-b.ts)) {
    if (!storm.length || e.ts - storm[storm.length-1].ts <= 5000) storm.push(e);
    else { if (storm.length >= 3) authStorms.push(storm); storm = [e]; }
  }
  if (storm.length >= 3) authStorms.push(storm);
  const authRefreshRaces = buildAuthRefreshRaceDiagnostics(events, invalidToken401);
  const pageRoleIndex = buildPageRoleIndex(events);
  const recommendationFeedback = buildRecommendationFeedbackDiagnostics(events, pageRoleIndex);

  const statusZeroLikelyNavigation = netResponses.filter(e => e.status === 0 && /navigation|hidden|abort|unload/i.test(e.statusZeroHint || '')).length;

  // Connectivity episodes are based on browser online/offline lifecycle hints. They
  // are evidence of local connectivity changes, not by themselves proof that
  // SpicyChat was down. Duplicate events from multiple open tabs are collapsed.
  const connectivityRaw = events.filter(e => e.type === 'lifecycle' && /^(network-offline|network-online)$/.test(e.subtype || '')).slice().sort((a,b)=>a.ts-b.ts);
  const connectivityCollapsed = [];
  for (const e of connectivityRaw) {
    const kind = e.subtype === 'network-offline' ? 'offline' : 'online';
    const prev = connectivityCollapsed[connectivityCollapsed.length - 1];
    if (prev && prev.kind === kind && e.ts - prev.lastTs <= 5000) { prev.lastTs = e.ts; prev.count++; }
    else connectivityCollapsed.push({ kind, ts: e.ts, lastTs: e.ts, count: 1 });
  }
  const offlineWindows = [];
  let offlineStart = null;
  for (const x of connectivityCollapsed) {
    if (x.kind === 'offline') {
      if (offlineStart == null) offlineStart = x.ts;
    } else if (offlineStart != null) {
      offlineWindows.push({ startTs: offlineStart, endTs: x.ts, durationMs: Math.max(0, x.ts - offlineStart) });
      offlineStart = null;
    }
  }
  if (offlineStart != null) {
    const endTs = events.reduce((m,e)=>Math.max(m,e.ts||0), offlineStart);
    offlineWindows.push({ startTs: offlineStart, endTs, durationMs: Math.max(0, endTs - offlineStart), openEnded: true });
  }
  const firstPartyFailures = netResponses.filter(e => {
    if (!(e.status === 0 || e.status >= 400)) return false;
    try { const h = new URL(endpointUrl(e)).hostname; return /(^|\.)spicychat\.ai$|(^|\.)nd-api\.com$/.test(h); } catch (_) { return false; }
  });
  let firstPartyFailuresNearOutage = 0, reconnectPageStarts = 0;
  for (const w of offlineWindows) {
    firstPartyFailuresNearOutage += firstPartyFailures.filter(e => e.ts >= w.startTs - 30000 && e.ts <= w.endTs + 30000).length;
    reconnectPageStarts += events.filter(e => e.type === 'lifecycle' && e.subtype === 'page-start' && e.ts >= w.endTs && e.ts <= w.endTs + 60000).length;
  }
  const connectivitySummary = {
    events: connectivityRaw.length,
    offlineWindows: offlineWindows.length,
    totalOfflineMs: offlineWindows.reduce((n,w)=>n+w.durationMs,0),
    longestOfflineMs: offlineWindows.reduce((m,w)=>Math.max(m,w.durationMs),0),
    firstPartyFailuresNearOutage,
    reconnectPageStarts,
    windows: offlineWindows.slice(-10)
  };

  const requestBursts = [];
  const byEndpoint = {};
  for (const e of netResponses) (byEndpoint[endpointLabel(e) || '(unknown)'] ||= []).push(e);
  for (const [endpoint, list] of Object.entries(byEndpoint)) {
    const ordered = list.slice().sort((a,b)=>a.ts-b.ts);
    let cluster = [];
    const flush = () => {
      if (cluster.length >= 4) requestBursts.push({ endpoint, count: cluster.length, startTs: cluster[0].ts, endTs: cluster[cluster.length-1].ts, durationMs: cluster[cluster.length-1].ts-cluster[0].ts, statuses: [...new Set(cluster.map(x=>x.status))] });
      cluster = [];
    };
    for (const e of ordered) {
      if (!cluster.length || e.ts - cluster[cluster.length-1].ts <= 1200) cluster.push(e);
      else { flush(); cluster = [e]; }
    }
    flush();
  }
  requestBursts.sort((a,b)=>b.count-a.count || a.durationMs-b.durationMs);

  const storageCounts = {};
  for (const e of storage) {
    const key = e.key || '(none)';
    const writes = e.subtype?.includes('write-burst') ? (e.writes || 1) : (/-(set)$/.test(e.subtype || '') ? 1 : 0);
    if (!writes) continue;
    const x = storageCounts[key] ||= { writes: 0, events: 0, burstEvents: 0 };
    x.writes += writes; x.events++; if (e.subtype?.includes('write-burst')) x.burstEvents++;
  }
  const topStorageKeys = Object.entries(storageCounts).sort((a,b)=>b[1].writes-a[1].writes).slice(0,10).map(([key,x])=>({key,...x}));

  const routeLong = {};
  for (const e of longTasks) {
    let route = '(unknown)';
    try { route = new URL(e.pageUrl || e.url || '').pathname || '/'; } catch (_) {}
    const x = routeLong[route] ||= { count: 0, totalMs: 0, maxMs: 0 };
    x.count++; x.totalMs += e.durationMs || 0; x.maxMs = Math.max(x.maxMs, e.durationMs || 0);
  }
  const topLongTaskRoutes = Object.entries(routeLong).sort((a,b)=>b[1].totalMs-a[1].totalMs).slice(0,8).map(([route,x])=>({route,...x,totalMs:Math.round(x.totalMs*10)/10}));

  // Duplicate-response diagnostics are page/session aware. The same settings/profile
  // response once on five separate page starts is normal startup behavior; only
  // repeated identical responses inside the same page instance are candidates for
  // avoidable duplicate traffic. Aggregate those same-page bursts afterward so
  // endpoints such as /cms/banners still show how consistently they repeat.
  const duplicateSessionMap = {};
  for (const e of netResponses) {
    if (!e.responseFingerprint) continue;
    const pageKey = e.pageId || (Number.isInteger(e.tabId) ? `tab:${e.tabId}` : 'page:unknown');
    const endpoint = endpointLabel(e);
    const key = `${pageKey}|${endpoint}|${e.responseFingerprint}`;
    const size = e.responseChars || e.contentLength || 0;
    const x = duplicateSessionMap[key] ||= { pageKey, endpoint, fingerprint: e.responseFingerprint, count: 0, chars: 0, firstChars: size, totalMs: 0 };
    x.count++; x.chars += size; x.totalMs += e.durationMs || 0;
  }
  const duplicateAggregate = {};
  for (const x of Object.values(duplicateSessionMap)) {
    if (x.count < 2) continue;
    const key = `${x.endpoint}|${x.fingerprint}`;
    const a = duplicateAggregate[key] ||= { endpoint:x.endpoint, fingerprint:x.fingerprint, count:0, chars:0, totalMs:0, repeatedPages:0, avoidableResponses:0, approxAvoidableChars:0 };
    a.count += x.count;
    a.chars += x.chars;
    a.totalMs += x.totalMs;
    a.repeatedPages++;
    a.avoidableResponses += Math.max(0, x.count - 1);
    a.approxAvoidableChars += Math.max(0, x.chars - x.firstChars);
  }
  const duplicateResponses = Object.values(duplicateAggregate)
    .sort((a,b)=>b.avoidableResponses-a.avoidableResponses || b.approxAvoidableChars-a.approxAvoidableChars)
    .slice(0,20)
    .map(x => ({ ...x, avgMs: x.count ? Math.round((x.totalMs/x.count)*10)/10 : 0 }));
  const quickDislike = buildQuickDislikeCompatibilityDiagnostics(events, recommendationFeedback);
  const listingRefill = buildListingRefillDiagnostics(events);
  const generationRender = buildGenerationRenderDiagnostics(events);
  const recentPerformance = buildRecentPerformanceComparison(events);
  const pageHotspots = buildPageInstanceHotspots(events);
  const pagePressureGrowth = buildPagePressureGrowthDiagnostics(events);
  const autoLagSpikes = events.filter(e=>e.type==='performance'&&e.subtype==='auto-lag-spike');

  const requestById = new Map();
  for (const e of events) {
    if (!e?.requestId || e.type !== 'network') continue;
    if (/request$/.test(e.subtype || '') || e.requestCombined === true) requestById.set(e.requestId, e);
  }
  const chatGenerations = netResponses.filter(e => /(^|\/)chat$/.test(endpointLabel(e)) && String(e.method || '').toUpperCase() === 'POST' && e.status >= 200 && e.status < 300);
  const generationTimeline = chatGenerations.map(e => {
    const req = requestById.get(e.requestId);
    const findSignal = (obj, re) => (obj?.signals || []).find(s => re.test(s.path || ''))?.value;
    const reqBody = requestBodyOf(req);
    const settings = reqBody?.inference_settings || null;
    return {
      ts: e.ts, durationMs: e.durationMs || null,
      is_nsfw: findSignal(e, /\.is_nsfw$/i),
      engine: findSignal(e, /\.engine$/i) || null,
      model: reqBody?.inference_model || findSignal(req, /(inference_model|\.model)$/i) || findSignal(e, /(inference_model|\.model)$/i) || null,
      settings: settings ? { max_new_tokens: settings.max_new_tokens ?? null, temperature: settings.temperature ?? null, top_p: settings.top_p ?? null, top_k: settings.top_k ?? null } : null,
      requestId: e.requestId || null
    };
  });
  let generationNsfwTrue = 0, generationNsfwFalse = 0, generationClassifierFlips = 0, prevClass;
  for (const g of generationTimeline) {
    if (g.is_nsfw === true) generationNsfwTrue++;
    if (g.is_nsfw === false) generationNsfwFalse++;
    if (typeof g.is_nsfw === 'boolean') { if (typeof prevClass === 'boolean' && prevClass !== g.is_nsfw) generationClassifierFlips++; prevClass = g.is_nsfw; }
  }

  const markerWindows = events.filter(e => e.type === 'marker').map(m => {
    const beforeMs = m.captureWindow?.beforeMs ?? 90000, afterMs = m.captureWindow?.afterMs ?? 30000;
    const win = events.filter(e => e !== m && e.ts >= m.ts - beforeMs && e.ts <= m.ts + afterMs);
    const nw = win.filter(e => e.type === 'network' && /response$/.test(e.subtype || ''));
    const gens = nw.filter(e => /(^|\/)chat$/.test(endpointLabel(e)) && String(e.method || '').toUpperCase() === 'POST');
    const classifierSequence = gens.map(g => (g.signals || []).find(s => /\.is_nsfw$/i.test(s.path || ''))?.value).filter(v => typeof v === 'boolean');
    const followups = events.filter(e => e.type === 'marker-context' && e.relatedMarkerTs === m.ts);
    return { markerId: m.id, subtype: m.subtype, label: m.label, ts: m.ts, url: m.url, beforeMs, afterMs, events: win.length, networkResponses: nw.length, errors: win.filter(e => ((e.type === 'error' && !e.likelyNonCriticalTracker) || (e.type === 'network' && e.status >= 400)) && !isKnownDailyMessageLimitEvent(e)).length, longTasks: win.filter(e => e.type === 'performance' && e.subtype === 'long-task').length, chatGenerations: gens.length, classifierSequence, recentContextEmbedded: Array.isArray(m.recentContext) ? m.recentContext.length : 0, followupContexts: followups.length, followupRecentContextEmbedded: followups.reduce((n,f)=>n+(Array.isArray(f.recentContext)?f.recentContext.length:0),0) };
  });

  const attributionCounts = { qolConfirmed: 0, qolLikely: 0, spicychatNative: 0, thirdParty: 0, otherExtension: 0, unknownMixed: 0 };
  for (const e of events) {
    const a = e.attribution || {};
    if (a.source === 'qol') {
      if (a.confidence === 'confirmed') attributionCounts.qolConfirmed++; else attributionCounts.qolLikely++;
    } else if (a.source === 'spicychat-native') attributionCounts.spicychatNative++;
    else if (a.source === 'third-party') attributionCounts.thirdParty++;
    else if (a.source === 'other-extension') attributionCounts.otherExtension++;
    else if (a.source === 'unknown-mixed') attributionCounts.unknownMixed++;
  }
  const qolEvents = events.filter(e => e.type === 'qol' || !!normalizedQolIdentity(e).version);
  const latestQol = qolEvents.slice().sort((a,b)=>eventTs(b)-eventTs(a)).find(e => { const q=normalizedQolIdentity(e); return q.version || q.build || /handshake|presence|ready|init/.test(e.subtype || ''); }) || null;
  const latestQolIdentity = normalizedQolIdentity(latestQol);
  const versionDiagnostics = buildVersionDiagnostics(events);
  const captureHealth = buildCaptureHealthDiagnostics(events);
  const scrollAndInput = buildScrollAndInputDiagnostics(events);
  const longTaskAttribution = buildLongTaskAttributionDiagnostics(events);

  const domBatches = events.filter(e => e.type === 'dom' && e.subtype === 'mutation-batch');
  const domSummary = { batches: domBatches.length, totalMutations: 0, qolRelated: 0, qolOwned: 0, noOp: 0, messageNodesAdded: 0, messageNodesRemoved: 0, maxMountedMessages: 0, topPatterns: [] };
  const domPatternCounts = new Map();
  for (const e of domBatches) {
    const st = e.stats || {};
    domSummary.totalMutations += st.totalMutations || (Array.isArray(e.changes) ? e.changes.length : 0);
    domSummary.qolRelated += st.qolRelated || 0;
    domSummary.qolOwned += st.qolOwned || 0;
    domSummary.noOp += st.noOp || 0;
    domSummary.messageNodesAdded += st.messageNodesAdded || 0;
    domSummary.messageNodesRemoved += st.messageNodesRemoved || 0;
    if (Number.isFinite(st.mountedMessages)) domSummary.maxMountedMessages = Math.max(domSummary.maxMountedMessages, st.mountedMessages);
    for (const p of (st.topPatterns || [])) domPatternCounts.set(p.value, (domPatternCounts.get(p.value) || 0) + (p.count || 0));
  }
  domSummary.topPatterns = [...domPatternCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([pattern,count])=>({pattern,count}));

  const focusLong = {};
  let qolOverlappedLongTasks = 0;
  for (const e of longTasks) {
    const i = e.interaction || {};
    const key = i.hidden ? 'hidden' : (i.userIdle ? 'idle' : (i.documentHasFocus || i.windowFocused ? 'focused' : 'blurred'));
    const x = focusLong[key] ||= { count: 0, totalMs: 0 };
    x.count++; x.totalMs += e.durationMs || 0;
    if (e.attribution?.triggerSource === 'qol') qolOverlappedLongTasks++;
  }
  for (const x of Object.values(focusLong)) x.totalMs = Math.round(x.totalMs * 10) / 10;

  const domTs = domBatches.map(e => e.ts).filter(Number.isFinite).sort((a,b)=>a-b);
  function nearestDistance(sorted, value) {
    if (!sorted.length || !Number.isFinite(value)) return Infinity;
    let lo=0, hi=sorted.length;
    while (lo<hi) { const mid=(lo+hi)>>1; if (sorted[mid] < value) lo=mid+1; else hi=mid; }
    return Math.min(lo < sorted.length ? Math.abs(sorted[lo]-value) : Infinity, lo > 0 ? Math.abs(sorted[lo-1]-value) : Infinity);
  }
  let longNearDom500=0, longNearDom1000=0;
  for (const e of longTasks) { const d=nearestDistance(domTs,e.ts); if (d<=500) longNearDom500++; if (d<=1000) longNearDom1000++; }
  const domLongCorrelation = { within500ms: longNearDom500, within1000ms: longNearDom1000, totalLongTasks: longTasks.length };

  // Large-chat pressure: correlate Long Tasks with the nearest sampled mounted-message
  // count, and summarize native message-history pagination. This helps distinguish
  // "loaded a lot of chat history" pressure from generic page churn.
  const chatDomSamples = domBatches
    .filter(e => Number.isFinite(e.stats?.mountedMessages))
    .map(e => ({ ts: e.ts, count: e.stats.mountedMessages, pageId: e.pageId, pageUrl: e.pageUrl }))
    .sort((a,b)=>a.ts-b.ts);
  const chatDomPressure = {
    maxMountedMessages: domSummary.maxMountedMessages || 0, longTaskBuckets: {},
    historyResponses: 0, historyFailures: 0, olderHistoryPages: 0, maxReportedMessages: 0,
    resourceOnlyHistoryPages: 0, resourceOnlyOlderHistoryPages: 0, resourceOnlyHistoryTotalMs: 0, resourceOnlyHistoryMaxMs: 0
  };
  const bucketName = n => n >= 200 ? '200+' : n >= 150 ? '150-199' : n >= 100 ? '100-149' : n >= 50 ? '50-99' : '0-49';
  for (const e of longTasks) {
    let best = null, bestD = Infinity;
    for (let i = chatDomSamples.length - 1; i >= 0; i--) {
      const x = chatDomSamples[i];
      const d = Math.abs(x.ts - e.ts);
      if (d > bestD && x.ts < e.ts) break;
      if (x.pageId === e.pageId && d < bestD) { best = x; bestD = d; }
      if (e.ts - x.ts > 2500 && best) break;
    }
    if (!best || bestD > 2500) continue;
    const k = bucketName(best.count);
    const b = chatDomPressure.longTaskBuckets[k] ||= { count: 0, totalMs: 0, maxMs: 0 };
    b.count++; b.totalMs += e.durationMs || 0; b.maxMs = Math.max(b.maxMs, e.durationMs || 0);
  }
  for (const b of Object.values(chatDomPressure.longTaskBuckets)) b.totalMs = Math.round(b.totalMs * 10) / 10;
  const historyNetworkKeys = new Set();
  for (const e of netResponses) {
    const u = endpointUrl(e);
    if (!/\/characters\/[^/?]+\/messages(?:\/[^/?]+)?(?:\?|$)/.test(u)) continue;
    const okHistory = e.status == null || (e.status >= 200 && e.status < 300);
    if (okHistory) chatDomPressure.historyResponses++; else chatDomPressure.historyFailures++;
    try { if (okHistory && new URL(u).searchParams.has('last_id')) chatDomPressure.olderHistoryPages++; } catch (_) {}
    historyNetworkKeys.add(`${e.pageId || ''}|${u}`);
    const n = e.body && typeof e.body === 'object' ? Number(e.body.num_messages) : NaN;
    if (Number.isFinite(n)) chatDomPressure.maxReportedMessages = Math.max(chatDomPressure.maxReportedMessages, n);
  }
  // Some extension/background API history requests bypass the page fetch/XHR bridge
  // but remain visible through Resource Timing. Count only resource entries that do
  // not have an equivalent captured network response so the two observation layers
  // cannot double-count the same page request. Status is unavailable at this layer,
  // therefore these are reported separately as resource-only timings rather than as
  // confirmed successful responses.
  for (const e of events) {
    if (e.type !== 'performance' || e.subtype !== 'resource') continue;
    const u = e.name || e.url || '';
    if (!/\/characters\/[^/?]+\/messages(?:\/[^/?]+)?(?:\?|$)/.test(u)) continue;
    if (historyNetworkKeys.has(`${e.pageId || ''}|${u}`)) continue;
    chatDomPressure.resourceOnlyHistoryPages++;
    const d = Number(e.durationMs) || 0;
    chatDomPressure.resourceOnlyHistoryTotalMs += d;
    chatDomPressure.resourceOnlyHistoryMaxMs = Math.max(chatDomPressure.resourceOnlyHistoryMaxMs, d);
    try { if (new URL(u).searchParams.has('last_id')) chatDomPressure.resourceOnlyOlderHistoryPages++; } catch (_) {}
  }
  chatDomPressure.resourceOnlyHistoryTotalMs = Math.round(chatDomPressure.resourceOnlyHistoryTotalMs * 10) / 10;
  chatDomPressure.resourceOnlyHistoryMaxMs = Math.round(chatDomPressure.resourceOnlyHistoryMaxMs * 10) / 10;

  const invalidTokenAttribution = {};
  for (const e of invalidToken401) {
    const k = e.attribution?.source || 'unknown-mixed';
    invalidTokenAttribution[k] = (invalidTokenAttribution[k] || 0) + 1;
  }

  const counterDriver = buildCounterDriverDiagnostics(events);
  const qolTrace = buildQolTraceDiagnostics(events);
  // Final export-time interval reconstruction is more reliable than provisional
  // capture-time attribution, especially when v1/v2 telemetry arrives out of order.
  qolOverlappedLongTasks = Number(qolTrace?.longTaskCorrelation?.longTasksOverlappingQol || 0);
  const canonicalLongTaskTotalMs = Math.round(longTasks.reduce((n,e)=>n+(e.durationMs||0),0)*10)/10;
  const diagnosticConsistencyWarnings = buildDiagnosticConsistencyWarnings(events, {
    longTasks: longTasks.length,
    longTaskTotalMs: canonicalLongTaskTotalMs,
    longAnimationFrames: longAnimationFrames.length,
    networkResponses: netResponses.length,
    captureHealth,
    recommendationFeedback,
    pageRoleIndex,
    counterDriver,
    qolTrace
  });

  return {
    totalEvents: events.length,
    attributionCounts,
    qolTelemetry: {
      count: qolEvents.length,
      version: (versionDiagnostics.qolVersions || []).length === 1 ? (versionDiagnostics.qolVersions[0]?.version || latestQolIdentity.version || null) : null,
      versions: (versionDiagnostics.qolVersions || []).map(x => x.version),
      mixedVersions: (versionDiagnostics.qolVersions || []).length > 1,
      newestObservedVersion: (versionDiagnostics.qolVersions || []).length ? versionDiagnostics.qolVersions[versionDiagnostics.qolVersions.length - 1].version : (latestQolIdentity.version || null),
      latestEventVersion: latestQolIdentity.version || null,
      build: latestQolIdentity.build || null,
      sessionId: latestQolIdentity.sessionId || null
    },
    versionDiagnostics,
    captureHealth,
    scrollAndInput,
    longTaskAttribution,
    domSummary,
    longTaskInteraction: focusLong,
    qolOverlappedLongTasks,
    domLongCorrelation,
    chatDomPressure,
    invalidTokenAttribution,
    authRefreshRaces,
    recommendationFeedback,
    counterDriver,
    qolTrace,
    dailyMessageLimits: {
      count: dailyMessageLimitEvents.length,
      errorCode: dailyMessageLimitEvents.length ? 'SC-001-5201' : null,
      recent: dailyMessageLimitEvents.slice(-10).map(e=>({ts:e.ts,pageId:e.pageId||null,endpoint:endpointLabel(e),status:e.status}))
    },
    diagnosticConsistencyWarnings,
    networkResponses: netResponses.length,
    errors: errors.length,
    trackerNoiseErrors: trackerNoiseErrors.length,
    slowRequests: slow.length,
    longTasks: longTasks.length,
    longTaskTotalMs: canonicalLongTaskTotalMs,
    longAnimationFrames: longAnimationFrames.length,
    longAnimationFrameTotalMs: Math.round(longAnimationFrames.reduce((n,e)=>n+(e.durationMs||0),0)*10)/10,
    longAnimationFrameBlockingMs: Math.round(longAnimationFrames.reduce((n,e)=>n+(e.blockingDurationMs||0),0)*10)/10,
    topLongAnimationFrameScripts,
    thirdPartyResources: thirdParty.length,
    workerResources,
    nsfwSignals: nsfw,
    models: [...models].slice(0,20),
    invalidToken401s: invalidToken401.length,
    authStorms: authStorms.map(group => ({ count: group.length, startTs: group[0].ts, endTs: group[group.length-1].ts, durationMs: group[group.length-1].ts-group[0].ts, endpoints: [...new Set(group.map(endpointLabel))].slice(0,10) })),
    statusZeroLikelyNavigation,
    connectivity: connectivitySummary,
    requestBursts: requestBursts.slice(0,20),
    topStorageKeys,
    topLongTaskRoutes,
    duplicateResponses,
    quickDislike,
    listingRefill,
    generationRender,
    recentPerformance,
    pageHotspots,
    pagePressureGrowth,
    autoLagSpikes: { count:autoLagSpikes.length, recent:autoLagSpikes.slice(-20) },
    chatGenerationSummary: { count: generationTimeline.length, nsfwTrue: generationNsfwTrue, nsfwFalse: generationNsfwFalse, classifierFlips: generationClassifierFlips, avgMs: generationTimeline.length ? Math.round((generationTimeline.reduce((n,g)=>n+(g.durationMs||0),0)/generationTimeline.length)*10)/10 : 0, note: 'is_nsfw is treated as a per-message classifier, not proof of a persistent SFW mode.' },
    generationTimeline: generationTimeline.slice(-100),
    markerWindows,
    topEndpoints,
    topThirdParty: topThirdParty.map(([host, bytes]) => ({ host, bytes })),
    largestResponses: netResponses.slice().sort((a,b)=>(b.responseChars||b.contentLength||0)-(a.responseChars||a.contentLength||0)).slice(0,8).map(e=>({ endpoint:endpointLabel(e), chars:e.responseChars || null, bytes:e.contentLength || null, ms:e.durationMs || null, status:e.status }))
  };
}

function renderOverview() {
  const s = buildSummary(allEvents);
  const chips = [
    ['Stored events', storedTotal.toLocaleString()], ['Loaded sample', s.totalEvents.toLocaleString()], ['Network', s.networkResponses.toLocaleString()], ['Errors', s.errors], ['Tracker-block noise', s.trackerNoiseErrors],
    ['Slow ≥1s', s.slowRequests], ['Long tasks', `${s.longTasks} / ${(s.longTaskTotalMs/1000).toFixed(1)}s`], ['LoAFs', `${s.longAnimationFrames} / ${(s.longAnimationFrameBlockingMs/1000).toFixed(1)}s block`], ['3rd-party resources', s.thirdPartyResources],
    ['401 invalid-token', s.invalidToken401s], ['Daily cap', s.dailyMessageLimits?.count || 0], ['Auth storms', s.authStorms.length], ['Req bursts', s.requestBursts.length], ['Status 0 nav/abort', s.statusZeroLikelyNavigation], ['Offline windows', s.connectivity?.offlineWindows || 0],
    ['NSFW true signals', s.nsfwSignals.true], ['NSFW false signals', s.nsfwSignals.false]
  ];
  if (s.qolTelemetry.count) chips.push(['QoL internals', s.qolTelemetry.count]);
  if (s.qolTrace?.operations?.count) chips.push(['QoL trace ops', s.qolTrace.operations.count]);
  const extra = [];
  if (s.models.length) extra.push(`<div><strong>Models/engines seen:</strong> ${s.models.map(esc).join(', ')}</div>`);
  if (s.dailyMessageLimits?.count) extra.push(`<div><strong>Known SpicyChat daily-message limit:</strong> ${s.dailyMessageLimits.count} SC-001-5201 response(s). <em>Shown separately from generic Errors because this is an expected product limit, not a network failure.</em></div>`);
  if (s.counterDriver?.logicalEvents) {
    const d=s.counterDriver;
    const retryText=d.retriedNumbers?.length?` · ${d.retriedNumbers.length} number(s) retried`:'';
    const progress=d.lastConfirmed!=null?` · last confirmed ${d.lastConfirmed}${d.nextNumber!=null?` → next ${d.nextNumber}`:''}`:'';
    const runtime=d.wallClockMs?` · runtime ${(d.wallClockMs/3600000).toFixed(2)}h`:'';
    extra.push(`<div><strong>Counter/Test Driver:</strong> ${d.sendAttempts.toLocaleString()} send attempt(s) · ${d.confirmed.toLocaleString()} confirmed · ${d.sendErrors} send error(s) · ${d.maintenanceReloads} maintenance reload(s) · ${d.dailyLimits} daily-limit marker(s) · ${d.stalls} stalled marker(s)${retryText}${progress}${runtime} · collapsed ${d.mirroredDuplicates.toLocaleString()} duplicate mirror marker(s)${d.orphanMirrors?` · ${d.orphanMirrors} unpaired mirror(s) preserved`:''}.</div>`);
  }
  if (s.qolTelemetry.count) {
    const versionText = s.qolTelemetry.mixedVersions
      ? ` · mixed runtimes ${s.qolTelemetry.versions.map(esc).join(' + ')}${s.qolTelemetry.newestObservedVersion ? ` · newest observed ${esc(s.qolTelemetry.newestObservedVersion)}` : ''}`
      : (s.qolTelemetry.version ? ` · QoL ${esc(s.qolTelemetry.version)}` : '');
    extra.push(`<div><strong>QoL compatibility:</strong> ${s.qolTelemetry.count} identity/telemetry sample(s)${versionText}${s.qolTelemetry.build ? ` · build ${esc(s.qolTelemetry.build)}` : ''}.${s.qolTelemetry.mixedVersions && s.qolTelemetry.latestEventVersion && s.qolTelemetry.latestEventVersion !== s.qolTelemetry.newestObservedVersion ? ` <em>The most recent heartbeat came from an older still-open tab (${esc(s.qolTelemetry.latestEventVersion)}); it is not treated as the current extension version.</em>` : ''}</div>`);
  }
  if (s.qolTrace?.events) {
    const t=s.qolTrace, op=t.operations||{}, lc=t.longTaskCorrelation||{};
    const proto=(t.protocols||[]).map(x=>`${esc(x.protocol)} ×${x.count}`).join(', ');
    const top=op.top?.[0];
    extra.push(`<div><strong>QoL Trace:</strong> ${t.explicitTraceEvents.toLocaleString()} detailed event(s) · ${op.count.toLocaleString()} operation span(s) / ${(op.totalMs/1000).toFixed(2)}s measured QoL work · slow ≥50ms ${op.slow50}, ≥200ms ${op.slow200}, ≥1s ${op.slow1000}${top?` · top ${esc(top.label)} ${(top.totalMs/1000).toFixed(2)}s across ${top.runs} run(s)`:''}${t.deduplicatedEvents?` · ${t.deduplicatedEvents.toLocaleString()} duplicate transport event(s) collapsed`:''}${t.sequenceGaps?` · <strong>${t.sequenceGaps} final missing sequence event(s)</strong>`:' · final sequence gaps 0'}${proto?` · protocol ${proto}`:''}.</div>`);
    if (t.scheduler?.events) extra.push(`<div><strong>QoL scheduler:</strong> ${t.scheduler.events} event(s) · deferred ${t.scheduler.deferred} · coalesced ${t.scheduler.coalesced} · skipped ${t.scheduler.skipped}${t.scheduler.queueDelaySamples?` · queue delay avg ${t.scheduler.avgQueueDelayMs.toFixed(1)}ms / p95 ${t.scheduler.p95QueueDelayMs.toFixed(1)}ms`:''}.</div>`);
    if (t.storage?.events) extra.push(`<div><strong>QoL storage trace:</strong> ${t.storage.events} event(s) · reads ${t.storage.reads} / writes ${t.storage.writes} · ${(t.storage.totalMs/1000).toFixed(2)}s measured${t.storage.top?.[0]?` · top ${esc(t.storage.top[0].backend)}:${esc(t.storage.top[0].key)} ${(t.storage.top[0].totalMs/1000).toFixed(2)}s`:''}.</div>`);
    if (t.network?.events) extra.push(`<div><strong>QoL network trace:</strong> ${t.network.completed} completed request(s) · ${t.network.errors} error(s) · ${(t.network.totalMs/1000).toFixed(2)}s measured request time${t.network.top?.[0]?` · top ${esc(t.network.top[0].feature)} ${esc(t.network.top[0].endpoint)}`:''}.</div>`);
    if (t.workers?.events) extra.push(`<div><strong>QoL workers:</strong> ${t.workers.events} trace event(s) · starts ${t.workers.starts} · ready ${t.workers.ready} · jobs ${t.workers.jobs} · throttled ${t.workers.throttled} · restarts ${t.workers.restarts} · closed ${t.workers.closed}.</div>`);
    if (lc.supported) extra.push(`<div><strong>Long Task ↔ explicit QoL span correlation:</strong> ${lc.longTasksOverlappingQol}/${lc.longTasksChecked} timestamped Long Task(s) overlapped QoL operation span(s), with ${(lc.totalOverlapMs/1000).toFixed(2)}s aggregate interval overlap${lc.topFeatures?.[0]?` · most overlap ${esc(lc.topFeatures[0].feature)} ${(lc.topFeatures[0].overlapMs/1000).toFixed(2)}s`:''}. <em>Overlap is correlation, not automatic proof of causation.</em></div>`);
  }
  const vd = s.versionDiagnostics || {};
  if ((vd.qolVersions || []).length) {
    const versions = vd.qolVersions.map(x => `${esc(x.version)} (${x.pages} page${x.pages===1?'':'s'})`).join(' → ');
    const overlap = vd.mixedQolVersionOverlap ? ` · mixed-version overlap ${(vd.mixedQolVersionOverlap.durationMs/60000).toFixed(1)} min; older tabs were still emitting after ${esc(vd.mixedQolVersionOverlap.newestVersion)} first appeared` : '';
    extra.push(`<div><strong>QoL versions in loaded sample:</strong> ${versions}${overlap}.</div>`);
  }
  if ((vd.inspectorVersions || []).length > 1) extra.push(`<div><strong>Inspector runtimes in loaded sample:</strong> ${vd.inspectorVersions.map(x => `${esc(x.version)} (${x.pageStarts} page start${x.pageStarts===1?'':'s'})`).join(' → ')}. <em>Already-open tabs can keep an older content script until reload/navigation.</em></div>`);
  const ac = s.attributionCounts;
  if (Object.values(ac).some(Boolean)) extra.push(`<div><strong>Attribution:</strong> confirmed QoL ${ac.qolConfirmed}, likely QoL ${ac.qolLikely}, native SpicyChat ${ac.spicychatNative}, third-party ${ac.thirdParty}, other extension ${ac.otherExtension}, unknown/mixed ${ac.unknownMixed}.</div>`);
  if (s.domSummary.batches) extra.push(`<div><strong>DOM churn:</strong> ${s.domSummary.totalMutations.toLocaleString()} mutations · ${s.domSummary.qolOwned.toLocaleString()} QoL-owned · ${s.domSummary.qolRelated.toLocaleString()} direct/owned ds-related · ${s.domSummary.noOp.toLocaleString()} no-op${s.domSummary.topPatterns[0] ? ` · top: ${esc(s.domSummary.topPatterns[0].pattern)} ×${s.domSummary.topPatterns[0].count}` : ''}.</div>`);
  if (s.captureHealth?.pressureSnapshots) extra.push(`<div><strong>Page pressure:</strong> ${s.captureHealth.pressureSnapshots} snapshot(s) · max ${s.captureHealth.maxDomElements.toLocaleString()} DOM element(s)${s.captureHealth.maxMountedMessages ? ` · max ${s.captureHealth.maxMountedMessages} mounted message(s)` : ''}${s.captureHealth.maxJsHeapUsedBytes ? ` · max JS heap ${formatBytes(s.captureHealth.maxJsHeapUsedBytes)}` : ''}${s.captureHealth.maxResourceEntries ? ` · max ${s.captureHealth.maxResourceEntries} Resource Timing entries` : ''}${s.captureHealth.resourceTimingBufferFullEvents ? ` · buffer-full events ${s.captureHealth.resourceTimingBufferFullEvents} · clear attempts ${s.captureHealth.resourceTimingBufferClearAttempts||0} / ${s.captureHealth.resourceTimingBufferClears||0} succeeded${s.captureHealth.resourceTimingBufferClearFailures ? ` / ${s.captureHealth.resourceTimingBufferClearFailures} failed` : ''}` : ''}${s.captureHealth.observerFastModeCallbacks ? ` · fast observer ${s.captureHealth.observerFastModeCallbacks} callback(s) / ${s.captureHealth.observerFastModeMutations.toLocaleString()} mutation(s)` : ''}.</div>`);
  if (s.captureHealth && (s.captureHealth.pageFreezes || s.captureHealth.pageResumes || s.captureHealth.discardedPageStarts)) extra.push(`<div><strong>Page lifecycle:</strong> freeze ${s.captureHealth.pageFreezes} · resume ${s.captureHealth.pageResumes} · discarded/reloaded starts ${s.captureHealth.discardedPageStarts} · pagehide ${s.captureHealth.pageHides} · pageshow ${s.captureHealth.pageShows}.</div>`);
  if (s.longTaskAttribution?.loafFrameOverlap) extra.push(`<div><strong>Long Task attribution candidates:</strong> ${s.longTaskAttribution.loafFrameOverlap} / ${s.longTaskAttribution.longTasks} tasks overlapped Long Animation Frames; ${s.longTaskAttribution.loafScriptCandidates} had at least one script-source category, ${s.longTaskAttribution.explicitQolOperationOverlap} also overlapped explicit QoL operations. A matching script does not prove causation.</div>`);
  if (s.scrollAndInput?.scrollWindows || s.scrollAndInput?.slowInputEvents) extra.push(`<div><strong>Scroll &amp; input:</strong> ${s.scrollAndInput.scrollWindows} human-input-correlated scroll window(s) · ${s.scrollAndInput.scrollFrameGapsOver100ms} sampled frame gap(s) &gt;100ms · ${s.scrollAndInput.scrollLinkedLongTasks} temporally overlapping Long Task(s) · ${s.scrollAndInput.slowInputEvents} slow Event Timing entry/entries. These are correlations, not causality.</div>`);
  if (s.generationRender?.domMatchOutcomes?.length) extra.push(`<div><strong>Generation DOM checks:</strong> ${s.generationRender.domMatchOutcomes.slice(0,5).map(x=>`${esc(x.label)} (${x.count})`).join(' · ')}.</div>`);
  if (s.captureHealth?.captureChecks) {const c=s.captureHealth.captureChecks;extra.push(`<div><strong>QoL tracing status:</strong> opt-in enabled in ${c.qolCaptureOn} captured page/settings state(s), disabled in ${c.qolCaptureOff}; ${c.qolTracesReceived} trace-received signal(s), ${c.qolHandshakeOnly} handshake-only signal(s), ${c.qolNoTrace} no-response signal(s). Check opt-in and whether meaningful operations occurred before concluding the protocol is broken.</div>`);}
  if (s.captureHealth && (s.captureHealth.inspectorSelfThrottleEvents || s.captureHealth.aggregatedThirdPartyResourceRequests || s.captureHealth.aggregatedWorkerResourceRequests || s.captureHealth.aggregatedTrackerErrors || s.captureHealth.resourceTimingProactiveClears)) extra.push(`<div><strong>Inspector self-protection:</strong> throttle windows ${s.captureHealth.inspectorSelfThrottleEvents || 0}${s.captureHealth.inspectorSelfThrottleEvents ? ` (${(s.captureHealth.inspectorSelfThrottleUnionMs/1000).toFixed(1)}s merged coverage per page; ${(s.captureHealth.inspectorSelfThrottleMs/1000).toFixed(1)}s summed windows)` : ''} · aggregated third-party resource timings ${s.captureHealth.aggregatedThirdPartyResourceRequests || 0} · aggregated QoL-worker resource timings ${s.captureHealth.aggregatedWorkerResourceRequests || 0} · proactive Resource Timing clears ${s.captureHealth.resourceTimingProactiveClears || 0} · aggregated tracker/resource errors ${s.captureHealth.aggregatedTrackerErrors || 0}.</div>`);
  if (s.captureHealth && (s.captureHealth.inspectorObserverMs || s.captureHealth.inspectorFlushMs)) {
    const slow = s.captureHealth.observerBatchesOver50ms || 0;
    const warning = (s.captureHealth.avgObserverCallbackMs || 0) >= 4 || slow > 0
      ? ` <strong>Capture-overhead warning:</strong> observer work is high enough to potentially perturb this page; interpret performance comparisons cautiously.`
      : '';
    const actualCb = s.captureHealth.maxObserverCallbackMs ? ` · worst measured callback ${s.captureHealth.maxObserverCallbackMs.toFixed(1)} ms · callbacks ≥16 ms ${s.captureHealth.observerCallbacksOver16ms || 0}, ≥50 ms ${s.captureHealth.observerCallbacksOver50ms || 0}` : '';
    const fastReasons = (s.captureHealth.observerFastModeReasons || []).length ? ` · fast-mode reasons ${s.captureHealth.observerFastModeReasons.map(x=>`${esc(x.value)} ×${x.count}`).join(', ')}` : '';
    extra.push(`<div><strong>Inspector DOM bookkeeping:</strong> ${s.captureHealth.inspectorObserverMs.toFixed(1)} ms inside MutationObserver callbacks + ${s.captureHealth.inspectorFlushMs.toFixed(1)} ms preparing stored batches across ${s.captureHealth.observerCallbacks.toLocaleString()} callback(s) · avg ${(s.captureHealth.avgObserverCallbackMs || 0).toFixed(2)} ms/callback · worst stored 500ms batch ${(s.captureHealth.maxObserverBatchMs || 0).toFixed(1)} ms · stored batches ≥16 ms ${s.captureHealth.observerBatchesOver16ms || 0}, ≥50 ms ${slow}${actualCb}${fastReasons}. <em>This measures Inspector's own DOM capture work, not page work.</em>${warning}</div>`);
  }
  if (s.chatDomPressure?.maxMountedMessages || s.chatDomPressure?.historyResponses) {
    const buckets = Object.entries(s.chatDomPressure.longTaskBuckets || {}).map(([k,x]) => `${k} msg: ${x.count}/${(x.totalMs/1000).toFixed(1)}s`).join(', ');
    extra.push(`<div><strong>Large-chat pressure:</strong> max ${s.chatDomPressure.maxMountedMessages || 'n/a'} mounted message node(s) · successful history responses ${s.chatDomPressure.historyResponses}${s.chatDomPressure.historyFailures ? ` · ${s.chatDomPressure.historyFailures} failed history response(s)` : ''}${s.chatDomPressure.olderHistoryPages ? ` (${s.chatDomPressure.olderHistoryPages} older-page load${s.chatDomPressure.olderHistoryPages===1?'':'s'})` : ''}${s.chatDomPressure.resourceOnlyHistoryPages ? ` · ${s.chatDomPressure.resourceOnlyHistoryPages} resource-only history timing(s)${s.chatDomPressure.resourceOnlyOlderHistoryPages ? ` (${s.chatDomPressure.resourceOnlyOlderHistoryPages} cursor page${s.chatDomPressure.resourceOnlyOlderHistoryPages===1?'':'s'})` : ''}` : ''}${s.chatDomPressure.maxReportedMessages ? ` · API-reported messages ${s.chatDomPressure.maxReportedMessages}` : ''}${buckets ? ` · Long Tasks by mounted size: ${esc(buckets)}` : ''}.</div>`);
  }
  if (s.longTasks) extra.push(`<div><strong>Long Task ↔ DOM:</strong> ${s.domLongCorrelation.within500ms}/${s.longTasks} within 500 ms · ${s.domLongCorrelation.within1000ms}/${s.longTasks} within 1s · ${s.qolOverlappedLongTasks} overlapped reconstructed completed QoL operation span(s).</div>`);
  if (s.connectivity?.offlineWindows) extra.push(`<div><strong>Connectivity:</strong> ${s.connectivity.offlineWindows} offline window(s) · ${(s.connectivity.totalOfflineMs/1000).toFixed(1)}s total · longest ${(s.connectivity.longestOfflineMs/1000).toFixed(1)}s · first-party failures near outage ${s.connectivity.firstPartyFailuresNearOutage} · page starts within 60s of reconnect ${s.connectivity.reconnectPageStarts}. <em>Browser online/offline is a connectivity hint, not proof of a SpicyChat outage.</em></div>`);
  if (s.longAnimationFrames) extra.push(`<div><strong>Long Animation Frames:</strong> ${s.longAnimationFrames} frame(s) · ${(s.longAnimationFrameTotalMs/1000).toFixed(1)}s duration · ${(s.longAnimationFrameBlockingMs/1000).toFixed(1)}s blocking${s.topLongAnimationFrameScripts[0] ? ` · top script: ${esc(s.topLongAnimationFrameScripts[0].source)} (${(s.topLongAnimationFrameScripts[0].totalMs/1000).toFixed(1)}s)` : ''}.</div>`);
  if (Object.keys(s.longTaskInteraction).length) extra.push(`<div><strong>Long Tasks by page state:</strong> ${Object.entries(s.longTaskInteraction).map(([k,x]) => `${esc(k)} ${x.count}/${(x.totalMs/1000).toFixed(1)}s`).join(', ')}.</div>`);
  if (s.authStorms.length) extra.push(`<div><strong>401 storms:</strong> ${s.authStorms.length} invalid/expired-token storm(s). Attribution: ${Object.entries(s.invalidTokenAttribution).map(([k,v]) => `${esc(k)} ${v}`).join(', ') || 'unknown'}.</div>`);
  if (s.authRefreshRaces?.count) extra.push(`<div><strong>Auth refresh race:</strong> ${s.authRefreshRaces.count} invalid-token request(s) fired while a successful OAuth refresh was already in flight. Latest refresh completed ${s.authRefreshRaces.races.at(-1)?.refreshCompletedAfter401Ms ?? '?'} ms after the 401.</div>`);
  if (s.recommendationFeedback?.count || s.recommendationFeedback?.workerPages) {
    const r=s.recommendationFeedback;
    const attempts = r.ratingPosts != null ? ` · rating POSTs ${r.ratingPosts.toLocaleString()}${r.corsPreflights!=null ? ` · CORS preflights ${r.corsPreflights.toLocaleString()}` : ''}` : '';
    const retries = r.retries ? ` · retries ${r.retries}${r.retriedTransactions ? ` across ${r.retriedTransactions} action(s)` : ''}` : '';
    const actions = Object.entries(r.byAction||{}).map(([k,v])=>`${esc(k)} ${v}`).join(', ');
    extra.push(`<div><strong>Recommendation feedback:</strong> ${r.count||0} bot action(s) · ${r.successes||0} succeeded${r.failures ? ` · ${r.failures} failed` : ''}${r.noResponse ? ` · ${r.noResponse} no response` : ''} · sources ${Object.entries(r.bySource||{}).map(([k,v])=>`${esc(k)} ${v}`).join(', ') || 'unknown'}${actions ? ` · actions ${actions}` : ''}${attempts}${retries}${r.duplicateItems?.length ? ` · ${r.duplicateItems.length} bot ID(s) acted on again later` : ''}.</div>`);
    if (r.workerPages) {
      const wp=r.workerPerformance||{};
      const domRange=wp.domElementsMin!=null&&wp.domElementsMax!=null?` · DOM ${wp.domElementsMin.toLocaleString()}–${wp.domElementsMax.toLocaleString()}`:'';
      const heapRange=wp.jsHeapUsedMinBytes!=null&&wp.jsHeapUsedMaxBytes!=null?` · JS heap ${formatBytes(wp.jsHeapUsedMinBytes)}–${formatBytes(wp.jsHeapUsedMaxBytes)}`:'';
      extra.push(`<div><strong>QoL recommendation-feedback worker (mode may be unknown):</strong> ${r.workerPages} page(s) · ${r.jobCount||0} job(s) · ${r.workerRatingActions||0} action(s), ${r.workerSuccesses||0} succeeded${r.workerFailures?` / ${r.workerFailures} failed`:''} · ${r.uniqueBotIds||0} unique bot ID(s) · runtime ${(r.wallClockMs/60000).toFixed(2)}m · POST median ${(r.postLatencyMedianMs||0).toFixed(1)}ms / p95 ${(r.postLatencyP95Ms||0).toFixed(1)}ms · request spacing median ${(r.requestSpacingMedianMs||0).toFixed(1)}ms · detected cooldowns ${r.detectedCooldownPauses||0} · Long Tasks ${wp.longTasks||0}/${((wp.longTaskMs||0)/1000).toFixed(2)}s · LoAFs ${wp.longAnimationFrames||0}/${((wp.loafBlockingMs||0)/1000).toFixed(2)}s block${domRange}${heapRange}.</div>`);
    }
  }
  if (s.chatGenerationSummary.count) extra.push(`<div><strong>Chat generations:</strong> ${s.chatGenerationSummary.count} · classifier true ${s.chatGenerationSummary.nsfwTrue} / false ${s.chatGenerationSummary.nsfwFalse} · ${s.chatGenerationSummary.classifierFlips} flip(s) · avg ${(s.chatGenerationSummary.avgMs/1000).toFixed(1)}s. <em>Per-message classifier only.</em></div>`);
  if (s.generationRender?.count) { const g=s.generationRender; const buckets=(g.mountedMessageBuckets||[]).map(x=>`${x.label}: ${(x.avgLongTaskMs/1000).toFixed(2)}s avg`).join(', '); extra.push(`<div><strong>Post-generation render (${(g.windowMs/1000).toFixed(0)}s window):</strong> ${g.count} generation(s) · avg Long Task ${(g.avgLongTaskMs/1000).toFixed(2)}s · median ${(g.medianLongTaskMs/1000).toFixed(2)}s · p95 ${(g.p95LongTaskMs/1000).toFixed(2)}s · avg LoAF blocking ${(g.avgLoafBlockingMs/1000).toFixed(2)}s · ${g.generationsOver1sPostBlock} generation(s) with ≥1s post-response Long Tasks${g.medianResponseDomSignalMs!=null ? ` · median response→confirmed DOM signal ${g.medianResponseDomSignalMs.toFixed(0)}ms` : ''}${g.missingResponseDomSignal ? ` · ${g.missingResponseDomSignal} generation(s) without confirmed DOM signal` : ''}${g.legacyFirstMessageDomSamples ? ` · ${g.legacyFirstMessageDomSamples} legacy/unverified DOM sample(s) excluded` : ''}${g.mountedMessageScaling ? ` · mounted-message slope ${g.mountedMessageScaling.slope.toFixed(1)} ms/msg (R² ${g.mountedMessageScaling.r2.toFixed(2)})` : ''}${buckets ? ` · by mounted size: ${esc(buckets)}` : ''}.</div>`); const routes=(g.routeSummaries||[]).map(r=>`${r.routeKind==='story'?'Story':'/chat'}: ${r.count} gen · ${(r.avgLongTaskMs/1000).toFixed(2)}s avg${r.maxMounted!=null?` · mounted ${r.minMounted}-${r.maxMounted}`:''}${r.mountedMessageScaling?` · slope ${r.mountedMessageScaling.slope.toFixed(1)} ms/msg`:''}`).join(' | '); if(routes) extra.push(`<div><strong>Generation render by route:</strong> ${esc(routes)}.</div>`); }
  if (s.workerResources?.requests) { const top=(s.workerResources.top||[]).slice(0,4).map(x=>`${x.workerRole} ${x.endpointGroup}: ${x.requests} req · avg ${x.avgDurationMs.toFixed(0)}ms · max ${x.maxDurationMs.toFixed(0)}ms`).join(' | '); extra.push(`<div><strong>QoL worker resources:</strong> ${s.workerResources.requests.toLocaleString()} aggregated request timing(s) in ${s.workerResources.summaryEvents} summary event(s)${top?` · ${esc(top)}`:''}.</div>`); }
  if (s.recentPerformance?.available) { const r=s.recentPerformance.recent,p=s.recentPerformance.previous,mins=s.recentPerformance.windowMs/60000; extra.push(`<div><strong>Recent performance:</strong> last ${mins.toFixed(0)}m Long Tasks ${(r.longTaskMs/1000).toFixed(1)}s vs prior ${(p.longTaskMs/1000).toFixed(1)}s${s.recentPerformance.longTaskRatio!=null ? ` (${s.recentPerformance.longTaskRatio.toFixed(1)}×)` : ''} · LoAF block ${(r.loafBlockingMs/1000).toFixed(1)}s vs ${(p.loafBlockingMs/1000).toFixed(1)}s · DOM ${r.domMutations.toLocaleString()} vs ${p.domMutations.toLocaleString()} · generations ${r.generations} vs ${p.generations}.</div>`); }
  if (s.autoLagSpikes?.count) extra.push(`<div><strong>Automatic lag spikes:</strong> ${s.autoLagSpikes.count} trigger(s) captured; each adds immediate + 10s page-pressure context with a 30s cooldown.</div>`);
  if (s.pageHotspots?.length) extra.push(`<div><strong>Worst page instance:</strong> ${esc(s.pageHotspots[0].dominantRoute || routeLabel(s.pageHotspots[0].pageUrl))} · ${(s.pageHotspots[0].longTaskMs/1000).toFixed(1)}s Long Tasks / ${s.pageHotspots[0].longTasks} · ${s.pageHotspots[0].domMutations.toLocaleString()} mutations over ${(s.pageHotspots[0].durationMs/60000).toFixed(1)}m${s.pageHotspots[0].routeChanges ? ` · ${s.pageHotspots[0].routeChanges} SPA route change(s)` : ''}.</div>`);
  if (s.pagePressureGrowth?.length) { const p=s.pagePressureGrowth[0]; extra.push(`<div><strong>Largest DOM pressure growth:</strong> ${esc(p.maxRoute)} · ${p.baselineDom.toLocaleString()} → ${p.maxDom.toLocaleString()} element(s) (${p.growth>=0?'+':''}${p.growth.toLocaleString()})${p.largestJump?.delta ? ` · largest sampled jump +${p.largestJump.delta.toLocaleString()}` : ''}${p.maxMountedMessages ? ` · max ${p.maxMountedMessages} mounted message(s)` : ''}${p.maxResourceEntries ? ` · Resource Timing ${p.maxResourceEntries}` : ''}.</div>`); }
  if (s.duplicateResponses.length) extra.push(`<div><strong>Repeated identical responses in the same page session:</strong> ${s.duplicateResponses.slice(0,4).map(x => `${esc(x.endpoint)} (${x.avoidableResponses} extra across ${x.repeatedPages} page${x.repeatedPages===1?'':'s'})`).join(', ')}</div>`);
  if (s.listingRefill?.workerPages) { const b=s.listingRefill.batches?.[s.listingRefill.batches.length-1]; extra.push(`<div><strong>Listing refill helpers:</strong> ${s.listingRefill.workerPages} page boot(s) across ${s.listingRefill.uniqueTabs} tab(s) · ${s.listingRefill.networkResponses} network response(s) · ${s.listingRefill.bannerResponses} banner response(s) · ${s.listingRefill.searchResponses} search response(s)${s.listingRefill.searchRecoveredFailovers ? ` · ${s.listingRefill.searchRecoveredFailovers} recovered Typesense failover(s)` : ''}${s.listingRefill.unresolvedSearchFailures ? ` · ${s.listingRefill.unresolvedSearchFailures} unresolved search failure(s)` : ''} · median completed lifetime ${(s.listingRefill.medianLifetimeMs/1000).toFixed(1)}s${s.listingRefill.longLivedWorkers ? ` · ${s.listingRefill.longLivedWorkers} completed helper(s) lived ≥20s` : ''}${s.listingRefill.incompleteAtExport ? ` · ${s.listingRefill.incompleteAtExport} still-open/export-cutoff helper(s)` : ''}${s.listingRefill.repeatedPageFetches ? ` · ${s.listingRefill.repeatedPageFetches} repeated refill page fetch(es)` : ''}${s.listingRefill.pageBacktracks ? ` · ${s.listingRefill.pageBacktracks} pagination backtrack(s)` : ''}${b ? ` · latest ${esc(b.route)} pages ${b.minPage ?? '?'}–${b.maxPage ?? '?'} (${b.workers} helper(s))` : ''}.</div>`); }
  if (s.diagnosticConsistencyWarnings?.length) extra.push(`<div><strong>Diagnostic consistency warnings:</strong> ${s.diagnosticConsistencyWarnings.map(x=>`${esc(x.code)} (expected ${esc(x.expected)}, got ${esc(x.actual)})`).join(' · ')}.</div>`);
  if (s.markerWindows.length) extra.push(`<div><strong>Preserved markers:</strong> ${s.markerWindows.length} marker(s); each stores compact recent context and triggers a pinned state snapshot.</div>`);
  if (s.requestBursts.length) extra.push(`<div><strong>Request bursts:</strong> ${s.requestBursts.slice(0,3).map(x => `${esc(x.endpoint)} (${x.count} in ${(x.durationMs/1000).toFixed(1)}s)`).join(', ')}</div>`);
  if (s.topStorageKeys.length) extra.push(`<div><strong>Top storage writers:</strong> ${s.topStorageKeys.slice(0,4).map(x => `${esc(x.key)} (${x.writes.toLocaleString()} writes)`).join(', ')}</div>`);
  if (s.topLongTaskRoutes.length) extra.push(`<div><strong>Main-thread hotspots:</strong> ${s.topLongTaskRoutes.slice(0,4).map(x => `${esc(x.route)} (${(x.totalMs/1000).toFixed(1)}s / ${x.count})`).join(', ')}</div>`);
  if (s.topThirdParty.length) extra.push(`<div><strong>Top third-party transfer candidates:</strong> ${s.topThirdParty.map(x => `${esc(x.host)} (${formatBytes(x.bytes)})`).join(', ')}</div>`);
  const overview = $('#overview');
  overview.replaceChildren();
  const chipWrap = document.createElement('div');
  chipWrap.className = 'summaryChips';
  for (const [label, value] of chips) {
    const span = document.createElement('span');
    const bold = document.createElement('b');
    bold.textContent = String(value ?? '');
    span.appendChild(bold);
    span.appendChild(document.createTextNode(String(label ?? '')));
    chipWrap.appendChild(span);
  }
  overview.appendChild(chipWrap);
  for (const markup of extra) appendOverviewExtra(overview, markup);
}
function formatBytes(n) { if (!n) return '0 B'; const u=['B','KB','MB','GB']; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(i?1:0)} ${u[i]}`; }

function applyFilters() {
  const q = $('#search').value.trim().toLowerCase(), t = $('#typeFilter').value, interestingOnly = $('#interestingOnly').checked;
  filtered = allEvents.filter(e => {
    if (t && e.type !== t) return false;
    if (interestingOnly && !isInteresting(e)) return false;
    if (q) { try { if (!JSON.stringify(e).toLowerCase().includes(q)) return false; } catch (_) { return false; } }
    return true;
  });
  render();
}
function render() {
  const box = $('#events');
  $('#count').textContent = `${filtered.length.toLocaleString()} / ${allEvents.length.toLocaleString()} events`;
  box.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No matching events.';
    box.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of filtered) {
    const btn = document.createElement('button');
    btn.className = `event ${classFor(e)}${selectedId === e.id ? ' selected' : ''}`;
    btn.dataset.id = String(e.id);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(e.ts);
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = String(e.type ?? '');
    const sum = document.createElement('span');
    sum.className = 'summary';
    sum.textContent = summary(e);
    btn.append(time, type, sum);
    btn.onclick = () => select(Number(btn.dataset.id));
    frag.appendChild(btn);
  }
  box.appendChild(frag);
}
async function select(id) {
  selectedId = id;
  let e = null;
  try { e = await getLocalEventById(id); } catch (_) {}
  if (!e) e = allEvents.find(x => x.id === id);
  if (!e) return;
  const detail = $('#detail');
  detail.replaceChildren();
  const head = document.createElement('div');
  head.className = 'detailHead';
  const title = document.createElement('strong');
  title.textContent = `${String(e.type ?? '')} / ${String(e.subtype || '')}`;
  const when = document.createElement('span');
  when.textContent = new Date(e.ts).toLocaleString();
  head.append(title, when);
  const pre = document.createElement('pre');
  appendHighlightedJson(pre, e);
  detail.append(head, pre);
  render();
}
const UI_EVENT_LIMIT = 3000;

function compactUiEvent(e) {
  if (!e || typeof e !== 'object') return e;
  const out = { ...e };
  delete out.headers;
  if (out.type === 'network') {
    const label = endpointLabel(out);
    const reqBody = requestBodyOf(out);
    const isChatRequest = /(^|\/)chat$/.test(label) && isNetworkRequestEvent(out) && String(out.method || '').toUpperCase() === 'POST';
    const isAuthError = out.status === 401 || out.errorCode === 'SC-001-6004' || out.authInvalidToken === true;
    delete out.requestHeaders;
    if (isChatRequest && reqBody && typeof reqBody === 'object') {
      out.requestBody = {
        inference_model: reqBody.inference_model ?? null,
        inference_settings: reqBody.inference_settings ? {
          max_new_tokens: reqBody.inference_settings.max_new_tokens ?? null,
          temperature: reqBody.inference_settings.temperature ?? null,
          top_p: reqBody.inference_settings.top_p ?? null,
          top_k: reqBody.inference_settings.top_k ?? null
        } : null,
        conversation_id: reqBody.conversation_id ?? null,
        character_id: reqBody.character_id ?? null,
        alt_message_id: reqBody.alt_message_id ?? null,
        continue_chat: reqBody.continue_chat ?? null
      };
    } else if (/\/spicychat-prod\/ratings\/?$/i.test(label) && reqBody && typeof reqBody === 'object') {
      out.requestBody = { itemId: reqBody.itemId ?? null, rating: reqBody.rating ?? null, cascadeCreate: reqBody.cascadeCreate ?? null };
    } else {
      delete out.requestBody;
    }
    if (/\/characters\/[^/]+\/messages(?:\/[^/?]+)?$/i.test(label) && out.body && typeof out.body === 'object') {
      out.body = { num_messages: out.body.num_messages ?? null };
    } else if (isAuthError && out.body && typeof out.body === 'object') {
      out.body = { errorCode: out.body.errorCode ?? out.body?.error?.code ?? null, message: out.body.message ?? out.body.error ?? null };
    } else {
      delete out.body;
    }
  } else if (out.type === 'marker' || out.type === 'marker-context') {
    if (Array.isArray(out.recentContext)) out.recentContextCount = out.recentContext.length;
    delete out.recentContext;
    delete out.state;
    delete out.html;
  } else if (out.type === 'state') {
    delete out.value;
    delete out.snapshot;
    delete out.html;
  }
  return out;
}

async function getLocalEventCount(db) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function getLatestLocalEvents(db, limit = UI_EVENT_LIMIT) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const source = store.indexNames.contains('ts') ? store.index('ts') : store;
    const out = [];
    const req = source.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
      out.push(compactUiEvent(cursor.value));
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out.reverse());
    tx.onerror = () => reject(tx.error);
  });
}

async function getLocalEventById(id) {
  const db = await openLocalDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function refresh(force = false) {
  const box = $('#events');
  try {
    const db = await openLocalDb();
    const total = await getLocalEventCount(db);
    if (!force && allEvents.length && total === storedTotal) { db.close(); return; }
    const events = await getLatestLocalEvents(db, UI_EVENT_LIMIT);
    db.close();
    allEvents = events;
    storedTotal = total;
    renderOverview();
    applyFilters();
  } catch (err) {
    console.error('Inspector refresh failed', err);
    if (box) {
      box.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty';
      const strong = document.createElement('strong');
      strong.textContent = 'Inspector UI load failed.';
      empty.appendChild(strong);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(document.createTextNode(String(err?.message || err)));
      empty.appendChild(document.createElement('br'));
      empty.appendChild(document.createElement('br'));
      empty.appendChild(document.createTextNode('The capture database was not cleared. Export can still read IndexedDB directly.'));
      box.appendChild(empty);
    }
    $('#count').textContent = 'UI load error';
  }
}

function exportFingerprintText(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
function exportFingerprintValue(value) {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch (_) { text = String(value ?? ''); }
  return exportFingerprintText(text);
}
function exportLorebookUrl(event) {
  return event?.finalUrl || event?.responseUrl || event?.requestedUrl || event?.url || event?.networkMeta?.endpoint || '';
}
function isLorebookApiExportUrl(url) {
  if (!url) return false;
  try { return /(?:^|\/)lorebooks(?:\/|$)/i.test(new URL(String(url)).pathname || ''); }
  catch (_) { return /(?:^|\/)lorebooks(?:[/?#]|$)/i.test(String(url)); }
}
function redactLorebookExportPayload(value, depth = 0, stats = { contentFields:0, keywordFields:0 }) {
  if (depth > 18 || value == null) return { value, stats };
  if (Array.isArray(value)) return { value:value.map(v=>redactLorebookExportPayload(v, depth+1, stats).value), stats };
  if (typeof value !== 'object') return { value, stats };
  const out = {};
  let privacy = value._inspectorLorebookPrivacy && typeof value._inspectorLorebookPrivacy === 'object' ? { ...value._inspectorLorebookPrivacy } : null;
  for (const [k,v] of Object.entries(value)) {
    const lower=String(k).toLowerCase();
    if (lower==='content') {
      if (v === '[REDACTED_LOREBOOK_CONTENT]') { out[k]=v; continue; }
      let chars=0; if(typeof v==='string') chars=v.length; else { try{chars=JSON.stringify(v).length;}catch(_){chars=String(v??'').length;} }
      out[k]='[REDACTED_LOREBOOK_CONTENT]'; privacy=privacy||{}; privacy.content={chars,fingerprint:exportFingerprintValue(v)}; stats.contentFields++; continue;
    }
    if (lower==='keywords') {
      if (v === '[REDACTED_LOREBOOK_KEYWORDS]') { out[k]=v; continue; }
      let count=null,chars=0;
      if(Array.isArray(v)){count=v.length;for(const item of v){if(typeof item==='string')chars+=item.length;else{try{chars+=JSON.stringify(item).length;}catch(_){chars+=String(item??'').length;}}}}
      else if(typeof v==='string'){count=v?1:0;chars=v.length;}
      else { try{chars=JSON.stringify(v).length;}catch(_){chars=String(v??'').length;} }
      out[k]='[REDACTED_LOREBOOK_KEYWORDS]'; privacy=privacy||{}; privacy.keywords={count,chars,fingerprint:exportFingerprintValue(v)}; stats.keywordFields++; continue;
    }
    if (k === '_inspectorLorebookPrivacy') continue;
    out[k]=redactLorebookExportPayload(v,depth+1,stats).value;
  }
  if(privacy) out._inspectorLorebookPrivacy=privacy;
  return {value:out,stats};
}
function sanitizeForExport(value, depth = 0) {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value == null || ['number','boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return redactExportString(value);
  if (Array.isArray(value)) return value.map(v => sanitizeForExport(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k,v] of Object.entries(value)) out[k] = isSecretKey(k) ? '[REDACTED]' : sanitizeForExport(v, depth + 1);
    return out;
  }
  return String(value);
}
function exportDomTextMeta(value) {
  const text=String(value??'');
  return text ? { chars:text.length, fingerprint:exportFingerprintValue(text) } : null;
}
function sanitizeLegacyDomMutationForExport(event) {
  if (!event || event.type!=='dom' || event.subtype!=='mutation-batch') return event;
  const safe={...event};
  const scrubDesc=d=>{
    if(!d||typeof d!=='object')return d;
    const out={...d};
    if(typeof out.text==='string'){out.textMeta=exportDomTextMeta(out.text);delete out.text;}
    return out;
  };
  safe.changes=(safe.changes||[]).map(ch=>{
    if(!ch||typeof ch!=='object')return ch;
    const out={...ch,target:scrubDesc(ch.target),added:(ch.added||[]).map(scrubDesc),removed:(ch.removed||[]).map(scrubDesc)};
    if(typeof out.oldText==='string'){out.oldTextMeta=exportDomTextMeta(out.oldText);delete out.oldText;}
    if(typeof out.newText==='string'){out.newTextMeta=exportDomTextMeta(out.newText);delete out.newText;}
    if(out.kind==='characterData'){
      if(typeof out.oldValue==='string'){out.oldTextMeta=exportDomTextMeta(out.oldValue);delete out.oldValue;}
      if(typeof out.newValue==='string'){out.newTextMeta=exportDomTextMeta(out.newValue);delete out.newValue;}
    }
    if(typeof out.pattern==='string' && /(?:children|text)\s+["']/.test(out.pattern)) out.pattern=`${out.kind||'mutation'}:${out.target?.node||'node'} text changed`;
    return out;
  });
  if(safe.stats?.topPatterns) safe.stats={...safe.stats,topPatterns:safe.stats.topPatterns.map(x=>({...x,value:typeof x?.value==='string'&&/(?:children|text)\s+["']/.test(x.value)?'DOM text changed':x.value}))};
  return safe;
}
function exportPrivateMeta(value, kind = 'private-payload') {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch (_) { text = String(value ?? ''); }
  const out = { redacted:true, kind, chars:text.length, fingerprint:exportFingerprintValue(value) };
  if (Array.isArray(value)) out.count = value.length;
  else if (value && typeof value === 'object') out.keys = Object.keys(value).slice(0,80);
  return out;
}
function parseExportPrivacyBody(value) {
  if (typeof value !== 'string') return { value, parseFailed:false };
  try { return { value:JSON.parse(value), parseFailed:false }; }
  catch (_) { return { value, parseFailed:true }; }
}
function exportPick(obj, keys) {
  const out={}; if(!obj||typeof obj!=='object') return out;
  for(const key of keys) if(obj[key]!==undefined) out[key]=obj[key];
  return out;
}
function exportSafeInferenceSettings(value) {
  if(!value||typeof value!=='object') return null;
  return exportPick(value,['max_new_tokens','temperature','top_p','top_k','min_p','repetition_penalty','frequency_penalty','presence_penalty']);
}
function sanitizeChatRequestForExport(value) {
  const parsed=parseExportPrivacyBody(value);
  if(parsed.parseFailed||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value)) return exportPrivateMeta(value,'chat-request');
  const v=parsed.value;
  const out=exportPick(v,['conversation_id','character_id','user_persona_id','language','inference_model','autopilot','continue_chat','alt_message_id']);
  out.inference_settings=exportSafeInferenceSettings(v.inference_settings);
  if(v.message!==undefined) out.message=exportPrivateMeta(v.message,'chat-user-message');
  if(v.prompt!==undefined) out.prompt=exportPrivateMeta(v.prompt,'chat-prompt');
  if(v.messages!==undefined) out.messages=exportPrivateMeta(v.messages,'chat-message-history');
  out._inspectorPrivacy={redacted:true,policy:'chat-request-metadata-only'};
  return out;
}
function sanitizeChatResponseForExport(value) {
  const parsed=parseExportPrivacyBody(value);
  if(parsed.parseFailed||!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value)) return exportPrivateMeta(value,'chat-response');
  const v=parsed.value,out=exportPick(v,['engine','provider','capped_message_id','finish_reason','model']);
  const m=v.message;
  if(m&&typeof m==='object'&&!Array.isArray(m)){
    out.message=exportPick(m,['conversation_id','character_id','role','id','prev_id','createdAt','updatedAt','is_nsfw','moderation_status']);
    if(m.content!==undefined) out.message.content=exportPrivateMeta(m.content,'chat-generated-content');
  } else if(m!==undefined) out.message=exportPrivateMeta(m,'chat-generated-content');
  if(v.content!==undefined) out.content=exportPrivateMeta(v.content,'chat-generated-content');
  out._inspectorPrivacy={redacted:true,policy:'chat-response-metadata-only'};
  return out;
}
function sanitizeMessageRecordForExport(m) {
  if(!m||typeof m!=='object'||Array.isArray(m)) return exportPrivateMeta(m,'message');
  const out=exportPick(m,['conversation_id','character_id','role','id','prev_id','createdAt','updatedAt','is_nsfw','moderation_status']);
  if(m.content!==undefined) out.content=exportPrivateMeta(m.content,'message-content');
  return out;
}
function sanitizePersonaRecordForExport(p) {
  if(!p||typeof p!=='object'||Array.isArray(p)) return exportPrivateMeta(p,'persona');
  const out=exportPick(p,['id','avatar_url','createdAt','updatedAt']);
  if(p.name!==undefined) out.name=exportPrivateMeta(p.name,'persona-name');
  if(p.highlights!==undefined) out.highlights=exportPrivateMeta(p.highlights,'persona-highlights');
  if(p.description!==undefined) out.description=exportPrivateMeta(p.description,'persona-description');
  out._inspectorPrivacy={redacted:true,policy:'persona-metadata-only'};
  return out;
}
function sanitizeHistoryForExport(value) {
  const parsed=parseExportPrivacyBody(value),v=parsed.value;
  if(parsed.parseFailed||!v||typeof v!=='object') return exportPrivateMeta(value,'conversation-history');
  if(Array.isArray(v)) return {messages:v.map(sanitizeMessageRecordForExport),count:v.length,_inspectorPrivacy:{redacted:true,policy:'message-history-metadata-only'}};
  const out=exportPick(v,['conversation_id','num_messages','createdAt','updatedAt','next_id','last_id']);
  if(v.label!==undefined) out.label=exportPrivateMeta(v.label,'conversation-label');
  if(v.userPersona!==undefined) out.userPersona=sanitizePersonaRecordForExport(v.userPersona);
  if(Array.isArray(v.messages)) out.messages=v.messages.map(sanitizeMessageRecordForExport);
  else if(v.messages!==undefined) out.messages=exportPrivateMeta(v.messages,'conversation-messages');
  out._inspectorPrivacy={redacted:true,policy:'message-history-metadata-only'};
  return out;
}
function sanitizePersonaForExport(value) {
  const parsed=parseExportPrivacyBody(value);
  if(parsed.parseFailed) return exportPrivateMeta(value,'persona-payload');
  return Array.isArray(parsed.value)?parsed.value.map(sanitizePersonaRecordForExport):sanitizePersonaRecordForExport(parsed.value);
}
function sanitizeUserForExport(value) {
  const parsed=parseExportPrivacyBody(value),root=parsed.value;
  if(parsed.parseFailed||!root||typeof root!=='object') return exportPrivateMeta(value,'user-profile');
  const user=root.user&&typeof root.user==='object'?root.user:root;
  const safeUser=exportPick(user,['id','application_id','default_persona_id','age_verification','subscription']);
  for(const key of ['name','username','email','avatar_url','highlights']) if(user[key]!==undefined) safeUser[key]=exportPrivateMeta(user[key],`user-${key}`);
  safeUser._inspectorPrivacy={redacted:true,policy:'user-profile-metadata-only'};
  return root.user&&typeof root.user==='object'?{user:safeUser}:safeUser;
}
function sanitizeSettingsForExport(value) {
  const parsed=parseExportPrivacyBody(value),v=parsed.value;
  if(parsed.parseFailed||!v||typeof v!=='object'||Array.isArray(v)) return exportPrivateMeta(value,'user-settings');
  const out=exportPick(v,['version','show_nsfw','auto_response_enabled','tts_include_narration']);
  if(v.selected_languages!==undefined) out.selected_languages=exportPrivateMeta(v.selected_languages,'selected-languages');
  if(v.selected_tags!==undefined) out.selected_tags=exportPrivateMeta(v.selected_tags,'selected-tags');
  if(v.liked_bots!==undefined) out.liked_bots={redacted:true,kind:'liked-bots',count:Array.isArray(v.liked_bots)?v.liked_bots.length:null,fingerprint:exportFingerprintValue(v.liked_bots)};
  if(v.userId!==undefined) out.userId=exportPrivateMeta(v.userId,'user-id');
  out._inspectorPrivacy={redacted:true,policy:'user-settings-metadata-only',keyCount:Object.keys(v).length};
  return out;
}
const EXPORT_CHARACTER_PRIVATE_FIELD_RE=/^(?:greeting|definition|description|scenario|personality|prompt|system_prompt|post_history_instructions|example_dialogue|mes_example|first_mes|chatText|messageText|messages|content)$/i;
function sanitizeCharacterForExport(value,depth=0){
  if(depth>12||value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return redactExportString(value);
  if(Array.isArray(value))return value.slice(0,1000).map(v=>sanitizeCharacterForExport(v,depth+1));
  if(typeof value!=='object')return String(value);
  const out={};
  for(const [k,v] of Object.entries(value).slice(0,1500)){
    if(isSecretKey(k))out[k]='[REDACTED]';
    else if(EXPORT_CHARACTER_PRIVATE_FIELD_RE.test(k))out[k]=exportPrivateMeta(v,`character-${String(k).toLowerCase()}`);
    else if(/^(?:email|highlights)$/i.test(k))out[k]=exportPrivateMeta(v,`private-${String(k).toLowerCase()}`);
    else out[k]=sanitizeCharacterForExport(v,depth+1);
  }
  return out;
}
function sanitizeErrorForExport(value){
  const parsed=parseExportPrivacyBody(value),v=parsed.value;
  if(parsed.parseFailed||!v||typeof v!=='object'||Array.isArray(v))return exportPrivateMeta(value,'error-body');
  const out={};
  for(const key of ['errorCode','code','status','statusCode','type'])if(v[key]!==undefined)out[key]=v[key];
  if(typeof v.message==='string')out.message=redactExportString(v.message).slice(0,500);
  else if(typeof v.error==='string')out.error=redactExportString(v.error).slice(0,500);
  else if(v.error&&typeof v.error==='object')out.error=sanitizeCharacterForExport(v.error);
  out._inspectorPrivacy={redacted:true,policy:'error-fields-only'};
  return out;
}
function exportNetworkPath(url){try{return new URL(String(url)).pathname||'';}catch(_){return String(url||'');}}
function exportIsCoreHost(url){try{const h=new URL(String(url)).hostname.toLowerCase();return h==='spicychat.ai'||h.endsWith('.spicychat.ai')||h==='nd-api.com'||h.endsWith('.nd-api.com');}catch(_){return false;}}
function isRulebookApiExportUrl(url){return /^\/(?:api\/)?(?:v\d+\/)?rulebooks?(?:\/|$)/i.test(exportNetworkPath(url))&&exportIsCoreHost(url);}
const EXPORT_GENERIC_NETWORK_PRIVATE_KEY_RE=/(?:email|e[_-]?mail|phone|highlights|persona(?:text|description)|full[_-]?text|raw[_-]?body)/i;
function scrubGenericNetworkPrivateFieldsForExport(value,depth=0){
  if(depth>12||value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return redactExportString(value);
  if(Array.isArray(value))return value.slice(0,1000).map(v=>scrubGenericNetworkPrivateFieldsForExport(v,depth+1));
  if(typeof value!=='object')return String(value);
  const out={};
  for(const [k,v] of Object.entries(value).slice(0,1500)){
    if(isSecretKey(k))out[k]='[REDACTED]';
    else if(EXPORT_GENERIC_NETWORK_PRIVATE_KEY_RE.test(k))out[k]=exportPrivateMeta(v,`private-${String(k).toLowerCase()}`);
    else out[k]=scrubGenericNetworkPrivateFieldsForExport(v,depth+1);
  }
  return out;
}
const EXPORT_PRIVATE_RECORD_PASSTHROUGH = new Set([
  'id','character_id','creator_user_id','conversation_id','user_persona_id',
  'last_message_id','prev_id','next_id','application_id','request_id',
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
function sanitizePrivateRecordForExport(value, kind = 'authoring', depth = 0) {
  if (depth > 12) return exportPrivateMeta(value, `${kind}-depth-limit`);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return exportPrivateMeta(value, kind);
  if (Array.isArray(value)) {
    if (value.length && value.every(v => v == null || typeof v !== 'object')) return exportPrivateMeta(value, `${kind}-values`);
    const items = value.slice(0, 1500).map(v => sanitizePrivateRecordForExport(v, kind, depth + 1));
    return value.length > items.length ? { count:value.length, items, truncated:true } : items;
  }
  if (typeof value !== 'object') return exportPrivateMeta(value, kind);
  if (value.redacted === true && Object.keys(value).every(k => ['redacted','kind','chars','fingerprint','count','keys'].includes(k))) return value;
  const out = {};
  for (const [key, v] of Object.entries(value).slice(0, 1600)) {
    if (isSecretKey(key)) { out[key] = '[REDACTED]'; continue; }
    if (EXPORT_PRIVATE_RECORD_PASSTHROUGH.has(key)) {
      // Only preserve primitive identifiers/numbers/enums. A forged object under a
      // normally harmless key must not become a bypass.
      out[key] = (v == null || typeof v === 'number' || typeof v === 'boolean') ? v
        : (typeof v === 'string' && v.length <= 180 ? redactExportString(v) : exportPrivateMeta(v, `${kind}-${key}`));
    } else if (v && typeof v === 'object' && !Array.isArray(v) && v.redacted === true && Object.keys(v).every(x => ['redacted','kind','chars','fingerprint','count','keys'].includes(x))) {
      out[key] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = sanitizePrivateRecordForExport(v, `${kind}-${key}`, depth + 1);
    } else if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) {
      out[key] = sanitizePrivateRecordForExport(v, `${kind}-${key}`, depth + 1);
    } else {
      out[key] = exportPrivateMeta(v, `${kind}-${key}`);
    }
  }
  return out;
}
function sanitizePrivateApiBodyForExport(value, kind) {
  const parsed = parseExportPrivacyBody(value);
  if (parsed.parseFailed) return exportPrivateMeta(value, kind);
  return sanitizePrivateRecordForExport(parsed.value, kind);
}

function sanitizeNetworkPayloadForExport(value,{url,role,status}){
  if(value==null)return value;
  const path=exportNetworkPath(url);
  if(isRulebookApiExportUrl(url))return sanitizePrivateApiBodyForExport(value,'rulebook');
  if(role==='response'&&Number(status)>=400)return sanitizeErrorForExport(value);
  if(/(?:^|\/)chat\/?$/i.test(path))return role==='request'?sanitizeChatRequestForExport(value):sanitizeChatResponseForExport(value);
  if(/\/characters\/[^/]+\/messages(?:\/[^/?]+)?\/?$/i.test(path))return sanitizeHistoryForExport(value);
  if(/\/personas(?:\/|$)/i.test(path))return sanitizePersonaForExport(value);
  if(/\/v2\/users\/?$/i.test(path))return sanitizeUserForExport(value);
  if(/\/users\/settings\/?$/i.test(path))return sanitizeSettingsForExport(value);
  if(/\/(?:v2\/)?(?:users\/)?characters(?:\/|$)/i.test(path)||/\/characters\/suggest_tags\/?$/i.test(path))return sanitizePrivateApiBodyForExport(value,'character-authoring');
  if(/\/v2\/conversations(?:\/|$)/i.test(path))return sanitizePrivateApiBodyForExport(value,'conversation-preview');
  if(/\/save-image\/?$/i.test(path))return exportPrivateMeta(value,'image-upload');
  if(!exportIsCoreHost(url)&&!/\/spicychat-prod\/ratings\/?$/i.test(path))return exportPrivateMeta(value,role==='request'?'third-party-request':'third-party-response');
  return scrubGenericNetworkPrivateFieldsForExport(value);
}
function applyNetworkExportPrivacy(event){
  if(!event||event.type!=='network')return event;
  const safe={...event},url=exportLorebookUrl(safe),subtype=String(safe.subtype||'');
  if(isLorebookApiExportUrl(url)){
    for(const field of ['body','requestBody']){
      if(safe[field]==null)continue;
      let body=safe[field];
      if(typeof body==='string'){try{body=JSON.parse(body);}catch(_){safe[field]={__redacted_lorebook_body__:true,chars:body.length,fingerprint:exportFingerprintValue(body)};continue;}}
      if(body&&typeof body==='object')safe[field]=redactLorebookExportPayload(body,0,{contentFields:0,keywordFields:0}).value;
    }
    safe.lorebookPrivacy={...(safe.lorebookPrivacy||{}),redacted:true,policy:'metadata-structure-only'};
    return safe;
  }
  if(isRulebookApiExportUrl(url)) {
    if(safe.requestBody!=null)safe.requestBody=sanitizePrivateApiBodyForExport(safe.requestBody,'rulebook');
    if(safe.body!=null)safe.body=sanitizePrivateApiBodyForExport(safe.body,'rulebook');
    // Older recordings can contain extracted signals derived from rule text.
    if(Array.isArray(safe.signals))safe.signals=[];
    safe.rulebookPrivacy={redacted:true,policy:'authored-text-metadata-only'};
    return safe;
  }
  if(safe.requestBody!=null)safe.requestBody=sanitizeNetworkPayloadForExport(safe.requestBody,{url,role:'request',status:safe.status});
  if(safe.body!=null){const role=/(?:request|incomplete)$/.test(subtype)&&!/response$/.test(subtype)?'request':'response';safe.body=sanitizeNetworkPayloadForExport(safe.body,{url,role,status:safe.status});}
  return safe;
}

function sanitizeEventForExport(event) {
  const safe = sanitizeLegacyDomMutationForExport(sanitizeForExport(event));
  return applyNetworkExportPrivacy(safe);
}


const DB_NAME = 'spicychat-inspector', STORE = 'events';
function openLocalDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open Inspector database.'));
  });
}
async function exportJson() {
  const button = $('#export');
  const original = button.textContent;
  button.disabled = true;
  try {
    const db = await openLocalDb();
    const total = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
    const version = chrome.runtime.getManifest().version;
    const fullCaptureVersions = await scanFullCaptureVersionSummary(db, total, button);
    const recentSampleSummary = buildSummary(sanitizeForExport(allEvents));
    const meta = {
      exportedAt: new Date().toISOString(), extension: 'SpicyChat Inspector', version,
      storedEvents: total,
      note: 'Defense-in-depth sanitization is applied at capture/storage and again during export. Sensitive network payloads are metadata-only by default: chat text/history, persona text, account/profile fields, character-authoring text, Rulebook instructions/descriptions/labels, image uploads, third-party payloads, and Lorebook entry content/keywords are redacted while diagnostic counts/IDs/status/model fields and fingerprints are retained where useful. Confirmed first-message render timing excludes unverified DOM signals. Export reads IndexedDB directly and uses gzip when supported. DOM batches retain aggregate counts but only a compact representative sample. Attribution is evidence-based.',
      summaryScope: 'full capture compact projection', loadedSampleEvents: allEvents.length,
      networkPrivacyPolicy: { chatText:'redacted', conversationHistory:'metadata-only', personaText:'metadata-only', accountProfile:'metadata-only', characterAuthoringText:'metadata-only', rulebookAuthoredText:'metadata-only', lorebookEntryContent:'redacted', lorebookEntryKeywords:'redacted', imageUploads:'metadata-only', thirdPartyBodies:'metadata-only', retainedDiagnostics:['IDs where useful','status/error codes','model/inference settings','NSFW flags','timestamps','lengths/counts','fnv1a32 fingerprints'] },
      lorebookPrivacyPolicy: { entryContent: 'redacted', entryKeywords: 'redacted', retainedDiagnostics: ['IDs','names','versions','timestamps','lengths/counts','fnv1a32 fingerprints'], scope: 'SpicyChat /lorebooks API request/response bodies' },
      summary: fullCaptureVersions.summary,
      diagnosticConsistencyWarnings: fullCaptureVersions.summary?.diagnosticConsistencyWarnings || [],
      recentSampleSummary,
      fullCaptureVersions
    };
    const parts = ['{"meta":', JSON.stringify(meta), ',"events":['];
    let exported = 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const source = store.indexNames.contains('ts') ? store.index('ts') : store;
      const req = source.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const safe = sanitizeEventForExport(cursor.value);
        parts.push(exported ? ',' : '', JSON.stringify(safe));
        exported++;
        if (exported % 500 === 0 || exported === total) button.textContent = `Exporting ${exported.toLocaleString()} / ${total.toLocaleString()}…`;
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    parts.push(']}');
    db.close();
    button.textContent = 'Building file…';
    const rawBlob = new Blob(parts, { type: 'application/json' });
    let blob = rawBlob;
    let ext = '.json';
    if (typeof CompressionStream === 'function') {
      button.textContent = 'Compressing export…';
      const compressed = rawBlob.stream().pipeThrough(new CompressionStream('gzip'));
      blob = await new Response(compressed).blob();
      ext = '.json.gz';
    }
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `spicychat-inspector-${new Date().toISOString().replace(/[:.]/g,'-')}${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    console.error('Inspector export failed', err);
    alert(`Export failed: ${err?.message || err}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

const versionEl = $('#version'); if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
$('#refresh').onclick = () => refresh(true); $('#export').onclick = exportJson;
$('#clear').onclick = async () => {
  if (!confirm('Clear all captured inspector events?')) return;
  await msg({ type: 'SCI_CLEAR_EVENTS' });
  selectedId = null;
  const detail = $('#detail');
  detail.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'Select an event to inspect it.';
  detail.appendChild(empty);
  await refresh(true);
};
$('#search').oninput = applyFilters; $('#typeFilter').onchange = applyFilters; $('#interestingOnly').onchange = applyFilters;
refresh(true); setInterval(() => { if (!document.hidden) refresh(false); }, 10000);
