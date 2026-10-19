// Markdown is the single source of truth. Render a safe subset without innerHTML.
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
const historyEl = document.getElementById('history');
function renderChangelog(markdown) {
  historyEl.replaceChildren();
  let currentList = null;
  for (const rawLine of String(markdown).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { currentList = null; continue; }
    const header = /^(#{1,3})\s+(.+)$/.exec(line);
    if (header) {
      currentList = null;
      const el = document.createElement(`h${Math.min(header[1].length, 4)}`);
      el.textContent = header[2];
      historyEl.appendChild(el);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!currentList) {
        currentList = document.createElement('ul');
        historyEl.appendChild(currentList);
      }
      const li = document.createElement('li');
      li.textContent = line.slice(2);
      currentList.appendChild(li);
      continue;
    }
    currentList = null;
    const p = document.createElement('p');
    p.textContent = line;
    historyEl.appendChild(p);
  }
}
fetch(chrome.runtime.getURL('CHANGELOG.md'))
  .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
  .then(renderChangelog)
  .catch(() => { historyEl.textContent = 'The release history could not be loaded. Check that CHANGELOG.md is present in your Inspector folder.'; });
