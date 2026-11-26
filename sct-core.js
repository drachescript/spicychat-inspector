/* SCT v1: strict metadata projection shared by isolated capture, worker and export.
   No network transport, page credentials, or raw authoring content. */
(function (root) {
  'use strict';
  const PROTOCOL = 'sct.community.v1';
  const MODES = ['disabled','health','editor','publication','errors','full'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EXT_ID = /^[a-p]{32}$/;
  const TYPES = ['lorebook','lorebook-entry','chatbot','rulebook','group'];
  const CORRELATION = ['projectId','releaseId','publicationJobId','operationId','internalCreationId','nativeCreationId','internalEntryId','nativeEntryId'];
  const ACTIONS = ['create','edit','delete','save','publish','unpublish','visibility','attach','detach','import','export','read','unknown'];
  const PHASES = ['start','attempt','submission','response','verification','failure','interruption','recovery','completion','observation'];
  const OUTCOMES = ['http-success','http-error','rate-limited','network-error','validation-failed','pending','readback-match','readback-mismatch','native-ui-observed','journal-reported','manual-check','reported-success','reported-failure','unknown'];
  const REASONS = ['watchdog','form-changed','keyword-changed','validation','rate-limit','navigation','freeze','reload','background','cancelled','timeout','unavailable','unknown'];
  const EVENTS = ['health','navigation','visibility','performance','editor-action','editor-state','validation','network','import-state','operation','error'];
  const SOURCES = ['page-bridge-untrusted','isolated-dom-observation','browser-lifecycle-observation','browser-performance-observation','qol-page-untrusted','local-operator','authorized-extension'];
  const ROUTES = ['lorebook-editor','lorebook-list','chatbot-editor','chatbot-list','rulebook-editor','rulebook-list','group-editor','group-list','other'];
  const HEALTH = ['attached','page-show','page-hide','freeze','resume','online','offline','route-enter','route-leave','route-change','expired','bridge-ready','coverage'];
  const N = (v, max = 1e12) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  const I = (v, max = 1e12) => Number.isSafeInteger(v) && v >= 0 && v <= max ? v : undefined;
  const B = v => typeof v === 'boolean' ? v : undefined;
  const E = (v, list) => typeof v === 'string' && list.includes(v) ? v : undefined;
  const id = v => typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
  const version = v => typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) ? v : undefined;
  const requestId = v => typeof v === 'string' && /^[fx]-[a-z0-9]{5,16}-\d{1,10}$/.test(v) ? v : undefined;
  const compact = v => Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined));
  function correlation(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const k of CORRELATION) { const v=id(raw[k]); if(v) out[k]=v; }
    const type = E(raw.creationType,TYPES); if(type) out.creationType=type;
    return out;
  }
  function route(path) {
    if (typeof path !== 'string' || path.length > 512) return {category:'other'};
    const p=path.replace(/^\/[a-z]{2}(?=\/)/i,'').split('/').filter(Boolean);
    if(p[0]==='my-creations' && p.length===2) {
      const type=({chatbots:'chatbot',lorebooks:'lorebook',rulebooks:'rulebook',groups:'group'})[p[1]];
      if(type) return {category:type+'-list',creationType:type};
    }
    const type=E(p[0],['lorebook','chatbot','rulebook','group']);
    if(type && ['create','edit','new'].includes(p[1]) && p.length<=4 && (!p[2]||id(p[2])) && (!p[3]||['entries','edit','settings'].includes(p[3]))) return compact({category:type+'-editor',creationType:type,nativeCreationId:id(p[2])});
    if(p[0]==='create' && E(p[1],['lorebook','chatbot','rulebook','group']) && p.length===2) return {category:p[1]+'-editor',creationType:p[1]};
    return {category:'other'};
  }
  function endpoint(url, method) {
    if(typeof url!=='string'||url.length>2048) return null;
    let u;try{u=new URL(url);}catch(_){return null;}
    if(u.protocol!=='https:'||u.port||u.username||u.password||!['prod.nd-api.com','spicychat.ai','api.spicychat.ai'].includes(u.hostname))return null;
    method=E(String(method||'').toUpperCase(),['GET','POST','PUT','PATCH','DELETE']);if(!method)return null;
    const p=u.pathname.replace(/^\/v\d+\//,'/').split('/').filter(Boolean);
    const type=({lorebooks:'lorebook',characters:'chatbot',rulebooks:'rulebook',groups:'group'})[p[0]];
    if(!type||p.length>4||p[1]&&!id(p[1]))return null;
    let kind=type, target='creation', nativeCreationId=id(p[1]),nativeEntryId,relatedNativeId;
    if(p.length>=3){
      if(type==='lorebook'&&p[2]==='entries'&&(!p[3]||id(p[3]))){kind='lorebook-entry';target='entries';nativeEntryId=id(p[3]);}
      else if(['publish','unpublish','visibility','moderation','attachments','characters','lorebooks','rulebooks','groups'].includes(p[2])&&(!p[3]||id(p[3]))){target=p[2];relatedNativeId=id(p[3]);}
      else return null;
    }
    if(method==='GET'&&!nativeCreationId)return null; // no personal listing reads
    let action=method==='GET'?'read':method==='DELETE'?'delete':method==='POST'?'create':'edit';
    if(['publish','unpublish','visibility'].includes(target)&&method!=='GET')action=target;
    if(['attachments','characters','lorebooks','rulebooks','groups'].includes(target)&&method!=='GET')action=method==='DELETE'?'detach':'attach';
    return compact({creationType:kind,nativeCreationId,nativeEntryId,relatedNativeId,endpoint:`${type}/${target}${nativeEntryId?'/:entry':''}`,method,action});
  }
  const ENDPOINT_RE=/^(?:lorebook|chatbot|rulebook|group)\/(?:creation|entries|publish|unpublish|visibility|moderation|attachments|characters|lorebooks|rulebooks|groups)(?:\/:entry)?$/;
  function headers(raw) {
    const out={}; if(!raw||typeof raw!=='object')return out;
    for(const k of ['retry-after','ratelimit-limit','ratelimit-remaining','ratelimit-reset','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset']){
      const v=raw[k]; if(typeof v==='number'&&I(v)!==undefined)out[k]=v;
      else if(typeof v==='string'&&/^\d{1,12}$/.test(v))out[k]=Number(v);
    }return out;
  }
  function counts(raw) {if(!raw||typeof raw!=='object')return undefined;const out={};for(const k of ['processed','total','created','skipped','remaining','expected','observed','retries','resumes','entries']){const v=I(raw[k],1000000);if(v!==undefined)out[k]=v;}return Object.keys(out).length?out:undefined;}
  function network(raw) {
    if(!raw||raw.type!=='network'||!['xhr-request','fetch-request','xhr-response','fetch-response','fetch-error','xhr-error','network-incomplete'].includes(raw.subtype))return null;
    const ep=endpoint(raw.requestedUrl||raw.url,raw.method);if(!ep)return null;
    const submission=raw.subtype.endsWith('request');const status=I(raw.status,599);
    const body=raw.body&&typeof raw.body==='object'&&!Array.isArray(raw.body)?raw.body:null;
    const record=body?.lorebook||body?.character||body?.rulebook||body?.group||body?.entry||body;
    const nativeResponseId=id(record?.id);
    const c=counts({entries:record?.num_entries,observed:Array.isArray(record?.entries)?record.entries.length:undefined});
    const errorCode=typeof body?.code==='string'&&/^SC-\d{3}-\d{4}$/.test(body.code)?body.code:typeof body?.error_code==='string'&&/^SC-\d{3}-\d{4}$/.test(body.error_code)?body.error_code:undefined;
    const failure=raw.subtype.endsWith('error')||raw.subtype==='network-incomplete'||status===0||status>=400;
    return compact({kind:'network',source:'page-bridge-untrusted',...ep,phase:submission?'submission':failure?'failure':'response',requestId:requestId(raw.requestId),status,durationMs:N(raw.durationMs,86400000),outcome:submission?undefined:status===429?'rate-limited':status===0||raw.subtype.endsWith('error')?'network-error':status>=400?'http-error':status>=200&&status<300?'http-success':'unknown',nativeResponseId,visibility:E(record?.visibility,['public','private','unlisted','draft']),publicationStatus:E(record?.publication_status||record?.moderation_status,['draft','pending','approved','rejected','published','unpublished','under-review']),counts:c,errorCode,rateHeaders:submission?undefined:headers(raw.headers),aborted:B(raw.aborted)});
  }
  function safeEvent(raw, sourceOverride) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const kind=E(raw.kind,EVENTS),source=E(sourceOverride||raw.source,SOURCES);if(!kind||!source)return null;
    const out=compact({kind,source,phase:E(raw.phase,PHASES),action:E(raw.action,ACTIONS),creationType:E(raw.creationType,TYPES),route:E(raw.route,ROUTES),health:E(raw.health,HEALTH),outcome:E(raw.outcome,OUTCOMES),reason:E(raw.reason,REASONS),nativeCreationId:id(raw.nativeCreationId),nativeEntryId:id(raw.nativeEntryId),nativeResponseId:id(raw.nativeResponseId),relatedNativeId:id(raw.relatedNativeId),visibility:E(raw.visibility,['public','private','unlisted','draft']),publicationStatus:E(raw.publicationStatus,['draft','pending','approved','rejected','published','unpublished','under-review']),requestId:requestId(raw.requestId),endpoint:typeof raw.endpoint==='string'&&ENDPOINT_RE.test(raw.endpoint)?raw.endpoint:undefined,method:E(raw.method,['GET','POST','PUT','PATCH','DELETE']),status:I(raw.status,599),durationMs:N(raw.durationMs,86400000),errorKind:E(raw.errorKind,['script-error','unhandled-rejection','bridge-load-failure']),errorCode:typeof raw.errorCode==='string'&&/^SC-\d{3}-\d{4}$/.test(raw.errorCode)?raw.errorCode:undefined,rateHeaders:raw.rateHeaders?headers(raw.rateHeaders):undefined,counts:counts(raw.counts),aborted:B(raw.aborted),hidden:B(raw.hidden),trustedClick:B(raw.trustedClick),savePresent:B(raw.savePresent),saveEnabled:B(raw.saveEnabled),formPresent:B(raw.formPresent),validationIndicator:B(raw.validationIndicator),qolHiddenPaused:B(raw.qolHiddenPaused),pendingWrite:B(raw.pendingWrite),previousConfirmed:B(raw.previousConfirmed),wasDiscarded:B(raw.wasDiscarded),persisted:B(raw.persisted),qolVersion:version(raw.qolVersion),importPhase:E(raw.importPhase,['running','completed','interrupted','paused','preparing','cancelled','unknown']),performanceType:E(raw.performanceType,['long-task','long-animation-frame']),dropped:I(raw.dropped,1000000),unconfirmed:I(raw.unconfirmed,1000000)});
    // Correlation is never copied from page/DOM telemetry. Only authorized sender
    // or local UI, and recording metadata written by the worker, can supply it.
    if(source==='authorized-extension'||source==='local-operator'){out.correlation=correlation(raw.correlation);if(!out.creationType)out.creationType=out.correlation.creationType;}
    if(kind==='network'&&(!out.endpoint||!out.method||!['submission','response','failure'].includes(out.phase)))return null;
    if(kind==='operation'&&(!['authorized-extension','local-operator'].includes(source)||!out.phase||!out.correlation?.operationId))return null;
    return out;
  }
  function active(config, now=Date.now()){return !!(config&&id(config.recordingId)&&MODES.includes(config.mode)&&config.mode!=='disabled'&&Number.isFinite(config.expiresAt)&&config.expiresAt>now);}
  function accepts(mode,event){
    if(!MODES.includes(mode)||mode==='disabled'||!event)return false;
    if(mode==='health')return ['health','navigation','visibility','performance','error'].includes(event.kind)&&(event.kind!=='performance'||event.durationMs>=1000);
    if(mode==='errors')return event.kind!=='editor-state'&&!(event.kind==='network'&&event.method==='GET'&&event.phase!=='failure')&&!(event.kind==='performance'&&event.durationMs<500);
    return true;
  }
  function config(raw,now=Date.now()) {
    const mode=E(raw?.mode,MODES.filter(x=>x!=='disabled'));if(!mode)throw Error('Choose a recording mode.');
    const durationHours=Math.max(0.25,Math.min(mode==='full'?1:168,N(raw.durationHours,168)|| (mode==='full'?0.5:24)));
    const maxEvents=Math.max(1000,Math.min(50000,I(raw.maxEvents,50000)||30000));
    const retentionDays=Math.max(1,Math.min(30,I(raw.retentionDays,30)||7));
    const scope=raw.scope==='all-editors'?'all-editors':'selected-tab';
    const tabId=I(raw.tabId,2147483647);if(scope==='selected-tab'&&tabId===undefined)throw Error('Select an editor tab.');
    const peerId=typeof raw.peerId==='string'&&EXT_ID.test(raw.peerId)?raw.peerId:undefined;
    if(raw.peerId&&!peerId)throw Error('Authorized peer must be a Chromium extension ID.');
    return compact({mode,scope,tabId:scope==='selected-tab'?tabId:undefined,peerId,recordingId:crypto.randomUUID(),startedAt:now,expiresAt:now+durationHours*3600000,maxEvents,retentionDays,correlation:correlation(raw.correlation),protocol:PROTOCOL,transfer:'disabled'});
  }
  function summarize(rows,recording){
    const kinds={},phases={},outcomes={},requests=new Map(),streams=new Map(),operations=new Map(),attemptQueues=new Map(),clickDelays=[];let attempts=0,matchedAttempts=0,ambiguousAttempts=0,repeatedAttemptCandidates=0;let expectedObservedMismatches=0,reportedVerification=0,missing=0,unmatchedResponses=0,duplicateSubmissions=0,operationOverflow=0,requestOverflow=0,bufferDrops=0,unconfirmed=0,longTasks=0,longTaskMs=0,first=null,last=null;
    for(const r of rows){const e=r.event||{};first=first===null?r.ts:Math.min(first,r.ts);last=last===null?r.ts:Math.max(last,r.ts);kinds[e.kind]=(kinds[e.kind]||0)+1;if(e.phase)phases[e.phase]=(phases[e.phase]||0)+1;if(e.outcome)outcomes[e.outcome]=(outcomes[e.outcome]||0)+1;
      const st=streams.get(r.streamId)||{min:r.sequence,max:r.sequence,count:0};st.min=Math.min(st.min,r.sequence);st.max=Math.max(st.max,r.sequence);st.count++;streams.set(r.streamId,st);
      if(e.counts?.expected!==undefined&&e.counts?.observed!==undefined&&e.counts.expected!==e.counts.observed)expectedObservedMismatches++;if(e.phase==='verification')reportedVerification++;bufferDrops+=e.dropped||0;unconfirmed+=e.unconfirmed||0;
      if(e.kind==='performance'){longTasks++;longTaskMs+=e.durationMs||0;}
      if(e.kind==='editor-action'&&e.phase==='attempt'&&['save','create','edit','delete','publish','unpublish','visibility','attach','detach'].includes(e.action)){
        attempts++;const key=r.streamId+'|'+(e.creationType==='lorebook-entry'?'lorebook':e.creationType||'unknown')+'|'+(e.nativeCreationId||'new');const list=(attemptQueues.get(key)||[]).filter(a=>r.ts-a.ts<=5000);if(list.some(a=>a.action===e.action&&r.ts-a.ts<=1000))repeatedAttemptCandidates++;list.push({ts:r.ts,action:e.action});attemptQueues.set(key,list.slice(-64));
      }
      if(e.kind==='network'&&e.phase==='submission'&&e.method!=='GET'){
        const key=r.streamId+'|'+(e.creationType==='lorebook-entry'?'lorebook':e.creationType||'unknown')+'|'+(e.nativeCreationId||'new');const list=(attemptQueues.get(key)||[]).filter(a=>r.ts>=a.ts&&r.ts-a.ts<=5000);const compatible=list.filter(a=>a.action===e.action||(a.action==='save'&&['create','edit'].includes(e.action)));if(compatible.length===1){matchedAttempts++;clickDelays.push(r.ts-compatible[0].ts);list.splice(list.indexOf(compatible[0]),1);}else if(compatible.length>1)ambiguousAttempts++;attemptQueues.set(key,list);
      }
      if(e.kind==='network'&&e.requestId){const k=r.streamId+'|'+e.requestId;let req=requests.get(k);if(!req){if(requests.size>=50000){requestOverflow++;continue;}req={submissions:0,responses:0,first:null,last:null,write:e.method!=='GET'};requests.set(k,req);}if(e.phase==='submission'){req.submissions++;req.first=req.first===null?r.ts:Math.min(req.first,r.ts);}else{req.responses++;req.last=req.last===null?r.ts:Math.max(req.last,r.ts);}}
      if(e.kind==='operation'&&e.correlation?.operationId){const k=e.correlation.operationId;let o=operations.get(k);if(!o){if(operations.size>=5000){operationOverflow++;continue;}o={operationId:k,firstAt:r.ts,lastAt:r.ts,phases:{},reportedVerification:0};operations.set(k,o);}o.firstAt=Math.min(o.firstAt,r.ts);o.lastAt=Math.max(o.lastAt,r.ts);o.phases[e.phase]=(o.phases[e.phase]||0)+1;if(e.phase==='verification')o.reportedVerification++;}
    }
    for(const st of streams.values())missing+=Math.max(0,st.max-st.min+1-st.count)+st.min;
    let unresolved=0,unresolvedWrites=0,maxUnresolvedWriteAgeMs=0;for(const r of requests.values()){if(r.submissions&&!r.responses){unresolved++;if(r.write){unresolvedWrites++;maxUnresolvedWriteAgeMs=Math.max(maxUnresolvedWriteAgeMs,(last||0)-(r.first||0));}}if(!r.submissions&&r.responses)unmatchedResponses++;duplicateSubmissions+=Math.max(0,r.submissions-1);}
    return {events:rows.length,firstObservedAt:first,lastObservedAt:last,kinds,phases,outcomes,streams:streams.size,missingSequencesWithinObservedStreams:missing,reportedBufferDrops:bufferDrops,reportedUnconfirmedDelivery:unconfirmed,retentionOrCapacityDrops:recording?.droppedCap||0,conflictingSequenceRows:recording?.conflicts||0,invalidEvents:recording?.invalid||0,duplicateRowsIgnored:recording?.duplicates||0,network:{requestKeys:requests.size,unresolved,unresolvedWrites,unmatchedResponses,maxUnresolvedWriteAgeAtLastObservationMs:maxUnresolvedWriteAgeMs,duplicateSubmissionObservations:duplicateSubmissions,overflow:requestOverflow},editorAttempts:{observed:attempts,matchedSubmissionCandidates:matchedAttempts,withoutUniqueSubmissionCandidate:attempts-matchedAttempts,ambiguousSubmissionCandidates:ambiguousAttempts,repeatedAttemptCandidates,medianClickToSubmissionMs:clickDelays.length?clickDelays.sort((a,b)=>a-b)[Math.floor(clickDelays.length/2)]:null,scope:'same stream, creation and compatible action within 5 seconds; candidates only, not verified causality'},performance:{longTasks,longTaskMs:Math.round(longTaskMs*10)/10},operationSpans:[...operations.values()].map(o=>({...o,observedSpanMs:o.lastAt-o.firstAt})),operationOverflow,completedOperationsWithoutReportedVerification:[...operations.values()].filter(o=>o.phases.completion&&!o.reportedVerification).length,expectedObservedMismatches,reportedVerification,coverage:'observed only; no proof of continuous recording, server persistence, or final publication. Verification markers are reports, not independent verification.'};
  }
  root.SCTCore=Object.freeze({PROTOCOL,MODES,EXT_ID,UUID,TYPES,CORRELATION,ACTIONS,PHASES,OUTCOMES,REASONS,EVENTS,ROUTES,SOURCES,HEALTH,N,I,B,E,id,version,compact,correlation,counts,route,endpoint,network,safeEvent,active,accepts,config,summarize});
})(globalThis);
