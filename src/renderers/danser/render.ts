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

export type DanserOutcome = { success: true; videoPath: string } | { success: false; errorCode: number; errorMessage: string }

export type DanserRunArgs = {
    danserDir: string
    replayPath: string
    outName: string
    settingsName: string
    outputDir: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    stallMs: number
    debug: boolean
    onProgress: (progress: string) => void
    log: (line: string) => void
}

const TAIL_LINES = 40

export class DanserRun {
    private proc: ChildProcess | null = null
    private abortCode: number | null = null
    private abortMessage = ""

    constructor(private readonly args: DanserRunArgs) {}

    /** Kill danser; the first reason given is the one reported. */
    abort(errorCode: number, message: string): void {
        if (this.abortCode === null) {
            this.abortCode = errorCode
            this.abortMessage = message
        }
        this.proc?.kill("SIGKILL")
    }

    run(): Promise<DanserOutcome> {
        const a = this.args
        const videoPath = path.join(a.outputDir, `${a.outName}.mp4`)
        const tempDirs = [path.join(a.danserDir, "videos", `${a.outName}_temp`), path.join(a.outputDir, `${a.outName}_temp`)]
        const tail: string[] = []
        const remember = (line: string) => {
            tail.push(line)
            if (tail.length > TAIL_LINES) tail.shift()
        }
        const tailText = () => tail.join("\n").slice(-1500)

        let canGetProgress = false
        let finished = false
        let panicking = false
        let errorCode: number | null = null
        let errorMessage = ""
        const fail = (code: number, message: string) => {
            if (errorCode === null) {
                errorCode = code
                errorMessage = message
            }
        }

        return new Promise<DanserOutcome>(resolve => {
            const danserArguments = ["-replay", a.replayPath, "-out", a.outName, "-noupdatecheck", "-skip", `-settings=${a.settingsName}`]
            const proc = spawn("./danser-cli", danserArguments, { cwd: a.danserDir, env: a.env, stdio: ["ignore", "pipe", "pipe"] })
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
                        const p = path.join(dir, f)
                        if (fs.existsSync(p)) {
                            seen = true
                            size += fs.statSync(p).size
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

            const onLine = (line: string, stream: "stdout" | "stderr") => {
                if (!line.trim()) return
                remember(line)
                if (a.debug) a.log(`[danser ${stream}] ${line}`)

                if (stream === "stdout") {
                    // Progress lines before "Starting encoding" belong to the pp pre-pass.
                    if (line.includes("Starting encoding")) canGetProgress = true
                    if (canGetProgress && line.includes("Progress")) {
                        const match = line.match(/(\d+)%/)
                        if (match) {
                            const pct = Number(match[1])
                            a.onProgress(pct >= 100 ? "Finalizing" : `Rendering (${pct}%)`)
                        }
                    }
                    if (line.includes("Finished.")) {
                        finished = true
                        a.onProgress("Finalizing")
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
            const attach = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
                if (!stream) return
                let buffer = ""
                stream.setEncoding("utf8")
                stream.on("data", (chunk: string) => {
                    buffer += chunk
                    const lines = buffer.split(/\r?\n/)
                    buffer = lines.pop() ?? ""
                    for (const line of lines) onLine(line, name)
                })
                stream.on("end", () => {
                    if (buffer) onLine(buffer, name)
                })
            }
            attach(proc.stdout, "stdout")
            attach(proc.stderr, "stderr")

            proc.on("error", err => {
                fail(21, `could not start danser: ${err.message}`)
            })
            proc.on("exit", (code, signal) => {
                clearTimeout(timeout)
                clearInterval(stall)
                this.proc = null
                if (finished && fs.existsSync(videoPath)) {
                    resolve({ success: true, videoPath })
                    return
                }
                if (this.abortCode !== null) {
                    resolve({ success: false, errorCode: this.abortCode, errorMessage: `${this.abortMessage}\n${tailText()}`.trim() })
                    return
                }
                if (errorCode !== null) {
                    resolve({ success: false, errorCode, errorMessage: `${errorMessage}\n${tailText()}`.trim() })
                    return
                }
                const why = panicking ? "danser panicked" : finished ? "danser finished but wrote no video" : `danser exited with code ${code}${signal ? ` (signal ${signal})` : ""}`
                resolve({ success: false, errorCode: 21, errorMessage: `${why}\n${tailText()}`.trim() })
            })
        })
    }
}
