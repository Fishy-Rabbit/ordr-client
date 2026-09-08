import fs from "fs"
import path from "path"
import crypto from "crypto"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { spawn } from "child_process"
import AdmZip from "adm-zip"
import { Config, PRESETS, isHinaiMirrorUrl } from "./config"
import { Journal, RenderRecord } from "./journal"
import { buildDanserSettings, DEFAULT_OPTIONS, Json, RenderOptions, writeSlotSettings } from "./renderers/danser/prepare"
import { DanserRun } from "./renderers/danser/render"

export type SlotPaths = { index: number; display: string; root: string; danserDir: string; songsDir: string; videosDir: string }

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

export function replayPath(cfg: Config, renderID: number): string {
    return path.join(cfg.replaysDir, `${renderID}.osr`)
}

export function parseOptions(raw: Record<string, string | number | boolean>): RenderOptions {
    const o: RenderOptions = { ...DEFAULT_OPTIONS }
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

type OszResult = { ok: true; path: string } | { ok: false; message: string }

/** The .osz for a set, from the songs cache or fetched from the mirror by set id. */
async function ensureOsz(cfg: Config, setId: number, log: (line: string) => void): Promise<OszResult> {
    const dest = path.join(cfg.songsDir, `${setId}.osz`)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { ok: true, path: dest }
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
    const tmp = `${dest}.part`
    try {
        await pipeline(Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream), fs.createWriteStream(tmp))
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
        return { ok: false, message: `map not available on the mirror: download failed (${(err as Error).message})` }
    }
    return { ok: true, path: dest }
}

type DiffInfo = { found: boolean; title: string }

/** Find the difficulty the replay was played on and name it "Artist - Title [Version]". */
function inspectOsz(oszPath: string, beatmapMd5: string | null): DiffInfo {
    const zip = new AdmZip(oszPath)
    let fallbackTitle = ""
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".osu")) continue
        const data = entry.getData()
        const md5 = crypto.createHash("md5").update(data).digest("hex")
        const text = data.toString("utf8", 0, Math.min(data.length, 16384))
        const pick = (key: string) => text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"))?.[1] ?? ""
        const title = `${pick("Artist")} - ${pick("Title")} [${pick("Version")}]`
        if (!fallbackTitle) fallbackTitle = title
        if (beatmapMd5 && md5 === beatmapMd5) return { found: true, title }
    }
    return { found: !beatmapMd5, title: fallbackTitle }
}

function cleanSlot(slot: SlotPaths): void {
    for (const dir of [slot.songsDir, slot.videosDir, path.join(slot.danserDir, "videos")]) {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
    }
    fs.rmSync(path.join(slot.danserDir, "danser.db"), { force: true })
}

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
 * failure: the record is marked failed with a code and the log tail.
 */
export async function runRenderJob(cfg: Config, journal: Journal, record: RenderRecord, slot: SlotPaths, template: Json, log: (line: string) => void, register: (run: DanserRun | null) => void): Promise<void> {
    const id = record.renderID
    const osr = replayPath(cfg, id)
    const finishFail = (errorCode: number, errorMessage: string) => {
        journal.update(id, { status: "failed", errorCode, errorMessage, progress: "Failed", finishedAt: new Date().toISOString(), slot: slot.index })
        fs.rmSync(osr, { force: true })
        log(`render ${id} failed (${errorCode}): ${errorMessage.split("\n")[0]}`)
    }

    journal.update(id, { status: "rendering", progress: "Rendering (preparing)", startedAt: new Date().toISOString(), slot: slot.index })
    log(`render ${id} starting on slot ${slot.index} (${record.resolution}, skin ${record.skin})`)

    if (!fs.existsSync(osr)) return finishFail(5, "the replay file is no longer on disk")
    if (!record.beatmapsetId) return finishFail(8, "map not available on the mirror: no beatmapsetId was given")

    const osz = await ensureOsz(cfg, record.beatmapsetId, log)
    if (!osz.ok) return finishFail(8, osz.message)

    let diff: DiffInfo
    try {
        diff = inspectOsz(osz.path, record.beatmapMd5)
    } catch (err) {
        fs.rmSync(osz.path, { force: true })
        return finishFail(8, `map not available on the mirror: the cached .osz is unreadable (${(err as Error).message})`)
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
            options: parseOptions(record.options),
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
        outputDir: slot.videosDir,
        env: slotEnv(cfg, slot),
        timeoutMs: cfg.timeoutMs,
        stallMs: cfg.stallMs,
        debug: cfg.debug,
        onProgress: progress => journal.update(id, { progress }),
        log
    })
    register(run)
    const outcome = await run.run()
    register(null)

    if (!outcome.success) {
        if (outcome.errorCode === SHUTDOWN_ABORT) {
            // The worker is going down: keep the replay and let the next boot re-run it.
            journal.update(id, { status: "queued", progress: "Waiting (resumed after a restart)", slot: null })
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
    fs.rmSync(osr, { force: true })
    cleanSlot(slot)
    journal.update(id, { status: "done", progress: "Done", videoFile: finalPath, finishedAt: new Date().toISOString() })
    const seconds = record.startedAt ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000) : 0
    log(`render ${id} done in ${seconds}s -> ${finalPath} (${fs.statSync(finalPath).size} bytes)`)
}
