import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import { spawn } from "child_process"
import AdmZip from "adm-zip"
import { Config, PRESETS, isHinaiMirrorUrl } from "./config"
import { Journal, RenderRecord } from "./journal"
import { buildDanserSettings, DEFAULT_OPTIONS, Json, RenderOptions, writeSlotSettings } from "./renderers/danser/prepare"
import { DanserRun } from "./renderers/danser/render"
import { windowedOptions } from "./window"
import { touchSong } from "./songcache"

/**
 * One render slot: its index and X display, its work root, its own copy of danser, and its songs
 * and videos folders.
 */
export type SlotPaths = { index: number; display: string; root: string; danserDir: string; songsDir: string; videosDir: string }

/** Resolve after `ms` milliseconds. */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Abort code reserved for shutdown: the render is re-queued instead of failed. */
export const SHUTDOWN_ABORT = -1

/** danser's environment for one slot: its display, and llvmpipe pinned to a thread budget. */
export function slotEnv(cfg: Config, slot: SlotPaths): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DISPLAY: slot.display,
        LIBGL_ALWAYS_SOFTWARE: "1",
        GALLIUM_DRIVER: "llvmpipe",
        LP_NUM_THREADS: String(cfg.threadsPerSlot),
        // danser execs its bundled ffmpeg/ffmpeg as a child process, and that
        // binary finds its sibling libav*.so only through the loader path.
        LD_LIBRARY_PATH: [path.join(slot.danserDir, "ffmpeg"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
        HOME: slot.root
    }
}

/**
 * Give a slot its own copy of the danser directory (settings, the beatmap
 * database and temp files are written next to the binary, so two slots
 * sharing one would trample each other), plus private songs and videos dirs.
 */
export function prepareSlotDirs(cfg: Config, index: number, display: string): SlotPaths {
    const root = path.join(cfg.workDir, `slot${index}`)
    const danserDir = path.join(root, "danser")
    const songsDir = path.join(root, "songs")
    const videosDir = path.join(root, "videos")
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    fs.cpSync(cfg.danserDir, danserDir, { recursive: true })
    fs.mkdirSync(songsDir, { recursive: true })
    fs.mkdirSync(videosDir, { recursive: true })
    return { index, display, root, danserDir, songsDir, videosDir }
}

/**
 * Let danser write its own defaults file once (`-settings=template`), so the
 * per-render document is a patch over a complete, version-correct base. If
 * danser never writes it, the patch alone is used and danser fills the rest.
 * A danser that cannot even start (an `error` event: EACCES, a missing loader)
 * ends the wait the same way instead of crashing the worker as an unhandled error.
 */
export async function generateSettingsTemplate(cfg: Config, slot: SlotPaths, log: (line: string) => void): Promise<Json> {
    const file = path.join(slot.danserDir, "settings", "template.json")
    fs.rmSync(file, { force: true })
    const proc = spawn("./danser-cli", ["-settings=template", "-noupdatecheck", "-skip"], { cwd: slot.danserDir, env: slotEnv(cfg, slot), stdio: ["ignore", "pipe", "pipe"] })
    let tail = ""
    proc.stdout?.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-1500)))
    proc.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-1500)))
    let exited = false
    proc.on("exit", () => (exited = true))
    proc.on("error", err => {
        tail = (tail + `\nspawn error: ${err.message}`).slice(-1500)
        exited = true
    })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) break
        if (exited) break
        await sleep(250)
    }
    if (!exited) {
        await sleep(500)
        proc.kill("SIGKILL")
    }
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        log(`danser did not write a settings template; renders will use a partial settings file. danser said: ${tail.trim().slice(-400)}`)
        return {}
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Json
        log(`danser settings template captured (${Object.keys(parsed).length} sections)`)
        return parsed
    } catch (err) {
        log(`danser settings template is not valid JSON, ignoring it: ${(err as Error).message}`)
        return {}
    }
}

/** Where a render's uploaded replay waits until its render ends: `<replaysDir>/<renderID>.osr`. */
export function replayPath(cfg: Config, renderID: number): string {
    return path.join(cfg.replaysDir, `${renderID}.osr`)
}

/**
 * The render options from a record's stored values: the default for each one absent, booleans read
 * leniently, the background dim clamped to 0..100 and the cursor size to 0.5..2.
 */
export function parseOptions(raw: Record<string, string | number | boolean>): RenderOptions {
    const o: RenderOptions = { ...DEFAULT_OPTIONS }
    /** A lenient boolean: true, "true", "1" or 1 is true; undefined keeps the fallback; anything else is false. */
    const bool = (v: unknown, fallback: boolean) => (v === undefined ? fallback : v === true || v === "true" || v === "1" || v === 1)
    o.showPPCounter = bool(raw.showPPCounter, o.showPPCounter)
    o.showHitErrorMeter = bool(raw.showHitErrorMeter, o.showHitErrorMeter)
    o.showResultScreen = bool(raw.showResultScreen, o.showResultScreen)
    o.showDanserLogo = bool(raw.showDanserLogo, o.showDanserLogo)
    o.loadVideo = bool(raw.loadVideo, o.loadVideo)
    o.loadStoryboard = bool(raw.loadStoryboard, o.loadStoryboard)
    if (raw.inGameBGDim !== undefined && Number.isFinite(Number(raw.inGameBGDim))) o.inGameBGDim = Math.min(100, Math.max(0, Math.round(Number(raw.inGameBGDim))))
    if (raw.cursorSize !== undefined && Number.isFinite(Number(raw.cursorSize))) o.cursorSize = Math.min(2, Math.max(0.5, Number(raw.cursorSize)))
    return o
}

/**
 * Fetch from the mirror without ever leaving it. Redirects are NOT followed
 * blindly: the hinai mirror can be configured to answer 307s toward upstream
 * mirrors (its "redirect" mode), and following one would pull the bytes from
 * a third party, which this renderer must never do. One hop is allowed when
 * it stays on a hinai mirror host; anything else is refused.
 */
async function fetchFromMirror(cfg: Config, url: string): Promise<Response> {
    if (!isHinaiMirrorUrl(url)) throw new Error(`${url} is not on a hinai mirror host; refusing`)
    const headers = { "User-Agent": cfg.mirrorUserAgent, Accept: "application/octet-stream, */*" }
    const signal = AbortSignal.timeout(10 * 60_000)
    let res: Response
    try {
        res = await fetch(url, { headers, redirect: "manual", signal })
    } catch (err) {
        throw new Error(`the mirror could not be reached (${(err as Error).message})`)
    }
    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location") || ""
        let next = ""
        try {
            next = location ? new URL(location, url).toString() : ""
        } catch {
            next = ""
        }
        if (!next || !isHinaiMirrorUrl(next)) {
            throw new Error(`the mirror redirected to ${next ? new URL(next).hostname : "an unreadable location"}, which is not a hinai mirror host; refusing`)
        }
        try {
            res = await fetch(next, { headers, redirect: "manual", signal })
        } catch (err) {
            throw new Error(`the mirror could not be reached (${(err as Error).message})`)
        }
        if (res.status >= 300 && res.status < 400) throw new Error("the mirror redirected twice; refusing")
    }
    return res
}

/** ensureOsz's answer: the path of the cached .osz, or why the map is not available. */
type OszResult = { ok: true; path: string } | { ok: false; message: string }

/** A set refused for its size (RENDER_MAX_OSZ_MB or the difficulty-file caps); the render fails with code 8. */
export class OszLimitError extends Error {}

/** A byte count for refusal messages: megabytes to one decimal from 1 MB up, plain bytes below. */
const sizeText = (bytes: number) => (bytes >= 1048576 ? `${Number((bytes / 1048576).toFixed(1))} MB` : `${bytes} bytes`)

/** Downloads in progress, by set id: a second render of a set that is downloading waits for that download. */
const oszDownloads = new Map<number, Promise<OszResult>>()

/**
 * The .osz for a set, from the songs cache or fetched from the mirror by set id. A cache hit
 * refreshes the file's mtime, the "last used" clock the daily cache sweep reads (songcache.ts).
 * Two slots can ask for the same uncached set at once: they share one download, so only one ever
 * writes `<setId>.osz.part`. Different sets download independently. Everything up to registering
 * the download runs before the first await, so a second call in the same tick already sees it.
 */
export async function ensureOsz(cfg: Config, setId: number, log: (line: string) => void): Promise<OszResult> {
    const pending = oszDownloads.get(setId)
    if (pending) {
        log(`set ${setId} is already downloading for another render; waiting for that download`)
        return pending
    }
    const dest = path.join(cfg.songsDir, `${setId}.osz`)
    const cached = fs.statSync(dest, { throwIfNoEntry: false })
    if (cached && cached.size > 0) {
        touchSong(dest)
        return { ok: true, path: dest }
    }
    const download = downloadOsz(cfg, setId, dest, log).finally(() => oszDownloads.delete(setId))
    oszDownloads.set(setId, download)
    return download
}

/**
 * Download a set from the mirror into `<dest>.part`, check the zip magic, then rename it to `dest`.
 * The body is counted while it streams: past cfg.maxOszBytes (RENDER_MAX_OSZ_MB) the download is
 * cut off and the part file deleted, as it is when the mirror's Content-Length already says the set
 * is too large. Only ensureOsz calls this, at most once per set at a time.
 */
async function downloadOsz(cfg: Config, setId: number, dest: string, log: (line: string) => void): Promise<OszResult> {
    const url = `${cfg.mirrorBase}${cfg.mirrorDownloadPath.replace("{id}", String(setId))}`
    log(`fetching set ${setId} from the mirror`)
    let res: Response
    try {
        res = await fetchFromMirror(cfg, url)
    } catch (err) {
        return { ok: false, message: `map not available on the mirror: ${(err as Error).message}` }
    }
    if (res.status === 404) return { ok: false, message: `map not available on the mirror (set ${setId} answered 404)` }
    if (!res.ok || !res.body) return { ok: false, message: `map not available on the mirror (set ${setId} answered HTTP ${res.status})` }
    const tooLarge = `map not available on the mirror: set ${setId} is larger than the RENDER_MAX_OSZ_MB limit (${sizeText(cfg.maxOszBytes)})`
    if (Number(res.headers.get("content-length")) > cfg.maxOszBytes) {
        await res.body.cancel().catch(() => undefined)
        return { ok: false, message: tooLarge }
    }
    let received = 0
    const capped = new Transform({
        /** Pass each chunk through until more than maxOszBytes have arrived, then fail the download. */
        transform(chunk: Buffer, _encoding, done) {
            received += chunk.length
            if (received > cfg.maxOszBytes) done(new OszLimitError(tooLarge))
            else done(null, chunk)
        }
    })
    const tmp = `${dest}.part`
    try {
        await pipeline(Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream), capped, fs.createWriteStream(tmp))
        const fd = fs.openSync(tmp, "r")
        const head = Buffer.alloc(2)
        fs.readSync(fd, head, 0, 2, 0)
        fs.closeSync(fd)
        if (head.toString("latin1") !== "PK") {
            fs.rmSync(tmp, { force: true })
            return { ok: false, message: `map not available on the mirror (set ${setId}: the answer was not a .osz)` }
        }
        fs.renameSync(tmp, dest)
    } catch (err) {
        fs.rmSync(tmp, { force: true })
        if (err instanceof OszLimitError) return { ok: false, message: err.message }
        return { ok: false, message: `map not available on the mirror: download failed (${(err as Error).message})` }
    }
    return { ok: true, path: dest }
}

/** Whether the replay's difficulty is in the set, and the title to show for it. */
export type DiffInfo = { found: boolean; title: string }

/** The size caps inspectOsz applies: the .osz file, one difficulty file, and a set's difficulty files together. */
export type OszLimits = { oszBytes: number; osuBytes: number; setOsuBytes: number }

/**
 * The difficulty-file caps. Real .osu files are small (32 KB at the median; the largest of about a
 * million is 35 MB); the per-set total keeps a set of many large ones from holding the worker in
 * inflate for long.
 */
export const OSU_FILE_LIMITS = { osuBytes: 64 * 1024 * 1024, setOsuBytes: 512 * 1024 * 1024 }

/**
 * Find the difficulty the replay was played on and name it "Artist - Title [Version]". The set is
 * untrusted, so its sizes are checked before anything is read into memory: an .osz over
 * limits.oszBytes is refused unread, and so is a difficulty file whose declared size is over
 * limits.osuBytes or takes the set's total over limits.setOsuBytes. adm-zip (0.5.18) allocates the
 * declared size and inflates with it as zlib's maxOutputLength, so capping the declared size caps
 * the memory; a declared size of 0 is the exception (adm-zip then inflates with no output limit),
 * so such an entry is taken for the empty file it claims to be and never inflated. Size refusals
 * throw OszLimitError; a damaged archive throws adm-zip's own error.
 */
export function inspectOsz(oszPath: string, beatmapMd5: string | null, limits: OszLimits): DiffInfo {
    const size = fs.statSync(oszPath).size
    if (size > limits.oszBytes) throw new OszLimitError(`the set's .osz is ${sizeText(size)}, larger than the RENDER_MAX_OSZ_MB limit (${sizeText(limits.oszBytes)})`)
    const zip = new AdmZip(oszPath)
    let fallbackTitle = ""
    let declaredTotal = 0
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".osu")) continue
        const declared = entry.header.size
        if (declared > limits.osuBytes) throw new OszLimitError(`a difficulty file in the set declares ${sizeText(declared)}, more than the ${sizeText(limits.osuBytes)} one may have`)
        declaredTotal += declared
        if (declaredTotal > limits.setOsuBytes) throw new OszLimitError(`the set's difficulty files declare more than ${sizeText(limits.setOsuBytes)} together`)
        const data = declared === 0 ? Buffer.alloc(0) : entry.getData()
        const md5 = crypto.createHash("md5").update(data).digest("hex")
        const text = data.toString("utf8", 0, Math.min(data.length, 16384))
        /** The value of the first `<key>:` line in the difficulty file's first 16 KiB, or an empty string. */
        const pick = (key: string) => text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"))?.[1] ?? ""
        const title = `${pick("Artist")} - ${pick("Title")} [${pick("Version")}]`
        if (!fallbackTitle) fallbackTitle = title
        if (beatmapMd5 && md5 === beatmapMd5) return { found: true, title }
    }
    return { found: !beatmapMd5, title: fallbackTitle }
}

/**
 * Empty the slot's songs folder, its videos folder and danser's own videos folder, and delete
 * danser's beatmap database, so nothing from one render carries into the next.
 */
function cleanSlot(slot: SlotPaths): void {
    for (const dir of [slot.songsDir, slot.videosDir, path.join(slot.danserDir, "videos")]) {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
    }
    fs.rmSync(path.join(slot.danserDir, "danser.db"), { force: true })
}

/** Rename a file, falling back to copy and delete when the move crosses filesystems (EXDEV). */
function moveFile(from: string, to: string): void {
    try {
        fs.renameSync(from, to)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
        fs.copyFileSync(from, to)
        fs.rmSync(from, { force: true })
    }
}

/**
 * Render one queued record on one slot, end to end. Never throws for a render
 * failure: the record is marked failed with a code and the log tail. A map set
 * refused for its size or unreadable fails with code 8 and is not kept. A
 * finished render is recorded done before its replay is deleted.
 *
 * `register` hands the danser run to the scheduler, so a shutdown can abort it, and
 * gets null once the run settles. It returns false when the worker began shutting
 * down while this render prepared its map: the scheduler's stop() could not abort a
 * run that did not exist yet, so the run is never started and the render goes back
 * to the queue with its replay, like a render the shutdown aborted.
 */
export async function runRenderJob(cfg: Config, journal: Journal, record: RenderRecord, slot: SlotPaths, template: Json, log: (line: string) => void, register: (run: DanserRun | null) => boolean | void): Promise<void> {
    const id = record.renderID
    const osr = replayPath(cfg, id)
    /** Mark the render failed with this code and message, delete its replay, and log the message's first line. */
    const finishFail = (errorCode: number, errorMessage: string) => {
        journal.update(id, { status: "failed", errorCode, errorMessage, progress: "Failed", finishedAt: new Date().toISOString(), slot: slot.index })
        fs.rmSync(osr, { force: true })
        log(`render ${id} failed (${errorCode}): ${errorMessage.split("\n")[0]}`)
    }
    /** The worker is going down: keep the replay and let the next boot re-run the render. */
    const requeueForRestart = () => journal.update(id, { status: "queued", progress: "Waiting (resumed after a restart)", slot: null })

    journal.update(id, { status: "rendering", progress: "Rendering (preparing)", startedAt: new Date().toISOString(), drawStartedAt: null, progressAt: null, slot: slot.index })
    log(`render ${id} starting on slot ${slot.index} (${record.resolution}, skin ${record.skin}${record.window ? `, window ${record.window.start}-${record.window.end}s` : ""})`)

    if (!fs.existsSync(osr)) return finishFail(5, "the replay file is no longer on disk")
    if (!record.beatmapsetId) return finishFail(8, "map not available on the mirror: no beatmapsetId was given")

    const osz = await ensureOsz(cfg, record.beatmapsetId, log)
    if (!osz.ok) return finishFail(8, osz.message)

    let diff: DiffInfo
    try {
        diff = inspectOsz(osz.path, record.beatmapMd5, { oszBytes: cfg.maxOszBytes, ...OSU_FILE_LIMITS })
    } catch (err) {
        fs.rmSync(osz.path, { force: true })
        const why = err instanceof OszLimitError ? err.message : `the cached .osz is unreadable (${(err as Error).message})`
        return finishFail(8, `map not available on the mirror: ${why}`)
    }
    if (!diff.found) return finishFail(8, `the set on the mirror has no difficulty with md5 ${record.beatmapMd5}; the map was probably updated after this play`)
    if (diff.title && diff.title !== record.mapTitle) journal.update(id, { mapTitle: diff.title })

    const preset = PRESETS[record.resolution] ?? PRESETS["1280x720"]
    try {
        cleanSlot(slot)
        fs.copyFileSync(osz.path, path.join(slot.songsDir, `${record.beatmapsetId}.osz`))
        const settings = buildDanserSettings(template, {
            songsDir: slot.songsDir,
            skinsDir: cfg.skinsDir,
            outputDir: slot.videosDir,
            preset,
            options: windowedOptions(parseOptions(record.options), record.window ?? null),
            skin: record.skin || "default"
        })
        writeSlotSettings(slot.danserDir, `slot${slot.index}`, settings)
    } catch (err) {
        return finishFail(21, `could not prepare the render slot: ${(err as Error).message}`)
    }

    const run = new DanserRun({
        danserDir: slot.danserDir,
        replayPath: osr,
        outName: `render${id}`,
        settingsName: `slot${slot.index}`,
        window: record.window ?? null,
        outputDir: slot.videosDir,
        env: slotEnv(cfg, slot),
        timeoutMs: cfg.timeoutMs,
        stallMs: cfg.stallMs,
        debug: cfg.debug,
        /** danser's progress text, stored as a lazily written tick. */
        onProgress: progress => journal.progress(id, progress),
        /** Stamp when danser starts drawing; the ETA projects the job's speed from it. */
        onDrawStart: () => journal.update(id, { drawStartedAt: new Date().toISOString() }),
        log
    })
    if (register(run) === false) {
        requeueForRestart()
        log(`render ${id} re-queued: the worker began shutting down while its map was being prepared`)
        return
    }
    const outcome = await run.run()
    register(null)

    if (!outcome.success) {
        if (outcome.errorCode === SHUTDOWN_ABORT) {
            requeueForRestart()
            return
        }
        return finishFail(outcome.errorCode, outcome.errorMessage)
    }

    const finalPath = path.join(cfg.videosDir, `render${id}.mp4`)
    try {
        moveFile(outcome.videoPath, finalPath)
    } catch (err) {
        return finishFail(21, `could not move the finished video into the videos volume: ${(err as Error).message}`)
    }
    // Done is recorded before the replay goes: a crash in between leaves a stray replay file,
    // never a "rendering" record without its replay, which the next boot would re-queue and fail
    // with code 5 while the finished video sat outside the retention sweep. Nothing after this
    // line may turn the render into a failure, so the cleanup only logs.
    journal.update(id, { status: "done", progress: "Done", videoFile: finalPath, finishedAt: new Date().toISOString() })
    try {
        fs.rmSync(osr, { force: true })
        cleanSlot(slot)
    } catch (err) {
        log(`render ${id}: cleanup after the render failed: ${(err as Error).message}`)
    }
    const seconds = record.startedAt ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000) : 0
    log(`render ${id} done in ${seconds}s -> ${finalPath} (${fs.statSync(finalPath, { throwIfNoEntry: false })?.size ?? 0} bytes)`)
}
