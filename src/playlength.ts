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
 * the output capped, a memory limit, a time limit and at most two at once: the input
 * comes from callers, and an LZMA stream can expand enormously. Anything that goes wrong
 * gives no length, never an error; the estimate then falls back to the median render.
 */

/** Decompressed frame text this large is not a replay (262 s of play is 0.4 MB, so this is about 1.5 hours). */
export const MAX_FRAME_TEXT_BYTES = 8 * 1024 * 1024

/** Song time no real play reaches: a frame total past this is not trusted. */
export const MAX_SONG_MS = 3 * 3600 * 1000

/** xz processes allowed at once; a submission past this gets no length rather than waiting. */
const MAX_CONCURRENT_XZ = 2
/** xz processes running now (at most MAX_CONCURRENT_XZ). */
let runningXz = 0

/** An xz run still going after this long is killed and gives no length. */
const XZ_TIMEOUT_MS = 10_000
const MOD_DOUBLETIME = 1 << 6
const MOD_HALFTIME = 1 << 8
const MOD_NIGHTCORE = 1 << 9
/** The frame osu! appends to carry the RNG seed; its time is not a time. */
const SEED_FRAME = -12345

/** Overrides for decompressFrames (tests use them): the output cap, the xz binary and the time limit. */
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
        /** Settle once: clear the timer and resolve; later calls do nothing. */
        const finish = (value: string | null) => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve(value)
        }
        const proc = spawn(opts.xzPath ?? "xz", ["--format=lzma", "--decompress", "--stdout", "--memlimit-decompress=32MiB"], { stdio: ["pipe", "pipe", "ignore"] })
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

const COMMA = 44
const BAR = 124
const MINUS = 45
const DIGIT_0 = 48
const DIGIT_9 = 57
/** The longest delta read in place: every integer under 10^15 is exact in a double, digit by digit. */
const MAX_PLAIN_DIGITS = 15

/**
 * The song time (ms) of the last frame: the frames' time deltas summed, the seed frame and
 * malformed frames (fewer than four "|"-separated fields, non-finite delta) skipped. One
 * pass over the characters, no arrays: linear whatever the text holds. Null past MAX_SONG_MS.
 * The delta osu! writes is a plain integer ("-?digits"); it is read in place while the pass goes
 * by, so a well-formed frame allocates nothing. Any other spelling (a sign other than a leading
 * "-", a decimal point, an exponent, spaces, more than 15 digits, an empty field) is cut out and
 * read by Number(), so every delta means exactly what Number() makes of it, as it always did.
 */
export function framesEndMs(text: string | null): number | null {
    if (!text) return null
    let t = 0
    let end = 0
    let counted = 0
    let frameStart = 0
    let firstBar = -1
    let bars = 0
    // The delta field so far: its digits as a number, a leading "-", and whether it is still plain.
    let digitsValue = 0
    let digits = 0
    let negative = false
    let plain = true
    for (let k = 0; k <= text.length; k++) {
        const c = k < text.length ? text.charCodeAt(k) : COMMA
        if (c === BAR) {
            if (bars === 0) firstBar = k
            bars++
        } else if (c === COMMA) {
            if (bars >= 3) {
                const w = plain && digits > 0 && digits <= MAX_PLAIN_DIGITS ? (negative ? -digitsValue : digitsValue) : Number(text.slice(frameStart, firstBar))
                if (Number.isFinite(w) && w !== SEED_FRAME) {
                    t += w
                    counted++
                    if (t > end) end = t
                }
            }
            frameStart = k + 1
            firstBar = -1
            bars = 0
            digitsValue = 0
            digits = 0
            negative = false
            plain = true
        } else if (bars === 0 && plain) {
            if (c >= DIGIT_0 && c <= DIGIT_9) {
                digitsValue = digitsValue * 10 + (c - DIGIT_0)
                digits++
            } else if (c === MINUS && k === frameStart) {
                negative = true
            } else {
                plain = false
            }
        }
    }
    if (counted === 0 || end <= 0 || end > MAX_SONG_MS) return null
    return end
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
    if (runningXz >= MAX_CONCURRENT_XZ) return null
    runningXz++
    try {
        const end = framesEndMs(await decompressFrames(block, opts))
        return end === null ? null : playSeconds(end, header.mods, window)
    } finally {
        runningXz--
    }
}
