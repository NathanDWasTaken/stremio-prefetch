# stremio-prefetch

Prefetch movies and episodes on your own Stremio streaming server, so playback from
[web.stremio.com](https://web.stremio.com) starts instantly and the next episode is
already downloaded when you get to it.

Two parts:

- **`helper/`** — a small Node service that runs on the same machine as the Stremio
  server. It keeps a download queue and keeps each torrent downloading until the file
  is fully cached. It keeps working when your laptop is asleep or the browser is closed.
- **`extension/`** — a Chrome extension (Manifest V3) for web.stremio.com that adds the
  buttons and tells the helper what to download. (Chrome rather than Firefox: Firefox on
  macOS loses video after seeking in .mkv streams.)

## How it works

The Stremio server only downloads a torrent while something is streaming from it, and
it destroys a torrent's engine 120 s after its last stream closes. The helper:

1. calls `POST /{infoHash}/create` to start the torrent and find the right file,
2. opens `GET /{infoHash}/{fileIdx}` and closes it right away (this selects the whole
   file for download), repeating every 45 s so the engine stays alive,
3. polls `/{infoHash}/{fileIdx}/stats.json` until `streamProgress` reaches 1.

The finished file stays in Stremio's cache. When you press play, Stremio reads it from
disk instead of downloading it.

To pick streams automatically (everything except right-clicking a specific stream), the
helper queries your installed addons (the extension sends their URLs from your Stremio
profile) and matches each episode to a reference stream:

1. the stream that is playing (player page / auto-prefetch), else
2. whichever is newer: the stream Stremio last played for this title (its "Last used"
   stream, read from Stremio's local storage) or the last prefetch of this title, else
3. nothing: the most-seeded stream at `defaultResolution` (1080p).

Against the reference it prefers the same torrent (season packs) → the same `bingeGroup`
(same release, e.g. Torrentio's `1080p|WEBRip|x265`) → the most-seeded stream at the same
resolution. Each picked episode becomes the reference for the next one, and episodes that
are already prefetched are kept as they are.

## Setup

### 1. Helper (on the Stremio machine)

No install needed — it runs on the Node runtime that ships with Stremio.

```
start-all.cmd     # starts the Stremio server (headless) + helper in the background
stop-all.cmd      # stops both (stop-all.ps1 -HelperOnly keeps the Stremio server)
helper\start.cmd  # run only the helper in a console, for debugging
```

`start-all` skips anything that's already running, so it's safe to use while the
Stremio desktop app is open. Output of background processes goes to `logs/`.

On first start the helper writes `helper/data/config.json` with a random `token`. The
helper's own log is `helper/data/helper.log`.

If other devices can't reach port 11480, open it in Windows Firewall (admin PowerShell;
the network profile here is Public, so the rule must include it):

```
New-NetFirewallRule -DisplayName "Stremio Prefetch Helper" -Direction Inbound -Protocol TCP -LocalPort 11480 -Action Allow -Profile Any -RemoteAddress LocalSubnet
```

### 2. Stremio cache size

In Stremio → Settings → Streaming, set **Caching** to 10 GB or ∞. With the default 2 GB,
Stremio deletes prefetched files when new torrents start.

### 3. Chrome extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the
`extension` folder. It stays installed across restarts. After changing the code, click
the reload icon on the extension's card.

Then open the extension's options (puzzle icon → Stremio Prefetch → ⋮ → Options) and set:

- **Helper URL**: `http://<stremio-machine-ip>:11480` (on the Stremio machine itself,
  `http://localhost:11480` also works)
- **Token**: from `helper/data/config.json`

Saving asks Chrome for permission to reach that address.

## Using it

- **Stream lists**: right-click a torrent stream → **Prefetch on server** to prefetch
  exactly that stream. Streams that are prefetching or ready get a small status tag.
- **Episode lists**: right-click an episode → **Prefetch episode**. Episodes that are
  prefetching or ready get a status tag. Watched state comes from your Stremio library
  (stored in the browser), decoded the same way stremio-core does.
- **Button next to Play / Resume**: on a series, **Prefetch S*N*** downloads the unwatched
  episodes of the season shown in the episode list (and shows progress); on an episode's
  page (with its stream list), **Prefetch episode** downloads that episode; on a movie,
  **Prefetch** downloads the movie.
- **Download icon in the top bar** (next to fullscreen / profile, on every page) opens a
  dropdown with all downloads, grouped per title. In the player it also has
  **Prefetch next episode now**.
- **Auto-prefetch**: while you watch a series from a torrent, the next episode(s) are
  queued after 2 minutes (configurable).
- **Toolbar popup**: all downloads grouped per title, retry, cache-size warning.
- **✕ on a download** removes it *and* deletes its file from Stremio's cache. A download
  is listed exactly as long as its file is kept: removed items and auto-deleted watched
  items disappear from the list. The file is deleted once Stremio has released the
  torrent (~2 minutes after the last stream from it closes).
- **Watched cleanup**: while Stremio Web is open, the extension checks your library
  (synced from your account, so this includes things watched on other devices) and tells
  the helper which prefetched episodes / movies are watched. The helper deletes those files
  from Stremio's cache (`stremio-cache/{infoHash}/{fileIdx}`) 60 minutes later, and never
  while that torrent is playing or downloading. Unfinished downloads of watched items stop
  right away. Marking something unwatched within the 60 minutes cancels the deletion.
  Prefetching a removed item again downloads it again, and it is deleted again 60 minutes
  after the next check finds it watched. Configure with `deleteWatched` and
  `deleteWatchedAfterMin` in `config.json`. Only files queued through this tool are deleted.

## Helper API

All endpoints except `/api/ping` need header `X-Prefetch-Token`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/status` | helper + Stremio server status |
| GET | `/api/jobs` | queue |
| POST | `/api/jobs` | `{ items: [{ infoHash, fileIdx?, sources?, type?, metaId?, videoId?, label? }], addons? }` |
| POST | `/api/queue` | `{ type, metaId, addons, prefer?, select }`, where `select` is `{ videoIds }`, `{ season, fromVideoId? }` or `{ nextAfter, count }`, and `prefer` is `{ infoHash?, bingeGroup?, resolution?, source: "playing" \| "lastWatched", at }` |
| POST | `/api/meta` | `{ type, id, addons? }` |
| POST | `/api/jobs/:id/retry` | |
| DELETE | `/api/jobs/:id` | stops prefetching and deletes the file from Stremio's cache (once Stremio drops the engine, ~2 min) |
| POST | `/api/jobs/watched` | `{ watched: [jobId], unwatched: [jobId] }`, sent by the extension |
| POST | `/api/jobs/clear` | removes failed jobs |

## Limitations

- Only torrent streams can be prefetched. Plain HTTP streams (e.g. debrid services) don't
  go through the Stremio server's torrent downloader.
- Prefetching shares bandwidth with whatever you're watching. `maxActive` in
  `config.json` limits how many torrents download at once (default 2).
- Windows only for now: the start/stop scripts expect Stremio 4 in its default install
  location (`%LOCALAPPDATA%\Programs\LNV\Stremio-4`).

## Disclaimer

This is an unofficial personal project. It is not affiliated with, endorsed by, or
supported by Stremio or any addon developer.

- **Use at your own risk.** The software is provided "as is", without warranty of any
  kind. The author is not responsible for any damage, data loss, or other consequences
  of using it.
- **You are responsible for what you download.** This tool does not host, index, or
  provide any content. It only tells your own Stremio server to download streams that
  your installed addons already offer. Make sure you have the right to access that
  content where you live.
- **BitTorrent is public.** While a torrent downloads, your IP address is visible to
  other peers, and the Stremio server may upload parts of the file to them. Prefetching
  downloads whole files ahead of time, so you take part in swarms for longer than when
  you just stream.
- **Keep the helper on your local network.** It is protected by a token, but it is not
  meant to be exposed to the internet. Don't forward port 11480 on your router.

## License

[MIT](LICENSE)
