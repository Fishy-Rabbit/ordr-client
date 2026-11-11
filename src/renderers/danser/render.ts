/*
 * Adapted from the o!rdr client (MasterIO02/ordr-client, src/renderers/danser/render.ts)
 * Copyright (c) 2025, issou.best and contributors. BSD-3-Clause; see LICENSE.
 *
 * Spawns danser-cli for one replay, turns its log into progress strings, maps
 * the failure shapes it prints to error codes, and kills it when it stalls or
 * overruns its time budget.
 */
import fs from "fs"
import path from "path"
import { spawn, ChildProcess } from "child_process"
import { RenderWindow, windowArgs } from "../../window"

/** How a run ended: the finished video's path, or an error code and message (with danser's log tail). */
export type DanserOutcome = { success: true; videoPath: string } | { success: false; errorCode: number; errorMessage: string }

/**
 * Everything one run needs: the slot's danser copy and paths, the clip, the environment, the time
 * limits and the callbacks.
 */
export type DanserRunArgs = {
    danserDir: string
    replayPath: string
    outName: string
    settingsName: string
    /** The clip to render, or null for the full play (see src/window.ts). */
    window: RenderWindow | null
    outputDir: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    stallMs: number
    debug: boolean
    /** Receives each progress text: "Rendering (N%)" while danser draws, then "Finalizing". */
    onProgress: (progress: string) => void
    /** Called once, when danser starts drawing frames (after its pp pre-pass). */
    onDrawStart?: () => void
    /** The worker's logger; danser's own output is copied to it only when `debug` is set. */
    log: (line: string) => void
}

/** danser log lines kept for error messages. */
const TAIL_LINES = 40

/**
 * After danser exits, how long run() waits for its output to close before deciding without it. The
 * pipes close within milliseconds of a normal exit, but a child danser left running (its ffmpeg)
 * holds them open until it ends. Deciding without the close first reads any last line danser left
 * without a newline, so an unterminated "Finished." still counts.
 */
const CLOSE_GRACE_MS = 2000

/** The danser-cli command line for one render; a full render's is exactly what it always was. */
export function danserArguments(a: Pick<DanserRunArgs, "replayPath" | "outName" | "settingsName" | "window">): string[] {
    return ["-replay", a.replayPath, "-out", a.outName, "-noupdatecheck", "-skip", `-settings=${a.settingsName}`, ...windowArgs(a.window)]
}

/**
 * One danser-cli process for one render: progress from its log, failures mapped to error codes,
 * killed when it stalls or overruns. danser leads its own process group, so a kill ends everything
 * it started (its ffmpeg encoder among them) and nothing outlives the run in the slot's folders.
 */
export class DanserRun {
    private proc: ChildProcess | null = null
    private abortCode: number | null = null
    private abortMessage = ""

    /** Prepare a run; nothing starts until run(). */
    constructor(private readonly args: DanserRunArgs) {}

    /** Kill danser and everything it started; the first reason given is the one reported. */
    abort(errorCode: number, message: string): void {
        if (this.abortCode === null) {
            this.abortCode = errorCode
            this.abortMessage = message
        }
        this.killGroup()
    }

    /**
     * SIGKILL danser's whole process group (danser and every process it started, ffmpeg among
     * them), falling back to danser alone if the group cannot be signalled. A no-op once the run
     * has settled: the handle is dropped then, so a pid the system has since reused is never hit.
     */
    private killGroup(): void {
        const proc = this.proc
        if (!proc || proc.pid === undefined) return
        try {
            process.kill(-proc.pid, "SIGKILL")
        } catch {
            proc.kill("SIGKILL")
        }
    }

    /**
     * Start danser and settle exactly once: when its output has closed after it exited (so its last
     * lines, "Finished." among them, have been read), CLOSE_GRACE_MS after the exit if a child of
     * danser keeps the output open (that child is killed with the rest of danser's process group,
     * and a last line without a newline is read first), or at once when danser cannot be started
     * at all. The answer is
     * the video path on success, else the abort reason, the first failure recognised in its log, or
     * code 21; each failure carries the log tail. The time limit and the stall detector end a hung
     * run through abort(). Settling stops both timers and drops the process handle.
     */
    run(): Promise<DanserOutcome> {
        const a = this.args
        const videoPath = path.join(a.outputDir, `${a.outName}.mp4`)
        const tempDirs = [path.join(a.danserDir, "videos", `${a.outName}_temp`), path.join(a.outputDir, `${a.outName}_temp`)]
        const tail: string[] = []
        /** Keep the last TAIL_LINES log lines. */
        const remember = (line: string) => {
            tail.push(line)
            if (tail.length > TAIL_LINES) tail.shift()
        }
        /** The kept lines as one text, at most its last 1,500 characters. */
        const tailText = () => tail.join("\n").slice(-1500)

        let canGetProgress = false
        let finished = false
        let panicking = false
        let errorCode: number | null = null
        let errorMessage = ""
        /** Record a failure seen in the log; the first one recorded is the one reported. */
        const fail = (code: number, message: string) => {
            if (errorCode === null) {
                errorCode = code
                errorMessage = message
            }
        }

        return new Promise<DanserOutcome>(resolve => {
            // detached: danser leads a new process group, so killGroup() reaches what it starts.
            const proc = spawn("./danser-cli", danserArguments(a), { cwd: a.danserDir, env: a.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
            this.proc = proc

            const timeout = setTimeout(() => this.abort(21, `render exceeded the ${Math.round(a.timeoutMs / 60000)} minute limit`), a.timeoutMs)

            // Stall detector: once danser has begun writing its temp video/audio,
            // two consecutive checks without growth means it is wedged.
            let lastSize = -1
            let stillChecks = 0
            const stall = setInterval(() => {
                let size = 0
                let seen = false
                for (const dir of tempDirs) {
                    for (const f of ["video.mp4", "audio.mp4"]) {
                        // danser deletes these after muxing; one gone between checks is no error
                        // (a throw here would be uncaught and take the whole worker down).
                        const st = fs.statSync(path.join(dir, f), { throwIfNoEntry: false })
                        if (st) {
                            seen = true
                            size += st.size
                        }
                    }
                }
                if (!seen) return
                if (size <= lastSize) {
                    stillChecks++
                    if (stillChecks >= 2) this.abort(21, `danser stalled: no output growth for ${Math.round((2 * a.stallMs) / 2000)}s`)
                } else {
                    stillChecks = 0
                    lastSize = size
                }
            }, a.stallMs / 2)

            let settled = false
            let closeWait: NodeJS.Timeout | null = null
            /** Resolve once: stop both timers and the close wait and drop the process handle; later calls do nothing. */
            const settle = (outcome: DanserOutcome) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                clearInterval(stall)
                if (closeWait) clearTimeout(closeWait)
                this.proc = null
                resolve(outcome)
            }
            /**
             * Settle with how the run ended, once danser is gone: the video when danser said
             * "Finished." and wrote it, else the abort reason, the first failure seen in the log, or
             * code 21 naming the exit code or signal.
             */
            const conclude = (code: number | null, signal: NodeJS.Signals | null) => {
                if (finished && fs.existsSync(videoPath)) return settle({ success: true, videoPath })
                if (this.abortCode !== null) return settle({ success: false, errorCode: this.abortCode, errorMessage: `${this.abortMessage}\n${tailText()}`.trim() })
                if (errorCode !== null) return settle({ success: false, errorCode, errorMessage: `${errorMessage}\n${tailText()}`.trim() })
                const why = panicking ? "danser panicked" : finished ? "danser finished but wrote no video" : `danser exited with code ${code}${signal ? ` (signal ${signal})` : ""}`
                settle({ success: false, errorCode: 21, errorMessage: `${why}\n${tailText()}`.trim() })
            }

            let hookFailed = false
            /**
             * Call a progress hook (onDrawStart, onProgress: they write the journal) without letting
             * its failure out of this output handler, where a full disk or an I/O error would be
             * uncaught and end the whole worker, every server's renders with it. Only the first
             * failure is logged; the run goes on and settles on danser's own outcome, and the
             * journal still holds the change in memory for its next write.
             */
            const hook = (call: () => void) => {
                try {
                    call()
                } catch (err) {
                    if (hookFailed) return
                    hookFailed = true
                    a.log(`${a.outName}: a progress update could not be recorded (the render goes on): ${(err as Error).message}`)
                }
            }
            /**
             * Read one log line: the draw start and progress from stdout, known failure shapes and
             * panics from either stream. Lines arriving after the run settled (from a child danser
             * left running) are ignored, so they cannot rewrite a finished render's progress.
             */
            const onLine = (line: string, stream: "stdout" | "stderr") => {
                if (settled || !line.trim()) return
                remember(line)
                if (a.debug) a.log(`[danser ${stream}] ${line}`)

                if (stream === "stdout") {
                    // Progress lines before "Starting encoding" belong to the pp pre-pass.
                    if (line.includes("Starting encoding") && !canGetProgress) {
                        canGetProgress = true
                        hook(() => a.onDrawStart?.())
                    }
                    if (canGetProgress && line.includes("Progress")) {
                        const match = line.match(/(\d+)%/)
                        if (match) {
                            const pct = Number(match[1])
                            hook(() => a.onProgress(pct >= 100 ? "Finalizing" : `Rendering (${pct}%)`))
                        }
                    }
                    if (line.includes("Finished.")) {
                        finished = true
                        hook(() => a.onProgress("Finalizing"))
                    }
                    if (line.includes("Beatmap not found")) {
                        fail(8, "danser could not match the replay to a difficulty in the downloaded set (the map may have been updated since the play)")
                    }
                }
                if (line.includes("Invalid data found") || line.includes("strconv.ParseFloat")) {
                    fail(5, "danser found invalid data in the replay; it may be corrupted")
                }
                // danser prefixes its log with a date and time, so a panic reads
                // "2025/01/01 00:00:00 panic: ..."; a Go runtime fatal has no prefix.
                const isPanic = /^\S+ \S+ panic:/.test(line) || line.startsWith("panic:")
                if (isPanic && line.includes("Incompatible mods")) {
                    fail(26, "danser reports an incompatible mod combination")
                }
                if (isPanic || line.startsWith("fatal error:")) panicking = true
            }
            /**
             * Feed a stream to onLine line by line (LF or CRLF). A last line with no newline is held
             * until the stream ends, or until the returned flush hands it over: the exit fallback
             * calls it when a child of danser keeps the stream open past the exit.
             */
            const attach = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr"): (() => void) => {
                if (!stream) return () => {}
                let buffer = ""
                /** Hand the held partial line, if any, to onLine and forget it. */
                const flush = () => {
                    if (buffer) onLine(buffer, name)
                    buffer = ""
                }
                stream.setEncoding("utf8")
                stream.on("data", (chunk: string) => {
                    buffer += chunk
                    const lines = buffer.split(/\r?\n/)
                    buffer = lines.pop() ?? ""
                    for (const line of lines) onLine(line, name)
                })
                stream.on("end", flush)
                return flush
            }
            const flushStdout = attach(proc.stdout, "stdout")
            const flushStderr = attach(proc.stderr, "stderr")

            proc.on("error", err => {
                fail(21, `could not start danser: ${err.message}`)
                // No pid: danser never started, and no exit is guaranteed to follow.
                if (proc.pid === undefined) conclude(null, null)
            })
            // At exit, stdout may still hold danser's last lines; close comes once they are read. When
            // a child keeps the pipes open, the fallback kills that child with the rest of the group
            // (so it cannot keep writing into the slot once the slot is released), reads the held
            // partial lines, then decides.
            proc.on("exit", (code, signal) => {
                closeWait = setTimeout(() => {
                    this.killGroup()
                    flushStdout()
                    flushStderr()
                    conclude(code, signal)
                }, CLOSE_GRACE_MS)
            })
            proc.on("close", (code, signal) => conclude(code, signal))
        })
    }
}
