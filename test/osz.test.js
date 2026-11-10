// Map sets (.osz) from the mirror. Runs against build/.
//
// A set is untrusted input: its download, the file kept in the songs cache and the difficulty
// files inside it all have size caps, checked before anything is read into memory
// (RENDER_MAX_OSZ_MB and OSU_FILE_LIMITS, added 2026-11-10). Two slots that need the same
// uncached set share one download, and a finished render is recorded done before its replay is
// deleted, so a crash between the two can never strand a finished video.
const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const AdmZip = require("adm-zip")

const { HINAI_MIRROR_HOSTS } = require("../build/config")
const { ensureOsz, inspectOsz, OszLimitError, OSU_FILE_LIMITS, prepareSlotDirs, replayPath, runRenderJob } = require("../build/job")
const { Journal } = require("../build/journal")

const MB = 1024 * 1024

/** A temp directory, removed when the test ends. */
function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/** Replace the global fetch for this test only. */
function stubFetch(t, fn) {
    const real = globalThis.fetch
    globalThis.fetch = fn
    t.after(() => {
        globalThis.fetch = real
    })
}

/** The config ensureOsz reads, with a songs dir under `dir` and a mirror base on a hinai host. */
function mirrorCfg(dir, overrides = {}) {
    const songsDir = path.join(dir, "songs")
    fs.mkdirSync(songsDir, { recursive: true })
    return { songsDir, mirrorBase: `http://${[...HINAI_MIRROR_HOSTS][0]}`, mirrorDownloadPath: "/d/{id}", mirrorUserAgent: "test", maxOszBytes: MB, ...overrides }
}

/** A difficulty file with the metadata inspectOsz reads, padded with "x" to `padTo` characters. */
function osuText(version, padTo = 0) {
    const text = `osu file format v14\n\n[Metadata]\nTitle:Song\nArtist:Band\nVersion:${version}\n`
    return padTo > text.length ? text + "x".repeat(padTo - text.length) : text
}

/** A .osz holding `files` ({ name: string or Buffer }). */
function oszBuffer(files) {
    const zip = new AdmZip()
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content))
    return zip.toBuffer()
}

/** The hex md5 of a string. */
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex")

/**
 * A copy of a one-file zip whose entry declares `size` uncompressed bytes in both its local and
 * central headers (what a hostile set controls), the compressed bytes unchanged.
 */
function declareSize(buf, size) {
    const out = Buffer.from(buf)
    const end = out.length - 22
    assert.equal(out.readUInt32LE(end), 0x06054b50, "end of central directory")
    assert.equal(out.readUInt16LE(end + 10), 1, "one entry")
    const central = out.readUInt32LE(end + 16)
    assert.equal(out.readUInt32LE(central), 0x02014b50, "central header")
    assert.equal(out.readUInt32LE(0), 0x04034b50, "local header")
    assert.equal(out.readUInt16LE(8), 8, "deflated")
    out.writeUInt32LE(size, central + 24)
    out.writeUInt32LE(size, 22)
    return out
}

/** Where the one entry's compressed bytes start in a one-file zip. */
const dataStart = (buf) => 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28)

/** Write a buffer into `dir` and return its path. */
function put(dir, name, buf) {
    const p = path.join(dir, name)
    fs.writeFileSync(p, buf)
    return p
}

test("two renders asking for the same uncached set at once share one download", async (t) => {
    const dir = tempDir(t, "osz-share-")
    const cfg = mirrorCfg(dir)
    const set = oszBuffer({ "hard.osu": osuText("Hard") })
    const calls = []
    stubFetch(t, async (url) => {
        calls.push(url)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(set, { status: 200 })
    })
    const lines = []
    const [a, b] = await Promise.all([ensureOsz(cfg, 5, (l) => lines.push(l)), ensureOsz(cfg, 5, (l) => lines.push(l))])
    assert.deepEqual(a, { ok: true, path: path.join(cfg.songsDir, "5.osz") })
    assert.deepEqual(b, a)
    assert.equal(calls.length, 1, "one download for both")
    assert.ok(lines.some((l) => /set 5 is already downloading/.test(l)), lines.join("\n"))
    assert.deepEqual(fs.readdirSync(cfg.songsDir), ["5.osz"], "no .part file left")
    assert.deepEqual(fs.readFileSync(a.path), set)

    await Promise.all([ensureOsz(cfg, 6, () => {}), ensureOsz(cfg, 7, () => {})])
    assert.equal(calls.length, 3, "different sets download independently")

    await ensureOsz(cfg, 5, () => {})
    assert.equal(calls.length, 3, "a finished download is a cache hit")
    fs.rmSync(a.path)
    assert.deepEqual(await ensureOsz(cfg, 5, () => {}), a)
    assert.equal(calls.length, 4, "the finished download is no longer shared: a deleted set downloads again")
})

test("a failed shared download fails every render waiting for it, and the next one retries", async (t) => {
    const dir = tempDir(t, "osz-share-fail-")
    const cfg = mirrorCfg(dir)
    let calls = 0
    stubFetch(t, async () => {
        calls++
        return new Response("gone", { status: 404 })
    })
    const both = await Promise.all([ensureOsz(cfg, 9, () => {}), ensureOsz(cfg, 9, () => {})])
    assert.deepEqual(both.map((r) => r.ok), [false, false])
    assert.match(both[1].message, /set 9 answered 404/)
    assert.equal(calls, 1)
    await ensureOsz(cfg, 9, () => {})
    assert.equal(calls, 2)
})

test("a set larger than RENDER_MAX_OSZ_MB is refused, whether the mirror declares the size or not", async (t) => {
    const dir = tempDir(t, "osz-cap-")
    const cfg = mirrorCfg(dir, { maxOszBytes: MB })
    const pulled = {}
    const cancelled = {}
    /** A 1.6 MB body in 16 KiB chunks that counts, per set, the chunks read and a cancel. */
    const body = (set) => {
        pulled[set] = 0
        return new ReadableStream({
            /** Hand out the next 16 KiB chunk and count it; after 100 chunks the body ends. */
            pull(controller) {
                if (pulled[set] < 100) {
                    pulled[set]++
                    controller.enqueue(new Uint8Array(16 * 1024).fill(0x50))
                } else {
                    controller.close()
                }
            },
            /** Note that the reader gave up on this body (what releases the connection). */
            cancel() {
                cancelled[set] = true
            },
        })
    }
    stubFetch(t, async (url) => {
        const set = url.slice(url.lastIndexOf("/") + 1)
        const headers = set === "1" ? { "content-length": String(100 * 16 * 1024) } : {}
        return new Response(body(set), { status: 200, headers })
    })

    const declared = await ensureOsz(cfg, 1, () => {})
    assert.deepEqual(declared, { ok: false, message: "map not available on the mirror: set 1 is larger than the RENDER_MAX_OSZ_MB limit (1 MB)" })
    const streamed = await ensureOsz(cfg, 2, () => {})
    assert.deepEqual(streamed, { ok: false, message: "map not available on the mirror: set 2 is larger than the RENDER_MAX_OSZ_MB limit (1 MB)" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(cancelled, { 1: true, 2: true }, "both bodies were cancelled, so the connection is released")
    assert.ok(pulled[1] <= 2, `the declared size was refused before the body was read (${pulled[1]} chunks)`)
    assert.ok(pulled[2] >= 64 && pulled[2] < 80, `the streamed download stopped at the cap (${pulled[2]} of 100 chunks)`)
    assert.deepEqual(fs.readdirSync(cfg.songsDir), [], "nothing kept: no .osz, no .part")
})

test("inspectOsz finds the played difficulty and refuses sizes out of bounds before reading", (t) => {
    const dir = tempDir(t, "osz-inspect-")
    const limits = { oszBytes: MB, osuBytes: 4096, setOsuBytes: 6000 }
    const hard = osuText("Hard")
    const normal = put(dir, "normal.osz", oszBuffer({ "easy.osu": osuText("Easy"), "hard.osu": hard, "bg.jpg": Buffer.alloc(10_000) }))
    assert.deepEqual(inspectOsz(normal, md5(hard), limits), { found: true, title: "Band - Song [Hard]" })
    assert.deepEqual(inspectOsz(normal, md5("another map"), limits), { found: false, title: "Band - Song [Easy]" })

    assert.throws(() => inspectOsz(normal, null, { ...limits, oszBytes: 100 }), (err) => err instanceof OszLimitError && /larger than the RENDER_MAX_OSZ_MB limit \(100 bytes\)/.test(err.message))
    const big = put(dir, "big.osz", oszBuffer({ "big.osu": osuText("Big", 5000) }))
    assert.throws(() => inspectOsz(big, null, limits), (err) => err instanceof OszLimitError && /declares 5000 bytes, more than the 4096 bytes one may have/.test(err.message))
    const many = put(dir, "many.osz", oszBuffer({ "a.osu": osuText("A", 3500), "b.osu": osuText("B", 3500) }))
    assert.throws(() => inspectOsz(many, null, limits), (err) => err instanceof OszLimitError && /declare more than 6000 bytes together/.test(err.message))
})

test("a difficulty file that declares 0 bytes is taken as empty and never inflated", (t) => {
    const dir = tempDir(t, "osz-zero-")
    const zero = declareSize(oszBuffer({ "zero.osu": osuText("Zero", 2000) }), 0)
    zero[dataStart(zero)] = 0xff // deflate block type 3: inflating these bytes throws
    const p = put(dir, "zero.osz", zero)
    assert.throws(() => new AdmZip(p).getEntries()[0].getData(), "adm-zip itself would inflate them (with no output limit) and fail")
    assert.equal(inspectOsz(p, md5(""), { oszBytes: MB, ...OSU_FILE_LIMITS }).found, true, "read as the empty file it declares")
})

test("a difficulty file that inflates past its declared size stops at the declared size", (t) => {
    // Pins the adm-zip behaviour the per-file cap relies on: the declared size is zlib's
    // maxOutputLength, so a 1 MiB entry that claims 1 KiB fails instead of inflating.
    const dir = tempDir(t, "osz-lie-")
    const p = put(dir, "lie.osz", declareSize(oszBuffer({ "lie.osu": osuText("Lie", MB) }), 1024))
    assert.ok(fs.statSync(p).size < 64 * 1024, "a few KB on disk")
    assert.throws(() => inspectOsz(p, null, { oszBytes: MB, ...OSU_FILE_LIMITS }), { code: "ERR_BUFFER_TOO_LARGE" })
})

test("the default caps leave room for every real set and difficulty file", () => {
    assert.equal(OSU_FILE_LIMITS.osuBytes, 64 * MB, "the largest real .osu seen is about 35 MB")
    assert.equal(OSU_FILE_LIMITS.setOsuBytes, 512 * MB)
})

/** A journal in `dir`, a render for set 77 with its replay on disk, and the config runRenderJob reads. */
function renderSetup(dir, overrides = {}) {
    const cfg = {
        songsDir: path.join(dir, "songs"),
        replaysDir: path.join(dir, "replays"),
        videosDir: path.join(dir, "videos"),
        workDir: path.join(dir, "work"),
        skinsDir: path.join(dir, "skins"),
        danserDir: path.join(dir, "danser"),
        maxOszBytes: MB,
        threadsPerSlot: 1,
        timeoutMs: 60_000,
        stallMs: 60_000,
        debug: false,
        ...overrides,
    }
    for (const d of [cfg.songsDir, cfg.replaysDir, cfg.videosDir, cfg.workDir, cfg.skinsDir, cfg.danserDir]) fs.mkdirSync(d, { recursive: true })
    const journal = new Journal(dir)
    journal.load()
    const record = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "640x480", skin: "default", options: {}, source: "", server: "fishy", scoreId: null, beatmapsetId: 77, beatmapMd5: null, window: null })
    fs.writeFileSync(replayPath(cfg, record.renderID), Buffer.alloc(64, 1))
    return { cfg, journal, record }
}

test("a render whose cached set is over RENDER_MAX_OSZ_MB fails with code 8 and the set is deleted", async (t) => {
    const dir = tempDir(t, "osz-render-cap-")
    const { cfg, journal, record } = renderSetup(dir)
    const cached = put(cfg.songsDir, "77.osz", Buffer.alloc(2 * MB, 0x50))
    const lines = []
    const slot = { index: 0, display: ":99", root: dir, danserDir: cfg.danserDir, songsDir: cfg.songsDir, videosDir: cfg.videosDir }
    await runRenderJob(cfg, journal, record, slot, {}, (l) => lines.push(l), () => {})
    const after = journal.get(record.renderID)
    assert.equal(after.status, "failed")
    assert.equal(after.errorCode, 8)
    assert.equal(after.errorMessage, "map not available on the mirror: the set's .osz is 2 MB, larger than the RENDER_MAX_OSZ_MB limit (1 MB)")
    assert.equal(fs.existsSync(cached), false, "the oversized set is not kept")
    assert.equal(fs.existsSync(replayPath(cfg, record.renderID)), false)
})

test("a finished render is recorded done before its replay is deleted", async (t) => {
    const dir = tempDir(t, "osz-render-done-")
    const { cfg, journal, record } = renderSetup(dir)
    put(cfg.songsDir, "77.osz", oszBuffer({ "hard.osu": osuText("Hard") }))
    // A stand-in danser-cli: it writes the video where the slot's settings point (../videos) and
    // says "Finished.", as danser does.
    fs.writeFileSync(path.join(cfg.danserDir, "danser-cli"), [
        "#!/bin/sh",
        "out=",
        "while [ $# -gt 0 ]; do",
        '    if [ "$1" = "-out" ]; then out="$2"; fi',
        "    shift",
        "done",
        ': > "../videos/$out.mp4"',
        "echo '2026/11/10 12:00:00 Finished.'",
    ].join("\n") + "\n", { mode: 0o755 })
    const slot = prepareSlotDirs(cfg, 0, ":99")
    fs.chmodSync(path.join(slot.danserDir, "danser-cli"), 0o755)

    const id = record.renderID
    let replayWhenDone = null
    const update = journal.update.bind(journal)
    journal.update = (rid, patch) => {
        if (patch.status === "done") replayWhenDone = fs.existsSync(replayPath(cfg, rid))
        return update(rid, patch)
    }
    const lines = []
    await runRenderJob(cfg, journal, journal.get(id), slot, {}, (l) => lines.push(l), () => {})

    const after = journal.get(id)
    assert.equal(after.status, "done", lines.join("\n"))
    assert.equal(after.mapTitle, "Band - Song [Hard]")
    assert.equal(replayWhenDone, true, "done was recorded while the replay was still on disk")
    assert.equal(fs.existsSync(replayPath(cfg, id)), false, "then the replay was deleted")
    assert.equal(after.videoFile, path.join(cfg.videosDir, `render${id}.mp4`))
    assert.ok(fs.existsSync(after.videoFile))
    assert.ok(lines.some((l) => new RegExp(`render ${id} done in`).test(l)), lines.join("\n"))
})
