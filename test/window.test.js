// Windowed renders: the start/end parser, danser's flags, the forced results screen, the journal field.
// Runs against the compiled build/ (npm test builds first).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { parseRenderWindow, windowArgs, windowedOptions, MAX_WINDOW_END_SECONDS } = require("../build/window")
const { danserArguments } = require("../build/renderers/danser/render")
const { buildDanserSettings, DEFAULT_OPTIONS } = require("../build/renderers/danser/prepare")
const { Journal } = require("../build/journal")

/** The fields journal.create needs, with overrides. */
function job(overrides) {
    return Object.assign({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "default", options: {}, source: "", server: "kawata", scoreId: null, beatmapsetId: 1, beatmapMd5: null }, overrides)
}

test("no window: both fields absent or blank", () => {
    assert.deepEqual(parseRenderWindow(undefined, undefined), { ok: true, window: null })
    assert.deepEqual(parseRenderWindow("", "  "), { ok: true, window: null })
})

test("a window: whole seconds, trimmed, up to a day", () => {
    assert.deepEqual(parseRenderWindow("12", " 32 "), { ok: true, window: { start: 12, end: 32 } })
    assert.deepEqual(parseRenderWindow("0", "1"), { ok: true, window: { start: 0, end: 1 } })
    assert.deepEqual(parseRenderWindow("0", String(MAX_WINDOW_END_SECONDS)), { ok: true, window: { start: 0, end: 86400 } })
})

test("refused: one without the other, not whole seconds, out of order, past a day", () => {
    const bad = [["12", undefined], [undefined, "32"], ["12", ""], ["", "32"], ["1.5", "3"], ["-1", "3"], ["12", "12"], ["30", "12"], ["0", "86401"], ["0", "99999"], ["1e3", "2000"], ["0x10", "40"], ["12", "32s"]]
    for (const [s, e] of bad) {
        const r = parseRenderWindow(s, e)
        assert.equal(r.ok, false, `${s} .. ${e}`)
        assert.equal(typeof r.message, "string")
        assert.ok(r.message.length > 0)
    }
})

test("danser arguments: unchanged without a window, -start and -end appended with one", () => {
    const base = { replayPath: "/state/replays/7.osr", outName: "render7", settingsName: "slot0" }
    assert.deepEqual(danserArguments({ ...base, window: null }), ["-replay", "/state/replays/7.osr", "-out", "render7", "-noupdatecheck", "-skip", "-settings=slot0"])
    assert.deepEqual(danserArguments({ ...base, window: { start: 12, end: 32 } }), ["-replay", "/state/replays/7.osr", "-out", "render7", "-noupdatecheck", "-skip", "-settings=slot0", "-start=12", "-end=32"])
    assert.deepEqual(danserArguments({ ...base, window: { start: 0, end: 5 } }), ["-replay", "/state/replays/7.osr", "-out", "render7", "-noupdatecheck", "-skip", "-settings=slot0", "-start=0", "-end=5"])
    assert.deepEqual(windowArgs(null), [])
})

test("a windowed render never shows the results screen; a full one keeps what was asked", () => {
    const asked = { ...DEFAULT_OPTIONS, showResultScreen: true }
    assert.equal(windowedOptions(asked, { start: 12, end: 32 }).showResultScreen, false)
    assert.equal(windowedOptions(asked, null).showResultScreen, true)
    assert.equal(asked.showResultScreen, true, "the caller's options are not mutated")
    const args = { songsDir: "/s", skinsDir: "/k", outputDir: "/o", preset: { width: 640, height: 480, fps: 15, turbo: true }, skin: "default" }
    assert.equal(buildDanserSettings({}, { ...args, options: windowedOptions(asked, { start: 12, end: 32 }) }).Gameplay.ShowResultsScreen, false)
    assert.equal(buildDanserSettings({}, { ...args, options: windowedOptions(asked, null) }).Gameplay.ShowResultsScreen, true)
})

test("the journal stores a window, defaults it to null, and back-fills old journals", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-journal-"))
    const journal = new Journal(dir)
    journal.load()
    const a = journal.create(job({ window: { start: 12, end: 32 } }))
    const b = journal.create(job({}))
    assert.deepEqual(a.window, { start: 12, end: 32 })
    assert.equal(b.window, null)
    const again = new Journal(dir)
    again.load()
    assert.deepEqual(again.get(a.renderID).window, { start: 12, end: 32 })

    const old = fs.mkdtempSync(path.join(os.tmpdir(), "window-old-"))
    const record = Object.assign(job({ source: "kawata.pw" }), { renderID: 1, status: "done", progress: "Done", queuePosition: 0, videoFile: null, errorCode: 0, errorMessage: "", removed: false, startedAt: null, finishedAt: null, slot: null, date: "2026-10-01T00:00:00Z" })
    fs.writeFileSync(path.join(old, "renders.json"), JSON.stringify({ version: 1, nextRenderID: 2, renders: [record] }))
    const loaded = new Journal(old)
    loaded.load()
    assert.equal(loaded.get(1).window, null)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(old, { recursive: true, force: true })
})
