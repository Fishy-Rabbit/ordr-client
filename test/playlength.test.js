// A queued render's estimate from its own play length. Runs against build/.
//
// Render time follows play length: on the Backup node danser draws about 1.2 s per second of
// play after a few seconds of preparation (2026-11-10: 262 s of play took 311 to 323 s to draw).
// The replay's own frames say how long the play is: their LZMA block is decompressed with xz
// (xz-utils in the image) and the frame times summed. Official replays carry no life bar graph,
// so that cheaper field is no use.
//
// fixtures/frames-30s.lzma: 30 s of synthetic frames as osu! writes them (two lead-in frames,
// one every 16 ms, the -12345 seed frame), made with Python's lzma.FORMAT_ALONE.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")
const { execFileSync } = require("child_process")

const { decompressFrames, framesEndMs, playSeconds, replayPlaySeconds } = require("../build/playlength")
const { parseReplayHeader } = require("../build/osr")
const { etaByRender, etaBasisFor, renderModel, ASSUMED_MODEL } = require("../build/fleet")
const { Journal } = require("../build/journal")
const { createServer } = require("../build/server")

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "frames-30s.lzma"))
/** Whether an xz binary is on PATH; the tests that need one are skipped without it. */
const HAS_XZ = (() => {
    try {
        execFileSync("xz", ["--version"], { stdio: "ignore" })
        return true
    } catch {
        return false
    }
})()
const TYPICAL = { seconds: 63, basis: "measured" }

/** A minimal but valid osu!standard .osr around a frame block. */
function osr(frames, mods = 0) {
    /** One byte. */
    const u8 = (v) => Buffer.from([v])
    /** A 16-bit little-endian integer. */
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
    /** A 32-bit little-endian integer. */
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
    /** A 64-bit little-endian integer. */
    const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
    /** An osu! string: 0x00 when empty, else 0x0b, a one-byte length and the bytes. */
    const str = (s) => (s === "" ? u8(0) : Buffer.concat([u8(0x0b), u8(Buffer.byteLength(s)), Buffer.from(s)]))
    return Buffer.concat([
        u8(0), u32(20251102), str("0123456789abcdef0123456789abcdef"), str("tester"), str("fedcba9876543210fedcba9876543210"),
        u16(100), u16(0), u16(0), u16(0), u16(0), u16(0), u32(1000000), u16(100), u8(1), u32(mods),
        str(""), i64(638000000000000000n), u32(frames.length), frames, i64(0),
    ])
}

/** A journal in a fresh temp directory, removed when the test `t` ends. */
function freshJournal(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playlen-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const journal = new Journal(dir)
    journal.load()
    return { journal, dir }
}

/** The fields journal.create needs. */
function job(overrides) {
    return Object.assign({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "default", options: {}, source: "", server: "hinai", scoreId: null, beatmapsetId: 1, beatmapMd5: null }, overrides)
}

test("framesEndMs sums the frame times, skipping the seed frame and anything malformed", () => {
    assert.equal(framesEndMs("0|256|-500|0,-1|256|-500|0,16|1|1|0,17|1|1|0,-12345|0|0|99,"), 32)
    assert.equal(framesEndMs("10|1|1|0,bad,20|1|1|0"), 30)
    assert.equal(framesEndMs(""), null)
    assert.equal(framesEndMs("-12345|0|0|1"), null)
})

test("framesEndMs refuses totals no real play reaches (over 3 hours of song time)", () => {
    assert.equal(framesEndMs("20000000|1|1|0"), null, "5.5 hours")
    assert.equal(framesEndMs("10000000|1|1|0"), 10000000, "2.8 hours is long but possible")
    assert.equal(framesEndMs("Infinity|1|1|0,10|1|1|0"), 10, "a non-finite delta is skipped")
    assert.equal(framesEndMs("10|1|1,20|1|1|0"), 20, "a frame needs four fields")
})

/**
 * framesEndMs as it was before the delta was read in place: every delta cut out of the text and
 * read by Number(). The in-place reading must give exactly the same answers.
 */
function framesEndMsByNumber(text) {
    if (!text) return null
    let sum = 0
    let end = 0
    let counted = 0
    let frameStart = 0
    let firstBar = -1
    let bars = 0
    for (let k = 0; k <= text.length; k++) {
        const c = k < text.length ? text.charCodeAt(k) : 44
        if (c === 124) {
            if (bars === 0) firstBar = k
            bars++
        } else if (c === 44) {
            if (bars >= 3) {
                const w = Number(text.slice(frameStart, firstBar))
                if (Number.isFinite(w) && w !== -12345) {
                    sum += w
                    counted++
                    if (sum > end) end = sum
                }
            }
            frameStart = k + 1
            firstBar = -1
            bars = 0
        }
    }
    if (counted === 0 || end <= 0 || end > 3 * 3600 * 1000) return null
    return end
}

test("framesEndMs reads every delta exactly as Number() does, odd spellings included", () => {
    const odd = ["16", "-16", "0", "-0", "007", "", "-", "+5", "1.5", "1e3", "0x10", "0b11", " 16", "16 ", "\t8", "Infinity", "-Infinity", "NaN", "abc", "--5", "5-", ".5", "5.", "1_000",
        "999999999999999", "-999999999999999", "9999999999999999", "123456789012345678901234", "-12345", "-012345", "12345"]
    for (const a of odd) {
        for (const b of odd) {
            const text = `${a}|1|2|0,${b}|3|4|0,10|1|1|0`
            assert.equal(framesEndMs(text), framesEndMsByNumber(text), JSON.stringify(text))
        }
    }
    let seed = 20261110
    /** A deterministic pseudo-random integer in [0, n). */
    const rand = (n) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
        return (seed >>> 16) % n
    }
    for (let i = 0; i < 5000; i++) {
        const frames = []
        for (let f = rand(12); f >= 0; f--) {
            const delta = rand(4) === 0 ? odd[rand(odd.length)] : String(rand(40) - 5)
            frames.push([delta, ...Array(rand(6) === 0 ? 2 : 3).fill("1")].join("|"))
        }
        const text = frames.join(rand(10) === 0 ? ",," : ",")
        assert.equal(framesEndMs(text), framesEndMsByNumber(text), JSON.stringify(text))
    }
})

test("framesEndMs and the Number() reading agree on the fixture's frames", { skip: !HAS_XZ && "xz is not installed here" }, async () => {
    const text = await decompressFrames(FIXTURE)
    assert.equal(framesEndMs(text), framesEndMsByNumber(text))
    assert.equal(framesEndMs(text), 30000)
})

test("framesEndMs stays linear on hostile text (many frames with no '|', or '|' with no ',')", () => {
    for (const text of [",".repeat(4_000_000) + "10|1|1|0", "|".repeat(4_000_000), ",|".repeat(2_000_000)]) {
        const started = Date.now()
        framesEndMs(text)
        assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
    }
    assert.equal(framesEndMs(",".repeat(1000) + "10|1|1|0"), 10)
})

test("at most two xz processes run at once; a third replay gets no length instead of waiting", { skip: !HAS_XZ && "xz is not installed here" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slowxz-"))
    try {
        const slow = path.join(dir, "xz")
        fs.writeFileSync(slow, "#!/bin/sh\nsleep 1\nexec xz \"$@\"\n", { mode: 0o755 })
        const buf = osr(FIXTURE)
        const header = parseReplayHeader(buf)
        const started = Date.now()
        const runs = [1, 2, 3].map(() => replayPlaySeconds(buf, header, null, { xzPath: slow }))
        const third = await runs[2]
        assert.equal(third, null)
        assert.ok(Date.now() - started < 900, "the third did not wait for a slot")
        assert.deepEqual(await Promise.all(runs.slice(0, 2)), [30, 30])
        assert.equal(await replayPlaySeconds(buf, header, null), 30, "slots are released afterwards")
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test("playSeconds turns song time into video time: DT and NC speed it up, HT slows it, a window clips it", () => {
    assert.equal(playSeconds(30000, 0, null), 30)
    assert.equal(playSeconds(30000, 64, null), 20, "DT")
    assert.equal(playSeconds(30000, 64 | 512, null), 20, "NC carries the DT bit")
    assert.equal(playSeconds(30000, 512, null), 20, "NC alone")
    assert.equal(playSeconds(30000, 256, null), 40, "HT")
    assert.equal(playSeconds(30000, 0, { start: 5, end: 20 }), 15)
    assert.equal(playSeconds(30000, 0, { start: 25, end: 40 }), 5, "the replay ends inside the window")
    assert.equal(playSeconds(30000, 0, { start: 40, end: 50 }), 0)
})

test("decompressFrames reads an LZMA frame block through xz, within a size cap", { skip: !HAS_XZ && "xz is not installed here" }, async () => {
    const text = await decompressFrames(FIXTURE)
    assert.equal(framesEndMs(text), 30000)
    assert.equal(await decompressFrames(FIXTURE, { maxBytes: 1000 }), null, "more output than the cap is refused")
    assert.equal(await decompressFrames(Buffer.from("not lzma at all, not even close")), null)
    assert.equal(await decompressFrames(FIXTURE, { xzPath: "/nonexistent/xz" }), null, "no xz: no length, never an error")
})

test("replayPlaySeconds reads a whole .osr: header, frame block, mods, window", { skip: !HAS_XZ && "xz is not installed here" }, async () => {
    const buf = osr(FIXTURE)
    const header = parseReplayHeader(buf)
    assert.deepEqual(buf.subarray(header.frameOffset, header.frameOffset + header.frameBytes), FIXTURE)
    assert.equal(await replayPlaySeconds(buf, header, null), 30)
    const dt = osr(FIXTURE, 64)
    assert.equal(await replayPlaySeconds(dt, parseReplayHeader(dt), null), 20)
    assert.equal(await replayPlaySeconds(buf, header, { start: 10, end: 20 }), 10)
})

test("a queued job's estimate comes from its play length; jobs without one keep the median", (t) => {
    const { journal } = freshJournal(t)
    const long = journal.create(job({ playSeconds: 262 }))
    const plain = journal.create(job({}))
    const model = renderModel(journal)
    assert.equal(model.basis, "assumed")
    const eta = etaByRender(journal, 1, TYPICAL, Date.now(), model)
    const longTotal = Math.round(ASSUMED_MODEL.prepSeconds + ASSUMED_MODEL.drawPerPlaySecond * 262)
    assert.equal(eta.get(long.renderID), longTotal)
    assert.equal(eta.get(plain.renderID), longTotal + TYPICAL.seconds, "waits for the long one, then a median render")
    assert.equal(etaBasisFor(journal.get(long.renderID), model, TYPICAL), "assumed")
    assert.equal(etaBasisFor(journal.get(plain.renderID), model, TYPICAL), "measured")
})

test("a running job before danser's first report counts its own expected length down", (t) => {
    const { journal } = freshJournal(t)
    const now = Date.parse("2026-11-10T15:00:00Z")
    const r = journal.create(job({ playSeconds: 262 }))
    journal.update(r.renderID, { status: "rendering", progress: "Rendering (preparing)", startedAt: new Date(now - 20_000).toISOString() })
    const model = renderModel(journal)
    const total = Math.round(ASSUMED_MODEL.prepSeconds + ASSUMED_MODEL.drawPerPlaySecond * 262)
    assert.equal(etaByRender(journal, 1, TYPICAL, now, model).get(r.renderID), total - 20)
})

test("the model is measured once three finished renders recorded their play length and draw start", (t) => {
    const { journal } = freshJournal(t)
    const t0 = Date.parse("2026-11-10T12:00:00Z")
    for (const [play, prep, draw] of [[100, 6, 130], [200, 8, 250], [50, 12, 60]]) {
        const r = journal.create(job({ playSeconds: play }))
        journal.update(r.renderID, {
            status: "done",
            startedAt: new Date(t0).toISOString(),
            drawStartedAt: new Date(t0 + prep * 1000).toISOString(),
            finishedAt: new Date(t0 + (prep + draw) * 1000).toISOString(),
        })
    }
    // Medians: prep 8 s; drawing 1.25 s per second of play (1.3, 1.25, 1.2).
    assert.deepEqual(renderModel(journal), { prepSeconds: 8, drawPerPlaySecond: 1.25, basis: "measured" })
})

test("POST /renders records the play length the replay's frames give", { skip: !HAS_XZ && "xz is not installed here" }, async (t) => {
    const { journal, dir } = freshJournal(t)
    const cfg = {
        fake: false, apiKey: "k3y", scopedKeys: [], scopedMaxActive: 10, minFreeBytes: 0, videosDir: dir, maxQueue: 20,
        maxReplayBytes: 1 << 20, skinsDir: dir, defaultSkin: "", replaysDir: dir, danserVersion: "test",
    }
    const scheduler = { slotCount: 1, queuePosition: (r) => (r.status === "queued" ? 1 : 0), tick: () => {} }
    const server = createServer(cfg, journal, scheduler, () => {})
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
        const boundary = "playlentest"
        /** One multipart text part. */
        const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
        const body = Buffer.concat([
            Buffer.from(field("beatmapsetId", "1") + field("server", "hinai") + field("resolution", "1280x720")),
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="r.osr"\r\nContent-Type: application/octet-stream\r\n\r\n`),
            osr(FIXTURE),
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ])
        const status = await new Promise((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${server.address().port}/renders`, {
                method: "POST",
                headers: { "x-render-key": "k3y", "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length },
            }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)) })
            req.on("error", reject)
            req.end(body)
        })
        assert.equal(status, 201)
        assert.equal(journal.all()[0].playSeconds, 30)
    } finally {
        server.close()
    }
})
