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

## API

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
available on the mirror (also: the replay's difficulty is not in the set), 11
autoplay, 12 invalid request field, 21 danser failed (the message carries the log
tail), 26 incompatible mods, 29 the same `scoreId` from the same server is already
queued or rendering, 40 queue full.

### One queue for every site

fishy and kawata send their renders to this one worker, so it is one queue: the
slots, the FIFO order and the 20-job cap are shared. Each job records its
`server`. The duplicate check is per server, because the two servers' score ids
overlap; one score id from both servers is two different plays. The wait
estimate is computed here, once, over every job: the median length of the last
20 finished renders from any server (210 s, `assumed`, until one finishes), with
the running jobs' remaining time read from their progress and the queued jobs
handed to the earliest free slot in order. So a player on either site and staff
on both admin panels read the same position and the same estimate.

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
| `PORT` | `3002` | |
| `RENDER_CONCURRENCY` | `2` | Render slots; each gets its own Xvfb display (`:10`, `:11`, ...) and working dir. |
| `RENDER_THREADS_PER_SLOT` | `4` | `LP_NUM_THREADS` for llvmpipe in each slot. |
| `RENDER_TIMEOUT_MIN` | `90` | A render past this is killed and marked failed (code 21). |
| `RENDER_STALL_SEC` | `90` | No output growth for this long is treated as a wedged danser. |
| `RENDER_RETENTION_DAYS` | `30` | Videos older than this are deleted by the daily sweep (`removed: true`). |
| `RENDER_MAX_QUEUE` | `20` | Waiting renders before `POST /renders` answers 503 / code 40. |
| `RENDER_MAX_REPLAY_MB` | `16` | Upload cap for the `.osr`. |
| `MIRROR_BASE` | `http://beatmap-mirror.hinai-rusty-mirror.svc.cluster.local:6100` | The beatmap mirror. |
| `MIRROR_DOWNLOAD_PATH` | `/api/v1/hinai/d/{id}` | Appended to `MIRROR_BASE` with `{id}` = beatmapsetId; must answer the `.osz` bytes (a JSON resolver answer fails the render with code 8). |
| `MIRROR_USER_AGENT` | `ordr-render/1.0 (+https://fishy.moe)` | |
| `VIDEOS_DIR`, `SONGS_DIR`, `SKINS_DIR`, `STATE_DIR`, `WORK_DIR` | `./data/...`, `./work` (image: `/data/...`, `/work`) | Finished videos; the `.osz` cache; skins; the journal (`renders.json`) and pending replays; per-slot scratch. |
| `RENDER_DEFAULT_SKIN` | unset | A folder name under `SKINS_DIR` that the wire value `default` (and an omitted `skin`) resolves to; unset = danser's built-in. A missing folder is a boot warning, not a refusal, and `default` renders with the built-in until it exists. |
| `DANSER_DIR` | `./bins/danser` (image: `/app/bins/danser`) | Where `danser-cli` lives; copied per slot at boot. |
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
