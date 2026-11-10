import fs from "fs"
import path from "path"
import type { Journal } from "./journal"

/**
 * The .osz cache under SONGS_DIR: one `<setId>.osz` per set ever rendered, fetched from the
 * hinai mirror on first use (job.ts ensureOsz). Without a sweep it only grows, and on the
 * Backup node it shares a disk with the nightly backups, so sets nobody has used for
 * RENDER_SONG_CACHE_DAYS are deleted by the scheduler's daily sweep. A deleted set costs
 * one in-cluster download the next time someone renders it.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const SET_FILE = /^(\d+)\.osz$/
const PART_FILE = /^\d+\.osz\.part$/

export type SongSweep = { removed: number; bytes: number; kept: number }

/** Mark a cached set as used now: its mtime is the cache's "last used" clock. Never throws. */
export function touchSong(file: string): void {
    const now = new Date()
    try {
        fs.utimesSync(file, now, now)
    } catch {
        // a vanished file is simply re-fetched next time
    }
}

/** Latest moment the journal says a set was wanted, plus whether a job for it is still active. */
function journalUse(journal: Journal): Map<number, { last: number; active: boolean }> {
    const out = new Map<number, { last: number; active: boolean }>()
    for (const r of journal.all()) {
        if (!r.beatmapsetId) continue
        const entry = out.get(r.beatmapsetId) ?? { last: 0, active: false }
        for (const t of [r.date, r.startedAt, r.finishedAt]) {
            const ms = t ? Date.parse(t) : NaN
            if (Number.isFinite(ms) && ms > entry.last) entry.last = ms
        }
        if (r.status === "queued" || r.status === "rendering") entry.active = true
        out.set(r.beatmapsetId, entry)
    }
    return out
}

/**
 * Delete cached sets unused for `days`. A set stays while ANY of these holds: its file was
 * used inside the window (mtime, refreshed on every cache hit), a journal render for it was
 * asked for, started or finished inside the window, or a render for it is still queued or
 * rendering. The journal check is what makes the first sweep safe on files that predate
 * the mtime refresh. Leftover `<setId>.osz.part` downloads older than a day go too; any
 * other file in the folder is left alone.
 */
export function sweepSongCache(songsDir: string, journal: Journal, days: number, now = Date.now()): SongSweep {
    const result: SongSweep = { removed: 0, bytes: 0, kept: 0 }
    let names: string[]
    try {
        names = fs.readdirSync(songsDir)
    } catch {
        return result
    }
    const cutoff = now - days * DAY_MS
    const used = journalUse(journal)
    for (const name of names) {
        const set = SET_FILE.exec(name)
        const part = PART_FILE.test(name)
        if (!set && !part) continue
        const file = path.join(songsDir, name)
        let st: fs.Stats
        try {
            st = fs.statSync(file)
        } catch {
            continue
        }
        if (!st.isFile()) continue
        let keep: boolean
        if (part) {
            keep = st.mtimeMs > now - DAY_MS
        } else {
            const u = used.get(Number(set![1]))
            keep = st.mtimeMs > cutoff || (u !== undefined && (u.active || u.last > cutoff))
        }
        if (keep) {
            if (!part) result.kept++
            continue
        }
        try {
            fs.rmSync(file, { force: true })
            result.removed++
            result.bytes += st.size
        } catch {
            // left for the next sweep
        }
    }
    return result
}
