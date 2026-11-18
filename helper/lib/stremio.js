// Thin client for the local Stremio streaming server (server.js, port 11470).
//
// How prefetching works with this server:
// - POST /{infoHash}/create starts a torrent engine and returns its file list.
// - GET  /{infoHash}/{fileIdx} opens a stream; on open the server selects the
//   whole file for download (stream-open handler / prewarmStream).
// - An engine without open streams is destroyed after ENGINE_TIMEOUT (120s),
//   so we briefly re-open the stream every touchIntervalSec to keep it alive.
// - GET /{infoHash}/{fileIdx}/stats.json reports streamProgress (0..1).

const path = require('path');

const IH_RE = /^[a-f0-9]{40}$/;

// Used when a stream comes without trackers (Torrentio omits them for some
// torrents, e.g. from 1337x). The server then only has DHT, which can find no
// peers at all on some networks. The Stremio desktop app adds a default tracker
// list in that case too; web.stremio.com does not.
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'http://tracker.renfei.net:8080/announce',
].map((t) => `tracker:${t}`);

const hasTracker = (sources) => (sources || []).some((s) => /^tracker:/.test(s));

function normalizeSources(sources, infoHash) {
  const out = (sources || [])
    .filter((s) => typeof s === 'string' && s)
    .map((s) => (/^(tracker|dht):/.test(s) ? s : `tracker:${s}`));
  if (!hasTracker(out)) out.push(...DEFAULT_TRACKERS);
  const dht = `dht:${infoHash}`;
  if (!out.includes(dht)) out.push(dht);
  return out;
}

class StremioServer {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async create(infoHash, { sources, guess, fileMustInclude }, timeoutMs) {
    if (!IH_RE.test(infoHash)) throw new Error(`Invalid infoHash: ${infoHash}`);
    await this.dropStaleEngine(infoHash);
    const body = {
      torrent: { infoHash },
      peerSearch: { sources: normalizeSources(sources, infoHash), min: 40, max: 150 },
      guessFileIdx: guess || {},
    };
    if (fileMustInclude && fileMustInclude.length) body.fileMustInclude = fileMustInclude;
    const res = await fetch(`${this.baseUrl}/${infoHash}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e) => {
      throw new Error(e.name === 'TimeoutError' ? 'Timed out fetching torrent metadata (no peers?)' : e.message);
    });
    if (!res.ok) throw new Error(`create failed: HTTP ${res.status}`);
    return res.json();
  }

  // The server only applies peerSearch when it creates an engine; later create
  // calls reuse the existing engine as is. An engine that was started with DHT
  // only (e.g. by web.stremio.com) and never got metadata would ignore our
  // trackers, so remove it first. It has no data, so nothing is lost.
  async dropStaleEngine(infoHash) {
    try {
      const res = await fetch(`${this.baseUrl}/${infoHash}/stats.json`, { signal: AbortSignal.timeout(5000) });
      const stats = res.ok ? await res.json() : null;
      if (!stats || stats.files) return;
      const sources = (stats.opts && stats.opts.peerSearch && stats.opts.peerSearch.sources) || [];
      if (hasTracker(sources)) return;
      await fetch(`${this.baseUrl}/${infoHash}/remove`, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Best effort: create still works, just possibly without our trackers.
    }
  }

  // Opens the stream and closes it as soon as headers arrive. This marks the
  // file for download and resets the server's inactivity timer.
  async touch(infoHash, fileIdx) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(`${this.baseUrl}/${infoHash}/${fileIdx}`, {
        headers: { Range: 'bytes=0-' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`touch failed: HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  // Returns null when no engine exists for this torrent.
  async fileStats(infoHash, fileIdx) {
    const res = await fetch(`${this.baseUrl}/${infoHash}/${fileIdx}/stats.json`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`stats failed: HTTP ${res.status}`);
    return res.json();
  }

  async settings() {
    const res = await fetch(`${this.baseUrl}/settings`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`settings failed: HTTP ${res.status}`);
    return (await res.json()).values;
  }

  // Info hashes of all torrent engines that currently exist (playing or downloading).
  async activeEngines() {
    const res = await fetch(`${this.baseUrl}/stats.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`stats failed: HTTP ${res.status}`);
    return new Set(Object.keys((await res.json()) || {}).map((ih) => ih.toLowerCase()));
  }

  // Torrent data lives in {cacheRoot}/stremio-cache/{infoHash}/{fileIdx}, one file per
  // torrent file (see enginefs.getCachePath in Stremio's server.js).
  async cacheDir() {
    const { cacheRoot } = await this.settings();
    if (!cacheRoot) throw new Error('Stremio server did not report cacheRoot');
    return path.join(cacheRoot, 'stremio-cache');
  }
}

module.exports = { StremioServer, normalizeSources, IH_RE };
