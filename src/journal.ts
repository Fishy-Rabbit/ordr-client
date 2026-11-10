import fs from "fs"
import path from "path"
import { progressPercent, serverFor } from "./fleet"
import type { RenderWindow } from "./window"

/** A render's lifecycle: queued, then rendering, then done or failed (a restart puts rendering jobs back to queued). */
export type RenderStatus = "queued" | "rendering" | "done" | "failed"

/** The option fields as the client sent them; parseOptions reads them when the job runs. */
export type RenderOptionValues = Record<string, string | number | boolean>

/** One render as the journal stores it; the API's wire shape is built from it (server.ts toApi). */
export type RenderRecord = {
    renderID: number
    status: RenderStatus
    progress: string
    queuePosition: number
    videoFile: string | null
    errorCode: number
    errorMessage: string
    replayUsername: string
    mapTitle: string
    replayMods: number
    resolution: string
    skin: string
    options: RenderOptionValues
    /** The requested clip in whole seconds of song position; null = the full play. */
    window: RenderWindow | null
    source: string
    /** The site the job came from ("fishy", "kawata", ...): the shared queue's key. */
    server: string
    scoreId: string | null
    beatmapsetId: number | null
    beatmapMd5: string | null
    date: string
    removed: boolean
    startedAt: string | null
    finishedAt: string | null
    /** When danser began drawing frames ("Starting encoding"); null before that. The ETA projects from it. */
    drawStartedAt: string | null
    /** When the progress percentage last changed; null until the first one. */
    progressAt: string | null
    /** Seconds of video the replay renders to, read from its frames at submit; null when unknown. */
    playSeconds: number | null
    slot: number | null
}

/** What a submission supplies for a new record; create() fills in the id, the status and the timestamps. */
type NewRecordFields = Pick<RenderRecord, "replayUsername" | "mapTitle" | "replayMods" | "resolution" | "skin" | "options" | "source" | "server" | "scoreId" | "beatmapsetId" | "beatmapMd5"> & { window?: RenderWindow | null; playSeconds?: number | null }

/** The layout of renders.json. */
type JournalFile = { version: 1; nextRenderID: number; renders: RenderRecord[] }

/**
 * The render ledger: one JSON file, rewritten atomically (write a sibling
 * temp file, then rename) so a crash mid-write never leaves a torn journal.
 * Status changes are flushed immediately; progress ticks are coalesced so a
 * chatty danser cannot turn the state volume into a write benchmark.
 */
export class Journal {
    private readonly file: string
    private data: JournalFile = { version: 1, nextRenderID: 1, renders: [] }
    private byId = new Map<number, RenderRecord>()
    private pending: NodeJS.Timeout | null = null

    /** The journal is `<stateDir>/renders.json`; nothing is read until load(). */
    constructor(stateDir: string) {
        this.file = path.join(stateDir, "renders.json")
    }

    /**
     * Read the journal file if it exists, back-filling the fields older records lack and setting
     * the next id past the highest one on record.
     */
    load(): void {
        if (!fs.existsSync(this.file)) return
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<JournalFile>
        const renders = Array.isArray(parsed.renders) ? parsed.renders : []
        let maxId = 0
        for (const r of renders) {
            // Records written before the shared queue carry no server; read it from source.
            if (!r.server) r.server = serverFor(undefined, r.source ?? "")
            // Records written before windowed renders carry no window: they were full renders.
            if (r.window === undefined) r.window = null
            // Records written before the projected ETA (2026-11-10) carry no draw timestamps.
            if (r.drawStartedAt === undefined) r.drawStartedAt = null
            if (r.progressAt === undefined) r.progressAt = null
            if (r.playSeconds === undefined) r.playSeconds = null
            this.byId.set(r.renderID, r)
            if (r.renderID > maxId) maxId = r.renderID
        }
        this.data = { version: 1, nextRenderID: Math.max(Number(parsed.nextRenderID) || 1, maxId + 1), renders }
    }

    /** Write the whole journal now (a temp file, then a rename) and cancel any pending deferred write. */
    flush(): void {
        if (this.pending) {
            clearTimeout(this.pending)
            this.pending = null
        }
        const tmp = `${this.file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), "utf-8")
        fs.renameSync(tmp, this.file)
    }

    /**
     * Write the journal within 500 ms; writes requested in the meantime share it. A failed deferred
     * write is logged, not thrown.
     */
    private scheduleFlush(): void {
        if (this.pending) return
        this.pending = setTimeout(() => {
            this.pending = null
            try {
                this.flush()
            } catch (err) {
                console.error("journal: deferred flush failed", err)
            }
        }, 500)
    }

    /** Add a queued render with the next id and write the journal at once. */
    create(fields: NewRecordFields): RenderRecord {
        const record: RenderRecord = {
            renderID: this.data.nextRenderID++,
            status: "queued",
            progress: "Waiting",
            queuePosition: 0,
            videoFile: null,
            errorCode: 0,
            errorMessage: "",
            removed: false,
            startedAt: null,
            finishedAt: null,
            drawStartedAt: null,
            progressAt: null,
            slot: null,
            date: new Date().toISOString(),
            ...fields,
            window: fields.window ?? null,
            playSeconds: fields.playSeconds ?? null
        }
        this.data.renders.push(record)
        this.byId.set(record.renderID, record)
        this.flush()
        return record
    }

    /** The render with this id, if there is one. */
    get(id: number): RenderRecord | undefined {
        return this.byId.get(id)
    }

    /** Every render on record, oldest first (the journal's own array, not a copy). */
    all(): RenderRecord[] {
        return this.data.renders
    }

    /** Apply a patch; anything but a pure progress tick is written through at once. */
    update(id: number, patch: Partial<RenderRecord>): RenderRecord | undefined {
        const record = this.byId.get(id)
        if (!record) return undefined
        Object.assign(record, patch)
        const keys = Object.keys(patch)
        const progressOnly = keys.length > 0 && keys.every(k => k === "progress")
        if (progressOnly) this.scheduleFlush()
        else this.flush()
        return record
    }

    /**
     * A progress tick from the renderer, written lazily like any tick. A new percentage
     * stamps progressAt: the ETA projects the job's own drawing speed from the moment
     * each percentage arrived (fleet.ts projectedSecondsLeft).
     */
    progress(id: number, text: string, now: Date = new Date()): void {
        const record = this.byId.get(id)
        if (!record) return
        const pct = progressPercent(text)
        if (pct !== null && pct !== progressPercent(record.progress)) record.progressAt = now.toISOString()
        record.progress = text
        this.scheduleFlush()
    }

    /** Queued renders in submission order (ids are monotonic, so this is FIFO). */
    queued(): RenderRecord[] {
        return this.data.renders.filter(r => r.status === "queued")
    }

    /** How many renders are queued and how many are rendering. */
    counts(): { queued: number; rendering: number } {
        let queued = 0
        let rendering = 0
        for (const r of this.data.renders) {
            if (r.status === "queued") queued++
            else if (r.status === "rendering") rendering++
        }
        return { queued, rendering }
    }

    /** An active job for this score from this server; score ids are only unique within one server. */
    findActiveByScore(server: string, scoreId: string): RenderRecord | undefined {
        return this.data.renders.find(r => r.server === server && r.scoreId === scoreId && (r.status === "queued" || r.status === "rendering"))
    }

    /** The latest finished or failed renders, newest first. */
    recentFinished(n: number): RenderRecord[] {
        const out: RenderRecord[] = []
        for (let i = this.data.renders.length - 1; i >= 0 && out.length < n; i--) {
            const r = this.data.renders[i]
            if (r.status === "done" || r.status === "failed") out.push(r)
        }
        return out
    }

    /** The `n` most recent renders in any state, newest first. */
    latest(n: number): RenderRecord[] {
        return this.data.renders.slice(-n).reverse()
    }
}
