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

  function jobLine(job) {
    const pct = `${Math.floor((job.progress || 0) * 100)}%`;
    switch (job.status) {
      case 'queued':
        return job.error ? `queued (retrying: ${job.error})` : 'queued';
      case 'starting':
        return 'finding peers…';
      case 'active':
        return `${pct} · ${formatBytes(job.downloadSpeed) || '0 B'}/s · ${job.peers} peers${job.size ? ` · ${formatBytes(job.size)}` : ''}`;
      case 'done':
        return `ready${job.size ? ` · ${formatBytes(job.size)}` : ''}`;
      case 'failed':
        return `failed: ${job.error || 'unknown error'}`;
      default:
        return job.status;
    }
  }

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

  return { DEFAULT_SETTINGS, getSettings, formatBytes, jobLine, parseRoute, decodeStream, decodeWatched, torrentInfo };
})();
