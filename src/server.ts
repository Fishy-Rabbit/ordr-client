import http from "http"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { pipeline } from "stream"
import Busboy from "busboy"
import { Config, DEFAULT_RESOLUTION, PRESETS, VERSION } from "./config"
import { Journal, RenderOptionValues, RenderRecord } from "./journal"
import { Scheduler } from "./queue"
import { defaultSkinFolder, listSkins, resolveSkin } from "./skins"
import { MOD_AUTOPLAY, parseReplayHeader, ReplayHeader, ReplayParseError } from "./osr"
import { replayPath } from "./job"
import { parseRenderWindow, type RenderWindow } from "./window"
import { etaBasisFor, etaByRender, progressPercent, renderModel, serverCounts, serverFor, typicalDuration } from "./fleet"
import { replayPlaySeconds } from "./playlength"

/** The form fields copied into a render's options; parseOptions validates them when the job runs. */
const OPTION_KEYS = ["showPPCounter", "showHitErrorMeter", "showResultScreen", "showDanserLogo", "loadVideo", "loadStoryboard", "inGameBGDim", "cursorSize"] as const

/** An error answered as JSON with this HTTP status and error code. */
class HttpError extends Error {
    /** `status` is the HTTP status; `errorCode` and the message go into the JSON body. */
    constructor(
        public readonly status: number,
        public readonly errorCode: number,
        message: string
    ) {
        super(message)
    }
}

/** Answer with a JSON body, its exact Content-Length and Cache-Control: no-store. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" })
    res.end(payload)
}

/** Constant-time comparison of a given key with the expected one; false when either is empty or the lengths differ. */
function keyMatches(expected: string, given: string | undefined): boolean {
    if (!expected || !given) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(given)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

/**
 * Who a request acts for. The staff key (RENDER_API_KEY) acts for every server; a scoped key
 * (RENDER_SCOPED_KEYS) for one: it queues under that server's name and sees only that
 * server's renders, queue jobs and videos. Another server's render looks exactly like one
 * that does not exist (404 / empty list), so a scoped key cannot even confirm it is there.
 */
type Caller = { staff: true } | { staff: false; server: string }

/** The caller the staff key identifies; also every caller in fake mode without a key. */
const STAFF: Caller = { staff: true }

/** The caller a key identifies, or null when it is no key at all. Every scoped digest is compared (no early exit). */
function identify(cfg: Config, given: string | undefined): Caller | null {
    if (!given) return null
    if (keyMatches(cfg.apiKey, given)) return STAFF
    const digest = crypto.createHash("sha256").update(given).digest()
    let server: string | null = null
    for (const k of cfg.scopedKeys ?? []) if (crypto.timingSafeEqual(k.hash, digest) && server === null) server = k.server
    return server === null ? null : { staff: false, server }
}

/** True when this caller may see this render. */
function canSee(caller: Caller, record: RenderRecord): boolean {
    return caller.staff || record.server === caller.server
}

/** Free bytes for an unprivileged writer on the filesystem holding `dir`. */
function freeBytes(dir: string): number {
    const st = fs.statfsSync(dir)
    return st.bavail * st.bsize
}

/** The wire shape of one render: the o!rdr fields plus this worker's extras. */
function toApi(record: RenderRecord, queuePosition: number, eta?: { seconds: number | undefined; basis: "measured" | "assumed" }): Record<string, unknown> {
    const playable = record.status === "done" && !record.removed && record.videoFile !== null
    return {
        renderID: record.renderID,
        status: record.status,
        progress: record.progress,
        queuePosition,
        videoUrl: playable ? `/videos/${record.renderID}.mp4` : null,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        replayUsername: record.replayUsername,
        mapTitle: record.mapTitle,
        replayMods: record.replayMods,
        resolution: record.resolution,
        skin: record.skin,
        options: record.options,
        window: record.window ?? null,
        source: record.source,
        server: record.server,
        scoreId: record.scoreId,
        beatmapsetId: record.beatmapsetId,
        beatmapMd5: record.beatmapMd5,
        date: record.date,
        removed: record.removed,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        // One estimate over the whole shared queue, so every site prints the same number.
        etaSeconds: eta && eta.seconds !== undefined ? eta.seconds : null,
        etaBasis: eta && eta.seconds !== undefined ? eta.basis : null
    }
}

/** One job in the shared queue view: what staff on any site need to read it, nothing more. */
function toQueueJob(record: RenderRecord, queuePosition: number, eta: number | undefined): Record<string, unknown> {
    return {
        renderID: record.renderID,
        server: record.server,
        status: record.status,
        queuePosition,
        progress: record.progress,
        progressPercent: progressPercent(record.progress),
        etaSeconds: eta ?? null,
        replayUsername: record.replayUsername,
        mapTitle: record.mapTitle,
        beatmapsetId: record.beatmapsetId,
        window: record.window ?? null,
        scoreId: record.scoreId,
        date: record.date,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        errorMessage: record.status === "failed" ? record.errorMessage : ""
    }
}

/**
 * A parsed POST /renders body: the text fields, the replay bytes and file name, and whether the
 * replay went over the size limit.
 */
type Submission = { fields: Record<string, string>; replay: Buffer | null; replayName: string; truncated: boolean }

/**
 * Parse a multipart submission under fixed limits (40 fields of at most 4 KiB, one file of at most
 * maxReplayBytes). Only the `replayFile` part is kept; any other file is drained. A malformed body
 * rejects with a 400 HttpError (code 12), and so does an upload the client abandons midway: the
 * request then closes before it is complete and busboy would wait for the rest forever. Exported
 * for the tests.
 */
export function readMultipart(req: http.IncomingMessage, maxReplayBytes: number): Promise<Submission> {
    return new Promise((resolve, reject) => {
        let bb: Busboy.Busboy
        try {
            bb = Busboy({ headers: req.headers, limits: { fields: 40, fieldSize: 4096, files: 1, fileSize: maxReplayBytes } })
        } catch (err) {
            reject(new HttpError(400, 12, `bad multipart request: ${(err as Error).message}`))
            return
        }
        const out: Submission = { fields: {}, replay: null, replayName: "", truncated: false }
        bb.on("field", (name, value) => {
            out.fields[name] = value
        })
        bb.on("file", (name, stream, info) => {
            if (name !== "replayFile") {
                stream.resume()
                return
            }
            const chunks: Buffer[] = []
            out.replayName = info.filename ?? ""
            stream.on("data", (chunk: Buffer) => chunks.push(chunk))
            stream.on("limit", () => (out.truncated = true))
            stream.on("end", () => (out.replay = Buffer.concat(chunks)))
        })
        bb.on("error", err => reject(new HttpError(400, 12, `bad multipart request: ${(err as Error).message}`)))
        bb.on("close", () => resolve(out))
        req.on("error", err => reject(new HttpError(400, 12, `bad multipart request: ${err.message}`)))
        req.on("close", () => {
            if (!req.complete) reject(new HttpError(400, 12, "the upload was aborted before the request was complete"))
        })
        req.pipe(bb)
    })
}

/**
 * The worker's HTTP API (README): GET /health needs no key; POST and GET /renders, GET /queue, GET
 * /skins and GET or HEAD /videos/<id>.mp4 need an X-Render-Key, and a scoped key sees only its own
 * server's renders.
 */
export function createServer(cfg: Config, journal: Journal, scheduler: Scheduler, log: (line: string) => void): http.Server {
    /** The GET /health body: version, queue, slot and per-server counts, and the typical render length. */
    const health = () => {
        const counts = journal.counts()
        const typical = typicalDuration(journal)
        return {
            ok: true,
            version: VERSION,
            queued: counts.queued,
            rendering: counts.rendering,
            slots: scheduler.slotCount,
            maxQueue: cfg.maxQueue,
            typicalSeconds: typical.seconds,
            typicalBasis: typical.basis,
            servers: serverCounts(journal),
            danserVersion: cfg.fake ? null : cfg.danserVersion,
            fake: cfg.fake
        }
    }

    /**
     * The shared queue for staff on every site: active jobs (rendering, then FIFO) plus the
     * latest finished ones. A scoped caller gets only its own server's jobs; the totals and
     * per-server counts stay whole (GET /health publishes them anyway, and the hinai mirror's
     * line cap reads `servers`).
     */
    const queueView = (recentLimit: number, caller: Caller) => {
        const counts = journal.counts()
        const typical = typicalDuration(journal)
        const eta = etaByRender(journal, scheduler.slotCount, typical)
        /** True for the renders this caller may see. */
        const mine = (r: RenderRecord) => canSee(caller, r)
        const active = journal.all().filter(r => r.status === "rendering").concat(journal.queued()).filter(mine)
        const recent = caller.staff ? journal.recentFinished(recentLimit) : journal.recentFinished(Number.MAX_SAFE_INTEGER).filter(mine).slice(0, recentLimit)
        return {
            slots: scheduler.slotCount,
            maxQueue: cfg.maxQueue,
            queued: counts.queued,
            rendering: counts.rendering,
            typicalSeconds: typical.seconds,
            typicalBasis: typical.basis,
            servers: serverCounts(journal),
            jobs: active.map(r => toQueueJob(r, scheduler.queuePosition(r), eta.get(r.renderID))),
            recent: recent.map(r => toQueueJob(r, 0, undefined))
        }
    }

    /** Every render's wire shape, with the shared ETA computed once for the batch. */
    const withEta = (records: RenderRecord[]) => {
        const typical = typicalDuration(journal)
        const model = renderModel(journal)
        const now = Date.now()
        const eta = etaByRender(journal, scheduler.slotCount, typical, now, model)
        return records.map(r => toApi(r, scheduler.queuePosition(r), { seconds: eta.get(r.renderID), basis: etaBasisFor(r, model, typical, now) }))
    }

    /** Uploads in progress per key: null for the staff key, a scoped key's server otherwise (cfg.maxUploads). */
    const uploads = new Map<string | null, number>()

    /**
     * Throw the refusal if the worker cannot take another render for `server` (null for the staff
     * key, which has no cap of its own): a full queue, a scoped server already holding its cap, or
     * the free-disk floor. Runs before an upload is read and again right before it is recorded.
     */
    const checkCapacity = (server: string | null) => {
        if (journal.counts().queued >= cfg.maxQueue) throw new HttpError(503, 40, `the queue is full (${cfg.maxQueue} renders waiting); try again later`)
        if (server !== null) {
            const held = journal.all().filter(r => r.server === server && (r.status === "queued" || r.status === "rendering")).length
            if (held >= cfg.scopedMaxActive) throw new HttpError(503, 40, `${server} already has ${held} renders in the line (the most it may hold); try again later`)
        }
        // The videos share a disk with other data, so below the floor nothing new is accepted.
        // Jobs already queued still run.
        if (cfg.minFreeBytes > 0) {
            const free = freeBytes(cfg.videosDir)
            if (free < cfg.minFreeBytes) {
                log(`submit refused: ${Math.floor(free / 1024 ** 3)} GB free under ${cfg.videosDir}, the floor is ${Math.round(cfg.minFreeBytes / 1024 ** 3)} GB (RENDER_MIN_FREE_GB)`)
                throw new HttpError(503, 43, "the renderer is low on disk space; try again later")
            }
        }
    }

    /**
     * Take a POST /renders submission (see receive). An upload is held in memory until its render
     * is recorded, so what cannot be taken is refused BEFORE the body is read: a full line (for the
     * caller's own server when it is scoped), or a key that already has cfg.maxUploads uploads in
     * progress. Node discards the unread body after the answer. The count covers the whole
     * submission, so parallel POSTs can hold at most cfg.maxUploads replays per key.
     */
    const submit = async (req: http.IncomingMessage, caller: Caller): Promise<{ renderID: number; window: RenderWindow | null }> => {
        const key = caller.staff ? null : caller.server
        checkCapacity(key)
        const inProgress = uploads.get(key) ?? 0
        if (inProgress >= cfg.maxUploads) throw new HttpError(503, 40, `this key already has ${inProgress} uploads in progress (the most at once); try again shortly`)
        uploads.set(key, inProgress + 1)
        try {
            return await receive(req, caller)
        } finally {
            const left = (uploads.get(key) ?? 1) - 1
            if (left > 0) uploads.set(key, left)
            else uploads.delete(key)
        }
    }

    /**
     * Read and validate a POST /renders submission (resolution, skin, options, window, set id,
     * replay header), admit it, record it and store its replay, then wake the scheduler. Every
     * refusal is an HttpError.
     */
    const receive = async (req: http.IncomingMessage, caller: Caller): Promise<{ renderID: number; window: RenderWindow | null }> => {
        const sub = await readMultipart(req, cfg.maxReplayBytes)
        if (sub.truncated) throw new HttpError(413, 5, `the replay is larger than the ${Math.round(cfg.maxReplayBytes / 1048576)} MB limit`)
        if (!sub.replay || sub.replay.length === 0) throw new HttpError(400, 2, "missing replayFile")
        const f = sub.fields

        const resolution = f.resolution?.trim() || DEFAULT_RESOLUTION
        if (!PRESETS[resolution]) throw new HttpError(400, 12, `unsupported resolution ${resolution}; one of ${Object.keys(PRESETS).join(", ")}`)

        // `default` (or nothing) is the server default; `danser` the built-in.
        // The record keeps the RESOLVED folder so GET /renders reports what
        // danser was actually given.
        const skin = resolveSkin(cfg.skinsDir, f.skin ?? "", cfg.defaultSkin)
        if (skin === null) throw new HttpError(400, 12, `unknown skin ${f.skin}; see GET /skins`)

        const options: RenderOptionValues = {}
        for (const key of OPTION_KEYS) if (f[key] !== undefined) options[key] = f[key]
        const win = parseRenderWindow(f.start, f.end)
        if (!win.ok) throw new HttpError(400, 12, win.message)

        const beatmapsetId = Number(f.beatmapsetId)
        if (!Number.isInteger(beatmapsetId) || beatmapsetId <= 0) throw new HttpError(400, 8, "map not available on the mirror: beatmapsetId is required, the renderer fetches the map from the mirror by set id")

        let header: ReplayHeader | null = null
        try {
            header = parseReplayHeader(sub.replay)
        } catch (err) {
            if (!cfg.fake) {
                if (err instanceof ReplayParseError) throw new HttpError(400, err.errorCode, err.message)
                throw new HttpError(400, 2, `the replay could not be parsed: ${(err as Error).message}`)
            }
        }
        if (header) {
            if (header.mode !== 0) throw new HttpError(400, 6, "only osu!standard replays can be rendered")
            if (header.mods & MOD_AUTOPLAY) throw new HttpError(400, 11, "autoplay replays cannot be rendered")
            if (header.frameBytes === 0) throw new HttpError(400, 7, "the replay carries no input data")
        }
        const formMd5 = (f.beatmapMd5 ?? "").trim().toLowerCase()
        const beatmapMd5 = header?.beatmapMd5 ?? (/^[0-9a-f]{32}$/.test(formMd5) ? formMd5 : null)
        if (header && formMd5 && formMd5 !== header.beatmapMd5) log(`submit: form beatmapMd5 ${formMd5} differs from the replay's ${header.beatmapMd5}; trusting the replay`)

        const source = (f.source ?? "").trim().slice(0, 64)
        // A scoped key decides the server; naming another one is refused, not rewritten.
        const asked = (f.server ?? "").trim().toLowerCase()
        if (!caller.staff && asked !== "" && asked !== caller.server) throw new HttpError(403, 403, `this key may only queue ${caller.server} renders`)
        const server = caller.staff ? serverFor(f.server, source) : caller.server
        const scoreId = (f.scoreId ?? "").trim() || null
        /**
         * Throw the refusal if there is one: the score already active for this server (409), a full
         * queue, a scoped server at its cap, or the free-disk floor (503).
         */
        const admit = () => {
            if (scoreId && journal.findActiveByScore(server, scoreId)) throw new HttpError(409, 29, `${server} score ${scoreId} is already queued or rendering`)
            checkCapacity(caller.staff ? null : server)
        }
        // Refused submissions never reach xz. Reading the play length awaits, so the checks
        // run again after it: nothing awaits between the last check and journal.create.
        admit()
        const play = header ? await replayPlaySeconds(sub.replay, header, win.window) : null
        admit()

        const record = journal.create({
            replayUsername: header?.playerName || (f.username ?? "").trim() || "unknown",
            mapTitle: "",
            replayMods: header?.mods ?? 0,
            resolution,
            skin,
            options,
            source,
            server,
            scoreId,
            beatmapsetId,
            beatmapMd5,
            window: win.window,
            playSeconds: play
        })
        try {
            fs.writeFileSync(replayPath(cfg, record.renderID), sub.replay)
        } catch (err) {
            journal.update(record.renderID, { status: "failed", progress: "Failed", errorCode: 21, errorMessage: `could not store the replay: ${(err as Error).message}`, finishedAt: new Date().toISOString() })
            throw new HttpError(500, 21, `could not store the replay: ${(err as Error).message}`)
        }
        log(`render ${record.renderID} queued: ${record.replayUsername} on set ${beatmapsetId} (${resolution}, skin ${skin}, server ${server}, source ${record.source || "-"}, score ${scoreId ?? "-"}${win.window ? `, window ${win.window.start}-${win.window.end}s` : ""}${play !== null ? `, ${play}s of play` : ""})`)
        scheduler.tick()
        return { renderID: record.renderID, window: record.window }
    }

    /**
     * Serve a finished video the caller may see, with HEAD and single byte-range (206) support;
     * anything else is a 404. The file goes out through stream.pipeline, so a player that drops the
     * connection (every seek does) releases the file descriptor, and a read error (the file deleted
     * after the checks, a directory, EMFILE) is logged and ends that response instead of throwing
     * an unhandled stream error that would stop the worker.
     */
    const serveVideo = (req: http.IncomingMessage, res: http.ServerResponse, name: string, caller: Caller): void => {
        const match = name.match(/^(?:render)?(\d+)\.mp4$/)
        const record = match ? journal.get(Number(match[1])) : undefined
        if (!record || !canSee(caller, record) || record.status !== "done" || record.removed || !record.videoFile || !fs.existsSync(record.videoFile)) {
            throw new HttpError(404, 404, "no such video")
        }
        const file = record.videoFile
        /** Stream the file (or the byte range) into the response; a client hanging up early is not logged. */
        const send = (range?: { start: number; end: number }) =>
            pipeline(fs.createReadStream(file, range), res, err => {
                if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") log(`video ${record.renderID}: ${err.message}`)
            })
        const size = fs.statSync(file).size
        const headers: http.OutgoingHttpHeaders = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "Content-Disposition": `inline; filename="render${record.renderID}.mp4"` }
        const range = req.headers.range
        if (range) {
            const m = range.match(/^bytes=(\d*)-(\d*)$/)
            if (!m || (m[1] === "" && m[2] === "")) {
                res.writeHead(416, { "Content-Range": `bytes */${size}` })
                res.end()
                return
            }
            // "bytes=-N" is the last N bytes; "bytes=N-" runs to the end.
            const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1])
            const end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(size - 1, Number(m[2]))
            if (start >= size || start > end) {
                res.writeHead(416, { "Content-Range": `bytes */${size}` })
                res.end()
                return
            }
            headers["Content-Range"] = `bytes ${start}-${end}/${size}`
            headers["Content-Length"] = end - start + 1
            res.writeHead(206, headers)
            if (req.method === "HEAD") {
                res.end()
                return
            }
            send({ start, end })
            return
        }
        headers["Content-Length"] = size
        res.writeHead(200, headers)
        if (req.method === "HEAD") {
            res.end()
            return
        }
        send()
    }

    /**
     * Route one request: /health first, then identify the key (401 without a valid one), then the
     * authenticated routes; an unknown route is a 404.
     */
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? "/", "http://localhost")
        const method = req.method ?? "GET"
        const route = url.pathname.replace(/\/+$/, "") || "/"

        if (route === "/health" && (method === "GET" || method === "HEAD")) return sendJson(res, 200, health())

        let caller: Caller = STAFF
        if (!cfg.fake || cfg.apiKey) {
            const given = req.headers["x-render-key"]
            const who = identify(cfg, Array.isArray(given) ? given[0] : given)
            if (!who) throw new HttpError(401, 401, "missing or invalid X-Render-Key")
            caller = who
        }

        if (route === "/renders" && method === "POST") {
            const { renderID, window } = await submit(req, caller)
            return sendJson(res, 201, { message: "Render queued", renderID, errorCode: 0, window })
        }
        if (route === "/renders" && method === "GET") {
            const raw = url.searchParams.get("renderID")
            if (raw !== null && raw !== "") {
                const record = journal.get(Number(raw))
                const renders = record && canSee(caller, record) ? withEta([record]) : []
                return sendJson(res, 200, { renders, maxRenders: renders.length })
            }
            const renders = withEta(caller.staff ? journal.latest(50) : journal.all().filter(r => canSee(caller, r)).slice(-50).reverse())
            return sendJson(res, 200, { renders, maxRenders: renders.length })
        }
        if (route === "/queue" && method === "GET") {
            const asked = Number(url.searchParams.get("recent") ?? 25)
            const recent = Number.isFinite(asked) ? Math.max(0, Math.min(100, Math.floor(asked))) : 25
            return sendJson(res, 200, queueView(recent, caller))
        }
        if (route === "/skins" && method === "GET") return sendJson(res, 200, { skins: listSkins(cfg.skinsDir, cfg.defaultSkin), default: defaultSkinFolder(cfg.skinsDir, cfg.defaultSkin) })
        if (route.startsWith("/videos/") && (method === "GET" || method === "HEAD")) return serveVideo(req, res, path.posix.basename(route), caller)
        throw new HttpError(404, 404, "not found")
    }

    return http.createServer((req, res) => {
        handle(req, res).catch(err => {
            if (err instanceof HttpError) {
                sendJson(res, err.status, { message: err.message, errorCode: err.errorCode })
                return
            }
            log(`unhandled error on ${req.method} ${req.url}: ${(err as Error).stack ?? err}`)
            if (!res.headersSent) sendJson(res, 500, { message: "internal error", errorCode: 500 })
            else res.end()
        })
    })
}
