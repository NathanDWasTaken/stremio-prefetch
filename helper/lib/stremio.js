// Thin client for the local Stremio streaming server (server.js, port 11470).
//
// How prefetching works with this server:
// - POST /{infoHash}/create starts a torrent engine and returns its file list.
// - GET  /{infoHash}/{fileIdx} opens a stream; on open the server selects the
//   whole file for download (stream-open handler / prewarmStream).
// - An engine without open streams is destroyed after ENGINE_TIMEOUT (120s),
//   so we briefly re-open the stream every touchIntervalSec to keep it alive.
// - GET /{infoHash}/{fileIdx}/stats.json reports streamProgress (0..1).

const IH_RE = /^[a-f0-9]{40}$/;

function normalizeSources(sources, infoHash) {
  const out = (sources || [])
    .filter((s) => typeof s === 'string' && s)
    .map((s) => (/^(tracker|dht):/.test(s) ? s : `tracker:${s}`));
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
}

module.exports = { StremioServer, normalizeSources, IH_RE };
