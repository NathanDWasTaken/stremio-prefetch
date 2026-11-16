// Prefetch queue. Each job is one file inside one torrent.
//
// Lifecycle: queued -> starting -> active -> done
//                         \-> (retry) queued -> ... -> failed

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|ts|m2ts)$/i;

function largestVideoIdx(files) {
  let best = -1;
  files.forEach((f, i) => {
    if (VIDEO_EXT.test(f.name) && (best < 0 || f.length > files[best].length)) best = i;
  });
  return best;
}

class JobManager {
  constructor({ cfg, server, log }) {
    this.cfg = cfg;
    this.server = server;
    this.log = log;
    this.jobs = [];
    this.ticking = false;
    this.saveTimer = null;
    try {
      this.jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
    } catch (_) {}
    for (const j of this.jobs) {
      if (j.status === 'starting' || j.status === 'active') j.status = 'queued';
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.writeFile(JOBS_PATH, JSON.stringify(this.jobs, null, 2), (err) => err && this.log('save failed', err.message));
    }, 500);
  }

  static key(item) {
    const file = Number.isInteger(item.fileIdx)
      ? item.fileIdx
      : Number.isFinite(item.season)
        ? `s${item.season}e${item.episode}`
        : 'auto';
    return `${item.infoHash}:${file}`;
  }

  // Returns { job, added }. Re-queues a failed duplicate instead of adding a new one.
  add(item) {
    const key = JobManager.key(item);
    const existing = this.jobs.find(
      (j) => j.key === key || (Number.isInteger(item.fileIdx) && j.infoHash === item.infoHash && j.fileIdx === item.fileIdx),
    );
    if (existing) {
      if (existing.status === 'failed') {
        Object.assign(existing, { status: 'queued', attempts: 0, error: null, retryAt: null });
        this.save();
      }
      return { job: existing, added: false };
    }
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      key,
      infoHash: item.infoHash,
      fileIdx: Number.isInteger(item.fileIdx) ? item.fileIdx : null,
      sources: item.sources || [],
      fileMustInclude: item.fileMustInclude || [],
      season: Number.isFinite(item.season) ? item.season : null,
      episode: Number.isFinite(item.episode) ? item.episode : null,
      type: item.type || null,
      metaId: item.metaId || null,
      videoId: item.videoId || null,
      label: item.label || item.infoHash,
      streamTitle: item.streamTitle || '',
      status: 'queued',
      attempts: 0,
      error: null,
      progress: 0,
      downloadSpeed: 0,
      peers: 0,
      size: null,
      fileName: null,
      addedAt: Date.now(),
      doneAt: null,
    };
    this.jobs.push(job);
    this.save();
    this.log(`queued ${job.label} (${job.infoHash}:${job.fileIdx ?? 'auto'})`);
    setImmediate(() => this.tick());
    return { job, added: true };
  }

  remove(id) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    return this.jobs.length !== before;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status !== 'done' && j.status !== 'failed');
    this.save();
  }

  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    Object.assign(job, { status: 'queued', attempts: 0, error: null, retryAt: null });
    this.save();
    setImmediate(() => this.tick());
    return true;
  }

  list() {
    return this.jobs;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.jobs.filter((j) => j.status === 'active')) {
        await this.check(job).catch((e) => this.log(`check ${job.label}: ${e.message}`));
      }
      let busy = this.jobs.filter((j) => j.status === 'active' || j.status === 'starting').length;
      const now = Date.now();
      for (const job of this.jobs) {
        if (busy >= this.cfg.maxActive) break;
        if (job.status === 'queued' && (!job.retryAt || job.retryAt <= now)) {
          busy++;
          this.start(job); // runs in the background; metadata can take a while
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async start(job) {
    job.status = 'starting';
    job.error = null;
    this.save();
    try {
      const guess = Number.isFinite(job.season) ? { season: job.season, episode: job.episode } : {};
      const stats = await this.server.create(
        job.infoHash,
        { sources: job.sources, guess, fileMustInclude: job.fileMustInclude },
        this.cfg.createTimeoutSec * 1000,
      );
      if (!this.jobs.includes(job)) return; // removed while starting
      const files = stats.files || [];
      let idx = job.fileIdx;
      if (!Number.isInteger(idx) || !files[idx]) {
        idx = Number.isInteger(stats.guessedFileIdx) && files[stats.guessedFileIdx] ? stats.guessedFileIdx : largestVideoIdx(files);
      }
      if (idx < 0 || !files[idx]) throw new Error('Torrent contains no video file');
      Object.assign(job, { fileIdx: idx, fileName: files[idx].name, size: files[idx].length, torrentName: stats.name });
      await this.server.touch(job.infoHash, idx);
      job.lastTouch = Date.now();
      job.status = 'active';
      job.startedAt = job.startedAt || Date.now();
      this.log(`started ${job.label} -> ${job.fileName}`);
    } catch (e) {
      if (!this.jobs.includes(job)) return;
      job.attempts++;
      job.error = e.message;
      if (job.attempts >= this.cfg.maxAttempts) {
        job.status = 'failed';
        this.log(`failed ${job.label}: ${e.message}`);
      } else {
        job.status = 'queued';
        job.retryAt = Date.now() + 60000 * job.attempts;
        this.log(`retry later ${job.label}: ${e.message}`);
      }
    }
    this.save();
  }

  async check(job) {
    const st = await this.server.fileStats(job.infoHash, job.fileIdx);
    if (!st || typeof st.streamProgress !== 'number') {
      // Engine was destroyed (e.g. Stremio restarted). Start it again.
      this.log(`engine gone for ${job.label}, restarting`);
      job.status = 'queued';
      job.retryAt = null;
      this.save();
      return;
    }
    job.progress = st.streamProgress;
    job.downloadSpeed = st.downloadSpeed || 0;
    job.peers = st.peers || 0;
    if (job.progress >= 1) {
      Object.assign(job, { status: 'done', doneAt: Date.now(), downloadSpeed: 0 });
      this.log(`done ${job.label}`);
    } else if (Date.now() - (job.lastTouch || 0) >= this.cfg.touchIntervalSec * 1000) {
      await this.server.touch(job.infoHash, job.fileIdx);
      job.lastTouch = Date.now();
    }
    this.save();
  }
}

module.exports = { JobManager };
