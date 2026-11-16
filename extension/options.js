const $ = (id) => document.getElementById(id);
const TEXT = ['helperUrl', 'token'];
const NUM = ['autoNextCount', 'autoNextDelaySec'];
const BOOL = ['autoNext', 'streamButtons'];

async function load() {
  const s = await SP.getSettings();
  TEXT.forEach((k) => ($(k).value = s[k]));
  NUM.forEach((k) => ($(k).value = s[k]));
  BOOL.forEach((k) => ($(k).checked = s[k]));
}

$('save').addEventListener('click', () => {
  const helperUrl = $('helperUrl').value.trim().replace(/\/+$/, '');
  let origin;
  try {
    origin = new URL(helperUrl).origin;
  } catch (_) {
    $('result').textContent = 'Invalid helper URL';
    return;
  }
  // permissions.request must run directly in the click handler (user gesture).
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    if (!granted) {
      $('result').textContent = 'Permission to reach the helper was denied.';
      return;
    }
    const values = { helperUrl };
    TEXT.filter((k) => k !== 'helperUrl').forEach((k) => (values[k] = $(k).value.trim()));
    NUM.forEach((k) => (values[k] = Number($(k).value) || SP.DEFAULT_SETTINGS[k]));
    BOOL.forEach((k) => (values[k] = $(k).checked));
    await chrome.storage.local.set(values);
    $('result').textContent = 'Saved. Testing…';
    const t = await chrome.runtime.sendMessage({ type: 'test', helperUrl, token: values.token });
    const line = (ok, text) => `${ok ? '✅' : '❌'} ${text}`;
    const lines = [line(t.reachable, t.reachable ? `Helper reachable (v${t.version})` : `Helper not reachable: ${t.error}`)];
    if (t.reachable) {
      lines.push(line(t.tokenValid, t.tokenValid ? 'Token valid' : `Token invalid${t.error ? `: ${t.error}` : ' — copy it from helper/data/config.json'}`));
    }
    if (t.tokenValid) {
      lines.push(
        line(t.stremio.reachable, t.stremio.reachable ? `Stremio server ${t.stremio.serverVersion} reachable` : `Stremio server not reachable: ${t.stremio.error}`),
      );
    }
    $('result').textContent = `Saved.\n${lines.join('\n')}`;
  });
});

load();
