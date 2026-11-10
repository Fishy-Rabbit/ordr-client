// The .osz cache sweep (RENDER_SONG_CACHE_DAYS). Runs against build/.
//
// A cached set is deleted once nobody has used it for the window: its file was not used
// (mtime, refreshed on every cache hit) AND no journal render for it is active or was asked
// for inside the window. Added 2026-11-10: the cache was never pruned, and on the Backup
// node it shares a disk with the nightly backups.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { Journal } = require("../build/journal")
const { sweepSongCache, touchSong } = require("../build/songcache")
const { ensureOsz } = require("../build/job")
const { Scheduler } = require("../build/queue")

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-11-10T12:00:00Z")

/** A temp dir with a songs folder and an empty journal; resolves nothing, cleans up via close(). */
function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "songcache-"))
    const songsDir = path.join(dir, "songs")
    fs.mkdirSync(songsDir)
    const journal = new Journal(dir)
    journal.load()
    return { dir, songsDir, journal, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Write a file and set its mtime to `ageDays` before NOW. */
function file(dir, name, ageDays, bytes = 100) {
    const p = path.join(dir, name)
    fs.writeFileSync(p, Buffer.alloc(bytes, 1))
    const t = new Date(NOW - ageDays * DAY)
    fs.utimesSync(p, t, t)
    return p
}

/** A journal render for a set, created `ageDays` before NOW, in the given status. */
function render(journal, setId, ageDays, status) {
    const r = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "", options: {}, source: "t", server: "hinai", scoreId: null, beatmapsetId: setId, beatmapMd5: null, window: null })
    const when = new Date(NOW - ageDays * DAY).toISOString()
    journal.update(r.renderID, { status, date: when, startedAt: status === "queued" ? null : when, finishedAt: status === "done" || status === "failed" ? when : null })
}

test("deletes sets unused for the window and keeps every set still in use", () => {
    const { songsDir, journal, close } = setup()
    try {
        file(songsDir, "1.osz", 45, 1000) // old file, never rendered: goes
        file(songsDir, "2.osz", 3) // used 3 days ago (mtime): stays
        file(songsDir, "3.osz", 60) // old file, but a render asked for it 5 days ago: stays
        render(journal, 3, 5, "done")
        file(songsDir, "4.osz", 90) // old file and an old render, but that render is still queued: stays
        render(journal, 4, 40, "queued")
        file(songsDir, "5.osz", 31) // old file whose only render is old too: goes
        render(journal, 5, 35, "done")
        file(songsDir, "notes.txt", 400) // not a cache entry: untouched
        file(songsDir, "abc.osz", 400) // not a set id: untouched
        file(songsDir, "6.osz.part", 2) // a stale download: goes
        file(songsDir, "7.osz.part", 0.01) // a download in progress: stays

        const result = sweepSongCache(songsDir, journal, 30, NOW)
        assert.deepEqual(fs.readdirSync(songsDir).sort(), ["2.osz", "3.osz", "4.osz", "7.osz.part", "abc.osz", "notes.txt"])
        assert.equal(result.removed, 3)
        assert.equal(result.bytes, 1000 + 100 + 100)
        assert.equal(result.kept, 3)
    } finally {
        close()
    }
})

test("a missing songs folder is an empty sweep, not an error", () => {
    const { dir, journal, close } = setup()
    try {
        assert.deepEqual(sweepSongCache(path.join(dir, "nope"), journal, 30, NOW), { removed: 0, bytes: 0, kept: 0 })
    } finally {
        close()
    }
})

test("touchSong marks a set as used now", () => {
    const { songsDir, close } = setup()
    try {
        const p = file(songsDir, "9.osz", 50)
        const before = Date.now()
        touchSong(p)
        assert.ok(fs.statSync(p).mtimeMs >= before - 1000)
        touchSong(path.join(songsDir, "missing.osz")) // never throws
    } finally {
        close()
    }
})

test("a cache hit refreshes the set's mtime, so a busy set is never swept", async () => {
    const { songsDir, close } = setup()
    try {
        const p = file(songsDir, "11.osz", 50)
        const before = Date.now()
        const got = await ensureOsz({ songsDir }, 11, () => {})
        assert.deepEqual(got, { ok: true, path: p })
        assert.ok(fs.statSync(p).mtimeMs >= before - 1000)
    } finally {
        close()
    }
})

test("the scheduler's daily sweep runs the song cache sweep too", () => {
    const { songsDir, journal, close } = setup()
    try {
        const old = new Date(Date.now() - 45 * DAY)
        fs.writeFileSync(path.join(songsDir, "21.osz"), Buffer.alloc(10))
        fs.utimesSync(path.join(songsDir, "21.osz"), old, old)
        const lines = []
        const cfg = { fake: true, concurrency: 1, retentionDays: 30, songCacheDays: 30, songsDir }
        new Scheduler(cfg, journal, [], {}, (l) => lines.push(l)).sweep()
        assert.deepEqual(fs.readdirSync(songsDir), [])
        assert.ok(lines.some((l) => /song cache sweep removed 1 set/.test(l)), lines.join("\n"))
    } finally {
        close()
    }
})
