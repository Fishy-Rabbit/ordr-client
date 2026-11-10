# ordr-render

A self-hosted osu! replay render worker. It takes a replay over HTTP, renders it
with [danser](https://github.com/Wieku/danser-go) under a virtual X display
(Xvfb + Mesa llvmpipe, pure CPU), and serves the MP4 back. The API is the subset
of the public o!rdr API a render panel needs, so a client written for o!rdr can
point at this worker instead, but this worker never talks to o!rdr, osu! or any
other host: the only outbound request it makes is the beatmap download from the
mirror you configure.

## Notice

This is a fork of [MasterIO02/ordr-client](https://github.com/MasterIO02/ordr-client)
(BSD-3-Clause, Copyright (c) 2025 issou.best and contributors; see `LICENSE`).
The danser settings mapping (`src/renderers/danser/prepare.ts`) and the danser
process driver (`src/renderers/danser/render.ts`) are adapted from it. The
websocket client, updater, telemetry, prompts and the ORV renderer were removed;
the worker is not usable with, and must not be pointed at, the official o!rdr
server.

danser-go is GPL-3.0 and runs as a separate process. The Docker image downloads
the pinned release zip once at build time (sha256-checked) and never downloads
anything at runtime. The zip ships danser's built-in default skin only; drop any
extra skin folders (an `.osk` is a zip) into `SKINS_DIR` yourself and name one of
them in `RENDER_DEFAULT_SKIN` to make it the server default: the wire value
`default` (what a panel sends when its skin field is left empty) then means that
folder, and `danser` is the built-in under its own name. Missing elements fall
back to the built-in; the default is resolved per request, so a folder that lands
while the worker runs becomes live without a restart.

## Map source: the hinai mirror, and nothing else

This worker fetches beatmaps from ONE place: the hinai beatmap mirror
(`rust-service/hinai-beatmap-mirror` in the Hinamizawa repo), through its
byte-streaming route `/api/v1/hinai/d/{setId}`. There is no fallback, no
cascade and no other mirror in this code base, and two guards keep it that way:
the process refuses to start when `MIRROR_BASE` is not a hinai mirror host
(`HINAI_MIRROR_HOSTS` in `src/config.ts`, not overridable by environment), and
redirects are followed only when they stay on a hinai mirror host, so a mirror
running in redirect mode can never hand this worker a third-party URL. If the
hinai mirror does not have a set, the render fails with code 8.

## API

Every route except `GET /health` requires the header `X-Render-Key`, carrying either the staff
key (`RENDER_API_KEY`) or a scoped key (`RENDER_SCOPED_KEYS`, see "Scoped keys" below).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/renders` | multipart: `replayFile` (a headered `.osr`), `beatmapsetId` (required: the map is fetched from the mirror by set id), optional `beatmapMd5`, `scoreId`, `source`, `server` (the site the job is for, e.g. `fishy` or `kawata`; omitted = read from `source`), `username`, `resolution` (`1280x720` default, `960x540`, `1920x1080`, `640x480` turbo), `skin` (folder name, id or display name from `/skins`, `default` = the server default, `danser` = the built-in; omitted = `default`), and the option fields `showPPCounter`, `showHitErrorMeter`, `showResultScreen`, `showDanserLogo`, `loadVideo`, `loadStoryboard` (`true`/`false`), `inGameBGDim` (0-100), `cursorSize` (0.5-2), and `start` / `end` (whole seconds, both or neither; see Windowed renders below). Answers `201 {message, renderID, errorCode: 0, window}` or `4xx/5xx {message, errorCode}`. |
| `GET` | `/renders?renderID=N` | `{renders: [render], maxRenders}`; without `renderID`, the latest 50. A render carries `renderID, status (queued/rendering/done/failed), progress ("Waiting", "Rendering (45%)", "Encoding", "Finalizing", "Done", "Failed"), queuePosition, videoUrl (/videos/N.mp4 when done), errorCode, errorMessage, replayUsername, mapTitle, replayMods, resolution, skin, options, source, server, scoreId, beatmapsetId, beatmapMd5, window, date, removed, startedAt, finishedAt, etaSeconds, etaBasis`. `etaSeconds` is set while queued or rendering, computed over the whole shared queue (see below). |
| `GET` | `/queue?recent=N` | The shared queue for staff on every site: `{slots, maxQueue, queued, rendering, typicalSeconds, typicalBasis, servers, jobs, recent}`. `jobs` are the active renders (rendering first, then queued in FIFO order), `recent` the latest N finished or failed ones (default 25, max 100). Each entry: `renderID, server, status, queuePosition, progress, progressPercent, etaSeconds, replayUsername, mapTitle, beatmapsetId, scoreId, window, date, startedAt, finishedAt, errorMessage`. |
| `GET` | `/skins` | `{skins: [{id, skin, presentationName, resolvesTo?}], default}`: id 0 is always the wire value `default` (the server default when `RENDER_DEFAULT_SKIN` names an existing folder, presented as `Server default: <skin.ini Name>` with `resolvesTo` = the folder; otherwise danser's built-in), then `danser` (the built-in under its own name, only when a server default exists), then the folders in `SKINS_DIR` in sorted order, the default folder included under its own name. `default` at the top level is the resolved default folder or `null`. |
| `GET` | `/videos/N.mp4` | The finished video, with HTTP Range support (`206`). `renderN.mp4` is accepted too. |
| `GET` | `/health` | `{ok, version, queued, rendering, slots, maxQueue, typicalSeconds, typicalBasis, servers, danserVersion, fake}` (no key needed). `servers` is `{<server>: {queued, rendering}}` for every server with an active job. |

Error codes reuse o!rdr's numbers where the meaning matches: 2 replay unparseable,
5 replay corrupted or oversized, 6 not osu!standard, 7 no input data, 8 map not
available on the mirror (also: the replay's difficulty is not in the set, or the set
is larger than `RENDER_MAX_OSZ_MB` or holds an implausibly large difficulty file), 11
autoplay, 12 invalid request field (also: an upload the client abandoned midway), 21
danser failed (the message carries the log tail; also, with HTTP 500, a replay the
worker could not store), 26 incompatible mods, 29 the same `scoreId` from the same
server is already queued or rendering, 40 queue full, 43 low on disk (see "Free-disk
floor").

Answers that are not about a render carry their HTTP status as the code: 401 a
missing or invalid `X-Render-Key`, 403 a scoped key naming another server, 404 an
unknown route or a video the key may not see, 500 an unexpected internal error (sent
only while nothing of the answer has gone out yet; otherwise the answer just stops).

### One queue for every site

fishy and kawata send their renders to this one worker, so it is one queue: the
slots, the FIFO order and the 20-job cap are shared. Each job records its
`server`. The duplicate check is per server, because the two servers' score ids
overlap; one score id from both servers is two different plays. The wait
estimate is computed here, once, over every job. A running job that danser has
drawn at least 5% of is projected from its own speed: the time it took to draw
what it last reported, scaled to the rest, plus a few seconds to finish the file,
counted down from that report (the journal keeps `drawStartedAt` and `progressAt`
for this). Before that, and for every queued job, the guess comes from the job's
own play length: at submit the replay's LZMA frame block is decompressed with xz
(xz-utils in the image: output capped at 8 MB, 10 s limit, two at once, and only
for submissions that pass the queue checks) and its frame times summed into
`playSeconds`: song time clipped to the window, divided by 1.5 for DT/NC or
0.75 for HT, and nothing past 3 hours of song time is trusted. Expected length = preparation + drawing seconds per second
of play x `playSeconds`, both medians over the last renders that recorded them
(`assumed` 10 s and 1.2x, the Backup node's numbers, until three have). A job
with no readable frames falls back to the median length of the last 20 finished
renders (210 s, `assumed`, until one finishes). Queued jobs are handed to the
earliest free slot in order. `etaBasis` says what the job's own estimate rests on.
A player on either site and staff on both admin panels read the same position and
the same estimate.

### Scoped keys (one server only)

A scoped key acts for ONE server. It exists so a public site (the hinai beatmap page, through
the hinai mirror) can make videos without holding the staff key that fishy and kawata use.
With a scoped key:

- `POST /renders` queues under the key's server, whatever `source` says. Naming another
  `server` is refused with `403`. The server may hold at most `RENDER_SCOPED_MAX_ACTIVE` jobs
  (queued + rendering) at once; past that the answer is `503` / code 40, like a full queue.
- `GET /renders`, `GET /renders?renderID=N`, `GET /queue` and `GET /videos/N.mp4` show only
  that server's renders. Another server's render looks like one that does not exist (an empty
  list, `404`). `/queue` keeps its totals and `servers` counts, which `/health` publishes anyway.
- `GET /skins` and `GET /health` answer as usual.

The worker never sees a scoped key itself, only its SHA-256, so `RENDER_SCOPED_KEYS` is not a
credential. Make a key and its entry like this (the key goes to the client's secret store, the
digest to the worker):

```bash
key=$(openssl rand -hex 32)
printf 'hinai=%s\n' "$(printf %s "$key" | sha256sum | cut -d' ' -f1)"
```

To rotate, add the new digest next to the old one (two entries for one server are allowed),
restart, switch the client to the new key, then remove the old entry.

### Free-disk floor

With `RENDER_MIN_FREE_GB` set, `POST /renders` answers `503` / code 43 for every key while the
filesystem holding `VIDEOS_DIR` has less free space than that. Jobs already queued still run.
It exists because the videos share a disk with other data (on the Backup node: the nightly
backups), and a public site can ask for videos faster than the 30-day sweep removes them.

The floor only gates new renders; it reserves nothing for the ones already admitted. If the disk
fills anyway, a journal write that fails during a render is logged and the worker keeps running. A
failed draw-start or progress write leaves the render going; a render already done stays done; any
other failure marks the render failed (code 21). The journal holds each change in memory and
writes it with the next write that succeeds.

### Uploads and child processes

`POST /renders` refuses what it cannot take before it reads the upload: a full queue, a scoped
key's server at its cap, the free-disk floor (`503` / code 40 or 43), or a key that already has
`RENDER_MAX_UPLOADS` uploads in progress (`503` / code 40). An upload is held in memory until its
render is recorded, so parallel uploads hold at most `RENDER_MAX_UPLOADS` x `RENDER_MAX_REPLAY_MB`
per key (the staff key, or each scoped key's server). The queue checks run again right before
the render is recorded, with nothing awaited in between.

xz, which reads the replay frames callers send, gets `PATH` and nothing else. danser and Xvfb
get the worker's environment without its `RENDER_*` settings, so a child that a crafted replay
or map set takes over does not find the API keys there. They also lose, case ignored, any
variable whose name contains `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD` or `CREDENTIAL` anywhere
(`CLIENTSECRET`, `DB_PASSWORD`), and any whose name has `KEY`, `APIKEY` (or `API_KEY`), a plural
of those, `PASS`, `AUTH` or `AUTHORIZATION` as a whole word, between underscores or at either end
(`DOCKER_AUTH_CONFIG`, `SSH_AUTH_SOCK`, `SMTP_PASS`). Those short words inside a longer word do
not count, so `XAUTHORITY` and `KEYBOARD` pass, and so would `DBPASS`. A credential under such a
name, or under another name altogether (a database URL, say), still reaches danser and Xvfb, so
keep unrelated credentials out of the worker's environment. The children still run as the
worker's user, with the same access to its files and sockets (withholding `SSH_AUTH_SOCK` hides
the path, not the socket).

### Map cache

`SONGS_DIR` keeps one `<setId>.osz` per set, fetched from the mirror the first time it is
rendered. Renders that need the same uncached set at the same time share one download, and a
set over `RENDER_MAX_OSZ_MB` is never stored. The sweep that removes old videos (at boot, then
daily) also deletes sets nobody used for `RENDER_SONG_CACHE_DAYS`. A set is kept while its file
was used inside the window (a cache hit refreshes its mtime), while a render in the journal
asked for it inside the window, or while a render for it is still queued or rendering. Leftover
`.osz.part` downloads older than a day go too. A deleted set costs one download from the mirror
the next time it is rendered.

### Windowed renders (`start`, `end`)

`POST /renders` takes two optional fields, `start` and `end`: whole seconds of
song position (map time, the clock the replay frames and josu's SEEK use; with
DT or NC it is not the video's own clock). They go together or not at all, and
`0 <= start < end <= 86400`; anything else answers 400 code 12 and queues
nothing. The job records them as `window: {start, end}` (`null` for a full
render), and the `POST /renders` answer, `GET /renders` and `GET /queue` all
carry it.

The worker passes them to danser as `-start=<start>` and `-end=<end>`. danser
drops every hit object outside the window before playback, so a windowed clip's
score, combo, accuracy and pp counters start from zero at the window and do not
match the full play. The worker therefore forces the results screen off
(`Gameplay.ShowResultsScreen` false) whatever `showResultScreen` asked for, and
a client labels such a clip as a window render. A full render's danser command
is unchanged. The duplicate check is too: a window of a score that already has
an active render from the same server answers code 29.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RENDER_API_KEY` | (none) | The staff key: every route, every server. Required unless `RENDER_FAKE=1`; the worker refuses to start without it. |
| `RENDER_SCOPED_KEYS` | unset | `server=<sha256 hex of the key>` entries, separated by commas or spaces: keys that act for one server only (see "Scoped keys"). A malformed entry refuses the boot. |
| `RENDER_SCOPED_MAX_ACTIVE` | `10` | Most queued + rendering jobs one scoped key's server may hold. |
| `RENDER_MIN_FREE_GB` | `0` (off) | Refuse new renders (503 / code 43) while `VIDEOS_DIR`'s filesystem has less free space than this. |
| `PORT` | `3002` | The listen port. The image's health check probes the same port. |
| `RENDER_CONCURRENCY` | `2` | Render slots; each gets its own Xvfb display (`:10`, `:11`, ...) and working dir. |
| `RENDER_THREADS_PER_SLOT` | `4` | `LP_NUM_THREADS` for llvmpipe in each slot. |
| `RENDER_TIMEOUT_MIN` | `90` | A render past this is killed and marked failed (code 21). |
| `RENDER_STALL_SEC` | `90` | No output growth for this long is treated as a wedged danser. |
| `RENDER_RETENTION_DAYS` | `30` | Videos older than this are deleted by the daily sweep (`removed: true`). A video that cannot be deleted is logged and tried again at the next sweep. |
| `RENDER_SONG_CACHE_DAYS` | `30` | Cached `.osz` sets nobody used for this long are deleted by the same sweep (see "Map cache"). |
| `RENDER_MAX_QUEUE` | `20` | Waiting renders before `POST /renders` answers 503 / code 40. |
| `RENDER_MAX_REPLAY_MB` | `16` | Upload cap for the `.osr`. |
| `RENDER_MAX_UPLOADS` | `4` | Uploads one key may have in progress at once (the staff key, or each scoped key's server); past it `POST /renders` answers 503 / code 40 without reading the body. |
| `RENDER_MAX_OSZ_MB` | `256` | Largest map set (`.osz`) a render may use. A bigger download is cut off and a bigger cached file is not opened; the render fails with code 8. osu! itself refuses uploads over 100 MB, but a few older sets are larger. |
| `MIRROR_BASE` | `http://beatmap-mirror.hinai-rusty-mirror.svc.cluster.local:6100` | The beatmap mirror. |
| `MIRROR_DOWNLOAD_PATH` | `/api/v1/hinai/d/{id}` | Appended to `MIRROR_BASE` with `{id}` = beatmapsetId; must answer the `.osz` bytes (a JSON resolver answer fails the render with code 8). |
| `MIRROR_USER_AGENT` | `ordr-render/1.0 (+https://fishy.moe)` | |
| `VIDEOS_DIR`, `SONGS_DIR`, `SKINS_DIR`, `STATE_DIR`, `WORK_DIR` | `./data/...`, `./work` (image: `/data/...`, `/work`) | Finished videos; the `.osz` cache; skins; the journal (`renders.json`) and pending replays; per-slot scratch. |
| `REPLAYS_DIR` | `STATE_DIR/replays` | Uploaded replays waiting for their render, one `<renderID>.osr` each; a replay is deleted when its render ends, done or failed. |
| `RENDER_DEFAULT_SKIN` | unset | A folder name under `SKINS_DIR` that the wire value `default` (and an omitted `skin`) resolves to; unset = danser's built-in. A missing folder is a boot warning, not a refusal, and `default` renders with the built-in until it exists. |
| `DANSER_DIR` | `./bins/danser` (image: `/app/bins/danser`) | Where `danser-cli` lives; copied per slot at boot. |
| `DANSER_VERSION` | `unknown` (image: the `DANSER_VERSION` build argument, `0.11.0`) | Reported as `danserVersion` by `GET /health` and in the boot log line. A label only: the danser that runs is whatever `DANSER_DIR` holds. |
| `XVFB_DISPLAY_BASE` | `10` | Slot N (from 0) uses X display `:<base + N>`. Rounded down to a whole number. |
| `RENDER_FAKE` | unset | `1`: no Xvfb/danser; a render walks to done in ~10 s with a 1-second black MP4 (ffmpeg). |
| `RENDER_DEBUG` | unset | `1`: log every danser line. |

## Build and run

```
docker build -t ordr-render .
docker run --rm -p 3002:3002 -e RENDER_API_KEY=change-me \
  -v render-videos:/data/videos -v render-songs:/data/songs -v render-skins:/data/skins -v render-state:/data/state \
  --cpus 8 --memory 12g ordr-render
```

The image runs as uid 1001; volumes mounted from the host must be writable by it.
Rendering on CPU is slow: budget several times the map length per render at
1280x720@30 and scale by adding slots (each needs its own CPU budget), not cores.

From source: `npm ci && npm run build && RENDER_FAKE=1 npm start`.
