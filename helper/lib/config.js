const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // Where the helper listens. 0.0.0.0 = reachable from other machines on the LAN.
  host: '0.0.0.0',
  port: 11480,
  // Shared secret the extension must send. Generated on first run.
  token: '',
  // Local Stremio streaming server.
  stremioUrl: 'http://127.0.0.1:11470',
  // How many torrents to download at the same time.
  maxActive: 2,
  // Stremio destroys a torrent engine 120s after the last open stream,
  // so we re-open the stream more often than that.
  touchIntervalSec: 45,
  pollIntervalSec: 10,
  // How long to wait for torrent metadata before giving up on an attempt.
  createTimeoutSec: 120,
  maxAttempts: 3,
  // Delete a prefetched file from Stremio's cache once the extension reports it as
  // watched, after a grace period (to rewatch the ending or undo "mark as watched").
  deleteWatched: true,
  deleteWatchedAfterMin: 60,
  // Used when picking a stream automatically and there is nothing to match against.
  defaultResolution: '1080p',
  // Used for metadata when no installed addon provides it.
  fallbackMetaAddon: 'https://v3-cinemeta.strem.io/manifest.json',
};

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  const cfg = { ...DEFAULTS, ...stored };
  if (!cfg.token) cfg.token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

module.exports = { loadConfig, DATA_DIR, CONFIG_PATH };
