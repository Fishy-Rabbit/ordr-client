import fs from "fs"
import { Config } from "./config"
import { Journal, RenderRecord } from "./journal"
import { Json } from "./renderers/danser/prepare"
import { DanserRun } from "./renderers/danser/render"
import { runRenderJob, SHUTDOWN_ABORT, SlotPaths } from "./job"
import { runFakeJob } from "./fake"
import { sweepSongCache } from "./songcache"

/** A slot's current job: its render id and, once danser starts, the run (so shutdown can abort it). */
type Active = { renderID: number; run: DanserRun | null }

/**
 * FIFO over the journal: every free slot takes the oldest queued render.
 * Renders interrupted by a restart go back to the queue; finished videos
 * older than the retention window, and cached maps nobody used for the
 * song-cache window, are swept at boot and once a day.
 */
export class Scheduler {
    private active = new Map<number, Active>()
    private sweepTimer: NodeJS.Timeout | null = null
    private stopped = false

    /**
     * The slots, the journal and the boot-time danser settings template come from main(); nothing
     * runs until start().
     */
    constructor(
        private readonly cfg: Config,
        private readonly journal: Journal,
        private readonly slots: SlotPaths[],
        private readonly template: Json,
        private readonly log: (line: string) => void
    ) {}

    /** Renders that may run at once: RENDER_CONCURRENCY in fake mode, else one per prepared slot. */
    get slotCount(): number {
        return this.cfg.fake ? this.cfg.concurrency : this.slots.length
    }

    /**
     * Re-queue renders the last shutdown interrupted, run the first retention and song-cache sweep,
     * schedule it daily, then fill the free slots.
     */
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

    /**
     * Give each free slot the oldest queued render not already running. Called at start, after each
     * submission and after each finished job.
     */
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

    /**
     * Run one render on one slot (fake or danser). An unexpected throw marks the render failed
     * (code 21); the slot is then freed and the queue ticked.
     */
    private async launch(slot: number, record: RenderRecord): Promise<void> {
        const entry: Active = { renderID: record.renderID, run: null }
        this.active.set(slot, entry)
        try {
            if (this.cfg.fake) {
                await runFakeJob(this.cfg, this.journal, record, this.log)
            } else {
                await runRenderJob(this.cfg, this.journal, record, this.slots[slot], this.template, this.log, run => {
                    // After stop() a new run is refused: stop() aborted the runs it could see, and this
                    // one did not exist yet, so starting it now would outlive the displays.
                    if (run && this.stopped) return false
                    entry.run = run
                    return true
                })
            }
        } catch (err) {
            this.log(`render ${record.renderID}: worker error ${(err as Error).stack ?? err}`)
            this.journal.update(record.renderID, { status: "failed", progress: "Failed", errorCode: 21, errorMessage: `worker error: ${(err as Error).message}`, finishedAt: new Date().toISOString() })
        } finally {
            this.active.delete(slot)
            setImmediate(() => this.tick())
        }
    }

    /**
     * Delete videos past the retention window (marking their records removed) and unused cached
     * maps. A failed record that still names a video counts too: when the "done" write fails after
     * the video was moved into place, the worker records the render as failed with the video kept,
     * and without this the file would never be deleted. A video that cannot be deleted (a
     * permission or I/O error) is logged and its record left as it is, for the next sweep: one
     * stuck file must not stop the sweep, nor the worker, which also sweeps when it starts.
     */
    sweep(): void {
        const cutoff = Date.now() - this.cfg.retentionDays * 24 * 60 * 60 * 1000
        let swept = 0
        for (const r of this.journal.all()) {
            if (r.removed || !(r.status === "done" || (r.status === "failed" && r.videoFile))) continue
            const when = Date.parse(r.finishedAt ?? r.date)
            if (!Number.isFinite(when) || when > cutoff) continue
            try {
                if (r.videoFile) fs.rmSync(r.videoFile, { force: true })
                this.journal.update(r.renderID, { removed: true })
                swept++
            } catch (err) {
                this.log(`retention sweep left render ${r.renderID} for the next sweep: ${(err as Error).message}`)
            }
        }
        if (swept) this.log(`retention sweep removed ${swept} video(s) older than ${this.cfg.retentionDays} days`)
        const songs = sweepSongCache(this.cfg.songsDir, this.journal, this.cfg.songCacheDays)
        if (songs.removed) this.log(`song cache sweep removed ${songs.removed} set(s), ${Math.round(songs.bytes / 1048576)} MB, unused for ${this.cfg.songCacheDays} days; ${songs.kept} kept`)
    }

    /**
     * Stop scheduling and the daily sweep, and abort running renders with SHUTDOWN_ABORT so they go
     * back to the queue. A render still preparing its map has no run to abort yet; when it reaches
     * registration it is refused (see launch) and goes back to the queue the same way.
     */
    stop(): void {
        this.stopped = true
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        for (const a of this.active.values()) a.run?.abort(SHUTDOWN_ABORT, "the worker is shutting down; the render will be re-queued")
    }

    /** A queued render's 1-based place in the FIFO; 0 when it is not queued. */
    queuePosition(record: RenderRecord): number {
        if (record.status !== "queued") return 0
        return this.journal.queued().findIndex(r => r.renderID === record.renderID) + 1
    }
}
