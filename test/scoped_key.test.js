// Scoped keys (RENDER_SCOPED_KEYS) and the free-disk floor (RENDER_MIN_FREE_GB), over the real
// HTTP routes in fake mode (no danser). Runs against build/.
//
// A scoped key acts for ONE server: it may queue renders only under that server's name, and it
// sees only that server's renders and videos. The staff key (RENDER_API_KEY) still sees every
// server. Added 2026-11-10 so the hinai beatmap mirror no longer holds the staff key.
const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")

const { Journal } = require("../build/journal")
const { createServer } = require("../build/server")
const { parseScopedKeys } = require("../build/config")

const STAFF = "staff-key"
const HINAI = "hinai-key"
const sha256hex = (text) => crypto.createHash("sha256").update(text).digest("hex")
const FIELDS = { beatmapsetId: "1", beatmapMd5: "0123456789abcdef0123456789abcdef", server: "hinai", source: "hinai beatmap page", resolution: "640x480" }

/** A record as the journal stores it, for seeding other servers' jobs. */
function seed(journal, server, status, extra = {}) {
    const r = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "640x480", skin: "", options: {}, source: server, server, scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
    journal.update(r.renderID, { status, ...extra })
    return journal.get(r.renderID)
}

/** A fresh journal and server over a stub scheduler; resolves to { base, journal, dir, close }. */
function serve(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-key-"))
    const journal = new Journal(dir)
    journal.load()
    const cfg = {
        fake: true,
        apiKey: STAFF,
        scopedKeys: parseScopedKeys(`hinai=${sha256hex(HINAI)}`),
        scopedMaxActive: 10,
        minFreeBytes: 0,
        videosDir: dir,
        maxQueue: 20,
        maxReplayBytes: 1 << 20,
        skinsDir: dir,
        defaultSkin: "",
        replaysDir: dir,
        danserVersion: "test",
        ...overrides,
    }
    const scheduler = {
        slotCount: 2,
        /** FIFO place among queued jobs, 0 otherwise. */
        queuePosition: (r) => (r.status === "queued" ? journal.queued().findIndex((q) => q.renderID === r.renderID) + 1 : 0),
        /** No-op. */
        tick: () => {},
    }
    const server = createServer(cfg, journal, scheduler, () => {})
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, journal, dir, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) } })))
}

/** One multipart body: the string fields plus a replayFile part (fake mode tolerates an unparseable replay). */
function multipart(fields) {
    const boundary = "ordrscopedtest"
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="1.osr"\r\nContent-Type: application/octet-stream\r\n\r\nnot a real replay\r\n--${boundary}--\r\n`)
    return { body: Buffer.from(parts.join("")), type: `multipart/form-data; boundary=${boundary}` }
}

/** A request with the given key; resolves to { status, body } (body parsed when it is JSON). */
function call(base, key, method, route, payload) {
    return new Promise((resolve, reject) => {
        const headers = key === null ? {} : { "x-render-key": key }
        if (payload) Object.assign(headers, { "content-type": payload.type, "content-length": payload.body.length })
        const req = http.request(base + route, { method, headers }, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () => {
                const raw = Buffer.concat(chunks)
                const json = String(res.headers["content-type"] || "").startsWith("application/json")
                resolve({ status: res.statusCode, body: json && raw.length ? JSON.parse(raw.toString()) : raw })
            })
        })
        req.on("error", reject)
        req.end(payload ? payload.body : undefined)
    })
}

test("parseScopedKeys reads server=sha256hex entries and refuses anything else", () => {
    const h = sha256hex("x")
    assert.deepEqual(parseScopedKeys(""), [])
    assert.deepEqual(parseScopedKeys("  "), [])
    const two = parseScopedKeys(`hinai=${h}, other-site=${h.toUpperCase()}`)
    assert.deepEqual(two.map((k) => k.server), ["hinai", "other-site"])
    assert.equal(two[0].hash.length, 32)
    assert.equal(two[1].hash.toString("hex"), h)
    // Two digests for one server: the rotation overlap.
    assert.equal(parseScopedKeys(`hinai=${h}\nhinai=${sha256hex("y")}`).length, 2)
    assert.throws(() => parseScopedKeys("hinai"), /RENDER_SCOPED_KEYS/)
    assert.throws(() => parseScopedKeys(`Hinai!=${h}`), /RENDER_SCOPED_KEYS/)
    assert.throws(() => parseScopedKeys("hinai=abc"), /RENDER_SCOPED_KEYS/)
    // A plaintext key pasted by mistake is not a digest.
    assert.throws(() => parseScopedKeys(`hinai=${HINAI}`), /RENDER_SCOPED_KEYS/)
})

test("a wrong key, a missing key and an unknown key are all 401", async () => {
    const { base, close } = await serve()
    try {
        assert.equal((await call(base, "nope", "GET", "/renders")).status, 401)
        assert.equal((await call(base, null, "GET", "/renders")).status, 401)
        // The DIGEST itself is not a key: only its preimage is.
        assert.equal((await call(base, sha256hex(HINAI), "GET", "/renders")).status, 401)
        assert.equal((await call(base, null, "GET", "/health")).status, 200)
    } finally {
        close()
    }
})

test("a scoped key queues only under its own server name", async () => {
    const { base, journal, close } = await serve()
    try {
        const own = await call(base, HINAI, "POST", "/renders", multipart(FIELDS))
        assert.equal(own.status, 201)
        assert.equal(journal.get(own.body.renderID).server, "hinai")

        // No server field: the key decides, not the source text.
        const { server: _omit, ...noServer } = FIELDS
        const implied = await call(base, HINAI, "POST", "/renders", multipart({ ...noServer, source: "kawata.fishy.moe" }))
        assert.equal(implied.status, 201)
        assert.equal(journal.get(implied.body.renderID).server, "hinai")

        const other = await call(base, HINAI, "POST", "/renders", multipart({ ...FIELDS, server: "fishy" }))
        assert.equal(other.status, 403)
        assert.equal(journal.all().length, 2)

        // The staff key still names any server.
        const staff = await call(base, STAFF, "POST", "/renders", multipart({ ...FIELDS, server: "fishy" }))
        assert.equal(staff.status, 201)
        assert.equal(journal.get(staff.body.renderID).server, "fishy")
    } finally {
        close()
    }
})

test("a scoped key reads only its own server's renders, queue jobs and videos", async () => {
    const { base, journal, dir, close } = await serve()
    try {
        const video = path.join(dir, "v.mp4")
        fs.writeFileSync(video, Buffer.alloc(64, 1))
        const fishyDone = seed(journal, "fishy", "done", { videoFile: video })
        const fishyQueued = seed(journal, "fishy", "queued")
        const hinaiDone = seed(journal, "hinai", "done", { videoFile: video })
        const hinaiQueued = seed(journal, "hinai", "queued")

        const one = async (key, id) => (await call(base, key, "GET", `/renders?renderID=${id}`)).body.renders.map((r) => r.renderID)
        assert.deepEqual(await one(HINAI, hinaiDone.renderID), [hinaiDone.renderID])
        assert.deepEqual(await one(HINAI, fishyDone.renderID), [])
        assert.deepEqual(await one(STAFF, fishyDone.renderID), [fishyDone.renderID])

        const list = async (key) => (await call(base, key, "GET", "/renders")).body.renders.map((r) => r.server)
        assert.deepEqual(await list(HINAI), ["hinai", "hinai"])
        assert.deepEqual((await list(STAFF)).sort(), ["fishy", "fishy", "hinai", "hinai"])

        const scopedQueue = (await call(base, HINAI, "GET", "/queue?recent=10")).body
        assert.deepEqual(scopedQueue.jobs.map((j) => j.renderID), [hinaiQueued.renderID])
        assert.deepEqual(scopedQueue.recent.map((j) => j.renderID), [hinaiDone.renderID])
        // Per-server counts are public already (/health), and the mirror's line cap reads them.
        assert.deepEqual(scopedQueue.servers, { fishy: { queued: 1, rendering: 0 }, hinai: { queued: 1, rendering: 0 } })
        const staffQueue = (await call(base, STAFF, "GET", "/queue?recent=10")).body
        assert.deepEqual(staffQueue.jobs.map((j) => j.renderID).sort(), [fishyQueued.renderID, hinaiQueued.renderID].sort())

        assert.equal((await call(base, HINAI, "GET", `/videos/${hinaiDone.renderID}.mp4`)).status, 200)
        assert.equal((await call(base, HINAI, "GET", `/videos/${fishyDone.renderID}.mp4`)).status, 404)
        assert.equal((await call(base, HINAI, "HEAD", `/videos/render${fishyDone.renderID}.mp4`)).status, 404)
        assert.equal((await call(base, STAFF, "GET", `/videos/${fishyDone.renderID}.mp4`)).status, 200)

        assert.equal((await call(base, HINAI, "GET", "/skins")).status, 200)
    } finally {
        close()
    }
})

test("a scoped key holds at most scopedMaxActive jobs in the line; the staff key is not capped by it", async () => {
    const { base, journal, close } = await serve({ scopedMaxActive: 2 })
    try {
        seed(journal, "hinai", "rendering")
        seed(journal, "fishy", "queued")
        seed(journal, "fishy", "queued")
        assert.equal((await call(base, HINAI, "POST", "/renders", multipart({ ...FIELDS, scoreId: "1" }))).status, 201)
        const full = await call(base, HINAI, "POST", "/renders", multipart({ ...FIELDS, scoreId: "2" }))
        assert.equal(full.status, 503)
        assert.equal(full.body.errorCode, 40)
        // Finished jobs do not count against the cap.
        seed(journal, "hinai", "done")
        assert.equal((await call(base, STAFF, "POST", "/renders", multipart({ ...FIELDS, server: "fishy", scoreId: "3" }))).status, 201)
    } finally {
        close()
    }
})

test("below the free-disk floor every new render is refused, for every key", async () => {
    const low = await serve({ minFreeBytes: Number.MAX_SAFE_INTEGER })
    try {
        for (const key of [HINAI, STAFF]) {
            const res = await call(low.base, key, "POST", "/renders", multipart(FIELDS))
            assert.equal(res.status, 503)
            assert.equal(res.body.errorCode, 43)
        }
        assert.equal(low.journal.all().length, 0)
    } finally {
        low.close()
    }
    const ok = await serve({ minFreeBytes: 1 })
    try {
        assert.equal((await call(ok.base, HINAI, "POST", "/renders", multipart(FIELDS))).status, 201)
    } finally {
        ok.close()
    }
})
