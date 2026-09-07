import fs from "fs"
import path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { Config } from "./config"
import { Journal, RenderRecord } from "./journal"
import { replayPath } from "./job"

const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * RENDER_FAKE=1: no Xvfb, no danser. A render walks queued -> rendering
 * (progress ticks) -> done in about ten seconds and yields a one-second black
 * 1280x720 MP4 from ffmpeg, so the panels can be built against real shapes.
 */
export async function runFakeJob(cfg: Config, journal: Journal, record: RenderRecord, log: (line: string) => void): Promise<void> {
    const id = record.renderID
    journal.update(id, { status: "rendering", progress: "Rendering (0%)", startedAt: new Date().toISOString(), slot: 0 })
    for (let pct = 10; pct <= 100; pct += 10) {
        await sleep(700)
        journal.update(id, { progress: pct < 100 ? `Rendering (${pct}%)` : "Encoding" })
    }
    await sleep(700)
    journal.update(id, { progress: "Finalizing" })
    const out = path.join(cfg.videosDir, `render${id}.mp4`)
    try {
        await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=1", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out], { timeout: 60_000 })
    } catch (err) {
        journal.update(id, { status: "failed", progress: "Failed", errorCode: 21, errorMessage: `fake render: ffmpeg failed (${(err as Error).message})`, finishedAt: new Date().toISOString() })
        fs.rmSync(replayPath(cfg, id), { force: true })
        return
    }
    fs.rmSync(replayPath(cfg, id), { force: true })
    journal.update(id, { status: "done", progress: "Done", videoFile: out, finishedAt: new Date().toISOString() })
    log(`fake render ${id} done -> ${out}`)
}
