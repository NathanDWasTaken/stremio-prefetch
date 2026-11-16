// Service worker. Relays API calls to the helper: content scripts on
// https://web.stremio.com can't call a plain-http LAN address (mixed content),
// the extension's service worker can.

importScripts('shared.js');

async function callApi(method, path, body) {
  const s = await SP.getSettings();
  if (!s.helperUrl) return { ok: false, error: 'Helper URL not configured (open the extension options)' };
  try {
    const res = await fetch(s.helperUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Prefetch-Token': s.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Helper unreachable: ${e.message}` };
  }
}

// Checks a helper URL + token without saving them. Each step is reported separately.
async function testConnection(helperUrl, token) {
  const base = helperUrl.replace(/\/+$/, '');
  const result = { reachable: false, tokenValid: false, stremio: null, error: null };
  try {
    const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(5000) });
    const data = await ping.json();
    if (data.name !== 'stremio-prefetch') throw new Error('Something answered, but it is not the prefetch helper');
    result.reachable = true;
    result.version = data.version;
  } catch (e) {
    result.error = e.name === 'TimeoutError' ? 'No answer within 5s (helper not running, or firewall)' : e.message;
    return result;
  }
  try {
    const res = await fetch(`${base}/api/status`, { headers: { 'X-Prefetch-Token': token } });
    if (res.status === 401) return result;
    result.tokenValid = res.ok;
    if (res.ok) result.stremio = (await res.json()).stremio;
    else result.error = `HTTP ${res.status}`;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let p;
  if (msg && msg.type === 'api') p = callApi(msg.method, msg.path, msg.body);
  else if (msg && msg.type === 'settings') p = SP.getSettings();
  else if (msg && msg.type === 'test') p = testConnection(msg.helperUrl, msg.token);
  else return false;
  p.then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true; // keep the channel open for the async response
});

// Badge with the number of downloads in progress.
async function updateBadge() {
  const r = await callApi('GET', '/api/jobs');
  if (!r.ok) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const busy = r.data.jobs.filter((j) => ['queued', 'starting', 'active'].includes(j.status)).length;
  chrome.action.setBadgeBackgroundColor({ color: '#7b5bf5' });
  chrome.action.setBadgeText({ text: busy ? String(busy) : '' });
}

// Open the settings right after install if the helper isn't configured yet.
chrome.runtime.onInstalled.addListener(async () => {
  const s = await SP.getSettings();
  if (!s.helperUrl || !s.token) chrome.runtime.openOptionsPage();
});

chrome.alarms.create('badge', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'badge' && updateBadge());
updateBadge();
