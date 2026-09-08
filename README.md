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

Every route except `GET /health` requires the header `X-Render-Key: <RENDER_API_KEY>`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/renders` | multipart: `replayFile` (a headered `.osr`), `beatmapsetId` (required: the map is fetched from the mirror by set id), optional `beatmapMd5`, `scoreId`, `source`, `username`, `resolution` (`1280x720` default, `960x540`, `1920x1080`, `640x480` turbo), `skin` (folder name, id or display name from `/skins`, `default` = the server default, `danser` = the built-in; omitted = `default`), and the option fields `showPPCounter`, `showHitErrorMeter`, `showResultScreen`, `showDanserLogo`, `loadVideo`, `loadStoryboard` (`true`/`false`), `inGameBGDim` (0-100), `cursorSize` (0.5-2). Answers `201 {message, renderID, errorCode: 0}` or `4xx/5xx {message, errorCode}`. |
| `GET` | `/renders?renderID=N` | `{renders: [render], maxRenders}`; without `renderID`, the latest 50. A render carries `renderID, status (queued/rendering/done/failed), progress ("Waiting", "Rendering (45%)", "Encoding", "Finalizing", "Done", "Failed"), queuePosition, videoUrl (/videos/N.mp4 when done), errorCode, errorMessage, replayUsername, mapTitle, replayMods, resolution, skin, options, source, scoreId, beatmapsetId, beatmapMd5, date, removed, startedAt, finishedAt`. |
| `GET` | `/skins` | `{skins: [{id, skin, presentationName, resolvesTo?}], default}`: id 0 is always the wire value `default` (the server default when `RENDER_DEFAULT_SKIN` names an existing folder, presented as `Server default: <skin.ini Name>` with `resolvesTo` = the folder; otherwise danser's built-in), then `danser` (the built-in under its own name, only when a server default exists), then the folders in `SKINS_DIR` in sorted order, the default folder included under its own name. `default` at the top level is the resolved default folder or `null`. |
| `GET` | `/videos/N.mp4` | The finished video, with HTTP Range support (`206`). `renderN.mp4` is accepted too. |
| `GET` | `/health` | `{ok, version, queued, rendering, slots, danserVersion, fake}` (no key needed). |

Error codes reuse o!rdr's numbers where the meaning matches: 2 replay unparseable,
5 replay corrupted or oversized, 6 not osu!standard, 7 no input data, 8 map not
available on the mirror (also: the replay's difficulty is not in the set), 11
autoplay, 12 invalid request field, 21 danser failed (the message carries the log
tail), 26 incompatible mods, 29 the same `scoreId` is already queued or rendering,
40 queue full.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `RENDER_API_KEY` | (none) | Required unless `RENDER_FAKE=1`; the worker refuses to start without it. |
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
