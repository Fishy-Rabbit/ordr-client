// The HTTP edges a client can break: an upload abandoned midway and a video that cannot be read
// after its checks passed. Runs against build/.
//
// Both used to hang or crash (fixed 2026-11-10): an aborted upload left readMultipart waiting
// forever, and a read error on a video (`.pipe()` adds no error listener) was an unhandled
// stream error that stopped the worker with every render on it.
//
// An upload is held in memory until its render is recorded, so POST /renders refuses what it
// cannot take before reading the body (a full line, or a key with RENDER_MAX_UPLOADS uploads in
// progress), and parallel uploads cannot pile replays up in the worker (also 2026-11-10).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")
const net = require("net")

const { Journal } = require("../build/journal")
const { createServer, readMultipart } = require("../build/server")
const { parseScopedKeys } = require("../build/config")
const crypto = require("crypto")

const KEY = "k3y"

/** The scheduler createServer reads, standing in for the real one: one slot, nothing ever waiting. */
const SCHEDULER = {
    slotCount: 1,
    /** Every render counts as first in line. */
    queuePosition: () => 0,
    /** There is nothing to start. */
    tick: () => {},
}

/** A temp directory, removed when the test ends. */
function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/**
 * Listen on a free local port; resolves to the port. When the test ends the server is closed and
 * the cleanup waits for close's callback, so no test ends while the server still holds handles.
 * close() runs first and stops new connections; closeAllConnections() then drops the open ones,
 * which close() would otherwise wait for. The callback also fires (with an error) when the server
 * never started listening, so the cleanup always finishes.
 */
function listen(t, server) {
    t.after(
        () =>
            new Promise((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections?.()
            })
    )
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}

test("an upload the client abandons midway rejects with code 12 instead of hanging", async (t) => {
    let settle
    const settled = new Promise((resolve) => (settle = resolve))
    const server = http.createServer((req, res) => {
        readMultipart(req, 1 << 20).then(
            (value) => settle({ resolved: value }),
            (err) => settle({ rejected: err })
        )
    })
    const port = await listen(t, server)
    const boundary = "ordrabort"
    const socket = net.connect(port, "127.0.0.1")
    await new Promise((resolve) => socket.on("connect", resolve))
    socket.write(
        `POST /renders HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000\r\n\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="1.osr"\r\nContent-Type: application/octet-stream\r\n\r\n` +
            "x".repeat(1000)
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    socket.destroy()

    const timeout = new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 3000))
    const result = await Promise.race([settled, timeout])
    assert.ok(result.rejected, `readMultipart settled: ${JSON.stringify(result)}`)
    assert.equal(result.rejected.status, 400)
    assert.equal(result.rejected.errorCode, 12)
    assert.match(result.rejected.message, /aborted/)
})

test("a complete upload still parses", async (t) => {
    const results = []
    const server = http.createServer((req, res) => {
        readMultipart(req, 1 << 20).then((sub) => {
            results.push(sub)
            res.end("ok")
        })
    })
    const port = await listen(t, server)
    const boundary = "ordrfull"
    const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="beatmapsetId"\r\n\r\n77\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="1.osr"\r\nContent-Type: application/octet-stream\r\n\r\nREPLAY\r\n--${boundary}--\r\n`
    )
    await new Promise((resolve, reject) => {
        const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/renders", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
            res.resume()
            res.on("end", resolve)
        })
        req.on("error", reject)
        req.end(body)
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].fields.beatmapsetId, "77")
    assert.equal(results[0].replay.toString(), "REPLAY")
    assert.equal(results[0].truncated, false)
})

/** GET a path with the key; resolves to { status, complete, body } once the answer has closed. */
function fetchPath(port, route, extraHeaders = {}) {
    return new Promise((resolve) => {
        const req = http.get({ port, host: "127.0.0.1", path: route, headers: { "x-render-key": KEY, ...extraHeaders } }, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("error", () => {})
            res.on("close", () => resolve({ status: res.statusCode, complete: res.complete, body: Buffer.concat(chunks) }))
        })
        req.on("error", (err) => resolve({ error: err.code }))
    })
}

test("a video that cannot be read once its checks pass ends that answer, not the worker", async (t) => {
    const dir = tempDir(t, "video-read-")
    const journal = new Journal(dir)
    journal.load()
    /** A done render whose video is `file`. */
    const done = (file) => {
        const r = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "640x480", skin: "", options: {}, source: "", server: "fishy", scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
        journal.update(r.renderID, { status: "done", videoFile: file, finishedAt: new Date().toISOString() })
        return r.renderID
    }
    const good = path.join(dir, "good.mp4")
    fs.writeFileSync(good, Buffer.from("0123456789"))
    const unreadable = path.join(dir, "unreadable.mp4")
    fs.mkdirSync(unreadable) // exists and stats fine, but reading it fails with EISDIR
    // An entry gives the directory a nonzero size on every filesystem (an empty one is 0 bytes on
    // btrfs), so the answer announces a body that never comes.
    fs.writeFileSync(path.join(unreadable, "frame.bin"), "x")
    assert.ok(fs.statSync(unreadable).size >= 4, "the stand-in video has a size to announce")
    const goodId = done(good)
    const badId = done(unreadable)

    const lines = []
    const cfg = { fake: true, apiKey: KEY, scopedKeys: [], maxQueue: 20, maxReplayBytes: 1 << 20, skinsDir: dir, defaultSkin: "", replaysDir: dir, videosDir: dir, danserVersion: "test" }
    const port = await listen(t, createServer(cfg, journal, SCHEDULER, (l) => lines.push(l)))

    // The status line may or may not have left before the read failed: either way that one
    // answer ends unfinished (a cut-short body or a dropped connection), and the read error is logged.
    for (const headers of [{}, { Range: "bytes=0-3" }]) {
        const answer = await fetchPath(port, `/videos/${badId}.mp4`, headers)
        assert.ok(answer.error || answer.complete === false, `the answer did not complete: ${JSON.stringify(answer)}`)
    }
    assert.equal(lines.filter((l) => new RegExp(`^video ${badId}: EISDIR`).test(l)).length, 2, lines.join("\n"))

    const health = await fetchPath(port, "/health")
    assert.equal(health.status, 200, "the worker is still up")
    const ok = await fetchPath(port, `/videos/${goodId}.mp4`)
    assert.deepEqual([ok.status, ok.complete, ok.body.toString()], [200, true, "0123456789"])
    const part = await fetchPath(port, `/videos/${goodId}.mp4`, { Range: "bytes=-4" })
    assert.deepEqual([part.status, part.body.toString()], [206, "6789"])
})

/** How many of this process's open file descriptors point at `file` (Linux /proc). */
function openFdsOn(file) {
    let n = 0
    for (const fd of fs.readdirSync("/proc/self/fd")) {
        try {
            if (fs.readlinkSync(`/proc/self/fd/${fd}`) === file) n++
        } catch {
            // closed while listing
        }
    }
    return n
}

test("a player that drops the connection mid-video releases the file", { skip: !fs.existsSync("/proc/self/fd") && "needs /proc" }, async (t) => {
    const dir = tempDir(t, "video-drop-")
    const journal = new Journal(dir)
    journal.load()
    const file = path.join(dir, "big.mp4")
    fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 0x41)) // far more than the socket buffers hold
    const r = journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "640x480", skin: "", options: {}, source: "", server: "fishy", scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
    journal.update(r.renderID, { status: "done", videoFile: file, finishedAt: new Date().toISOString() })
    const cfg = { fake: true, apiKey: KEY, scopedKeys: [], maxQueue: 20, maxReplayBytes: 1 << 20, skinsDir: dir, defaultSkin: "", replaysDir: dir, videosDir: dir, danserVersion: "test" }
    const port = await listen(t, createServer(cfg, journal, SCHEDULER, () => {}))

    for (const headers of [{}, { Range: "bytes=1000-" }]) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no data")), 3000)
            const req = http.get({ port, host: "127.0.0.1", path: `/videos/${r.renderID}.mp4`, headers: { "x-render-key": KEY, ...headers } }, (res) => {
                res.once("data", () => {
                    req.destroy() // what a player does on every seek
                    clearTimeout(timer)
                    resolve()
                })
            })
            req.on("error", () => {})
        })
        const deadline = Date.now() + 3000
        while (openFdsOn(file) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(openFdsOn(file), 0, `the read stream was closed (${JSON.stringify(headers)})`)
    }
})

const SCOPED = "scoped-k3y"
/** The SHA-256 of a key as lowercase hex, the form RENDER_SCOPED_KEYS holds. */
const sha256hex = (text) => crypto.createHash("sha256").update(text).digest("hex")
/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A journal in a temp dir and a fake-mode server over it (staff key KEY, scoped key SCOPED for "hinai"); resolves to { port, journal }. */
async function admissionServer(t, overrides = {}) {
    const dir = tempDir(t, "admission-")
    const journal = new Journal(dir)
    journal.load()
    const cfg = {
        fake: true, apiKey: KEY, scopedKeys: parseScopedKeys(`hinai=${sha256hex(SCOPED)}`), scopedMaxActive: 10, minFreeBytes: 0,
        maxQueue: 20, maxReplayBytes: 1 << 20, maxUploads: 4, skinsDir: dir, defaultSkin: "", replaysDir: dir, videosDir: dir, danserVersion: "test",
        ...overrides,
    }
    const port = await listen(t, createServer(cfg, journal, SCHEDULER, () => {}))
    return { port, journal }
}

/** A queued job of `server`, as the journal stores it. */
function queuedJob(journal, server) {
    return journal.create({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "640x480", skin: "", options: {}, source: server, server, scoreId: null, beatmapsetId: 1, beatmapMd5: null, window: null })
}

/**
 * Start a POST /renders upload that does not finish: the headers announce 100000 bytes and only
 * the start of the replay part follows. Resolves to { socket, answer }; `answer` resolves to
 * { status, json } once the server has answered in full, or { none: true } when nothing arrives
 * within `waitMs` (the server is waiting for the rest of the body).
 */
async function partialUpload(t, port, key, waitMs = 2000) {
    const boundary = "ordrslow"
    const socket = net.connect(port, "127.0.0.1")
    t.after(() => socket.destroy())
    socket.on("error", () => {})
    await new Promise((resolve) => socket.on("connect", resolve))
    let text = ""
    const answer = new Promise((resolve) => {
        const deadline = setTimeout(() => resolve({ none: true }), waitMs)
        socket.on("data", (chunk) => {
            text += chunk.toString("latin1")
            const head = text.indexOf("\r\n\r\n")
            if (head < 0) return
            const length = Number((/content-length:\s*(\d+)/i.exec(text.slice(0, head)) || [])[1] ?? 0)
            const body = text.slice(head + 4)
            if (body.length < length) return
            clearTimeout(deadline)
            let json = null
            try {
                json = JSON.parse(body.slice(0, length))
            } catch {
                // not JSON: status only
            }
            resolve({ status: Number(text.slice(9, 12)), json })
        })
    })
    socket.write(
        `POST /renders HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Render-Key: ${key}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000\r\n\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="replayFile"; filename="1.osr"\r\nContent-Type: application/octet-stream\r\n\r\n` +
            "x".repeat(1000)
    )
    return { socket, answer }
}

/** A complete POST /renders without a replay: read in full and refused with 400 / code 2 once admitted. Resolves to { status, json }. */
function postWithoutReplay(port, key) {
    const boundary = "ordrnoreplay"
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="beatmapsetId"\r\n\r\n1\r\n--${boundary}--\r\n`)
    return new Promise((resolve, reject) => {
        const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/renders", headers: { "x-render-key": key, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }))
        })
        req.on("error", reject)
        req.end(body)
    })
}

test("a full line is refused before the upload is read", async (t) => {
    // The whole queue full: every key is refused at once.
    const full = await admissionServer(t, { maxQueue: 1 })
    queuedJob(full.journal, "fishy")
    const staff = await (await partialUpload(t, full.port, KEY)).answer
    assert.equal(staff.status, 503, `answered without the body: ${JSON.stringify(staff)}`)
    assert.equal(staff.json.errorCode, 40)

    // A scoped key whose server already holds its cap: refused at once, while the queue has room.
    const capped = await admissionServer(t, { scopedMaxActive: 1 })
    queuedJob(capped.journal, "hinai")
    const scoped = await (await partialUpload(t, capped.port, SCOPED)).answer
    assert.equal(scoped.status, 503, `answered without the body: ${JSON.stringify(scoped)}`)
    assert.equal(scoped.json.errorCode, 40)
    assert.match(scoped.json.message, /hinai already has 1 renders/)
})

test("a key with RENDER_MAX_UPLOADS uploads in progress is refused at once, and another key is not", async (t) => {
    const { port } = await admissionServer(t, { maxUploads: 1 })
    const first = await partialUpload(t, port, KEY)
    await sleep(100) // the server has the first upload's headers and is reading its body

    const second = await (await partialUpload(t, port, KEY)).answer
    assert.equal(second.status, 503, `answered without the body: ${JSON.stringify(second)}`)
    assert.equal(second.json.errorCode, 40)
    assert.match(second.json.message, /1 uploads in progress/)

    // The scoped key has its own count: its upload is read and judged (400, no replay).
    const other = await postWithoutReplay(port, SCOPED)
    assert.deepEqual([other.status, other.json.errorCode], [400, 2])

    // Once the first upload ends (abandoned here), the staff key may upload again.
    first.socket.destroy()
    let again
    for (const until = Date.now() + 3000; Date.now() < until; await sleep(50)) {
        again = await postWithoutReplay(port, KEY)
        if (again.status !== 503) break
    }
    assert.deepEqual([again.status, again.json.errorCode], [400, 2], "the count went back down when the upload ended")
})

