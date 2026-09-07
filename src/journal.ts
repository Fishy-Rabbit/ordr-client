import fs from "fs"
import path from "path"

export type RenderStatus = "queued" | "rendering" | "done" | "failed"

export type RenderOptionValues = Record<string, string | number | boolean>

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
    source: string
    scoreId: string | null
    beatmapsetId: number | null
    beatmapMd5: string | null
    date: string
    removed: boolean
    startedAt: string | null
    finishedAt: string | null
    slot: number | null
}

type NewRecordFields = Pick<RenderRecord, "replayUsername" | "mapTitle" | "replayMods" | "resolution" | "skin" | "options" | "source" | "scoreId" | "beatmapsetId" | "beatmapMd5">

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

    constructor(stateDir: string) {
        this.file = path.join(stateDir, "renders.json")
    }

    load(): void {
        if (!fs.existsSync(this.file)) return
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<JournalFile>
        const renders = Array.isArray(parsed.renders) ? parsed.renders : []
        let maxId = 0
        for (const r of renders) {
            this.byId.set(r.renderID, r)
            if (r.renderID > maxId) maxId = r.renderID
        }
        this.data = { version: 1, nextRenderID: Math.max(Number(parsed.nextRenderID) || 1, maxId + 1), renders }
    }

    flush(): void {
        if (this.pending) {
            clearTimeout(this.pending)
            this.pending = null
        }
        const tmp = `${this.file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), "utf-8")
        fs.renameSync(tmp, this.file)
    }

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
            slot: null,
            date: new Date().toISOString(),
            ...fields
        }
        this.data.renders.push(record)
        this.byId.set(record.renderID, record)
        this.flush()
        return record
    }

    get(id: number): RenderRecord | undefined {
        return this.byId.get(id)
    }

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

    /** Queued renders in submission order (ids are monotonic, so this is FIFO). */
    queued(): RenderRecord[] {
        return this.data.renders.filter(r => r.status === "queued")
    }

    counts(): { queued: number; rendering: number } {
        let queued = 0
        let rendering = 0
        for (const r of this.data.renders) {
            if (r.status === "queued") queued++
            else if (r.status === "rendering") rendering++
        }
        return { queued, rendering }
    }

    findActiveByScore(scoreId: string): RenderRecord | undefined {
        return this.data.renders.find(r => r.scoreId === scoreId && (r.status === "queued" || r.status === "rendering"))
    }

    latest(n: number): RenderRecord[] {
        return this.data.renders.slice(-n).reverse()
    }
}
