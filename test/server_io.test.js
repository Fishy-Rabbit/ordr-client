// The HTTP edges a client can break: an upload abandoned midway and a video that cannot be read
// after its checks passed. Runs against build/.
//
// Both used to hang or crash (fixed 2026-11-10): an aborted upload left readMultipart waiting
// forever, and a read error on a video (`.pipe()` adds no error listener) was an unhandled
// stream error that stopped the worker with every render on it.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")
const net = require("net")

const { Journal } = require("../build/journal")
const { createServer, readMultipart } = require("../build/server")

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

/** Listen on a free local port; resolves to the port, and closes the server when the test ends. */
function listen(t, server) {
    t.after(() => {
        server.closeAllConnections?.()
        server.close()
    })
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
