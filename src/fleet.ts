import type { Journal, RenderRecord } from "./journal"

/**
 * The shared queue as every server sees it. fishy and kawata feed this one
 * worker: this module names which server each job came from (their score ids
 * overlap, so a duplicate check must be per server), and computes one wait
 * estimate over every job, so both sites print the same number for the same
 * moment of the same queue.
 */

/** Assumed render length before any render has finished. */
export const FALLBACK_RENDER_SECONDS = 210

/** How many finished renders the typical duration is taken over. */
const DURATION_SAMPLE = 20

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * The server a job belongs to: the explicit `server` field when it is a valid
 * name, otherwise read from `source`. kawata's staging host is
 * kawata.fishy.moe, so kawata is matched before fishy.
 */
export function serverFor(explicit: string | undefined, source: string): string {
    const given = (explicit ?? "").trim().toLowerCase()
    if (SERVER_NAME.test(given)) return given
    const text = source.toLowerCase()
    if (text.includes("kawata")) return "kawata"
    if (text.includes("fishy")) return "fishy"
    return "other"
}

/** `"Rendering (45%)"` -> 45; null when the text carries no percentage. */
export function progressPercent(progress: string): number | null {
    const match = /(\d{1,3})%/.exec(progress)
    return match ? Math.min(100, Number(match[1])) : null
}

export type Typical = { seconds: number; basis: "measured" | "assumed" }

/** Median length of the most recent finished renders from every server; the fallback until one finishes. */
export function typicalDuration(journal: Journal): Typical {
    const durations: number[] = []
    const all = journal.all()
    for (let i = all.length - 1; i >= 0 && durations.length < DURATION_SAMPLE; i--) {
        const r = all[i]
        if (r.status !== "done" || !r.startedAt || !r.finishedAt) continue
        const seconds = (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000
        if (Number.isFinite(seconds) && seconds > 0) durations.push(seconds)
    }
    if (durations.length === 0) return { seconds: FALLBACK_RENDER_SECONDS, basis: "assumed" }
    durations.sort((a, b) => a - b)
    const mid = durations.length >> 1
    const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2
    return { seconds: Math.round(median), basis: "measured" }
}

/** Seconds a rendering job still needs: from its percentage, else from how long it has run. */
function remainingFor(record: RenderRecord, typical: number, now: number): number {
    const pct = progressPercent(record.progress)
    if (pct !== null) return Math.max(5, Math.round((typical * (100 - pct)) / 100))
    const started = record.startedAt ? Date.parse(record.startedAt) : NaN
    if (Number.isFinite(started)) return Math.max(5, Math.round(typical - (now - started) / 1000))
    return typical
}

/** Insert into an ascending list, keeping it sorted. */
function insertSorted(list: number[], value: number): void {
    let i = 0
    while (i < list.length && list[i] <= value) i++
    list.splice(i, 0, value)
}

/**
 * Seconds until each active job is done, simulated over the worker's slots.
 * Running jobs need what is left of a typical render; queued jobs then take
 * the earliest free slot in FIFO order, one typical render each, which is
 * exactly how the scheduler hands them out.
 */
export function etaByRender(journal: Journal, slots: number, typical: Typical, now: number = Date.now()): Map<number, number> {
    const eta = new Map<number, number>()
    const freeAt: number[] = []
    for (const r of journal.all()) {
        if (r.status !== "rendering") continue
        const left = remainingFor(r, typical.seconds, now)
        eta.set(r.renderID, left)
        insertSorted(freeAt, left)
    }
    while (freeAt.length < Math.max(1, slots)) insertSorted(freeAt, 0)
    for (const r of journal.queued()) {
        const start = freeAt.shift() ?? 0
        const done = start + typical.seconds
        eta.set(r.renderID, Math.round(done))
        insertSorted(freeAt, done)
    }
    return eta
}

export type ServerCounts = Record<string, { queued: number; rendering: number }>

/** Active jobs per server; a server with nothing queued or rendering is absent. */
export function serverCounts(journal: Journal): ServerCounts {
    const out: ServerCounts = {}
    for (const r of journal.all()) {
        if (r.status !== "queued" && r.status !== "rendering") continue
        const entry = out[r.server] ?? (out[r.server] = { queued: 0, rendering: 0 })
        entry[r.status]++
    }
    return out
}
