import { spawn } from "child_process"
import type { ReplayHeader } from "./osr"
import type { RenderWindow } from "./window"

/**
 * How long a replay plays, from its own frames, so a render's length can be estimated
 * before danser starts (fleet.ts expectedSeconds). Render time follows play length:
 * danser draws about 1.2 s per second of play on the Backup node.
 *
 * The frames are an LZMA ("alone" format) block inside the .osr. Node has no LZMA, so
 * the block goes through xz (Debian's xz-utils in the image) as a child process, with
 * the output capped and a time limit: the input comes from callers, and an LZMA stream
 * can expand enormously. Anything that goes wrong gives no length, never an error; the
 * estimate then falls back to the median render.
 */

/** Decompressed frame text this large is not a replay (a 10-minute play is about 1 MB). */
export const MAX_FRAME_TEXT_BYTES = 32 * 1024 * 1024

const XZ_TIMEOUT_MS = 10_000
const MOD_DOUBLETIME = 1 << 6
const MOD_HALFTIME = 1 << 8
const MOD_NIGHTCORE = 1 << 9
/** The frame osu! appends to carry the RNG seed; its time is not a time. */
const SEED_FRAME = -12345

export type DecompressOptions = { maxBytes?: number; xzPath?: string; timeoutMs?: number }

/** The frame block as text, or null when it is not LZMA, too large, or xz is missing or fails. */
export function decompressFrames(block: Buffer, opts: DecompressOptions = {}): Promise<string | null> {
    const maxBytes = opts.maxBytes ?? MAX_FRAME_TEXT_BYTES
    // The 13-byte header declares the output size (-1 = unknown): refuse a too-large claim unread.
    if (block.length < 13) return Promise.resolve(null)
    const declared = block.readBigInt64LE(5)
    if (declared >= 0n && declared > BigInt(maxBytes)) return Promise.resolve(null)

    return new Promise(resolve => {
        let done = false
        const finish = (value: string | null) => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve(value)
        }
        const proc = spawn(opts.xzPath ?? "xz", ["--format=lzma", "--decompress", "--stdout", "--memlimit-decompress=64MiB"], { stdio: ["pipe", "pipe", "ignore"] })
        const timer = setTimeout(() => {
            proc.kill("SIGKILL")
            finish(null)
        }, opts.timeoutMs ?? XZ_TIMEOUT_MS)
        const chunks: Buffer[] = []
        let size = 0
        proc.stdout.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > maxBytes) {
                proc.kill("SIGKILL")
                finish(null)
                return
            }
            chunks.push(chunk)
        })
        proc.on("error", () => finish(null))
        proc.on("close", code => finish(code === 0 ? Buffer.concat(chunks).toString("latin1") : null))
        proc.stdin.on("error", () => finish(null))
        proc.stdin.end(block)
    })
}

/** The song time (ms) of the last frame: the frames' time deltas summed, the seed frame skipped. */
export function framesEndMs(text: string | null): number | null {
    if (!text) return null
    let t = 0
    let end = 0
    let counted = 0
    for (const frame of text.split(",")) {
        const parts = frame.split("|")
        if (parts.length < 4) continue
        const w = Number(parts[0])
        if (!Number.isFinite(w) || w === SEED_FRAME) continue
        t += w
        counted++
        if (t > end) end = t
    }
    return counted > 0 && end > 0 ? end : null
}

/**
 * Seconds of video a render of this play makes: song time clipped to the window (song
 * seconds), then divided by the speed DT/NC (1.5x) or HT (0.75x) play it at.
 */
export function playSeconds(endMs: number, mods: number, window: RenderWindow | null): number {
    let song = endMs / 1000
    if (window) song = Math.max(0, Math.min(window.end, song) - window.start)
    const rate = mods & (MOD_DOUBLETIME | MOD_NIGHTCORE) ? 1.5 : mods & MOD_HALFTIME ? 0.75 : 1
    return Math.round((song / rate) * 10) / 10
}

/** Seconds of video this replay will render to, or null when the frames cannot be read. */
export async function replayPlaySeconds(replay: Buffer, header: ReplayHeader, window: RenderWindow | null, opts: DecompressOptions = {}): Promise<number | null> {
    const block = replay.subarray(header.frameOffset, header.frameOffset + header.frameBytes)
    if (block.length !== header.frameBytes) return null
    const end = framesEndMs(await decompressFrames(block, opts))
    return end === null ? null : playSeconds(end, header.mods, window)
}
