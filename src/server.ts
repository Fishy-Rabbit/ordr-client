import http from "http"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import Busboy from "busboy"
import { Config, DEFAULT_RESOLUTION, PRESETS, VERSION } from "./config"
import { Journal, RenderOptionValues, RenderRecord } from "./journal"
import { Scheduler } from "./queue"
import { listSkins, resolveSkin } from "./skins"
import { MOD_AUTOPLAY, parseReplayHeader, ReplayHeader, ReplayParseError } from "./osr"
import { replayPath } from "./job"

const OPTION_KEYS = ["showPPCounter", "showHitErrorMeter", "showResultScreen", "showDanserLogo", "loadVideo", "loadStoryboard", "inGameBGDim", "cursorSize"] as const

class HttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly errorCode: number,
        message: string
    ) {
        super(message)
    }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" })
    res.end(payload)
}

function keyMatches(expected: string, given: string | undefined): boolean {
    if (!expected || !given) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(given)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

/** The wire shape of one render: the o!rdr fields plus this worker's extras. */
function toApi(record: RenderRecord, queuePosition: number): Record<string, unknown> {
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
        source: record.source,
        scoreId: record.scoreId,
        beatmapsetId: record.beatmapsetId,
        beatmapMd5: record.beatmapMd5,
        date: record.date,
        removed: record.removed,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt
    }
}

type Submission = { fields: Record<string, string>; replay: Buffer | null; replayName: string; truncated: boolean }

function readMultipart(req: http.IncomingMessage, maxReplayBytes: number): Promise<Submission> {
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
        req.pipe(bb)
    })
}

export function createServer(cfg: Config, journal: Journal, scheduler: Scheduler, log: (line: string) => void): http.Server {
    const health = () => {
        const counts = journal.counts()
        return { ok: true, version: VERSION, queued: counts.queued, rendering: counts.rendering, slots: scheduler.slotCount, danserVersion: cfg.fake ? null : cfg.danserVersion, fake: cfg.fake }
    }

    const submit = async (req: http.IncomingMessage): Promise<{ renderID: number }> => {
        const sub = await readMultipart(req, cfg.maxReplayBytes)
        if (sub.truncated) throw new HttpError(413, 5, `the replay is larger than the ${Math.round(cfg.maxReplayBytes / 1048576)} MB limit`)
        if (!sub.replay || sub.replay.length === 0) throw new HttpError(400, 2, "missing replayFile")
        const f = sub.fields

        const resolution = f.resolution?.trim() || DEFAULT_RESOLUTION
        if (!PRESETS[resolution]) throw new HttpError(400, 12, `unsupported resolution ${resolution}; one of ${Object.keys(PRESETS).join(", ")}`)

        const skin = resolveSkin(cfg.skinsDir, f.skin ?? "")
        if (skin === null) throw new HttpError(400, 12, `unknown skin ${f.skin}; see GET /skins`)

        const options: RenderOptionValues = {}
        for (const key of OPTION_KEYS) if (f[key] !== undefined) options[key] = f[key]

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

        const scoreId = (f.scoreId ?? "").trim() || null
        if (scoreId && journal.findActiveByScore(scoreId)) throw new HttpError(409, 29, `score ${scoreId} is already queued or rendering`)
        if (journal.counts().queued >= cfg.maxQueue) throw new HttpError(503, 40, `the queue is full (${cfg.maxQueue} renders waiting); try again later`)

        const record = journal.create({
            replayUsername: header?.playerName || (f.username ?? "").trim() || "unknown",
            mapTitle: "",
            replayMods: header?.mods ?? 0,
            resolution,
            skin,
            options,
            source: (f.source ?? "").trim().slice(0, 64),
            scoreId,
            beatmapsetId,
            beatmapMd5
        })
        try {
            fs.writeFileSync(replayPath(cfg, record.renderID), sub.replay)
        } catch (err) {
            journal.update(record.renderID, { status: "failed", progress: "Failed", errorCode: 21, errorMessage: `could not store the replay: ${(err as Error).message}`, finishedAt: new Date().toISOString() })
            throw new HttpError(500, 21, `could not store the replay: ${(err as Error).message}`)
        }
        log(`render ${record.renderID} queued: ${record.replayUsername} on set ${beatmapsetId} (${resolution}, skin ${skin}, source ${record.source || "-"}, score ${scoreId ?? "-"})`)
        scheduler.tick()
        return { renderID: record.renderID }
    }

    const serveVideo = (req: http.IncomingMessage, res: http.ServerResponse, name: string): void => {
        const match = name.match(/^(?:render)?(\d+)\.mp4$/)
        const record = match ? journal.get(Number(match[1])) : undefined
        if (!record || record.status !== "done" || record.removed || !record.videoFile || !fs.existsSync(record.videoFile)) {
            throw new HttpError(404, 404, "no such video")
        }
        const size = fs.statSync(record.videoFile).size
        const headers: http.OutgoingHttpHeaders = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "Content-Disposition": `inline; filename="render${record.renderID}.mp4"` }
        const range = req.headers.range
        if (range) {
            const m = range.match(/^bytes=(\d*)-(\d*)$/)
            if (!m || (m[1] === "" && m[2] === "")) {
                res.writeHead(416, { "Content-Range": `bytes */${size}` })
                res.end()
                return
            }
            let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1])
            let end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(size - 1, Number(m[2]))
            if (m[1] === "") start = Math.max(0, size - Number(m[2]))
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
            fs.createReadStream(record.videoFile, { start, end }).pipe(res)
            return
        }
        headers["Content-Length"] = size
        res.writeHead(200, headers)
        if (req.method === "HEAD") {
                res.end()
                return
            }
        fs.createReadStream(record.videoFile).pipe(res)
    }

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? "/", "http://localhost")
        const method = req.method ?? "GET"
        const route = url.pathname.replace(/\/+$/, "") || "/"

        if (route === "/health" && (method === "GET" || method === "HEAD")) return sendJson(res, 200, health())

        if (!cfg.fake || cfg.apiKey) {
            const given = req.headers["x-render-key"]
            if (!keyMatches(cfg.apiKey, Array.isArray(given) ? given[0] : given)) throw new HttpError(401, 401, "missing or invalid X-Render-Key")
        }

        if (route === "/renders" && method === "POST") {
            const { renderID } = await submit(req)
            return sendJson(res, 201, { message: "Render queued", renderID, errorCode: 0 })
        }
        if (route === "/renders" && method === "GET") {
            const raw = url.searchParams.get("renderID")
            if (raw !== null && raw !== "") {
                const record = journal.get(Number(raw))
                const renders = record ? [toApi(record, scheduler.queuePosition(record))] : []
                return sendJson(res, 200, { renders, maxRenders: renders.length })
            }
            const renders = journal.latest(50).map(r => toApi(r, scheduler.queuePosition(r)))
            return sendJson(res, 200, { renders, maxRenders: renders.length })
        }
        if (route === "/skins" && method === "GET") return sendJson(res, 200, { skins: listSkins(cfg.skinsDir) })
        if (route.startsWith("/videos/") && (method === "GET" || method === "HEAD")) return serveVideo(req, res, path.posix.basename(route))
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
