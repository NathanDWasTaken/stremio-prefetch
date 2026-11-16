// Shared between background, content script, popup and options page.
/* exported SP */

const SP = (() => {
  const DEFAULT_SETTINGS = {
    helperUrl: '',
    token: '',
    autoNext: true,
    autoNextCount: 1,
    autoNextDelaySec: 120,
    streamButtons: true,
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
  }

  // "deleting in 42 min" / "deleting when playback stops" for watched jobs.
  function deleteNote(job) {
    if (!job.deleteAt) return '';
    const min = Math.ceil((job.deleteAt - Date.now()) / 60000);
    return min > 0 ? `deleting in ${min} min` : 'deleting when nothing plays from this torrent';
  }

  function jobLine(job) {
    const pct = `${Math.floor((job.progress || 0) * 100)}%`;
    switch (job.status) {
      case 'queued':
        return job.error ? `Queued (retrying: ${job.error})` : 'Queued';
      case 'starting':
        return 'Finding peers…';
      case 'active':
        return `${pct} · ${formatBytes(job.downloadSpeed) || '0 B'}/s · ${job.peers} peers`;
      case 'done':
        if (job.watchedAt) return `Watched · ${deleteNote(job)}`;
        return `Ready${job.size ? ` · ${formatBytes(job.size)}` : ''}`;
      case 'watched':
        return `Watched, stopped · ${deleteNote(job)}`;
      case 'failed':
        return `Failed: ${job.error || 'unknown error'}`;
      default:
        return job.status;
    }
  }

  // ---- Download list (toolbar popup and in-page panel) --------------------------
  // Jobs grouped per title, newest title first; one compact row per episode.

  const DOWNLOADING = ['queued', 'starting', 'active'];
  const pad2 = (n) => String(n).padStart(2, '0');

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function groupJobs(jobs) {
    const groups = new Map();
    for (const j of jobs) {
      const key = j.metaId || j.infoHash;
      if (!groups.has(key)) {
        const title = (j.label || '').replace(/\s+S\d+E\d+$/, '') || j.metaId || 'Unknown';
        groups.set(key, { key, title, jobs: [], latest: 0 });
      }
      const g = groups.get(key);
      g.jobs.push(j);
      g.latest = Math.max(g.latest, j.addedAt || 0);
    }
    const list = [...groups.values()].sort((a, b) => b.latest - a.latest);
    for (const g of list) g.jobs.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    return list;
  }

  function groupSummary(g) {
    const n = (f) => g.jobs.filter(f).length;
    const parts = [];
    const busy = n((j) => DOWNLOADING.includes(j.status));
    const ready = n((j) => j.status === 'done' && !j.watchedAt);
    const watched = n((j) => j.watchedAt || j.status === 'watched');
    const failed = n((j) => j.status === 'failed');
    if (busy) parts.push(`${busy} downloading`);
    if (ready) parts.push(`${ready} ready`);
    if (watched) parts.push(`${watched} watched`);
    if (failed) parts.push(`${failed} failed`);
    return parts.join(' · ');
  }

  // opts.currentKey: metaId of the title on screen (listed first, expanded).
  // opts.expanded: Map key -> bool for groups the user opened / closed.
  function jobsListHtml(jobs, opts = {}) {
    if (!jobs.length) return '<div class="sp-empty">Nothing prefetched yet.</div>';
    const groups = groupJobs(jobs);
    groups.sort((a, b) => (b.key === opts.currentKey) - (a.key === opts.currentKey));
    const expanded = opts.expanded || new Map();
    return groups
      .map((g) => {
        const open = expanded.has(g.key)
          ? expanded.get(g.key)
          : g.key === opts.currentKey || g.jobs.some((j) => DOWNLOADING.includes(j.status) || j.status === 'failed');
        const rows = g.jobs
          .map((j) => {
            const name =
              Number.isFinite(j.season) && Number.isFinite(j.episode) ? `S${pad2(j.season)}E${pad2(j.episode)}` : j.type === 'movie' ? 'Movie' : 'File';
            const state = j.watchedAt || j.status === 'watched' ? 'watched' : j.status;
            const bar = DOWNLOADING.includes(j.status) ? `<div class="sp-bar"><div style="width:${Math.floor((j.progress || 0) * 100)}%"></div></div>` : '';
            return `<div class="sp-row sp-${state}" title="${escHtml(j.fileName || j.streamTitle || '')}">
                <span class="sp-dot"></span><span class="sp-name">${name}</span>
                <span class="sp-state">${escHtml(jobLine(j))}</span>
                ${j.status === 'failed' ? `<button class="sp-retry" data-retry="${j.id}">Retry</button>` : ''}
                <button class="sp-x" data-del="${j.id}" title="Remove and delete from Stremio's cache">✕</button>
                ${bar}
              </div>`;
          })
          .join('');
        return `<details class="sp-group" data-group="${escHtml(g.key)}" ${open ? 'open' : ''}>
            <summary><span class="sp-title">${escHtml(g.title)}</span><span class="sp-sum">${escHtml(groupSummary(g))}</span></summary>
            ${rows}
          </details>`;
      })
      .join('');
  }

  const JOBS_CSS = `
    .sp-empty { color: #999; padding: 6px 0; }
    .sp-group { border-top: 1px solid #2d2b45; padding: 4px 0; }
    .sp-group summary { display: flex; align-items: baseline; gap: 8px; cursor: pointer; padding: 4px 0; list-style: none; }
    .sp-group summary::-webkit-details-marker { display: none; }
    .sp-group summary::before { content: '▸'; color: #888; width: 10px; flex: none; }
    .sp-group[open] summary::before { content: '▾'; }
    .sp-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .sp-sum { color: #999; font-size: 11px; white-space: nowrap; }
    .sp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 3px 0 3px 18px; }
    .sp-dot { width: 7px; height: 7px; border-radius: 50%; background: #7b5bf5; flex: none; }
    .sp-done .sp-dot { background: #3ecf8e; }
    .sp-failed .sp-dot { background: #e5484d; }
    .sp-watched .sp-dot { background: #777; }
    .sp-queued .sp-dot { background: #555; }
    .sp-name { font-variant-numeric: tabular-nums; flex: none; }
    .sp-state { color: #aaa; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sp-x { background: none; border: none; color: #888; cursor: pointer; font-size: 13px; padding: 0 2px; }
    .sp-x:hover { color: #fff; }
    .sp-retry { background: #2d2b45; color: #fff; border: 1px solid #44406a; border-radius: 5px; padding: 1px 6px; cursor: pointer; font-size: 11px; }
    .sp-bar { flex-basis: 100%; height: 3px; background: #2d2b45; border-radius: 2px; overflow: hidden; margin-left: 15px; }
    .sp-bar div { height: 100%; background: #7b5bf5; }
  `;

  // Mirrors stremio-web's routesRegexp for the routes we care about.
  function parseRoute(hash) {
    const [h, query] = (hash || '').replace(/^#/, '').split('?');
    const dec = (s) => (s ? decodeURIComponent(s) : null);
    let m = /^\/(?:metadetails|detail)\/([^/]*)\/([^/]*)(?:\/([^/]*))?$/.exec(h);
    if (m) {
      const season = new URLSearchParams(query || '').get('season');
      return { name: 'detail', type: dec(m[1]), id: dec(m[2]), videoId: dec(m[3]), season: season !== null && !isNaN(season) ? Number(season) : null };
    }
    m = /^\/player\/([^/]*)(?:\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*))?$/.exec(h);
    if (m) return { name: 'player', stream: dec(m[1]), type: dec(m[4]), id: dec(m[5]), videoId: dec(m[6]) };
    return { name: 'other' };
  }

  // Stremio encodes the stream in player URLs as base64(zlib(json)).
  async function decodeStream(encoded) {
    const bin = atob(encoded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream('deflate');
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
    return JSON.parse(text);
  }

  async function inflate(b64) {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Video ids in the order stremio-core uses for the watched bitfield:
  // by season, then episode, then release date (missing values first).
  function coreSortedIds(videos) {
    const key = (x) => (x === null || x === undefined ? -Infinity : x);
    const rel = (v) => (v.released ? new Date(v.released).getTime() : -Infinity);
    const hasInfo = (v) => Number.isFinite(v.season) && Number.isFinite(v.episode);
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    return videos
      .slice()
      .sort(
        (a, b) =>
          cmp(key(hasInfo(a) ? a.season : null), key(hasInfo(b) ? b.season : null)) ||
          cmp(key(hasInfo(a) ? a.episode : null), key(hasInfo(b) ? b.episode : null)) ||
          cmp(rel(a), rel(b)),
      )
      .map((v) => v.id);
  }

  // Decodes a library item's `state.watched` field: "{anchorVideoId}:{anchorLength}:{base64(zlib(bits))}".
  // Mirrors stremio-watched-bitfield's WatchedBitField::construct_with_videos.
  async function decodeWatched(field, videos) {
    const set = new Set();
    if (!field) return set;
    const parts = field.split(':');
    if (parts.length < 3) return set;
    const buf = parts.pop();
    const anchorLength = Number(parts.pop());
    const anchor = parts.join(':');
    const values = await inflate(buf);
    const ids = coreSortedIds(videos);
    const anchorIdx = ids.indexOf(anchor);
    if (anchorIdx < 0) return set;
    const offset = anchorLength - anchorIdx - 1;
    ids.forEach((id, i) => {
      const prev = i + offset;
      if (prev >= 0 && prev < ids.length && (values[prev >> 3] >> (prev & 7)) & 1) set.add(id);
    });
    return set;
  }

  function torrentInfo(stream) {
    if (!stream || !/^[a-f0-9]{40}$/i.test(stream.infoHash || '')) return null;
    const text = `${stream.name || ''}\n${stream.description || stream.title || ''}`;
    const res = /\b(2160p|4k|1080p|720p|480p)\b/i.exec(text);
    return {
      infoHash: stream.infoHash.toLowerCase(),
      fileIdx: Number.isInteger(stream.fileIdx) ? stream.fileIdx : null,
      sources: stream.announce || stream.sources || [],
      fileMustInclude: stream.fileMustInclude || [],
      bingeGroup: (stream.behaviorHints && stream.behaviorHints.bingeGroup) || null,
      resolution: res ? (res[1].toLowerCase() === '4k' ? '2160p' : res[1].toLowerCase()) : null,
      title: (stream.description || stream.title || stream.name || '').split('\n')[0],
    };
  }

  return { DEFAULT_SETTINGS, getSettings, formatBytes, jobLine, jobsListHtml, JOBS_CSS, parseRoute, decodeStream, decodeWatched, torrentInfo };
})();
