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
}
for (const key of ['recording','captureDom','capturePerformance','captureErrors','captureQolInternals']) {
  $('#'+key)?.addEventListener('change', async e => {
    const patch = { [key]: e.target.checked };
    if (key === 'captureQolInternals') patch.qolTraceLevel = e.target.checked ? (/Android/i.test(navigator.userAgent) ? 'normal' : 'deep') : 'off';
    await msg({ type: 'SCI_SET_SETTINGS', patch });
    await refresh();
  });
}

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
