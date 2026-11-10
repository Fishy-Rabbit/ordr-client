// How a danser run settles. Runs against build/.
//
// run() settles exactly once, in every case (added 2026-11-10):
// - danser cannot be started at all: at once, code 21 (before, the promise never settled and the
//   slot stayed busy for good);
// - danser exits: once its output has closed, so its last line ("Finished.") has been read
//   (before, the answer was decided at exit and could miss it);
// - danser exits but a child it started keeps the output open: shortly after the exit, after
//   reading a last line danser left without a newline (an unterminated "Finished." counts).
// The settings-template step at boot (job.ts generateSettingsTemplate) survives a danser that
// cannot be started too: before, the child's unhandled `error` event crashed the worker.
// The stand-in danser-cli scripts below play danser's part.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { DanserRun } = require("../build/renderers/danser/render")
const { generateSettingsTemplate } = require("../build/job")

/** A temp directory with an `out` folder, removed when the test ends. */
function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "danser-run-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, "out"))
    return dir
}

/** Install a stand-in danser-cli made of these shell lines. */
function standIn(dir, lines) {
    fs.writeFileSync(path.join(dir, "danser-cli"), ["#!/bin/sh", ...lines].join("\n") + "\n", { mode: 0o755 })
}

/** A run of the stand-in in `dir`, rendering to `out/render1.mp4`. */
function danserRun(dir, overrides = {}) {
    return new DanserRun({
        danserDir: dir, replayPath: "/x.osr", outName: "render1", settingsName: "s", window: null, outputDir: path.join(dir, "out"),
        env: process.env, timeoutMs: 60_000, stallMs: 60_000, debug: false,
        /** Progress reports are not what these tests check. */
        onProgress: () => {},
        /** Nor are log lines. */
        log: () => {},
        ...overrides,
    })
}

test("a danser that cannot be started settles at once with code 21", async (t) => {
    const dir = workspace(t)
    const started = Date.now()
    const outcome = await danserRun(dir).run()
    assert.equal(outcome.success, false)
    assert.equal(outcome.errorCode, 21)
    assert.match(outcome.errorMessage, /^could not start danser: spawn \.\/danser-cli ENOENT/)
    assert.ok(Date.now() - started < 5000, "settled without waiting for the time limit")
})

test("the last line is read before the run is decided: Finished. right before exit is a success", async (t) => {
    const dir = workspace(t)
    // Plenty of progress output first, so the final line arrives in a late chunk.
    standIn(dir, [
        "i=0",
        "while [ $i -lt 4000 ]; do echo \"2026/11/10 12:00:00 Progress: 50%, Speed: 1.00x, ETA: 1m00s $i\"; i=$((i+1)); done",
        `: > '${path.join(dir, "out", "render1.mp4")}'`,
        "printf '2026/11/10 12:01:00 Finished.'",
        "exit 0",
    ])
    for (let round = 0; round < 5; round++) {
        const outcome = await danserRun(dir).run()
        assert.deepEqual(outcome, { success: true, videoPath: path.join(dir, "out", "render1.mp4") }, `round ${round}`)
    }
})

test("a child that keeps danser's output open does not hold the run: it settles shortly after the exit", async (t) => {
    const dir = workspace(t)
    const pidFile = path.join(dir, "child.pid")
    standIn(dir, [
        "sleep 60 &",
        `echo $! > '${pidFile}'`,
        `: > '${path.join(dir, "out", "render1.mp4")}'`,
        "echo '2026/11/10 12:01:00 Finished.'",
        "exit 0",
    ])
    const started = Date.now()
    const outcome = await danserRun(dir).run()
    const took = Date.now() - started
    // End the child now: it still holds danser's output pipes, so this test file's process would
    // wait for it, and its pid file goes with the workspace when the test ends.
    try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL")
    } catch {
        // already gone
    }
    assert.equal(outcome.success, true)
    assert.ok(took < 10_000, `settled ${took} ms after the start, not when the child ends`)
})

test("an unterminated Finished. is still read when a child keeps the output open past the exit", async (t) => {
    const dir = workspace(t)
    const pidFile = path.join(dir, "child.pid")
    // Both conditions at once: the last line has no newline, and the output never closes on its own.
    standIn(dir, [
        "sleep 60 &",
        `echo $! > '${pidFile}'`,
        `: > '${path.join(dir, "out", "render1.mp4")}'`,
        "printf '2026/11/10 12:01:00 Finished.'",
        "exit 0",
    ])
    const outcome = await danserRun(dir).run()
    // End the child now, as in the test above: it still holds danser's output pipes.
    try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL")
    } catch {
        // already gone
    }
    assert.deepEqual(outcome, { success: true, videoPath: path.join(dir, "out", "render1.mp4") })
})

test("a failed exit still reports code 21 with the exit code and the log tail", async (t) => {
    const dir = workspace(t)
    standIn(dir, ["echo 'something went wrong' >&2", "exit 3"])
    const outcome = await danserRun(dir).run()
    assert.equal(outcome.success, false)
    assert.equal(outcome.errorCode, 21)
    assert.equal(outcome.errorMessage, "danser exited with code 3\nsomething went wrong")
})

test("the time limit still ends a run whose danser never exits", async (t) => {
    const dir = workspace(t)
    standIn(dir, ["exec sleep 60"])
    const outcome = await danserRun(dir, { timeoutMs: 300 }).run()
    assert.equal(outcome.success, false)
    assert.equal(outcome.errorCode, 21)
    assert.match(outcome.errorMessage, /^render exceeded the 0 minute limit/)
})

test("a danser that cannot be started ends the settings-template wait at once, without crashing", async (t) => {
    const dir = workspace(t)
    // No danser-cli in the folder: the spawn fails with ENOENT through the child's `error` event.
    const slot = { index: 0, display: ":99", root: dir, danserDir: dir, songsDir: dir, videosDir: dir }
    const lines = []
    const started = Date.now()
    const template = await generateSettingsTemplate({ threadsPerSlot: 1 }, slot, (l) => lines.push(l))
    assert.deepEqual(template, {}, "the renders fall back to the patch alone")
    assert.ok(Date.now() - started < 5000, "the wait ended without running into its 60-second deadline")
    assert.ok(lines.some((l) => /spawn error: spawn \.\/danser-cli ENOENT/.test(l)), lines.join("\n"))
})
