// The retention sweep (added 2026-11-10): videos past RENDER_RETENTION_DAYS are deleted and their
// records marked removed. That covers a failed record that still names a video as well as a done
// one: when the "done" write fails after the video was moved into place, the worker records the
// render as failed with the video kept, and the sweep used to skip it for good. Runs against build/.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { Journal } = require("../build/journal")
const { Scheduler } = require("../build/queue")

const DAY = 24 * 60 * 60 * 1000

/** A render that finished `ageDays` ago in `status`, holding a video file when `video` is true. */
function finished(journal, videosDir, ageDays, status, video) {
    const r = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "", options: {}, source: "t", server: "hinai", scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
    const when = new Date(Date.now() - ageDays * DAY).toISOString()
    let videoFile = null
    if (video) {
        videoFile = path.join(videosDir, `render${r.renderID}.mp4`)
        fs.writeFileSync(videoFile, Buffer.alloc(10))
    }
    journal.update(r.renderID, { status, date: when, startedAt: when, finishedAt: when, videoFile })
    return { id: r.renderID, videoFile }
}

test("the retention sweep deletes old videos of done records and of failed records that still name one", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const videosDir = path.join(dir, "videos")
    const songsDir = path.join(dir, "songs")
    fs.mkdirSync(videosDir)
    fs.mkdirSync(songsDir)
    const journal = new Journal(dir)
    journal.load()

    const oldDone = finished(journal, videosDir, 40, "done", true)
    const oldFailedWithVideo = finished(journal, videosDir, 40, "failed", true)
    const oldFailed = finished(journal, videosDir, 40, "failed", false)
    const recentDone = finished(journal, videosDir, 2, "done", true)
    const recentFailedWithVideo = finished(journal, videosDir, 2, "failed", true)

    const lines = []
    const cfg = { fake: true, concurrency: 1, retentionDays: 30, songCacheDays: 30, songsDir }
    new Scheduler(cfg, journal, [], {}, (l) => lines.push(l)).sweep()

    /** Whether the sweep marked this render removed. */
    const removed = (x) => journal.all().find((r) => r.renderID === x.id).removed === true
    assert.equal(fs.existsSync(oldDone.videoFile), false)
    assert.equal(fs.existsSync(oldFailedWithVideo.videoFile), false, "a failed record's video is swept like a done one")
    assert.equal(removed(oldDone), true)
    assert.equal(removed(oldFailedWithVideo), true)
    assert.equal(removed(oldFailed), false, "a failed record without a video has nothing to sweep")
    assert.equal(fs.existsSync(recentDone.videoFile), true, "videos inside the window stay")
    assert.equal(fs.existsSync(recentFailedWithVideo.videoFile), true, "videos inside the window stay")
    assert.ok(lines.some((l) => /retention sweep removed 2 video/.test(l)), lines.join("\n"))
})
