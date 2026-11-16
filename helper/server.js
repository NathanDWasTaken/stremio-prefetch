// stremio-prefetch helper: runs next to the Stremio streaming server and keeps
// queued torrents downloading until they are fully cached.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, DATA_DIR, CONFIG_PATH } = require('./lib/config');
const { StremioServer } = require('./lib/stremio');
const { JobManager } = require('./lib/jobs');
const resolver = require('./lib/resolver');

const VERSION = '0.1.0';
const LOG_PATH = path.join(DATA_DIR, 'helper.log');

const cfg = loadConfig();

try {
  if (fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.truncateSync(LOG_PATH, 0);
} catch (_) {}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + '\n', () => {});
}

const server = new StremioServer(cfg.stremioUrl);
const jobs = new JobManager({ cfg, server, log });

// ---- HTTP helpers -------------------------------------------------------------

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- API ----------------------------------------------------------------------

async function status() {
  let stremio = { reachable: false };
  try {
    const s = await server.settings();
    stremio = { reachable: true, cacheSize: s.cacheSize, serverVersion: s.serverVersion };
  } catch (e) {
    stremio.error = e.message;
  }
  const counts = {};
  for (const j of jobs.list()) counts[j.status] = (counts[j.status] || 0) + 1;
  return { ok: true, version: VERSION, stremio, counts, maxActive: cfg.maxActive };
}

// Resolves episodes/movies to torrent streams through the user's addons and queues them.
// body: { type, metaId, addons, prefer?, select }
async function queueFromAddons(body) {
  const { type, metaId, addons, select } = body;
  if (!type || !metaId || !select) throw new HttpError(400, 'type, metaId and select are required');
  let prefer = { ...(body.prefer || {}) };

  let meta = null;
  let videos;
  if (type === 'movie') {
    meta = await resolver.getMeta(type, metaId, addons, cfg.fallbackMetaAddon).catch(() => null);
    videos = [{ id: metaId, season: null, episode: null }];
  } else {
    meta = await resolver.getMeta(type, metaId, addons, cfg.fallbackMetaAddon);
    videos = resolver.selectVideos(meta, select);
  }
  if (!videos.length) return { results: [], message: 'No (released) episodes matched' };

  const results = [];
  for (const v of videos) {
    const label = resolver.episodeLabel(meta, v);
    try {
      const streams = await resolver.getStreams(type, v.id, addons);
      const pick = resolver.pickStream(streams, prefer, cfg.defaultResolution);
      if (!pick) {
        results.push({ videoId: v.id, label, ok: false, reason: 'No torrent streams found' });
        continue;
      }
      const { job, added } = jobs.add({
        infoHash: pick.infoHash,
        fileIdx: pick.fileIdx,
        sources: pick.sources,
        fileMustInclude: pick.fileMustInclude,
        season: v.season,
        episode: v.episode,
        type,
        metaId,
        videoId: v.id,
        label,
        streamTitle: `${pick.addon}: ${pick.title}`,
      });
      results.push({ videoId: v.id, label, ok: true, added, jobId: job.id, stream: pick.title });
      // Keep following episodes on the same release when possible.
      prefer = { infoHash: pick.infoHash, bingeGroup: pick.bingeGroup || prefer.bingeGroup, resolution: pick.resolution || prefer.resolution };
    } catch (e) {
      results.push({ videoId: v.id, label, ok: false, reason: e.message });
    }
  }
  return { results };
}

// Directly queue known torrent streams (e.g. one picked from Stremio's stream list).
// body: { items: [{ infoHash, fileIdx?, sources?, type?, metaId?, videoId?, label?, addons? }] }
async function queueItems(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'items is required');
  const results = [];
  for (const item of items) {
    const infoHash = String(item.infoHash || '').toLowerCase();
    let label = item.label;
    let season = null;
    let episode = null;
    if (item.metaId && item.type) {
      const meta = await resolver.getMeta(item.type, item.metaId, body.addons, cfg.fallbackMetaAddon).catch(() => null);
      const v = meta && meta.videos.find((x) => x.id === item.videoId);
      if (v) ({ season, episode } = v);
      if (!label && meta) label = resolver.episodeLabel(meta, v || { id: item.videoId });
    }
    const { job, added } = jobs.add({ ...item, infoHash, season, episode, label });
    results.push({ ok: true, added, jobId: job.id, label: job.label });
  }
  return { results };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Prefetch-Token',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  if (p === '/' || p === '/api/ping') return send(res, 200, { ok: true, name: 'stremio-prefetch', version: VERSION });

  if (req.headers['x-prefetch-token'] !== cfg.token) throw new HttpError(401, 'Invalid or missing token');

  if (req.method === 'GET' && p === '/api/status') return send(res, 200, await status());
  if (req.method === 'GET' && p === '/api/jobs') return send(res, 200, { jobs: jobs.list() });
  if (req.method === 'POST' && p === '/api/jobs') return send(res, 200, await queueItems(await readBody(req)));
  if (req.method === 'POST' && p === '/api/queue') return send(res, 200, await queueFromAddons(await readBody(req)));
  if (req.method === 'POST' && p === '/api/jobs/clear') {
    jobs.clearFinished();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/meta') {
    const { type, id, addons } = await readBody(req);
    return send(res, 200, { meta: await resolver.getMeta(type, id, addons, cfg.fallbackMetaAddon) });
  }
  let m;
  if (req.method === 'DELETE' && (m = /^\/api\/jobs\/([a-f0-9]+)$/.exec(p))) {
    return send(res, jobs.remove(m[1]) ? 200 : 404, { ok: true });
  }
  if (req.method === 'POST' && (m = /^\/api\/jobs\/([a-f0-9]+)\/retry$/.exec(p))) {
    return send(res, jobs.retry(m[1]) ? 200 : 404, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

http
  .createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!(e instanceof HttpError)) log(`error ${req.method} ${req.url}: ${e.stack || e.message}`);
      send(res, e.status || 500, { ok: false, error: e.message });
    });
  })
  .listen(cfg.port, cfg.host, () => {
    log(`stremio-prefetch ${VERSION} listening on http://${cfg.host}:${cfg.port}`);
    log(`stremio server: ${cfg.stremioUrl}`);
    log(`token: ${cfg.token} (from ${CONFIG_PATH})`);
  });

setInterval(() => jobs.tick(), cfg.pollIntervalSec * 1000);
jobs.tick();
