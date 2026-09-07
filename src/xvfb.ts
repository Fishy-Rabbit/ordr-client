import { spawn, ChildProcess } from "child_process"
import fs from "fs"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One virtual X display per render slot. danser needs a GLX context; under
 * Xvfb + Mesa llvmpipe that is a pure CPU path. The server is kept alive for
 * the life of the worker and respawned if it ever dies.
 */
export class Xvfb {
    private proc: ChildProcess | null = null
    private stopping = false
    private stderrTail = ""

    constructor(
        public readonly display: number,
        private readonly log: (line: string) => void
    ) {}

    get displayName(): string {
        return `:${this.display}`
    }

    get alive(): boolean {
        return this.proc !== null
    }

    async start(): Promise<void> {
        // /tmp may be a fresh empty volume (the k8s emptyDir): Xvfb needs the
        // socket directory to exist, world-writable and sticky, and creating it
        // ourselves as uid 1001 avoids depending on the X server's own mkdir.
        try {
            fs.mkdirSync("/tmp/.X11-unix", { recursive: true, mode: 0o1777 })
            fs.chmodSync("/tmp/.X11-unix", 0o1777)
        } catch (err) {
            this.log(`Xvfb ${this.displayName}: could not prepare /tmp/.X11-unix: ${(err as Error).message}`)
        }
        // A stale lock from a previous life of this display makes Xvfb exit at once.
        for (const p of [`/tmp/.X${this.display}-lock`, `/tmp/.X11-unix/X${this.display}`]) {
            fs.rmSync(p, { force: true })
        }
        this.stderrTail = ""
        const proc = spawn("Xvfb", [this.displayName, "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-nocursor"], {
            stdio: ["ignore", "ignore", "pipe"]
        })
        this.proc = proc
        proc.stderr?.setEncoding("utf8")
        proc.stderr?.on("data", (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-2000)
        })
        proc.on("error", err => this.log(`Xvfb ${this.displayName}: spawn error ${err.message}`))
        proc.on("exit", (code, signal) => {
            if (this.proc === proc) this.proc = null
            if (this.stopping) return
            this.log(`Xvfb ${this.displayName} exited (code ${code}, signal ${signal}); respawning in 2s. stderr: ${this.stderrTail.trim().slice(-300)}`)
            setTimeout(() => {
                this.start().catch(err => this.log(`Xvfb ${this.displayName}: respawn failed: ${err.message}`))
            }, 2000)
        })
        await this.waitReady()
    }

    private async waitReady(): Promise<void> {
        const socket = `/tmp/.X11-unix/X${this.display}`
        for (let i = 0; i < 100; i++) {
            if (fs.existsSync(socket)) return
            if (!this.proc) throw new Error(`Xvfb ${this.displayName} died before its socket appeared: ${this.stderrTail.trim().slice(-300)}`)
            await sleep(100)
        }
        throw new Error(`Xvfb ${this.displayName} did not come up within 10s`)
    }

    stop(): void {
        this.stopping = true
        this.proc?.kill("SIGTERM")
    }
}
