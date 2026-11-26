/* SCT worker entry points. Page observations and authorized peer markers are
   separate paths. No external website, publication command or backend transport. */
(function(root){'use strict';
 const C=root.SCTCore,S=root.SCTStore;let control=Promise.resolve(),lastCleanup=0;
 const fail=message=>({ok:false,error:message});
 const localUi=sender=>sender?.id===chrome.runtime.id&&typeof sender.url==='string'&&sender.url.split(/[?#]/,1)[0]===chrome.runtime.getURL('sct.html')&&!sender.tab?.incognito;
 function site(sender){if(sender?.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(sender.tab?.id)||sender.tab.incognito)return false;try{const u=new URL(sender.url);return u.protocol==='https:'&&!u.port&&u.hostname==='spicychat.ai';}catch(_){return false;}}
 async function current(){const r=(await getSettings()).sct;return C.active(r)?r:null;}
 async function cleanup(activeId){if(Date.now()-lastCleanup<3600000)return;await S.cleanup(activeId);lastCleanup=Date.now();}
 async function status(){const settings=await getSettings(),raw=settings.sct,active=C.active(raw)?raw:null;if(raw?.recordingId&&!active){await S.stop(raw.recordingId,'expired');}await cleanup(active?.recordingId);const recordings=await S.list();const tabs=await chrome.tabs.query({url:'https://spicychat.ai/*'});return {ok:true,protocol:C.PROTOCOL,version:chrome.runtime.getManifest().version,active,recordings:recordings.sort((a,b)=>b.startedAt-a.startedAt),tabs:tabs.filter(t=>!t.incognito&&Number.isInteger(t.id)).map(t=>{try{return {tabId:t.id,route:C.route(new URL(t.url).pathname).category};}catch(_){return null;}}).filter(t=>t&&t.route!=='other'),transfer:SCTTransport.status()};}
 function serialize(fn){const next=control.then(fn,fn);control=next.catch(()=>{});return next;}
 async function handle(message,sender){
  if(message.type==='SCT_ATTACH'){if(!site(sender))return fail('Not an eligible content script.');const r=await current();if(!r||message.recordingId!==r.recordingId||(r.scope==='selected-tab'&&r.tabId!==sender.tab.id))return {ok:true,allowed:false};await cleanup(r.recordingId);return {ok:true,allowed:true};}
  if(message.type==='SCT_BATCH'){if(!site(sender))return fail('Not an eligible content script.');const r=await current();if(!r||message.recordingId!==r.recordingId||(r.scope==='selected-tab'&&r.tabId!==sender.tab.id))return {ok:true,stored:0,notActive:true};if(!C.id(message.streamId)||!Array.isArray(message.items)||message.items.length>64)return fail('Invalid batch.');await cleanup(r.recordingId);const a=await S.append(r.recordingId,message.streamId,message.items,'page',sender.tab.id);return {ok:true,...a};}
  if(!localUi(sender))return fail('SCT controls are extension-page only.');
  if(message.type==='SCT_STATUS')return status();
  if(message.type==='SCT_START')return serialize(async()=>{if(await current())return fail('Stop the active SCT recording first.');const old=(await getSettings()).sct;if(old?.recordingId)await S.stop(old.recordingId,'expired');const r=C.config(message.config);if(r.scope==='selected-tab'){const t=await chrome.tabs.get(r.tabId);if(t.incognito||!t.url||new URL(t.url).origin!=='https://spicychat.ai'||C.route(new URL(t.url).pathname).category==='other')return fail('Select an eligible creation editor/list tab.');}await S.cleanup();await S.create(r);try{await setSettings({sct:r});}catch(e){await S.stop(r.recordingId,'interrupted');throw e;}return {ok:true,recording:r};});
  if(message.type==='SCT_STOP')return serialize(async()=>{const r=(await getSettings()).sct;if(r?.recordingId){let stopDelivery;if(C.active(r)){const all=await chrome.tabs.query({url:'https://spicychat.ai/*'});const tabs=all.filter(t=>!t.incognito&&(r.scope!=='selected-tab'||t.id===r.tabId));const replies=await Promise.all(tabs.slice(0,64).map(t=>{let timer;return Promise.race([chrome.tabs.sendMessage(t.id,{type:'SCT_FLUSH',recordingId:r.recordingId}).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2500);})]).finally(()=>clearTimeout(timer));}));stopDelivery={requested:tabs.length,acknowledged:replies.filter(a=>a?.ok).length,unconfirmed:tabs.length-replies.filter(a=>a?.ok).length,reportedBuffered:replies.reduce((n,a)=>n+(C.I(a?.remaining,1000000)||0),0),reportedUnconfirmed:replies.reduce((n,a)=>n+(C.I(a?.unconfirmed,1000000)||0),0),reportedDropped:replies.reduce((n,a)=>n+(C.I(a?.dropped,1000000)||0),0)};}await S.stop(r.recordingId,C.active(r)?'stopped':'expired',stopDelivery);await setSettings({sct:null});}return {ok:true};});
  if(message.type==='SCT_DELETE')return serialize(async()=>{const id=C.id(message.recordingId);if(!id)return fail('Invalid recording ID.');if((await current())?.recordingId===id)return fail('Stop the recording first.');return {ok:true,deleted:await S.remove(id)};});
  if(message.type==='SCT_OPERATOR_MARKER')return serialize(async()=>{const r=await current();if(!r)return fail('No active SCT recording.');const event=C.safeEvent({...message.event,kind:'operation',correlation:{...r.correlation,...message.event?.correlation}},'local-operator');if(!event||!C.accepts(r.mode,event))return fail('Invalid or excluded operation marker.');return {ok:true,...await S.append(r.recordingId,crypto.randomUUID(),[{sequence:0,ts:Date.now(),event}],'operator',r.tabId)};});
  return fail('Unknown SCT action.');
 }
 // Chromium extension identity is browser-provided, not a string in a page event.
 // Only an explicitly authorized peer may append a report to the selected
 // recording. No start/stop, no browsing, no data read or remote commands.
 async function external(message,sender){
  const r=await current();if(!r?.peerId||sender?.id!==r.peerId||sender.tab?.incognito||!['publication','editor','errors','full'].includes(r.mode))return fail('Unauthorized SCT peer.');
  const origin='chrome-extension://'+r.peerId;
  // A service-worker sender can omit URL/origin. Require a browser-provided
  // exact extension ID and no tab in that case; reject web-origin senders.
  if((sender.url&& !sender.url.startsWith(origin+'/'))||(sender.origin&&sender.origin!==origin)||(!sender.url&&!sender.origin&&sender.tab))return fail('Extension-origin sender required.');
  if(message?.protocol!==C.PROTOCOL)return fail('Protocol mismatch.');
  if(message.type==='SCT_GET_CONTEXT')return {ok:true,protocol:C.PROTOCOL,inspectorVersion:chrome.runtime.getManifest().version,recordingId:r.recordingId,mode:r.mode,scope:r.scope,tabId:r.tabId,expiresAt:r.expiresAt,correlation:r.correlation,transfer:'disabled'};
  if(message.recordingId!==r.recordingId)return fail('Recording mismatch.');
  if(message.type!=='SCT_OPERATION_EVENT'||!C.id(message.streamId)||C.I(message.sequence,100000000)===undefined||C.I(message.tabId,2147483647)===undefined)return fail('Invalid SCT event envelope.');
  if(r.scope==='selected-tab'&&message.tabId!==r.tabId)return fail('Tab scope mismatch.');
  let t;try{t=await chrome.tabs.get(message.tabId);if(t.incognito||new URL(t.url).origin!=='https://spicychat.ai')return fail('Ineligible tab.');}catch(_){return fail('Ineligible tab.');}
  const supplied=C.correlation(message.event?.correlation);
  for(const k of ['projectId','releaseId','publicationJobId','internalCreationId','nativeCreationId'])if(r.correlation?.[k]&&supplied[k]&&r.correlation[k]!==supplied[k])return fail('Correlation mismatch.');
  const e=C.safeEvent({...message.event,kind:'operation',correlation:{...r.correlation,...supplied}},'authorized-extension');if(!e||!C.accepts(r.mode,e))return fail('Invalid operation marker.');
  return {ok:true,...await S.append(r.recordingId,message.streamId,[{sequence:message.sequence,ts:message.observedAt,event:e}],'peer',message.tabId)};
 }
 root.SCTWorker=Object.freeze({handle,external});
 if(chrome.runtime.onMessageExternal)chrome.runtime.onMessageExternal.addListener((message,sender,respond)=>{if(message?.protocol!==C.PROTOCOL)return false;external(message,sender).then(respond,()=>respond(fail('SCT marker could not be persisted.')));return true;});
})(globalThis);
