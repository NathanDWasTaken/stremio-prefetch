const api = (method, path, body) => chrome.runtime.sendMessage({ type: 'api', method, path, body });
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function load() {
  const settings = await SP.getSettings();
  if (!settings.helperUrl || !settings.token) {
    $('status').innerHTML = 'Not set up yet. <button id="options">Open settings</button>';
    $('jobs').innerHTML = '';
    return;
  }
  const st = await api('GET', '/api/status');
  if (!st.ok) {
    $('status').innerHTML = `<span class="warn">${esc(st.error)}</span>`;
    $('jobs').innerHTML = '';
    return;
  }
  const s = st.data;
  $('ver').textContent = `v${s.version}`;
  let html = s.stremio.reachable
    ? `Stremio server ${esc(s.stremio.serverVersion)} · cache ${s.stremio.cacheSize === null ? '∞' : SP.formatBytes(s.stremio.cacheSize)}`
    : `<span class="warn">Stremio server unreachable from helper: ${esc(s.stremio.error)}</span>`;
  if (s.stremio.reachable && s.stremio.cacheSize !== null && s.stremio.cacheSize < 10 * 1024 ** 3) {
    html += '<br><span class="warn">Cache is small — prefetched files may be evicted. Raise it in Stremio settings → Streaming.</span>';
  }
  $('status').innerHTML = html;

  const r = await api('GET', '/api/jobs');
  if (!r.ok) return;
  const jobs = r.data.jobs.slice().reverse();
  $('jobs').innerHTML = jobs.length
    ? jobs
        .map(
          (j) => `<div class="job ${j.status}" title="${esc(j.fileName || j.streamTitle || '')}">
            <div class="top"><span class="label">${esc(j.label)}</span>
              <span>${j.status === 'failed' ? `<button data-retry="${j.id}">Retry</button>` : ''}<button class="x" data-del="${j.id}" title="Remove">✕</button></span></div>
            <div class="muted">${esc(SP.jobLine(j))}</div>
            <div class="bar"><div style="width:${j.status === 'done' ? 100 : Math.floor((j.progress || 0) * 100)}%"></div></div>
          </div>`,
        )
        .join('')
    : '<div class="muted">Nothing prefetched yet.</div>';
}

document.addEventListener('click', async (e) => {
  const { del, retry } = e.target.dataset;
  if (del) await api('DELETE', `/api/jobs/${del}`);
  else if (retry) await api('POST', `/api/jobs/${retry}/retry`);
  else if (e.target.id === 'clear') await api('POST', '/api/jobs/clear');
  else if (e.target.id === 'options') return chrome.runtime.openOptionsPage();
  else return;
  load();
});

load();
setInterval(load, 3000);
