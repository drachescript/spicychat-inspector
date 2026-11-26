// UI only: the installed manifest version is distinct from the live tab's
// source-stamped content-script version, checked on demand below.
const manifestVersion = chrome.runtime.getManifest().version;
document.querySelector('#version') && (document.querySelector('#version').textContent = `v${manifestVersion}`);
const $ = s => document.querySelector(s);
async function msg(data) { const res = await chrome.runtime.sendMessage(data); if (!res?.ok) throw new Error(res?.error || 'Request failed'); return res; }
function status(text, bad = false) { const el = $('#status'); el.textContent = text; el.className = `status ${bad ? 'bad' : ''}`; setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2800); }
async function refresh() {
  const { settings } = await msg({ type: 'SCI_GET_SETTINGS' });
  for (const key of ['recording','captureDom','capturePerformance','captureErrors','captureQolInternals']) if ($('#'+key)) $('#'+key).checked = !!settings[key];
  $('#recBadge').textContent = settings.recording ? 'REC' : 'PAUSED';
  $('#recBadge').className = `badge ${settings.recording ? 'on' : ''}`;
  const traceLevel = $('#qolTraceLevel');
  if (traceLevel) {
    traceLevel.value = settings.captureQolInternals && settings.qolTraceLevel === 'deep' ? 'deep' : 'normal';
    traceLevel.disabled = !settings.captureQolInternals;
  }
  if ($('#requestQolTrace')) $('#requestQolTrace').disabled = !settings.recording || !settings.captureQolInternals;
}
for (const key of ['recording','captureDom','capturePerformance','captureErrors','captureQolInternals']) {
  $('#'+key)?.addEventListener('change', async e => {
    const patch = { [key]: e.target.checked };
    // Normal is the desktop default as well: Deep must be selected separately.
    if (key === 'captureQolInternals') patch.qolTraceLevel = e.target.checked ? 'normal' : 'off';
    await msg({ type: 'SCI_SET_SETTINGS', patch });
    await refresh();
  });
}

$('#qolTraceLevel')?.addEventListener('change', async e => {
  if (!$('#captureQolInternals')?.checked) return;
  const selected = e.target.value === 'deep' ? 'deep' : 'normal';
  try {
    await msg({ type: 'SCI_SET_SETTINGS', patch: { qolTraceLevel: selected } });
    await refresh();
  } catch (error) { status(String(error?.message || error), true); }
});

// On-demand existing protocol request: no continuous polling or new observers.
$('#requestQolTrace')?.addEventListener('click', async () => {
  const button = $('#requestQolTrace');
  button.disabled = true;
  try {
    const response = await msg({ type: 'SCI_ACTIVE_COMMAND', command: 'request-qol-trace' });
    if (!response.result?.ok) throw new Error(response.result?.error || 'No responding SpicyChat Inspector content tab.');
    status('QoL trace requested. Check Inspector after using the affected tab.');
  } catch (error) {
    status(String(error?.message || error), true);
  } finally { await refresh().catch(() => { button.disabled = false; }); }
});

// Read-only active-tab check; no periodic polling and no extra page observer.
$('#checkQolConnection')?.addEventListener('click', async () => {
  const button = $('#checkQolConnection');
  button.disabled = true;
  try {
    const response = await msg({type:'SCI_ACTIVE_COMMAND',command:'qol-trace-status'});
    const info = response.result;
    if (!info?.ok) throw new Error(info?.error || 'Inspector could not reach the active SpicyChat tab.');
    if (!info.recording) status('Inspector recording is paused.');
    else if (!info.traceEnabled) status('QoL tracing is off; enable Detailed QoL internals for a targeted test.');
    else if (info.traceEventsSeen > 0) status(`QoL traces received: ${info.traceEventsSeen}. Level: ${info.traceLevel}.`);
    else if (info.handshakeResponses > 0) status('QoL connected; no individual traces yet. Normal mode may summarize short operations.');
    else status('No QoL handshake or operation trace observed in this tab yet.');
  } catch (error) { status(String(error?.message || error), true); }
  finally { button.disabled = false; }
});

// Read-only, on-demand check against the actual content script in the active tab.
$('#checkInspectorBuild')?.addEventListener('click', async () => {
  const button = $('#checkInspectorBuild');
  const result = $('#inspectorBuildResult');
  button.disabled = true;
  if (result) result.textContent = 'Checking the active tab…';
  try {
    const response = await msg({ type: 'SCI_ACTIVE_COMMAND', command: 'inspector-build-status' });
    const info = response?.result;
    if (!info?.ok) throw new Error(info?.error || 'Active tab has no responding Inspector content script.');
    const liveVersion = String(info.version || 'unknown');
    const liveBuild = String(info.contentBuildId || 'unavailable');
    const match = liveVersion === manifestVersion;
    const bridgeState = String(info.bridgeState || 'not-reported');
    const bridgeNote = bridgeState === 'ready' ? 'Page bridge responding' :
      bridgeState === 'waiting-document' ? 'Page bridge awaiting document; check after the page finishes loading' :
      bridgeState === 'script-loaded' || bridgeState === 'injected' ? 'Page bridge not confirmed yet; check again shortly' :
      bridgeState === 'not-injected' ? 'Page bridge not started (startup issue)' :
      bridgeState === 'runtime-unavailable' ? 'Page bridge cannot start: extension runtime unavailable' :
      bridgeState === 'no-handshake' ? 'Bridge file loaded but did not respond (possibly blocked or stale; refresh tab)' :
      bridgeState === 'no-load-confirmation' ? 'Bridge script load not confirmed (Orion/WebKit restriction possible)' :
      bridgeState === 'load-error' ? 'Bridge script load failed (Orion/WebKit restriction possible)' :
      `Page bridge: ${bridgeState} (recording may be incomplete)`;
    const startInfo = info.startupPhase === 'settings-error' ?
      ` · Settings unavailable: ${String(info.bootstrapError || 'unknown')}; recording paused` :
      info.startupPhase === 'waiting-settings' ? ' · Settings pending' :
      ` · Tab recording ${info.recording ? 'enabled' : 'paused'}` +
        (info.settingsSource ? ` (settings: ${String(info.settingsSource)})` : '');
    const deliveryInfo = Number(info.eventMessagesSent || 0) > 0 ?
      ` · Event delivery: ${Number(info.eventMessagesAcked || 0)}/${Number(info.eventMessagesSent || 0)} acknowledged` +
      (info.eventMessagesFailed ? `, ${Number(info.eventMessagesFailed)} failed` : '') :
      (info.recording ? ' · No event deliveries attempted yet' : '');
    // A valid message acknowledgement alone does not prove an event was saved.
    // These counters cover the core content collector, not optional Driver events.
    const storedInfo = Number(info.eventEntriesSubmitted || 0) > 0 ?
      ` · Core events stored ${Number(info.eventEntriesStored || 0)}/${Number(info.eventEntriesSubmitted || 0)}` +
      (info.eventEntriesNotStored ? ` (${Number(info.eventEntriesNotStored)} filtered/not stored)` : '') +
      (info.eventEntriesUnconfirmed ? ` (${Number(info.eventEntriesUnconfirmed)} unconfirmed)` : '') : '';
    const attemptInfo = ` · Bridge attempts ${Number(info.bridgeAttemptCount || 0)}` +
      (info.bridgeStartTrigger ? ` (${String(info.bridgeStartTrigger)})` : '') +
      (info.runtimeIdPresent === false ? ' · runtime.id absent' : '');
    if (result) result.textContent = `Installed v${manifestVersion} · Active tab v${liveVersion} · Build ${liveBuild}` +
      (match ? ' (version matches)' : ' (version differs — refresh this SpicyChat tab)') +
      ` · ${bridgeNote}${startInfo}${deliveryInfo}${storedInfo}${attemptInfo}`;
  } catch (error) {
    if (result) result.textContent = 'No matching Inspector script in this tab. Open/refresh a SpicyChat tab, then retry. ' +
      String(error?.message || error);
  } finally { button.disabled = false; }
});

// Snapshot HTML remains a supported automatic diagnostic action.
$('#snapshotHtml')?.addEventListener('click', async () => {
  const button = $('#snapshotHtml');
  button.disabled = true;
  try {
    const response = await msg({ type: 'SCI_ACTIVE_COMMAND', command: 'snapshot-html' });
    if (!response.result?.ok) throw new Error(response.result?.error || 'Snapshot request was not accepted.');
    status('HTML snapshot captured.');
  } catch (error) {
    const message = String(error?.message || error);
    status(/Receiving end does not exist|Could not establish connection/i.test(message)
      ? 'Open a SpicyChat tab and try again.' : message, true);
  } finally {
    button.disabled = false;
  }
});

// User-initiated recovery for tabs still holding an invalidated content-script
// context after an extension reload. Never automatically navigate or refresh tabs.
// Chrome's existing SpicyChat host permissions are enough; no new permissions.
$('#refreshSpicyChatTabs')?.addEventListener('click', async () => {
  const button = $('#refreshSpicyChatTabs');
  button.disabled = true;
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://spicychat.ai/*', 'https://*.spicychat.ai/*']
    });
    const targets = [];
    let skipped = 0;
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      let url;
      try { url = new URL(tab.url); } catch (_) { skipped++; continue; }
      if (url.protocol !== 'https:' ||
          (url.hostname !== 'spicychat.ai' && !url.hostname.endsWith('.spicychat.ai'))) continue;
      // Do not awaken sleeping/discarded tabs or interrupt the export workflow.
      if (tab.discarded || tab.status === 'loading' ||
          (url.pathname === '/chats' && url.searchParams.get('ds-research-export') === '1')) {
        skipped++;
        continue;
      }
      targets.push(tab.id);
    }
    if (!targets.length) {
      status(skipped ? `No eligible tabs to refresh (${skipped} left alone).` : 'No open SpicyChat tabs found.');
      return;
    }
    const notice = `Refresh ${targets.length} open SpicyChat tab${targets.length === 1 ? '' : 's'}?\n\n` +
      'Unsaved messages and editor drafts in those tabs may be lost. Save them first.\n' +
      (skipped ? `${skipped} export, loading or discarded tab${skipped === 1 ? '' : 's'} will be left alone.\n` : '') +
      '\nThis does not clear Brave’s stored extension error history.';
    if (!window.confirm(notice)) return;
    // User confirmed; do not silently retry failures or reload unrelated tabs.
    const results = await Promise.allSettled(targets.map(id => chrome.tabs.reload(id)));
    const refreshed = results.filter(result => result.status === 'fulfilled').length;
    const failed = results.length - refreshed;
    status(`Refreshed ${refreshed} SpicyChat tab${refreshed === 1 ? '' : 's'}.` +
      (skipped ? ` ${skipped} left alone.` : '') +
      (failed ? ` ${failed} failed.` : ''), failed > 0);
  } catch (error) {
    status(`Could not refresh tabs: ${String(error?.message || error)}`, true);
  } finally {
    button.disabled = false;
  }
});

$('#openSct').onclick = async () => { await msg({type:'SCI_OPEN_SCT'}); window.close(); };
$('#openInspector').onclick = async () => { await msg({ type: 'SCI_OPEN_INSPECTOR' }); window.close(); };
refresh().catch(e => status(e.message, true));
