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
    else if (info.handshakeResponses > 0) status('QoL handshake received, but no operation traces yet.');
    else status('No QoL handshake or operation trace observed in this tab yet.');
  } catch (error) { status(String(error?.message || error), true); }
  finally { button.disabled = false; }
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

$('#openInspector').onclick = async () => { await msg({ type: 'SCI_OPEN_INSPECTOR' }); window.close(); };
refresh().catch(e => status(e.message, true));
