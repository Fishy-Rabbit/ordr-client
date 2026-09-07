import fs from "fs"
import { Config } from "./config"
import { Journal, RenderRecord } from "./journal"
import { Json } from "./renderers/danser/prepare"
import { DanserRun } from "./renderers/danser/render"
import { runRenderJob, SHUTDOWN_ABORT, SlotPaths } from "./job"
import { runFakeJob } from "./fake"

type Active = { renderID: number; run: DanserRun | null }

/**
 * FIFO over the journal: every free slot takes the oldest queued render.
 * Renders interrupted by a restart go back to the queue; finished videos
 * older than the retention window are swept once a day.
 */
export class Scheduler {
    private active = new Map<number, Active>()
    private sweepTimer: NodeJS.Timeout | null = null
    private stopped = false

    constructor(
        private readonly cfg: Config,
        private readonly journal: Journal,
        private readonly slots: SlotPaths[],
        private readonly template: Json,
        private readonly log: (line: string) => void
    ) {}

    get slotCount(): number {
        return this.cfg.fake ? this.cfg.concurrency : this.slots.length
    }

    start(): void {
        let requeued = 0
        for (const r of this.journal.all()) {
            if (r.status === "rendering") {
                this.journal.update(r.renderID, { status: "queued", progress: "Waiting (resumed after a restart)", slot: null })
                requeued++
            }
        }
        if (requeued) this.log(`re-queued ${requeued} render(s) interrupted by the last shutdown`)
        this.sweep()
        this.sweepTimer = setInterval(() => this.sweep(), 24 * 60 * 60 * 1000)
        this.tick()
    }

    tick(): void {
        if (this.stopped) return
        for (let slot = 0; slot < this.slotCount; slot++) {
            if (this.active.has(slot)) continue
            const busy = new Set([...this.active.values()].map(a => a.renderID))
            const next = this.journal.queued().find(r => !busy.has(r.renderID))
            if (!next) return
            void this.launch(slot, next)
        }
    }

    private async launch(slot: number, record: RenderRecord): Promise<void> {
        const entry: Active = { renderID: record.renderID, run: null }
        this.active.set(slot, entry)
        try {
            if (this.cfg.fake) {
                await runFakeJob(this.cfg, this.journal, record, this.log)
            } else {
                await runRenderJob(this.cfg, this.journal, record, this.slots[slot], this.template, this.log, run => (entry.run = run))
            }
        } catch (err) {
            this.log(`render ${record.renderID}: worker error ${(err as Error).stack ?? err}`)
            this.journal.update(record.renderID, { status: "failed", progress: "Failed", errorCode: 21, errorMessage: `worker error: ${(err as Error).message}`, finishedAt: new Date().toISOString() })
        } finally {
            this.active.delete(slot)
            setImmediate(() => this.tick())
        }
    }

    /** Delete videos past the retention window and mark their records removed. */
    sweep(): void {
        const cutoff = Date.now() - this.cfg.retentionDays * 24 * 60 * 60 * 1000
        let swept = 0
        for (const r of this.journal.all()) {
            if (r.status !== "done" || r.removed) continue
            const when = Date.parse(r.finishedAt ?? r.date)
            if (!Number.isFinite(when) || when > cutoff) continue
            if (r.videoFile) fs.rmSync(r.videoFile, { force: true })
            this.journal.update(r.renderID, { removed: true })
            swept++
        }
        if (swept) this.log(`retention sweep removed ${swept} video(s) older than ${this.cfg.retentionDays} days`)
    }

    stop(): void {
        this.stopped = true
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        for (const a of this.active.values()) a.run?.abort(SHUTDOWN_ABORT, "the worker is shutting down; the render will be re-queued")
    }

    queuePosition(record: RenderRecord): number {
        if (record.status !== "queued") return 0
        return this.journal.queued().findIndex(r => r.renderID === record.renderID) + 1
    }
}
