// Runs on web.stremio.com. Adds:
//  - a download icon in the top-right nav bar (next to fullscreen / profile) that opens
//    a dropdown with movie / episode / season actions and download status
//  - a "Prefetch on server" item in the right-click menu of torrent streams, plus a small
//    status tag on streams that are already prefetched
//  - auto-prefetch of the next episode(s) while watching a series
//
// Stremio's CSS class names are hashed (e.g. "buttons-container-XbKVa"), so elements are
// matched on the stable prefix with [class*="..."] and pages are detected from the URL.

(() => {
  const api = (method, path, body) => chrome.runtime.sendMessage({ type: 'api', method, path, body });

  const SEL = {
    navButtons: 'nav[class*="horizontal-nav-bar-container"] > [class*="buttons-container"]',
    navButton: '[class*="button-container"]',
    streamLink: 'a[href^="#/player/"]',
    ctxMenu: '[class*="context-menu-content"]',
    ctxOption: '[class*="context-menu-option-container"]',
    ctxLabel: '[class*="context-menu-option-label"]',
    infoContainer: '[class*="info-container"]',
    videoItem: '[class*="video-container"]',
    videoTitle: '[class*="title-container"]',
    videoRow: '[class*="flex-row-container"]',
    seasonLabel: '[class*="seasons-popup-label-container"]',
  };

  const ICON_PATHS =
    '<path d="M12 3.5v11.5m0 0l-4.75-4.75M12 15l4.75-4.75" />' + '<path d="M4.5 15.5v2.75a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25V15.5" />';

  function iconSvg(className) {
    return `<svg ${className ? `class="${className}"` : ''} viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${ICON_PATHS}</svg>`;
  }

  let settings = { ...SP.DEFAULT_SETTINGS };
  let route = SP.parseRoute(location.hash);
  let jobs = [];
  let meta = null; // metadata of the series on screen
  let selectedSeason = null;
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

  function isReleased(v) {
    return !v.released || new Date(v.released).getTime() <= Date.now();
  }

  async function unwatchedInSeason(season, fromVideoId) {
    const watched = await watchedIds(meta);
    let list = meta.videos.filter((v) => v.season === season && isReleased(v));
    if (fromVideoId) {
      const from = list.findIndex((v) => v.id === fromVideoId);
      if (from >= 0) list = list.slice(from);
    }
    return list.filter((v) => !watched.has(v.id)).map((v) => v.id);
  }

  // Season currently shown in Stremio's episode list.
  function displayedSeason() {
    if (Number.isFinite(route.season)) return route.season;
    const label = document.querySelector(SEL.seasonLabel);
    const m = label && /(\d+)/.exec(label.getAttribute('title') || label.textContent || '');
    if (m) return Number(m[1]);
    const sel = selectedVideo();
    return sel ? sel.season : selectedSeason;
  }

  // Maps an episode list item ("3. Episode title") to a video in the metadata.
  function videoFromElement(el) {
    if (!meta || !el) return null;
    const titleEl = el.querySelector(SEL.videoTitle);
    const text = ((titleEl && titleEl.textContent) || '').trim();
    const m = /^(\d+)\.\s*([\s\S]*)$/.exec(text);
    const episode = m ? Number(m[1]) : null;
    const title = m ? m[2].trim() : text;
    const season = displayedSeason();
    const candidates = meta.videos.filter((v) => episode === null || v.episode === episode);
    return (
      candidates.find((v) => v.season === season && (v.title || v.id) === title) ||
      candidates.find((v) => v.season === season) ||
      (candidates.filter((v) => (v.title || v.id) === title).length === 1 ? candidates.find((v) => (v.title || v.id) === title) : null)
    );
  }

  function jobFor(t) {
    return jobs.find((j) => j.infoHash === t.infoHash && (t.fileIdx === null || j.fileIdx === t.fileIdx));
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
      h3 { margin: 0 0 10px; font-size: 15px; }
      h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #aaa; }
      button.act { background: #2d2b45; color: #fff; border: 1px solid #44406a; border-radius: 6px; padding: 6px 9px;
        margin: 0 6px 6px 0; cursor: pointer; font-size: 12px; }
      button.act:hover:not(:disabled) { background: #7b5bf5; }
      button.act:disabled { opacity: .4; cursor: default; }
      select { background: #2d2b45; color: #fff; border: 1px solid #44406a; border-radius: 6px; padding: 5px; margin-bottom: 8px; }
      .msg { color: #c9b8ff; margin: 6px 0; white-space: pre-wrap; }
      .muted { color: #999; }
      .job { padding: 6px 0; border-top: 1px solid #2d2b45; }
      .job .top { display: flex; justify-content: space-between; gap: 8px; }
      .job .label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .job .x { background: none; border: none; color: #999; cursor: pointer; font-size: 14px; padding: 0 2px; }
      .job .x:hover { color: #fff; }
      .bar { height: 4px; background: #2d2b45; border-radius: 2px; margin-top: 4px; overflow: hidden; }
      .bar div { height: 100%; background: #7b5bf5; }
      .job.done .bar div { background: #3ecf8e; }
      .job.failed .bar div { background: #e5484d; }
      .toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 2147483647;
        background: #1b1a2b; color: #eee; border: 1px solid #44406a; border-radius: 8px; padding: 10px 16px;
        font: 13px system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.5); max-width: 80vw; }
      .toast.error { border-color: #e5484d; }
    </style>
    <div class="panel hidden"></div>
    <div class="toast hidden"></div>
  `;
  const panel = shadow.querySelector('.panel');
  const toastEl = shadow.querySelector('.toast');
  let toastTimer = null;

  function toast(text, isError) {
    toastEl.textContent = text;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 4000);
  }

  // ---- Nav bar icon -----------------------------------------------------------

  let navBtn = null;

  function ensureNavButton() {
    const container = document.querySelector(SEL.navButtons);
    if (!container) return;
    if (navBtn && container.contains(navBtn)) return;
    // Copy the look of an existing nav button (fullscreen / profile).
    const ref = container.querySelector(`:scope > ${SEL.navButton}`) || container.querySelector(SEL.navButton);
    const refIcon = ref && ref.querySelector('svg');
    navBtn = document.createElement('div');
    navBtn.className = ref ? ref.className : '';
    navBtn.setAttribute('role', 'button');
    navBtn.title = 'Stremio Prefetch';
    navBtn.style.position = 'relative';
    navBtn.style.cursor = 'pointer';
    navBtn.innerHTML =
      iconSvg(refIcon ? refIcon.getAttribute('class') : '') +
      '<span data-sp-count style="position:absolute;top:6px;right:4px;min-width:16px;height:16px;padding:0 4px;' +
      'border-radius:8px;background:#7b5bf5;color:#fff;font:700 10px/16px system-ui,sans-serif;text-align:center;display:none"></span>';
    if (!refIcon) navBtn.querySelector('svg').style.cssText += ';width:24px;height:24px';
    navBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panelOpen = !panelOpen;
      render();
      if (panelOpen) refresh();
    });
    container.insertBefore(navBtn, container.firstChild);
    updateCount();
  }

  function updateCount() {
    if (!navBtn) return;
    const active = jobs.filter((j) => ['queued', 'starting', 'active'].includes(j.status)).length;
    const badge = navBtn.querySelector('[data-sp-count]');
    badge.textContent = active;
    badge.style.display = active ? 'block' : 'none';
  }

  function positionPanel() {
    if (!navBtn || !document.contains(navBtn)) {
      panel.style.top = '70px';
      panel.style.right = '16px';
      return;
    }
    const r = navBtn.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  // Close the dropdown when clicking anywhere else.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!panelOpen) return;
      const path = e.composedPath();
      if (path.includes(host) || (navBtn && path.includes(navBtn))) return;
      panelOpen = false;
      render();
    },
    true,
  );

  // ---- Panel content ------------------------------------------------------------

  function seasons() {
    if (!meta) return [];
    return [...new Set(meta.videos.map((v) => v.season).filter((s) => s !== null))].sort((a, b) => (a || 99999) - (b || 99999));
  }

  function selectedVideo() {
    return meta && route.videoId ? meta.videos.find((v) => v.id === route.videoId) : null;
  }

  function actionsHtml() {
    const dis = busy ? 'disabled' : '';
    if (route.name === 'detail' && route.type === 'movie') {
      return `<h4>Movie</h4><button class="act" data-act="movie" ${dis}>Prefetch movie (best stream)</button>
        <div class="muted">Or right-click a specific stream → Prefetch on server.</div>`;
    }
    if (route.name === 'detail' && route.type === 'series') {
      if (!meta) return '<div class="muted">Loading episodes…</div>';
      const sel = selectedVideo();
      const opts = seasons()
        .map((s) => `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${s === 0 ? 'Specials' : `Season ${s}`}</option>`)
        .join('');
      return `<h4>${esc(meta.name)}</h4>
        <select data-role="season">${opts}</select><br>
        <button class="act" data-act="unwatched" ${dis}>Unwatched in season</button>
        <button class="act" data-act="season" ${dis}>Whole season</button>
        <button class="act" data-act="episode" ${sel ? dis : 'disabled'}>Selected episode</button>
        <button class="act" data-act="rest" ${sel ? dis : 'disabled'}>Selected → end of season (unwatched)</button>
        <button class="act" data-act="next3" ${sel ? dis : 'disabled'}>Next 3 after selected</button>
        <div class="muted">${sel ? '' : 'Select an episode to enable the per-episode actions. '}Tip: right-click an episode to prefetch it directly.</div>`;
    }
    if (route.name === 'player' && route.type === 'series') {
      return `<h4>Watching</h4>
        <button class="act" data-act="next" ${currentTorrent ? dis : 'disabled'}>Prefetch next episode now</button>
        <div class="muted">${esc(autoState)}</div>`;
    }
    return '<div class="muted">Open a movie or series to prefetch it.</div>';
  }

  function jobsHtml() {
    const relevant = route.id ? jobs.filter((j) => j.metaId === route.id) : [];
    const list = relevant.length ? relevant : jobs;
    if (!list.length) return '<div class="muted">Nothing prefetched yet.</div>';
    return list
      .slice()
      .reverse()
      .map(
        (j) => `<div class="job ${j.status}" title="${esc(j.fileName || j.streamTitle || '')}">
          <div class="top"><span class="label">${esc(j.label)}</span><button class="x" data-del="${j.id}" title="Remove">✕</button></div>
          <div class="muted">${esc(SP.jobLine(j))}</div>
          <div class="bar"><div style="width:${j.status === 'done' ? 100 : Math.floor((j.progress || 0) * 100)}%"></div></div>
        </div>`,
      )
      .join('');
  }

  function render() {
    updateCount();
    panel.classList.toggle('hidden', !panelOpen);
    if (!panelOpen) return;
    positionPanel();
    const relevant = route.id && jobs.some((j) => j.metaId === route.id);
    panel.innerHTML = `
      <h3>Stremio Prefetch</h3>
      ${message ? `<div class="msg">${esc(message)}</div>` : ''}
      ${actionsHtml()}
      <h4>${relevant ? 'Downloads for this title' : 'All downloads'}</h4>
      ${jobsHtml()}`;
  }

  window.addEventListener('resize', () => panelOpen && positionPanel());

  panel.addEventListener('change', (e) => {
    if (e.target.dataset.role === 'season') {
      selectedSeason = Number(e.target.value);
      render();
    }
  });

  panel.addEventListener('click', async (e) => {
    const del = e.target.dataset.del;
    if (del) {
      await api('DELETE', `/api/jobs/${del}`);
      return refresh();
    }
    const act = e.target.dataset.act;
    if (!act) return;
    const sel = selectedVideo();
    let select;
    switch (act) {
      case 'movie':
        select = { videoIds: [route.id] };
        break;
      case 'season':
        select = { season: selectedSeason };
        break;
      case 'unwatched':
        select = { videoIds: await unwatchedInSeason(selectedSeason) };
        break;
      case 'episode':
        select = sel && { videoIds: [sel.id] };
        break;
      case 'rest':
        select = sel && { videoIds: await unwatchedInSeason(sel.season, sel.id) };
        break;
      case 'next3':
        select = sel && { nextAfter: sel.id, count: 3 };
        break;
      case 'next':
        select = { nextAfter: route.videoId, count: settings.autoNextCount };
        break;
    }
    if (!select) return;
    if (select.videoIds && !select.videoIds.length) {
      message = 'All episodes in that range are already watched.';
      return render();
    }
    await queue(select, act === 'next' ? currentTorrent : null);
  });

  async function queue(select, prefer) {
    busy = true;
    message = 'Looking up streams…';
    render();
    const r = await api('POST', '/api/queue', {
      type: route.type,
      metaId: route.id,
      addons: getAddons(),
      select,
      prefer: prefer ? { infoHash: prefer.infoHash, bingeGroup: prefer.bingeGroup, resolution: prefer.resolution } : undefined,
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
    let s = `Queued ${ok.length} item${ok.length === 1 ? '' : 's'}`;
    const dupes = ok.filter((x) => !x.added).length;
    if (dupes) s += ` (${dupes} already queued)`;
    if (failed.length) s += `\nFailed: ${failed.map((x) => `${x.label}: ${x.reason}`).join('\n')}`;
    return s;
  }

  async function refresh() {
    const r = await api('GET', '/api/jobs');
    if (r.ok) jobs = r.data.jobs;
    else if (panelOpen) message = r.error;
    render();
    updateStreamTags();
  }

  // ---- Stream right-click menu ----------------------------------------------------

  document.addEventListener(
    'contextmenu',
    (e) => {
      const target = e.target.closest ? e.target : null;
      const a = target && target.closest(SEL.streamLink);
      lastContextHref = a ? a.getAttribute('href') : null;
      lastContextVideo = !a && target && route.name === 'detail' ? target.closest(SEL.videoItem) : null;
    },
    true,
  );

  function closeStremioMenu() {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  }

  // Clones one of Stremio's own menu options so the new item looks native.
  function addMenuItem(menu, after, text, onClick) {
    const template = menu.querySelector(SEL.ctxOption);
    const item = template.cloneNode(true);
    ['href', 'target', 'download', 'title'].forEach((a) => item.removeAttribute(a));
    item.dataset.spItem = '1';
    const oldIcon = item.querySelector('svg');
    if (oldIcon) oldIcon.outerHTML = iconSvg(oldIcon.getAttribute('class'));
    (item.querySelector(SEL.ctxLabel) || item).textContent = text;
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
    if (job.status === 'failed') return `${idleText} (last attempt failed)`;
    return `Prefetching… ${Math.floor((job.progress || 0) * 100)}%`;
  }

  async function decorateStreamMenu(menu, href) {
    const t = await torrentFromHref(href);
    if (!t || !document.contains(menu)) return; // not a torrent (e.g. HTTP stream)
    const job = jobFor(t);
    addMenuItem(menu, null, jobText(job, 'Prefetch on server'), async () => {
      if (job && job.status !== 'failed') return;
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
    const job = jobs.find((j) => j.videoId === video.id && j.status !== 'failed');
    const last = menu.querySelectorAll(SEL.ctxOption);
    let after = last[last.length - 1];
    after = addMenuItem(menu, after, jobText(job, 'Prefetch episode'), () => {
      if (!job) queueFromMenu([video.id]);
    });
    after = addMenuItem(menu, after, 'Prefetch unwatched until end of season', async () =>
      queueFromMenu(await unwatchedInSeason(video.season, video.id), 'All remaining episodes are already watched.'),
    );
    addMenuItem(menu, after, `Prefetch unwatched in ${video.season === 0 ? 'specials' : `season ${video.season}`}`, async () =>
      queueFromMenu(await unwatchedInSeason(video.season), 'All episodes in this season are already watched.'),
    );
  }

  function decorateMenu(menu) {
    menu.dataset.spDone = '1';
    if (!menu.querySelector(SEL.ctxOption)) return;
    const playLink = menu.querySelector(SEL.streamLink);
    const href = (playLink && playLink.getAttribute('href')) || lastContextHref;
    if (href) return decorateStreamMenu(menu, href);
    if (lastContextVideo && route.type === 'series' && meta) return decorateEpisodeMenu(menu, lastContextVideo);
    return undefined;
  }

  // ---- Status tags on streams and episodes ----------------------------------------

  function tagFor(job) {
    if (!job) return null;
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
    if (!settings.streamButtons) return;
    // Streams: tag goes under the "<Source> <Resolution>" name.
    for (const a of document.querySelectorAll(SEL.streamLink)) {
      if (a.closest(SEL.ctxMenu)) continue;
      const t = await torrentFromHref(a.getAttribute('href'));
      const parent = a.querySelector(SEL.infoContainer);
      if (parent) setTag(parent, t && tagFor(jobFor(t)));
    }
    // Episodes: tag goes in the row with the release date / watched flag.
    if (route.name === 'detail' && route.type === 'series' && meta) {
      for (const el of document.querySelectorAll(SEL.videoItem)) {
        const video = videoFromElement(el);
        const job = video && jobs.find((j) => j.videoId === video.id);
        const row = el.querySelector(SEL.videoRow);
        const parent = row || el.querySelector(SEL.infoContainer);
        if (parent) setTag(parent, tagFor(job), !!row);
      }
    }
  }

  function onDomChange() {
    ensureNavButton();
    if (settings.streamButtons) {
      document.querySelectorAll(`${SEL.ctxMenu}:not([data-sp-done])`).forEach(decorateMenu);
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
      render();
      const r = await queue({ nextAfter: videoId, count: settings.autoNextCount }, currentTorrent);
      autoState = r.ok ? `Auto-prefetch: ${summarize(r.data)}` : `Auto-prefetch failed: ${r.error}`;
      if (r.ok) toast(autoState);
      else autoQueued.delete(videoId);
      render();
    }, delay * 1000);
  }

  // ---- Routing -----------------------------------------------------------------

  async function onRoute() {
    const prevId = route.id;
    route = SP.parseRoute(location.hash);
    clearTimeout(autoTimer);
    message = '';
    if (route.id !== prevId) meta = null;
    await setupPlayer();
    render();
    if (route.name === 'detail' && route.type === 'series' && !meta) {
      const id = route.id;
      const r = await api('POST', '/api/meta', { type: 'series', id, addons: getAddons() });
      if (route.id !== id) return;
      if (r.ok) {
        meta = r.data.meta;
        const sel = selectedVideo();
        selectedSeason = route.season ?? (sel ? sel.season : seasons().find((s) => s > 0) ?? seasons()[0] ?? null);
      } else {
        message = r.error;
      }
      render();
      scheduleTags();
    } else if (route.name === 'detail' && route.type === 'series' && meta) {
      const sel = selectedVideo();
      selectedSeason = route.season ?? (sel ? sel.season : selectedSeason);
      render();
      scheduleTags();
    }
  }

  async function init() {
    settings = await chrome.runtime.sendMessage({ type: 'settings' });
    document.body.appendChild(host);
    window.addEventListener('hashchange', onRoute);
    new MutationObserver(() => {
      onDomChange();
      scheduleTags();
    }).observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener(async () => {
      settings = await chrome.runtime.sendMessage({ type: 'settings' });
    });
    await onRoute();
    onDomChange();
    refresh();
    setInterval(() => (panelOpen || document.querySelector('[data-sp-tag]') ? refresh() : null), 4000);
    setInterval(refresh, 20000);
  }

  init();
})();
