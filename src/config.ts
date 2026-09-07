import path from "path"

export const VERSION = "1.0.0"

export type Preset = { width: number; height: number; fps: number; turbo: boolean }

/**
 * The resolutions a client may ask for. The keys are the exact wire values;
 * 640x480 is the turbo preview preset (15 fps, ultrafast x264, tiny audio).
 */
export const PRESETS: Record<string, Preset> = {
    "1280x720": { width: 1280, height: 720, fps: 30, turbo: false },
    "960x540": { width: 960, height: 540, fps: 30, turbo: false },
    "1920x1080": { width: 1920, height: 1080, fps: 60, turbo: false },
    "640x480": { width: 640, height: 480, fps: 15, turbo: true }
}
export const DEFAULT_RESOLUTION = "1280x720"

export type Config = {
    port: number
    apiKey: string
    fake: boolean
    concurrency: number
    threadsPerSlot: number
    timeoutMs: number
    stallMs: number
    retentionDays: number
    maxQueue: number
    maxReplayBytes: number
    mirrorBase: string
    mirrorUserAgent: string
    videosDir: string
    songsDir: string
    skinsDir: string
    stateDir: string
    replaysDir: string
    workDir: string
    danserDir: string
    danserVersion: string
    displayBase: number
    debug: boolean
}

function num(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
    return n
}

function str(name: string, fallback: string): string {
    const raw = process.env[name]
    return raw === undefined || raw === "" ? fallback : raw
}

function flag(name: string): boolean {
    const raw = (process.env[name] ?? "").trim().toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

/**
 * Everything is configured by environment. The path defaults are relative to
 * the working directory so `npm start` works on a laptop; the Docker image
 * points them at the /data and /work volumes.
 */
export function loadConfig(): Config {
    const cwd = process.cwd()
    const stateDir = path.resolve(str("STATE_DIR", path.join(cwd, "data", "state")))
    const cfg: Config = {
        port: num("PORT", 3002),
        apiKey: str("RENDER_API_KEY", ""),
        fake: flag("RENDER_FAKE"),
        concurrency: Math.max(1, Math.floor(num("RENDER_CONCURRENCY", 2))),
        threadsPerSlot: Math.max(1, Math.floor(num("RENDER_THREADS_PER_SLOT", 4))),
        timeoutMs: Math.max(1, num("RENDER_TIMEOUT_MIN", 90)) * 60_000,
        stallMs: Math.max(30, num("RENDER_STALL_SEC", 90)) * 1000,
        retentionDays: Math.max(1, num("RENDER_RETENTION_DAYS", 30)),
        maxQueue: Math.max(1, Math.floor(num("RENDER_MAX_QUEUE", 20))),
        maxReplayBytes: Math.max(1, num("RENDER_MAX_REPLAY_MB", 16)) * 1024 * 1024,
        mirrorBase: str("MIRROR_BASE", "http://beatmap-mirror.hinai-rusty-mirror.svc.cluster.local:6100").replace(/\/+$/, ""),
        mirrorUserAgent: str("MIRROR_USER_AGENT", "ordr-render/1.0 (+https://fishy.moe)"),
        videosDir: path.resolve(str("VIDEOS_DIR", path.join(cwd, "data", "videos"))),
        songsDir: path.resolve(str("SONGS_DIR", path.join(cwd, "data", "songs"))),
        skinsDir: path.resolve(str("SKINS_DIR", path.join(cwd, "data", "skins"))),
        stateDir,
        replaysDir: path.resolve(str("REPLAYS_DIR", path.join(stateDir, "replays"))),
        workDir: path.resolve(str("WORK_DIR", path.join(cwd, "work"))),
        danserDir: path.resolve(str("DANSER_DIR", path.join(cwd, "bins", "danser"))),
        danserVersion: str("DANSER_VERSION", "unknown"),
        displayBase: Math.floor(num("XVFB_DISPLAY_BASE", 10)),
        debug: flag("RENDER_DEBUG")
    }
    if (!cfg.apiKey && !cfg.fake) {
        throw new Error("RENDER_API_KEY is not set. Refusing to start an unauthenticated renderer: set it, or set RENDER_FAKE=1 for the development stub.")
    }
    return cfg
}
