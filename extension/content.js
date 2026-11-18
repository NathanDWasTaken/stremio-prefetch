// Runs on web.stremio.com. Adds:
//  - a download icon in the top-right nav (next to fullscreen / profile) on every page,
//    which opens a dropdown with movie / episode / season actions and download status
//  - a "Prefetch S{n}" / "Prefetch" button next to Play / Resume on series and movie pages
//  - "Prefetch ..." items in the right-click menu of torrent streams and of episodes
//  - status tags on streams and episodes that are prefetching / prefetched
//  - auto-prefetch of the next episode(s) while watching a series
//
// Stremio's CSS class names are hashed (e.g. "buttons-container-XbKVa"), so elements are
// matched on the stable prefix with [class*="..."]. Pages are detected from the URL.
// Stremio Web routes with react-router's HashRouter, which changes the URL through
// history.pushState, so there is no "hashchange" event: the URL is polled instead.
// Stremio also keeps earlier pages mounted underneath the current one (one
// ".route-container" per page), so lookups are scoped to the top-most page.

(() => {
  let dead = false; // set by shutdown() once the extension context is gone

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // chrome.runtime.sendMessage that never throws. After the extension was reloaded, this
  // copy of the script is orphaned: it shuts itself down instead of erroring every few seconds.
  async function send(msg) {
    if (dead || !contextAlive()) {
      shutdown();
      return { ok: false, error: 'Stremio Prefetch was reloaded; refresh the page' };
    }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!contextAlive() || /context invalidated/i.test(e.message)) shutdown();
      return { ok: false, error: e.message };
    }
  }

  const api = (method, path, body) => send({ type: 'api', method, path, body });

  const SEL = {
    // Top-right button groups: old nav bar (board), floating nav (other pages), player.
    navContainers: [
      'nav[class*="horizontal-nav-bar-container"] > [class*="buttons-container"]',
      '[class*="floating-nav-"] > [class*="actions-"]',
      '[class*="player-actions-"]',
    ].join(', '),
    // Buttons to copy the look from, best first.
    navButtonRefs: ['[class*="fullscreen-button-"]', '[class*="player-button-"]', '[class*="button-container"]:not([class*="menu-"])', '[class*="button-container"]'],
    streamLink: 'a[href^="#/player/"]',
    // Right-click menus. Episodes: "menu > option > option-label" (new episode list) or
    // "context-menu-content > context-menu-option-container" (older list). Streams:
    // "menu > menu-option > menu-label".
    episodeMenu: '[class*="context-menu-content"], div:has(> [class^="option-"]:not([class^="option-label"]))',
    streamMenu: 'div:has(> [class^="menu-option-"])',
    ctxMenu: '[class*="context-menu-content"], div:has(> [class^="option-"]:not([class^="option-label"])), div:has(> [class^="menu-option-"])',
    ctxOption: '[class*="context-menu-option-container"], [class^="menu-option-"], [class^="option-"]:not([class^="option-label"])',
    ctxLabel: '[class*="context-menu-option-label"], [class^="menu-label-"], [class^="option-label-"]',
    streamHeading: ':scope > [class^="info-"] > [class^="heading-"]',
    streamInfo: ':scope > [class^="info-"], :scope > [class*="info-container"]',
    // Episode list item: "row > video > info > title + meta" (new) or "video-container" (older).
    videoItem: '[class^="row-"] :is([class^="video-"], [class*=" video-"]):has([class^="info-"]), [class*="video-container"]',
    videoTitle: '[class*="title-container"], [class^="info-"] > [class^="title-"]',
    videoRow: '[class*="flex-row-container"], [class^="info-"] > [class^="meta-"]',
    // Play / Resume button on the details page, and the group of buttons next to it.
    primaryPlay: '[class*="primary-"][class*="play-button-"]',
    secondaryActions: ':scope > [class*="secondary-"]',
    // Episode pages have no Play button, only the Trailer / library / rating group.
    anyActions: '[class*="actions-"] > [class*="secondary-"]',
  };

  const ICON_PATHS =
    '<path d="M12 3.5v11.5m0 0l-4.75-4.75M12 15l4.75-4.75" />' + '<path d="M4.5 15.5v2.75a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25V15.5" />';

  function iconSvg(className, extraStyle) {
    return `<svg ${className ? `class="${className}"` : ''} viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;${extraStyle || ''}">${ICON_PATHS}</svg>`;
  }

  let settings = { ...SP.DEFAULT_SETTINGS };
  let route = SP.parseRoute(location.hash);
  let lastHash = location.hash;
  let jobs = [];
  let meta = null; // metadata of the series on screen
  let watched = new Set(); // watched video ids of `meta`
  let panelOpen = false;
  let message = '';
  let busy = false;
  let autoState = '';
  let autoTimer = null;
  let currentTorrent = null; // torrent stream currently playing
  let lastContextHref = null; // stream link that was right-clicked last
  let lastContextVideo = null; // episode list item that was right-clicked last
  const autoQueued = new Set();
  const decoded = new Map(); // player href -> torrent info (or null)

  // The page on top. Earlier pages stay mounted below it.
  function activeRoot() {
    const all = document.querySelectorAll('.route-container');
    return all.length ? all[all.length - 1] : document;
  }

  // Installed addons, read from Stremio's own local storage.
  function getAddons() {
    try {
      const profile = JSON.parse(localStorage.getItem('profile'));
      return (profile.addons || []).map((a) => ({
        transportUrl: a.transportUrl,
        manifest: {
          id: a.manifest.id,
          name: a.manifest.name,
          resources: a.manifest.resources,
          types: a.manifest.types,
          idPrefixes: a.manifest.idPrefixes,
        },
      }));
    } catch (_) {
      return [];
    }
  }

  async function torrentFromHref(href) {
    if (decoded.has(href)) return decoded.get(href);
    const r = SP.parseRoute(href);
    let t = null;
    if (r.name === 'player' && r.stream) {
      try {
        t = SP.torrentInfo(await SP.decodeStream(r.stream));
      } catch (_) {}
      if (t) t.route = r;
    }
    decoded.set(href, t);
    return t;
  }

  // ---- Last watched stream ----------------------------------------------------------
  // stremio-core remembers the last stream played per episode (StreamsBucket; this is what
  // the "Last used" flag in the stream list comes from). It's stored in localStorage as
  // { uid, items } where items holds [{ metaId, videoId }, { stream, metaId, videoId, mtime, ... }]
  // pairs. The newest torrent stream of a title is what automatic picks are matched to.

  let streamsKey = null;
  let streamsKeyCheckedAt = 0;

  function streamItems(raw) {
    const items = raw && raw.items;
    if (!items) return null;
    const list = Array.isArray(items) ? items.map((x) => (Array.isArray(x) ? x[1] : x)) : Object.values(items);
    return list.filter((v) => v && typeof v === 'object');
  }

  function readStreamItems() {
    const parse = (k) => {
      try {
        return streamItems(JSON.parse(localStorage.getItem(k)));
      } catch (_) {
        return null;
      }
    };
    if (streamsKey) return parse(streamsKey) || [];
    // Find the storage key once (it's "streams" in current versions).
    if (Date.now() - streamsKeyCheckedAt < 60000) return [];
    streamsKeyCheckedAt = Date.now();
    const keys = ['streams', ...Object.keys(localStorage).filter((k) => /stream/i.test(k) && k !== 'streams')];
    for (const k of keys) {
      const list = parse(k);
      if (list && list.some((v) => v.stream && v.metaId)) {
        streamsKey = k;
        return list;
      }
    }
    return [];
  }

  // { infoHash, bingeGroup, resolution, at, videoId } of the newest torrent stream played for metaId.
  function lastWatchedStream(metaId) {
    let best = null;
    for (const item of readStreamItems()) {
      if (item.metaId !== metaId) continue;
      const t = SP.torrentInfo(item.stream);
      const at = new Date(item.mtime || 0).getTime() || 0;
      if (t && (!best || at > best.at)) best = { ...t, at, videoId: item.videoId };
    }
    return best;
  }

  // ---- Watched episodes ---------------------------------------------------------
  // Stremio keeps the library in localStorage. A series' watched episodes are stored as
  // "{anchorVideoId}:{anchorLength}:{base64(zlib(bitfield))}" over the video ids sorted
  // by season, episode, release date (stremio-core LibraryItemState::watched_bitfield).

  function readLibraryItem(id) {
    let best = null;
    for (const key of ['library_recent', 'library']) {
      try {
        const item = JSON.parse(localStorage.getItem(key)).items[id];
        if (item && (!best || new Date(item._mtime) > new Date(best._mtime))) best = item;
      } catch (_) {}
    }
    return best;
  }

  // Returns the set of watched video ids for the series in `m` (empty if unknown).
  async function watchedIds(m) {
    const item = readLibraryItem(m.id);
    try {
      return await SP.decodeWatched(item && item.state && item.state.watched, m.videos);
    } catch (_) {
      return new Set();
    }
  }

  async function updateWatched() {
    if (meta) watched = await watchedIds(meta);
  }

  function isReleased(v) {
    return !v.released || new Date(v.released).getTime() <= Date.now();
  }

  // Is the job's episode / movie watched according to the Stremio library?
  // Returns null when unknown (not in the library, metadata unavailable).
  const metaCache = new Map(); // series id -> { at, meta }
  async function seriesMeta(id) {
    const hit = metaCache.get(id);
    if (hit && Date.now() - hit.at < 30 * 60000) return hit.meta;
    if (meta && meta.id === id) return meta;
    const r = await api('POST', '/api/meta', { type: 'series', id, addons: getAddons() });
    const m = r.ok ? r.data.meta : null;
    metaCache.set(id, { at: Date.now(), meta: m });
    return m;
  }

  async function isJobWatched(job) {
    const item = readLibraryItem(job.metaId);
    const state = item && item.state;
    if (!state) return null;
    if (job.type === 'movie' || job.videoId === job.metaId) {
      return (state.timesWatched || 0) > 0 || (state.flaggedWatched || 0) > 0;
    }
    const m = await seriesMeta(job.metaId);
    if (!m || !m.videos || !m.videos.some((v) => v.id === job.videoId)) return null;
    try {
      return (await SP.decodeWatched(state.watched, m.videos)).has(job.videoId);
    } catch (_) {
      return null;
    }
  }

  // Tells the helper which prefetched files are watched, so it can delete them after a
  // grace period. Runs while Stremio Web is open; the library there syncs from the
  // account, so episodes watched on other devices are picked up too.
  let lastWatchedSync = 0;
  async function syncWatched() {
    if (Date.now() - lastWatchedSync < 60000) return;
    lastWatchedSync = Date.now();
    const watchedJobs = [];
    const unwatchedJobs = [];
    for (const job of jobs) {
      if (!job.metaId || !job.videoId) continue;
      const w = await isJobWatched(job);
      if (w === true && !job.watchedAt) watchedJobs.push(job.id);
      else if (w === false && job.watchedAt) unwatchedJobs.push(job.id);
    }
    if (watchedJobs.length || unwatchedJobs.length) {
      const r = await api('POST', '/api/jobs/watched', { watched: watchedJobs, unwatched: unwatchedJobs });
      if (r.ok && r.data.changed) refresh();
    }
  }

  // ---- Episode list ---------------------------------------------------------------

  // "9. Aura the Guillotine" -> { episode: 9, title: "Aura the Guillotine" }
  function parseVideoElement(el) {
    const titleEl = el.querySelector(SEL.videoTitle);
    const text = ((titleEl && titleEl.textContent) || '').trim();
    const m = /^(\d+)\.\s*([\s\S]*)$/.exec(text);
    return { episode: m ? Number(m[1]) : null, title: (m ? m[2] : text).trim() };
  }

  function videoElements() {
    return [...activeRoot().querySelectorAll(SEL.videoItem)].filter((el) => el.querySelector(SEL.videoTitle));
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // The season shown in Stremio's episode list. The list itself is the most reliable
  // source: the season whose (episode number, title) pairs match the list items best.
  function displayedSeason() {
    if (!meta) return null;
    if (Number.isFinite(route.season)) return route.season;
    const items = videoElements().map(parseVideoElement);
    const score = new Map();
    for (const it of items) {
      for (const v of meta.videos) {
        if (it.episode !== null && v.episode !== it.episode) continue;
        const pts = norm(v.title) === norm(it.title) ? 2 : it.episode !== null ? 1 : 0;
        if (pts) score.set(v.season, (score.get(v.season) || 0) + pts);
      }
    }
    if (score.size) {
      const best = [...score.entries()].sort((a, b) => b[1] - a[1]);
      // Only number matches and a tie: not decisive, fall through to the other hints.
      if (best.length === 1 || best[0][1] > best[1][1]) return best[0][0];
    }
    // "Season 2" / "Specials" in the season picker or header.
    for (const el of activeRoot().querySelectorAll('button[aria-haspopup], [class*="season-"]')) {
      const t = (el.textContent || '').trim();
      if (t.length > 40) continue;
      const m = /season\s*(\d+)/i.exec(t);
      if (m) return Number(m[1]);
      if (/^specials?$/i.test(t)) return 0;
    }
    const sel = selectedVideo();
    if (sel) return sel.season;
    const next = nextUpVideo();
    return next ? next.season : null;
  }

  // Maps an episode list item to a video in the metadata.
  function videoFromElement(el, season) {
    if (!meta || !el) return null;
    const { episode, title } = parseVideoElement(el);
    if (season === undefined) season = displayedSeason();
    const candidates = meta.videos.filter((v) => episode === null || v.episode === episode);
    const sameTitle = candidates.filter((v) => norm(v.title || v.id) === norm(title));
    return (
      sameTitle.find((v) => v.season === season) ||
      candidates.find((v) => v.season === season) ||
      (sameTitle.length === 1 ? sameTitle[0] : null)
    );
  }

  function selectedVideo() {
    return meta && route.videoId ? meta.videos.find((v) => v.id === route.videoId) : null;
  }

  // The episode Stremio would "Resume" / play next.
  function nextUpVideo() {
    if (!meta) return null;
    const item = readLibraryItem(meta.id);
    const current = item && item.state && item.state.video_id;
    const v = current && meta.videos.find((x) => x.id === current);
    if (v) return v;
    return meta.videos.find((x) => x.season > 0 && isReleased(x) && !watched.has(x.id)) || null;
  }

  function seasonName(s) {
    return s === 0 ? 'specials' : `season ${s}`;
  }

  function jobFor(t) {
    return jobs.find((j) => j.infoHash === t.infoHash && (t.fileIdx === null || j.fileIdx === t.fileIdx));
  }

  // The prefetch job of an episode / movie, ignoring removed and failed ones.
  function jobForVideo(videoId) {
    const list = jobs.filter((j) => j.videoId === videoId);
    return list.find((j) => j.status !== 'failed') || list[0] || null;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ---- Dropdown panel + toast (shadow DOM, isolated from Stremio's CSS) ----------

  const host = document.createElement('div');
  host.id = 'stremio-prefetch-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: inherit; }
      .panel { position: fixed; z-index: 2147483647; width: 360px; max-height: 70vh; overflow: auto;
        background: #1b1a2b; color: #eee; border-radius: 12px; padding: 14px; font: 13px system-ui, sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,.6); border: 1px solid #2d2b45; }
      .hidden { display: none; }
      .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
      .head h3 { margin: 0; font-size: 15px; }
      .card { background: #24223a; border-radius: 10px; padding: 10px; margin-bottom: 10px; }
      .card .line { display: flex; gap: 8px; align-items: center; }
      .card .line + .line, .card .muted { margin-top: 6px; }
      button.act { background: #7b5bf5; color: #fff; border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
      button.act:hover:not(:disabled) { background: #8f74ff; }
      button.act:disabled { background: #3a3757; color: #aaa; cursor: default; }
      .msg { color: #c9b8ff; margin: 0 0 10px; white-space: pre-wrap; }
      .muted { color: #999; font-size: 12px; }
      .section { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #aaa; margin: 4px 0; }
      ${SP.JOBS_CSS}
      .toast { position: fixed; right: 24px; bottom: 110px; z-index: 2147483647;
        background: #1b1a2b; color: #eee; border: 1px solid #44406a; border-radius: 8px; padding: 8px 14px;
        font: 13px system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.5); max-width: min(360px, 80vw); white-space: pre-wrap; }
      .toast.error { border-color: #e5484d; }

      /* Auto-prefetch badge: a round icon instead of a text toast. */
      .badge { position: fixed; right: 24px; bottom: 110px; z-index: 2147483647; width: 44px; height: 44px;
        border-radius: 50%; background: #1b1a2b; border: 1px solid #44406a; box-shadow: 0 6px 20px rgba(0,0,0,.5);
        display: grid; place-items: center; color: #c9b8ff; pointer-events: none;
        animation: sp-in .25s ease-out; transition: opacity .4s, transform .4s; }
      .badge.hidden { display: none; }
      .badge.out { opacity: 0; transform: scale(.6); }
      .badge svg { width: 24px; height: 24px; overflow: visible; }
      .badge .ring { position: absolute; inset: -1px; border-radius: 50%; border: 2px solid transparent;
        border-top-color: #7b5bf5; animation: sp-spin .9s linear infinite; }
      .badge.queued { border-color: #7b5bf5; }
      .badge.queued .arrow { animation: sp-drop 1.1s ease-in-out infinite; }
      .badge.done { color: #46c37b; border-color: #46c37b; }
      .badge.done svg { animation: sp-pop .35s ease-out; }
      .badge.error { color: #e5484d; border-color: #e5484d; animation: sp-in .25s ease-out, sp-shake .4s .25s; }
      @keyframes sp-in { from { opacity: 0; transform: scale(.6); } }
      @keyframes sp-spin { to { transform: rotate(360deg); } }
      @keyframes sp-drop { 0% { transform: translateY(-7px); opacity: 0; } 30%, 70% { opacity: 1; }
        100% { transform: translateY(3px); opacity: 0; } }
      @keyframes sp-pop { 0% { transform: scale(.3); } 70% { transform: scale(1.2); } 100% { transform: scale(1); } }
      @keyframes sp-shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
      @media (prefers-reduced-motion: reduce) { .badge, .badge * { animation: none !important; } }
    </style>
    <div class="panel hidden"></div>
    <div class="toast hidden"></div>
    <div class="badge hidden"></div>
  `;
  const panel = shadow.querySelector('.panel');
  const toastEl = shadow.querySelector('.toast');
  const badgeEl = shadow.querySelector('.badge');
  let toastTimer = null;
  let badgeTimer = null;

  const SVG = (body) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ARROW = '<g class="arrow"><path d="M12 4v10"/><path d="M7.5 10 12 14.5 16.5 10"/></g>';
  const BADGE_ICONS = {
    busy: `<div class="ring"></div>${SVG(ARROW)}`,
    queued: SVG(`${ARROW}<path d="M5 19h14"/>`),
    done: SVG('<path d="M5 12.5 10 17.5 19 7"/>'),
    error: SVG('<path d="M12 6v8"/><path d="M12 18.5v.01"/>'),
  };

  // kind: busy | queued | done | error. `label` is for screen readers.
  // Stays up while busy; the result hides itself after a few seconds.
  function badge(kind, label) {
    clearTimeout(badgeTimer);
    badgeEl.className = `badge ${kind}`;
    badgeEl.innerHTML = BADGE_ICONS[kind];
    badgeEl.setAttribute('role', 'status');
    badgeEl.setAttribute('aria-label', label);
    if (kind === 'busy') return;
    badgeTimer = setTimeout(() => {
      badgeEl.classList.add('out');
      badgeTimer = setTimeout(() => badgeEl.classList.add('hidden'), 400);
    }, 4000);
  }

  function toast(text, isError) {
    toastEl.textContent = text;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 5000);
  }

  // ---- Nav bar icon -----------------------------------------------------------
  // One button per nav button group (each page has its own nav). The panel opens under
  // the button that was clicked.

  let anchorBtn = null;

  function navButtons() {
    return [...document.querySelectorAll('[data-sp-nav]')];
  }

  function ensureNavButtons() {
    for (const container of document.querySelectorAll(SEL.navContainers)) {
      if (container.querySelector(':scope > [data-sp-nav]')) continue;
      // Copy the look of an existing button in the group (fullscreen / profile).
      const ref = SEL.navButtonRefs.map((s) => container.querySelector(`:scope > ${s}:not([data-sp-nav])`)).find(Boolean);
      const refIcon = ref && ref.querySelector('svg');
      const btn = document.createElement('div');
      btn.dataset.spNav = '1';
      if (ref) btn.className = [...ref.classList].filter((c) => !/^fullscreen-button-/.test(c)).join(' ');
      else btn.style.cssText = 'width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;';
      btn.setAttribute('role', 'button');
      btn.title = 'Stremio Prefetch';
      btn.style.position = 'relative';
      btn.style.cursor = 'pointer';
      btn.innerHTML =
        iconSvg(refIcon ? refIcon.getAttribute('class') : '', refIcon ? '' : 'width:22px;height:22px') +
        '<span data-sp-count style="position:absolute;top:0;right:-2px;min-width:16px;height:16px;padding:0 4px;' +
        'border-radius:8px;background:#7b5bf5;color:#fff;font:700 10px/16px system-ui,sans-serif;text-align:center;display:none;pointer-events:none"></span>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        panelOpen = !(panelOpen && anchorBtn === btn);
        anchorBtn = btn;
        if (panelOpen) message = '';
        render();
        if (panelOpen) refresh();
      });
      container.insertBefore(btn, container.firstChild);
      updateCount();
    }
  }

  function updateCount() {
    const active = jobs.filter((j) => ['queued', 'starting', 'active'].includes(j.status)).length;
    for (const btn of navButtons()) {
      const badge = btn.querySelector('[data-sp-count]');
      const text = active ? String(active) : '';
      if (badge.textContent !== text) badge.textContent = text;
      const display = active ? 'block' : 'none';
      if (badge.style.display !== display) badge.style.display = display;
    }
  }

  function isVisible(el) {
    if (!el || !document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function positionPanel() {
    const btn = isVisible(anchorBtn) ? anchorBtn : navButtons().find(isVisible);
    if (!btn) {
      panel.style.top = '70px';
      panel.style.right = '16px';
      return;
    }
    const r = btn.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  // Close the dropdown when clicking anywhere else.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!panelOpen) return;
      const path = e.composedPath();
      if (path.includes(host) || path.some((el) => el.dataset && el.dataset.spNav)) return;
      panelOpen = false;
      render();
    },
    true,
  );

  // ---- Panel content ------------------------------------------------------------

  // Only actions that have no button in the page itself. Movies, seasons, episodes and
  // streams are prefetched from the page (button next to Play / Resume / Trailer, right-click).
  function contextHtml() {
    if (route.name === 'player' && route.type === 'series') {
      return `<div class="card"><div class="line">
          <button class="act" data-act="next" ${currentTorrent && !busy ? '' : 'disabled'}>Prefetch next episode now</button></div>
        <div class="muted">${esc(autoState)}</div></div>`;
    }
    return '';
  }

  const expandedGroups = new Map(); // download groups the user opened / closed

  function render() {
    if (dead) return;
    updateCount();
    updateActionButton();
    panel.classList.toggle('hidden', !panelOpen);
    if (!panelOpen) return;
    positionPanel();
    const downloading = jobs.filter((j) => ['queued', 'starting', 'active'].includes(j.status)).length;
    panel.innerHTML = `
      <div class="head"><h3>Stremio Prefetch</h3><span class="muted">${downloading ? `${downloading} downloading` : ''}</span></div>
      ${contextHtml()}
      ${message ? `<div class="msg">${esc(message)}</div>` : ''}
      <div class="section">Downloads</div>
      ${SP.jobsListHtml(jobs, { currentKey: route.id, expanded: expandedGroups })}`;
  }

  window.addEventListener('resize', () => panelOpen && positionPanel());

  panel.addEventListener(
    'toggle',
    (e) => e.target.dataset && e.target.dataset.group && expandedGroups.set(e.target.dataset.group, e.target.open),
    true,
  );

  panel.addEventListener('click', async (e) => {
    const { del, retry, act } = e.target.dataset;
    if (del) {
      await api('DELETE', `/api/jobs/${del}`);
      return refresh();
    }
    if (retry) {
      await api('POST', `/api/jobs/${retry}/retry`);
      return refresh();
    }
    if (act === 'next') await queue({ nextAfter: route.videoId, count: settings.autoNextCount }, currentTorrent);
  });

  // What automatic picks are matched to (see referenceStream in the helper):
  // the stream playing now, else the stream Stremio last played for this title.
  function preferFor(playing) {
    if (playing) {
      return { infoHash: playing.infoHash, bingeGroup: playing.bingeGroup, resolution: playing.resolution, source: 'playing', at: Date.now() };
    }
    const last = route.id && lastWatchedStream(route.id);
    if (!last) return undefined;
    return { infoHash: last.infoHash, bingeGroup: last.bingeGroup, resolution: last.resolution, source: 'lastWatched', at: last.at };
  }

  async function queue(select, playing) {
    busy = true;
    message = 'Looking up streams…';
    render();
    const r = await api('POST', '/api/queue', {
      type: route.type,
      metaId: route.id,
      addons: getAddons(),
      select,
      prefer: preferFor(playing),
    });
    busy = false;
    message = r.ok ? summarize(r.data) : `Error: ${r.error}`;
    await refresh();
    return r;
  }

  function summarize(data) {
    if (data.message) return data.message;
    const ok = data.results.filter((x) => x.ok);
    const failed = data.results.filter((x) => !x.ok);
    const added = ok.filter((x) => x.added).length;
    let s = `Queued ${added} item${added === 1 ? '' : 's'}`;
    const dupes = ok.length - added;
    if (dupes) s += ` (${dupes} already prefetched)`;
    if (added && data.basis) s += `\nSource: ${data.basis}`;
    if (failed.length) s += `\nFailed: ${failed.map((x) => `${x.label}: ${x.reason}`).join('\n')}`;
    return s;
  }

  // [kind, label] for the badge shown while watching; details stay in the panel.
  function badgeFor(data) {
    const results = data.results || [];
    const added = results.filter((x) => x.ok && x.added);
    if (added.length === 1) {
      const ep = /S\d+E\d+/i.exec(added[0].label || '');
      return ['queued', `Prefetching ${ep ? ep[0].toUpperCase() : 'next episode'}`];
    }
    if (added.length) return ['queued', `Prefetching ${added.length} episodes`];
    if (results.some((x) => x.ok)) return ['done', 'Next episode already prefetched'];
    if (results.length) return ['error', 'Prefetch failed'];
    return ['done', 'Nothing to prefetch'];
  }

  async function refresh() {
    const r = await api('GET', '/api/jobs');
    if (dead) return;
    if (r.ok) jobs = r.data.jobs;
    else if (panelOpen) message = r.error;
    await updateWatched();
    render();
    updateStreamTags();
    if (r.ok) syncWatched().catch(() => {});
  }

  // ---- Prefetch button next to Play / Resume (or Trailer) ------------------------------
  // Movie page: the movie. Episode page (series with an episode open): that episode.
  // Series page: the unwatched episodes of the season shown in the episode list.

  // Button state for a single movie / episode.
  function singleButtonState(videoId, idleLabel, what) {
    const job = jobForVideo(videoId);
    const idle = canStart(job);
    return {
      label: idle ? idleLabel : job.status === 'done' ? 'Prefetched' : `Prefetching ${Math.floor((job.progress || 0) * 100)}%`,
      title:
        job && job.status === 'failed'
          ? `Last attempt failed: ${job.error || ''}. Click to try again.`
          : `Download this ${what} on the Stremio server`,
      done: !!job && job.status === 'done',
      disabled: !idle,
      run: () => queueFromButton({ videoIds: [videoId] }),
    };
  }

  // What the button does and shows on the current page, or null to hide it.
  function actionButtonState() {
    if (route.name !== 'detail') return null;
    if (route.type === 'movie') return singleButtonState(route.id, 'Prefetch', 'movie');
    if (route.type !== 'series' || !meta) return null;
    if (route.videoId) {
      const v = selectedVideo();
      return v && isReleased(v) ? singleButtonState(v.id, 'Prefetch episode', 'episode') : null;
    }
    const season = displayedSeason();
    if (season === null || season === undefined) return null;
    const name = season === 0 ? 'specials' : `S${season}`;
    const targets = meta.videos.filter((v) => v.season === season && isReleased(v) && !watched.has(v.id));
    const states = targets.map((v) => jobForVideo(v.id)).map((j) => (j ? j.status : null));
    const done = states.filter((s) => s === 'done').length;
    const busyCount = states.filter((s) => ['queued', 'starting', 'active'].includes(s)).length;
    const todo = targets.length - done - busyCount;
    let label;
    if (!targets.length) label = `${name} watched`;
    else if (done === targets.length) label = `${name} prefetched`;
    else if (busyCount) label = `Prefetching ${name} · ${done}/${targets.length}`;
    else label = `Prefetch ${name}`;
    return {
      label,
      title: targets.length
        ? `Download the ${targets.length} unwatched episode${targets.length === 1 ? '' : 's'} of ${seasonName(season)} on the Stremio server` +
          (todo ? ` (${todo} not prefetched yet)` : '')
        : `All released episodes of ${seasonName(season)} are watched`,
      done: !!targets.length && done === targets.length,
      disabled: !targets.length || todo === 0,
      run: () => queueFromButton({ videoIds: targets.map((v) => v.id) }, seasonName(season)),
    };
  }

  async function queueFromButton(select, what) {
    if (!select.videoIds.length) return;
    toast(`Looking up streams${what ? ` for ${what}` : ''}…`);
    const r = await queue(select);
    toast(r.ok ? summarize(r.data) : `Prefetch failed: ${r.error}`, !r.ok);
  }

  let actionBtnState = null;

  function updateActionButton() {
    const root = activeRoot();
    const existing = root.querySelector('[data-sp-action]');
    const primary = route.name === 'detail' ? root.querySelector(SEL.primaryPlay) : null;
    const group = route.name !== 'detail' ? null : primary ? primary.parentElement.querySelector(SEL.secondaryActions) : root.querySelector(SEL.anyActions);
    actionBtnState = primary || group ? actionButtonState() : null;
    if (!actionBtnState) {
      if (existing) existing.remove();
      return;
    }
    let btn = existing;
    if (!btn) {
      const secondary = group;
      // Copy the look of the "Trailer" button when there is one.
      const template = secondary && [...secondary.children].find((el) => /(^|\s)button-/.test(el.className) && !/(^|\s)round-/.test(el.className));
      btn = document.createElement('div');
      btn.dataset.spAction = '1';
      btn.setAttribute('role', 'button');
      btn.tabIndex = 0;
      const tplIcon = template && template.querySelector('svg');
      const tplLabel = template && template.querySelector('[class*="label-"]');
      if (template) btn.className = template.className;
      else
        btn.style.cssText =
          'display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 20px;border-radius:24px;' +
          'background:rgba(255,255,255,.08);color:#fff;font-weight:600;';
      btn.innerHTML =
        iconSvg(tplIcon ? tplIcon.getAttribute('class') : '', tplIcon ? '' : 'width:20px;height:20px') +
        `<div data-sp-label ${tplLabel ? `class="${tplLabel.className}"` : ''}></div>`;
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (actionBtnState && !actionBtnState.disabled) actionBtnState.run();
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && actionBtnState && !actionBtnState.disabled) actionBtnState.run();
      });
      if (secondary) secondary.insertBefore(btn, secondary.firstChild);
      else primary.after(btn);
    }
    // Only touch the DOM when something changed, or the MutationObserver loops.
    const s = actionBtnState;
    const label = btn.querySelector('[data-sp-label]');
    const text = `${s.label}${s.done ? ' ✓' : ''}`;
    if (label.textContent !== text) label.textContent = text;
    if (btn.title !== s.title) btn.title = s.title;
    const opacity = s.disabled ? '0.55' : '';
    if (btn.style.opacity !== opacity) btn.style.opacity = opacity;
  }

  // ---- Right-click menus ----------------------------------------------------------

  // Stremio opens the episode menu on mouseup, before the "contextmenu" event, so the
  // target is recorded on pointerdown as well. Only right-clicks count: a left-click on
  // an episode opens its stream list, whose addon tabs look like a menu too.
  function rememberTarget(e) {
    const target = e.target && e.target.closest ? e.target : null;
    if (target && target.closest(SEL.ctxMenu)) return;
    const isContext = e.type === 'contextmenu' || e.button === 2;
    const a = target && target.closest(SEL.streamLink);
    lastContextHref = a ? a.getAttribute('href') : null;
    lastContextVideo = isContext && target && route.name === 'detail' ? target.closest(SEL.videoItem) : null;
  }
  document.addEventListener('pointerdown', rememberTarget, true);
  document.addEventListener('contextmenu', rememberTarget, true);

  function closeStremioMenu() {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  }

  // Clones one of Stremio's own menu options so the new item looks native.
  function addMenuItem(menu, after, text, onClick) {
    const template = menu.querySelector(SEL.ctxOption);
    const item = template.cloneNode(true);
    ['href', 'target', 'download', 'title', 'data-link'].forEach((a) => item.removeAttribute(a));
    item.dataset.spItem = '1';
    const oldIcon = item.querySelector('svg');
    if (oldIcon) oldIcon.outerHTML = iconSvg(oldIcon.getAttribute('class'));
    (item.querySelector(SEL.ctxLabel) || item).textContent = text;
    item.title = text;
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeStremioMenu();
      onClick();
    });
    (after || template).after(item);
    return item;
  }

  function jobText(job, idleText) {
    if (!job) return idleText;
    if (job.status === 'done') return 'Prefetched ✓ (ready)';
    if (job.status === 'watched') return `${idleText} again`;
    if (job.status === 'failed') return `${idleText} (last attempt failed)`;
    return `Prefetching… ${Math.floor((job.progress || 0) * 100)}%`;
  }

  // Jobs that a click can (re)start.
  const canStart = (job) => !job || ['failed', 'watched'].includes(job.status);

  async function decorateStreamMenu(menu, href) {
    const t = await torrentFromHref(href);
    if (!t || !document.contains(menu)) return; // not a torrent (e.g. HTTP stream)
    const job = jobFor(t);
    addMenuItem(menu, null, jobText(job, 'Prefetch on server'), async () => {
      if (!canStart(job)) return;
      const r = t.route;
      const res = await api('POST', '/api/jobs', {
        addons: getAddons(),
        items: [{ ...t, route: undefined, type: r.type, metaId: r.id, videoId: r.videoId, streamTitle: t.title }],
      });
      if (res.ok) toast(`Prefetching ${res.data.results[0].label}`);
      else toast(`Prefetch failed: ${res.error}`, true);
      refresh();
    });
  }

  async function queueFromMenu(videoIds, emptyMessage) {
    if (!videoIds.length) return toast(emptyMessage);
    toast('Looking up streams…');
    const r = await queue({ videoIds });
    toast(r.ok ? summarize(r.data) : `Prefetch failed: ${r.error}`, !r.ok);
  }

  function decorateEpisodeMenu(menu, videoEl) {
    const video = videoFromElement(videoEl);
    if (!video) return;
    const job = jobForVideo(video.id);
    const options = menu.querySelectorAll(SEL.ctxOption);
    addMenuItem(menu, options[options.length - 1], jobText(job, 'Prefetch episode'), () => {
      if (canStart(job)) queueFromMenu([video.id]);
    });
  }

  function decorateMenu(menu) {
    menu.dataset.spDone = '1';
    if (!menu.querySelector(SEL.ctxOption)) return undefined;
    // Episode menus also contain a "#/player/..." link (Watch), so check the menu type first.
    if (menu.matches(SEL.episodeMenu)) {
      // Older lists render the menu inside the list item, newer ones in a portal.
      const videoEl = menu.closest(SEL.videoItem) || lastContextVideo;
      if (videoEl && route.name === 'detail' && route.type === 'series' && meta) return decorateEpisodeMenu(menu, videoEl);
      return undefined;
    }
    if (!menu.matches(SEL.streamMenu)) return undefined;
    const playLink = menu.querySelector(SEL.streamLink);
    const href = (playLink && playLink.getAttribute('href')) || lastContextHref;
    return href ? decorateStreamMenu(menu, href) : undefined;
  }

  // ---- Status tags on streams and episodes ----------------------------------------

  function tagFor(job) {
    if (!job || job.status === 'watched') return null;
    if (job.status === 'done') return { text: '✓ Prefetched', bg: '#2f9e6e' };
    if (job.status === 'failed') return { text: '! Prefetch failed', bg: '#c0392b' };
    return { text: `⬇ ${Math.floor((job.progress || 0) * 100)}%`, bg: '#7b5bf5' };
  }

  // Puts (or updates / removes) a small inline tag as the last child of `parent`.
  function setTag(parent, tag, inRow) {
    let el = parent.querySelector(':scope > [data-sp-tag]');
    if (!tag) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.dataset.spTag = '1';
      el.style.cssText =
        (inRow ? 'margin:0 0 0 8px;align-self:center;' : 'margin-top:6px;align-self:flex-start;') +
        'display:inline-block;width:fit-content;flex:none;padding:1px 7px;border-radius:9px;' +
        'color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap;pointer-events:none;';
      parent.appendChild(el);
    }
    // Only touch the DOM when something changed, or the MutationObserver loops.
    if (el.textContent !== tag.text) el.textContent = tag.text;
    if (el.dataset.bg !== tag.bg) {
      el.dataset.bg = tag.bg;
      el.style.background = tag.bg;
    }
  }

  async function updateStreamTags() {
    if (dead) return;
    updateActionButton();
    if (!settings.streamButtons) return;
    const root = activeRoot();
    // Streams: tag goes next to the "<Addon> <Resolution>" name.
    for (const a of root.querySelectorAll(SEL.streamLink)) {
      if (a.closest(SEL.ctxMenu)) continue;
      const t = await torrentFromHref(a.getAttribute('href'));
      const heading = a.querySelector(SEL.streamHeading);
      const parent = heading || a.querySelector(SEL.streamInfo);
      if (parent) setTag(parent, t && tagFor(jobFor(t)), !!heading);
    }
    // Episodes: tag goes in the row with the release date / watched flag.
    if (route.name === 'detail' && route.type === 'series' && meta) {
      const season = displayedSeason();
      for (const el of videoElements()) {
        const video = videoFromElement(el, season);
        const job = video && jobForVideo(video.id);
        const row = el.querySelector(SEL.videoRow);
        const parent = row || el.querySelector('[class*="info-container"]');
        if (parent) setTag(parent, tagFor(job), !!row);
      }
    }
  }

  function onDomChange() {
    checkRoute();
    ensureNavButtons();
    if (settings.streamButtons) {
      document.querySelectorAll(`:is(${SEL.ctxMenu}):not([data-sp-done])`).forEach(decorateMenu);
    }
  }

  let tagsPending = false;
  function scheduleTags() {
    if (tagsPending) return;
    tagsPending = true;
    setTimeout(() => {
      tagsPending = false;
      updateStreamTags();
    }, 300);
  }

  // ---- Auto-prefetch next episode ----------------------------------------------

  async function setupPlayer() {
    currentTorrent = null;
    autoState = '';
    if (route.name !== 'player' || !route.stream) return;
    try {
      currentTorrent = SP.torrentInfo(await SP.decodeStream(route.stream));
    } catch (_) {}
    if (route.type !== 'series' || !route.videoId) return;
    if (!currentTorrent) {
      autoState = 'Current stream is not a torrent; auto-prefetch is off for it.';
      return;
    }
    if (!settings.autoNext) {
      autoState = 'Auto-prefetch is disabled in the extension options.';
      return;
    }
    const videoId = route.videoId;
    if (autoQueued.has(videoId)) {
      autoState = 'Next episode already queued.';
      return;
    }
    const delay = settings.autoNextDelaySec;
    autoState = `Next ${settings.autoNextCount} episode(s) will be prefetched after ${delay}s of watching.`;
    autoTimer = setTimeout(async () => {
      if (SP.parseRoute(location.hash).videoId !== videoId) return;
      autoQueued.add(videoId);
      autoState = 'Queuing next episode…';
      badge('busy', autoState);
      render();
      const r = await queue({ nextAfter: videoId, count: settings.autoNextCount }, currentTorrent);
      autoState = r.ok ? `Auto-prefetch: ${summarize(r.data)}` : `Auto-prefetch failed: ${r.error}`;
      if (r.ok) badge(...badgeFor(r.data));
      else {
        badge('error', autoState);
        autoQueued.delete(videoId);
      }
      render();
    }, delay * 1000);
  }

  // ---- Routing -----------------------------------------------------------------

  function checkRoute() {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    onRoute();
  }

  async function onRoute() {
    const prevId = route.id;
    route = SP.parseRoute(location.hash);
    clearTimeout(autoTimer);
    message = '';
    if (route.id !== prevId) {
      meta = null;
      watched = new Set();
    }
    await setupPlayer();
    render();
    if (route.name === 'detail' && route.type === 'series' && !meta) {
      const id = route.id;
      const r = await api('POST', '/api/meta', { type: 'series', id, addons: getAddons() });
      if (route.id !== id) return;
      if (r.ok) {
        meta = r.data.meta;
        await updateWatched();
      } else {
        message = r.error;
      }
    }
    render();
    scheduleTags();
  }

  const timers = [];
  let observer = null;

  // Stops this copy of the script and removes everything it added to the page. Called
  // when the extension was reloaded or updated: the copy in already-open tabs then
  // can't reach the extension anymore ("Extension context invalidated").
  function shutdown() {
    if (dead) return;
    dead = true;
    timers.forEach(clearInterval);
    clearTimeout(autoTimer);
    if (observer) observer.disconnect();
    window.removeEventListener('hashchange', checkRoute);
    window.removeEventListener('popstate', checkRoute);
    document.removeEventListener('pointerdown', rememberTarget, true);
    document.removeEventListener('contextmenu', rememberTarget, true);
    document.querySelectorAll('[data-sp-nav], [data-sp-action], [data-sp-tag], [data-sp-item]').forEach((el) => el.remove());
    host.remove();
  }

  async function loadSettings() {
    const s = await send({ type: 'settings' });
    if (s && !s.error) settings = s;
  }

  async function init() {
    await loadSettings();
    if (dead) return;
    document.body.appendChild(host);
    window.addEventListener('hashchange', checkRoute);
    window.addEventListener('popstate', checkRoute);
    timers.push(setInterval(checkRoute, 300));
    observer = new MutationObserver(() => {
      onDomChange();
      scheduleTags();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener(() => !dead && loadSettings());
    await onRoute();
    onDomChange();
    refresh();
    timers.push(setInterval(() => (panelOpen || document.querySelector('[data-sp-tag], [data-sp-action]') ? refresh() : null), 4000));
    timers.push(setInterval(refresh, 20000));
  }

  init();
})();
