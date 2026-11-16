// Talks to Stremio addons (Torrentio, TPB, Cinemeta, ...) to find episodes and
// pick a torrent stream for them, the same way the Stremio client would.

const { IH_RE } = require('./stremio');

const UA = 'Mozilla/5.0 (stremio-prefetch)';
const META_TTL_MS = 60 * 60 * 1000;
const metaCache = new Map();

function addonBase(transportUrl) {
  return transportUrl.replace(/\/manifest\.json$/, '');
}

function supports(addon, resource, type, id) {
  const m = (addon && addon.manifest) || {};
  const res = (m.resources || []).find((r) => (typeof r === 'string' ? r : r && r.name) === resource);
  if (!res) return false;
  const types = (typeof res === 'object' && res.types) || m.types || [];
  const prefixes = (typeof res === 'object' && res.idPrefixes) || m.idPrefixes;
  if (!types.includes(type)) return false;
  if (prefixes && prefixes.length && !prefixes.some((p) => id.startsWith(p))) return false;
  return true;
}

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function resourceUrl(addon, resource, type, id) {
  return `${addonBase(addon.transportUrl)}/${resource}/${type}/${encodeURIComponent(id)}.json`;
}

// ---- Metadata ---------------------------------------------------------------

function normalizeMeta(meta) {
  const videos = (meta.videos || [])
    .filter((v) => v && v.id)
    .map((v) => ({
      id: v.id,
      season: Number.isFinite(v.season) ? v.season : null,
      episode: Number.isFinite(v.episode) ? v.episode : Number.isFinite(v.number) ? v.number : null,
      title: v.title || v.name || '',
      released: v.released || null,
    }))
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  return { id: meta.id, type: meta.type, name: meta.name || meta.id, videos };
}

async function getMeta(type, id, addons, fallbackMetaAddon) {
  const key = `${type}:${id}`;
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;

  const candidates = (addons || []).filter((a) => supports(a, 'meta', type, id));
  if (fallbackMetaAddon && !candidates.some((a) => a.transportUrl === fallbackMetaAddon)) {
    candidates.push({ transportUrl: fallbackMetaAddon });
  }
  let lastErr;
  for (const addon of candidates) {
    try {
      const data = await fetchJson(resourceUrl(addon, 'meta', type, id));
      if (data && data.meta) {
        const meta = normalizeMeta(data.meta);
        metaCache.set(key, { at: Date.now(), meta });
        return meta;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not load metadata for ${id}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function isReleased(v) {
  return !v.released || new Date(v.released).getTime() <= Date.now();
}

// select is one of:
//   { videoIds: [...] }
//   { season: n, fromVideoId?: id }
//   { nextAfter: id, count: n }
function selectVideos(meta, select) {
  const all = meta.videos;
  if (Array.isArray(select.videoIds)) {
    return select.videoIds.map((id) => all.find((v) => v.id === id) || { id, season: null, episode: null, title: '' });
  }
  if (Number.isFinite(select.season)) {
    let list = all.filter((v) => v.season === select.season && isReleased(v));
    if (select.fromVideoId) {
      const from = list.findIndex((v) => v.id === select.fromVideoId);
      if (from >= 0) list = list.slice(from);
    }
    return list;
  }
  if (select.nextAfter) {
    const cur = all.find((v) => v.id === select.nextAfter);
    if (!cur) throw new Error(`Episode ${select.nextAfter} not found in metadata`);
    // Skip specials (season 0) unless we are watching specials.
    const pool = all.filter((v) => (cur.season === 0 ? v.season === 0 : v.season !== 0));
    const idx = pool.indexOf(cur);
    return pool.slice(idx + 1, idx + 1 + (select.count || 1)).filter(isReleased);
  }
  throw new Error('Invalid selection');
}

function episodeLabel(meta, v) {
  if (!meta) return v.id;
  if (Number.isFinite(v.season) && Number.isFinite(v.episode)) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${meta.name} S${pad(v.season)}E${pad(v.episode)}`;
  }
  return meta.name;
}

// ---- Streams ----------------------------------------------------------------

function streamText(s) {
  return `${s.name || ''}\n${s.title || ''}\n${s.description || ''}`;
}

function resolutionOf(text) {
  const m = /\b(2160p|4k|uhd|1440p|1080p|720p|576p|480p)\b/i.exec(text || '');
  if (!m) return null;
  const r = m[1].toLowerCase();
  return r === '4k' || r === 'uhd' ? '2160p' : r;
}

function seedersOf(text) {
  const m = /(?:👤|seeders?:?|seeds?:?)\s*(\d+)/i.exec(text || '');
  return m ? Number(m[1]) : 0;
}

function normalizeStream(s, addon) {
  const infoHash = (s.infoHash || '').toLowerCase();
  if (!IH_RE.test(infoHash)) return null;
  const text = streamText(s);
  const hints = s.behaviorHints || {};
  return {
    infoHash,
    fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null,
    sources: s.sources || s.announce || [],
    fileMustInclude: s.fileMustInclude || [],
    bingeGroup: hints.bingeGroup || null,
    filename: hints.filename || null,
    title: (s.title || s.description || '').split('\n')[0],
    resolution: resolutionOf(text),
    seeders: seedersOf(text),
    addon: (addon.manifest && addon.manifest.name) || addonBase(addon.transportUrl),
  };
}

async function getStreams(type, id, addons) {
  const candidates = (addons || []).filter((a) => supports(a, 'stream', type, id));
  if (!candidates.length) throw new Error('None of your installed addons provide streams for this item');
  const results = await Promise.allSettled(
    candidates.map(async (addon) => {
      const data = await fetchJson(resourceUrl(addon, 'stream', type, id), 20000);
      return (data.streams || []).map((s) => normalizeStream(s, addon)).filter(Boolean);
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

// prefer: { infoHash?, bingeGroup?, resolution? }
function pickStream(streams, prefer, defaultResolution) {
  if (!streams.length) return null;
  prefer = prefer || {};
  if (prefer.infoHash) {
    const same = streams.find((s) => s.infoHash === prefer.infoHash);
    if (same) return same;
  }
  if (prefer.bingeGroup) {
    const same = streams.find((s) => s.bingeGroup === prefer.bingeGroup);
    if (same) return same;
  }
  const wanted = prefer.resolution || defaultResolution;
  const sameRes = streams.filter((s) => s.resolution === wanted);
  const pool = sameRes.length ? sameRes : streams;
  return [...pool].sort((a, b) => b.seeders - a.seeders)[0];
}

module.exports = { getMeta, selectVideos, episodeLabel, getStreams, pickStream, resolutionOf };
