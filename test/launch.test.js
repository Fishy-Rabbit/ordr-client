// The scheduler's per-render failure boundary (added 2026-11-10): a render that throws is marked
// failed, and when even that write fails (a full disk), the failure is logged and kept in the
// journal's memory instead of rejecting, which would reach the process's unhandledRejection
// handler and end the worker for every server. A render already done stays done. Runs against
// build/.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const fake = require("../build/fake")
const { Journal } = require("../build/journal")
const { Scheduler } = require("../build/queue")

/** A fresh journal in a temporary directory with one queued render; the directory goes after the test. */
function setUp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const journal = new Journal(dir)
    journal.load()
    const record = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "", options: {}, source: "t", server: "hinai", scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
    // From here on every journal write fails, as on a full disk; update() still applies the change
    // in memory before it writes.
    journal.flush = () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })
    }
    return { dir, journal, record }
}

/** A fake-mode scheduler with one slot whose log lines go to `lines`. */
function scheduler(dir, journal, lines) {
    const cfg = { fake: true, concurrency: 1, retentionDays: 30, songCacheDays: 30, songsDir: dir, videosDir: dir }
    return new Scheduler(cfg, journal, [], {}, (l) => lines.push(l))
}

/** A render whose failure cannot be written to disk is still failed in memory, and the worker goes on. */
test("a render whose failure cannot be written to disk does not end the worker", async (t) => {
    const { dir, journal, record: r } = setUp(t)
    const lines = []
    await assert.doesNotReject(scheduler(dir, journal, lines)["launch"](0, r), "the failed write stays inside the render's failure boundary")
    const record = journal.get(r.renderID)
    assert.equal(record.status, "failed")
    assert.equal(record.errorCode, 21)
    assert.ok(lines.some((l) => l.includes(`render ${r.renderID}: could not record the failure: ENOSPC`)), lines.join(" | "))
})

/** Done is final: a render whose done write fails is kept as done in memory, not turned into a failure. */
test("a render already done stays done when the write of its result fails", async (t) => {
    const { dir, journal, record: r } = setUp(t)
    // The job records its video as done and that write fails, as runRenderJob's last update would.
    t.mock.method(fake, "runFakeJob", async (_cfg, j, record) => {
        j.update(record.renderID, { status: "done", progress: "Done", videoFile: path.join(dir, `render${record.renderID}.mp4`), finishedAt: new Date().toISOString() })
    })
    const lines = []
    await assert.doesNotReject(scheduler(dir, journal, lines)["launch"](0, r))
    const record = journal.get(r.renderID)
    assert.equal(record.status, "done")
    assert.equal(record.errorCode, 0)
    assert.ok(lines.some((l) => l.includes(`render ${r.renderID}: kept as done`)), lines.join(" | "))
})
