// The time-left estimate for a running render. Runs against build/.
//
// Until 2026-11-10 a running job's time left was the median render length times the share
// still to draw, so every job was assumed to be as long as the median (about 42 s on the
// live journal) whatever its map. A 261 s play took 156 to 330 s, so the panel read
// "about 5 seconds left" for minutes. Now, once danser reports a percentage, the job's
// own drawing speed decides: time spent drawing so far, scaled to what is left.
//
// The numbers below are from a real full render on the Backup node (score 4938602860,
// set 39804): danser said "Starting encoding" at 14:38:38, 20% at 14:39:37, and the
// render was done at 14:43:49.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { etaByRender, projectedSecondsLeft, FINALIZE_SECONDS } = require("../build/fleet")
const { Journal } = require("../build/journal")
const { DanserRun } = require("../build/renderers/danser/render")

const DRAW_START = Date.parse("2026-11-10T14:38:38Z")
const TICK_20 = Date.parse("2026-11-10T14:39:37Z")
const TYPICAL = { seconds: 42, basis: "measured" }

/** A journal in a fresh temp directory, removed when the test `t` ends; `seed` is written as renders.json first. */
function freshJournal(t, seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    if (seed) fs.writeFileSync(path.join(dir, "renders.json"), JSON.stringify(seed))
    const journal = new Journal(dir)
    journal.load()
    return journal
}

/** The fields journal.create needs. */
function job(overrides) {
    return Object.assign({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "default", options: {}, source: "", server: "hinai", scoreId: null, beatmapsetId: 1, beatmapMd5: null }, overrides)
}

/** A rendering record that reached `pct` at `tickMs` after drawing since `drawMs`. */
function drawing(journal, pct, drawMs, tickMs) {
    const r = journal.create(job({}))
    journal.update(r.renderID, { status: "rendering", progress: `Rendering (${pct}%)`, startedAt: new Date(drawMs - 7000).toISOString(), drawStartedAt: drawMs === null ? null : new Date(drawMs).toISOString(), progressAt: new Date(tickMs).toISOString() })
    return journal.get(r.renderID)
}

test("a long render's time left comes from its own drawing speed, not the median length", (t) => {
    const journal = freshJournal(t)
    const r = drawing(journal, 20, DRAW_START, TICK_20)
    // 59 s to draw 20%, so 236 s for the other 80%, plus the finalize step.
    const want = 59 * 4 + FINALIZE_SECONDS
    assert.equal(projectedSecondsLeft(r, TICK_20), want)
    assert.equal(etaByRender(journal, 1, TYPICAL, TICK_20).get(r.renderID), want)
    // The real answer was 252 s; the old estimate was 42 * 0.8 = 34 s.
    assert.ok(Math.abs(want - 252) < 20, `${want} should be near the real 252 s`)
})

test("between two danser reports the estimate counts down with the clock", (t) => {
    const journal = freshJournal(t)
    const r = drawing(journal, 20, DRAW_START, TICK_20)
    const atTick = etaByRender(journal, 1, TYPICAL, TICK_20).get(r.renderID)
    assert.equal(etaByRender(journal, 1, TYPICAL, TICK_20 + 10_000).get(r.renderID), atTick - 10)
    // Never below 5 s while the job is still running: zero would claim it is done.
    assert.equal(etaByRender(journal, 1, TYPICAL, TICK_20 + 3_600_000).get(r.renderID), 5)
})

test("a job queued behind a long render waits for that render's own estimate", (t) => {
    const journal = freshJournal(t)
    const running = drawing(journal, 20, DRAW_START, TICK_20)
    const queued = journal.create(job({}))
    const eta = etaByRender(journal, 1, TYPICAL, TICK_20)
    assert.equal(eta.get(queued.renderID), eta.get(running.renderID) + TYPICAL.seconds)
})

test("without a usable percentage the median estimate still applies", (t) => {
    const journal = freshJournal(t)
    // Under 5%: too little drawn to trust the speed yet (danser reports every 5%).
    const early = drawing(journal, 0, DRAW_START, DRAW_START)
    assert.equal(projectedSecondsLeft(early, DRAW_START + 1000), null)
    // A record from before this change (no draw start): the old share-of-the-median rule.
    const old = drawing(journal, 50, null, TICK_20)
    assert.equal(projectedSecondsLeft(old, TICK_20), null)
    assert.equal(etaByRender(journal, 2, TYPICAL, TICK_20).get(old.renderID), 21)
    // "Finalizing" carries no percentage.
    const fin = drawing(journal, 95, DRAW_START, TICK_20)
    fin.progress = "Finalizing"
    assert.equal(projectedSecondsLeft(fin, TICK_20), null)
})

test("journal.progress stamps progressAt only when the percentage changes", (t) => {
    const journal = freshJournal(t)
    const r = journal.create(job({}))
    assert.equal(r.progressAt, null)
    assert.equal(r.drawStartedAt, null)
    journal.progress(r.renderID, "Rendering (5%)", new Date(1000))
    assert.equal(r.progressAt, new Date(1000).toISOString())
    journal.progress(r.renderID, "Rendering (5%)", new Date(9000))
    assert.equal(r.progressAt, new Date(1000).toISOString(), "the same percentage again is not a new report")
    journal.progress(r.renderID, "Rendering (10%)", new Date(12000))
    assert.equal(r.progressAt, new Date(12000).toISOString())
    journal.progress(r.renderID, "Finalizing", new Date(20000))
    assert.equal(r.progress, "Finalizing")
    assert.equal(r.progressAt, new Date(12000).toISOString())
})

test("records written before the draw timestamps load with them as null", (t) => {
    const journal = freshJournal(t, { version: 1, nextRenderID: 2, renders: [{ renderID: 1, status: "done", progress: "Done", server: "fishy", source: "", window: null }] })
    assert.equal(journal.get(1).drawStartedAt, null)
    assert.equal(journal.get(1).progressAt, null)
})

test("DanserRun reports the moment danser starts drawing, once, and not during the pp pre-pass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-danser-"))
    try {
        const out = path.join(dir, "out")
        fs.mkdirSync(out)
        // A stand-in danser-cli: a pre-pass progress line, the start of drawing, two reports, the end.
        fs.writeFileSync(path.join(dir, "danser-cli"), [
            "#!/bin/sh",
            "echo '2026/11/10 14:38:30 Progress: 50%'",
            "echo '2026/11/10 14:38:38 Starting encoding!'",
            "echo '2026/11/10 14:38:51 Progress: 5%, Speed: 0.97x, ETA: 4m24s'",
            "echo '2026/11/10 14:38:52 Starting encoding!'",
            "echo '2026/11/10 14:39:08 Progress: 10%, Speed: 0.78x, ETA: 5m11s'",
            `: > '${path.join(out, "render1.mp4")}'`,
            "echo '2026/11/10 14:43:49 Finished.'",
        ].join("\n") + "\n", { mode: 0o755 })
        const events = []
        const run = new DanserRun({
            danserDir: dir, replayPath: "/x.osr", outName: "render1", settingsName: "s", window: null, outputDir: out,
            env: process.env, timeoutMs: 60_000, stallMs: 60_000, debug: false,
            onProgress: (p) => events.push(p), onDrawStart: () => events.push("DRAW"), log: () => {},
        })
        const outcome = await run.run()
        assert.equal(outcome.success, true)
        assert.deepEqual(events, ["DRAW", "Rendering (5%)", "Rendering (10%)", "Finalizing"])
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
