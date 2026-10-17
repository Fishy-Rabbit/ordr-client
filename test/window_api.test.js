// POST /renders with a window, over the real HTTP routes in fake mode (no danser). Runs against build/.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")

const { Journal } = require("../build/journal")
const { createServer } = require("../build/server")

const KEY = "k3y"
const FIELDS = { beatmapsetId: "1", beatmapMd5: "0123456789abcdef0123456789abcdef", server: "kawata", source: "kawata.fishy.moe", resolution: "640x480" }

/** A fresh journal and server over a stub scheduler; resolves to { base, journal, close }. */
function serve() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-api-"))
    const journal = new Journal(dir)
    journal.load()
    const cfg = { fake: true, apiKey: KEY, maxQueue: 20, maxReplayBytes: 1 << 20, skinsDir: dir, defaultSkin: "", replaysDir: dir, danserVersion: "test" }
    const scheduler = {
        slotCount: 2,
        /** FIFO place among queued jobs, 0 otherwise. */
        queuePosition: (r) => (r.status === "queued" ? journal.queued().findIndex((q) => q.renderID === r.renderID) + 1 : 0),
        /** No-op. */
        tick: () => {},
    }
    const server = createServer(cfg, journal, scheduler, () => {})
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, journal, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) } })))
}

/** One multipart body: the string fields plus a replayFile part (fake mode tolerates an unparseable replay). */
function multipart(fields) {
    const boundary = "ordrwindowtest"
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="1.osr"\r\nContent-Type: application/octet-stream\r\n\r\nnot a real replay\r\n--${boundary}--\r\n`)
    return { body: Buffer.from(parts.join("")), type: `multipart/form-data; boundary=${boundary}` }
}

/** A keyed request; resolves to { status, body }. */
function call(base, method, route, payload) {
    return new Promise((resolve, reject) => {
        const headers = { "x-render-key": KEY }
        if (payload) Object.assign(headers, { "content-type": payload.type, "content-length": payload.body.length })
        const req = http.request(base + route, { method, headers }, (res) => {
            let raw = ""
            res.on("data", (c) => (raw += c))
            res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
        })
        req.on("error", reject)
        req.end(payload ? payload.body : undefined)
    })
}

test("a windowed submit is stored and reported on every read", async () => {
    const { base, journal, close } = await serve()
    try {
        const posted = await call(base, "POST", "/renders", multipart({ ...FIELDS, scoreId: "41", start: "12", end: "32" }))
        assert.equal(posted.status, 201)
        assert.equal(posted.body.errorCode, 0)
        assert.deepEqual(posted.body.window, { start: 12, end: 32 })
        const id = posted.body.renderID
        assert.deepEqual(journal.get(id).window, { start: 12, end: 32 })
        const one = await call(base, "GET", `/renders?renderID=${id}`)
        assert.deepEqual(one.body.renders[0].window, { start: 12, end: 32 })
        const queue = await call(base, "GET", "/queue")
        assert.deepEqual(queue.body.jobs.find((j) => j.renderID === id).window, { start: 12, end: 32 })
    } finally {
        close()
    }
})

test("a full render reports window null", async () => {
    const { base, close } = await serve()
    try {
        const posted = await call(base, "POST", "/renders", multipart({ ...FIELDS, scoreId: "40" }))
        assert.equal(posted.status, 201)
        assert.equal(posted.body.window, null)
        const one = await call(base, "GET", `/renders?renderID=${posted.body.renderID}`)
        assert.equal(one.body.renders[0].window, null)
    } finally {
        close()
    }
})

test("a bad window queues nothing and answers 400 code 12", async () => {
    const { base, journal, close } = await serve()
    try {
        for (const [start, end] of [["12", undefined], [undefined, "32"], ["30", "12"], ["12", "12"], ["1.5", "3"], ["-1", "3"], ["0", "86401"]]) {
            const fields = { ...FIELDS, scoreId: "42" }
            if (start !== undefined) fields.start = start
            if (end !== undefined) fields.end = end
            const res = await call(base, "POST", "/renders", multipart(fields))
            assert.equal(res.status, 400, `${start} .. ${end}`)
            assert.equal(res.body.errorCode, 12)
        }
        assert.equal(journal.all().length, 0)
    } finally {
        close()
    }
})

test("a window of a score already active from the same server is a duplicate (code 29)", async () => {
    const { base, close } = await serve()
    try {
        assert.equal((await call(base, "POST", "/renders", multipart({ ...FIELDS, scoreId: "43" }))).status, 201)
        const dup = await call(base, "POST", "/renders", multipart({ ...FIELDS, scoreId: "43", start: "12", end: "32" }))
        assert.equal(dup.status, 409)
        assert.equal(dup.body.errorCode, 29)
    } finally {
        close()
    }
})
