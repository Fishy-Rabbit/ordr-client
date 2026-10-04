// The shared queue fishy and kawata both feed. Runs against the compiled build/ (npm test builds first).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const http = require("http")

const { serverFor, typicalDuration, etaByRender, serverCounts, FALLBACK_RENDER_SECONDS } = require("../build/fleet")
const { Journal } = require("../build/journal")
const { createServer } = require("../build/server")

/** A journal in a fresh temp directory. */
function freshJournal(seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-"))
    if (seed) fs.writeFileSync(path.join(dir, "renders.json"), JSON.stringify(seed))
    const journal = new Journal(dir)
    journal.load()
    return journal
}

/** The fields journal.create needs, with overrides. */
function job(overrides) {
    return Object.assign({ replayUsername: "p", mapTitle: "", replayMods: 0, resolution: "1280x720", skin: "default", options: {}, source: "", server: "fishy", scoreId: null, beatmapsetId: 1, beatmapMd5: null }, overrides)
}

test("serverFor: an explicit name wins, otherwise the source names the site", () => {
    assert.equal(serverFor("kawata", "fishy-player"), "kawata")
    assert.equal(serverFor(undefined, "kawata.fishy.moe player"), "kawata", "kawata staging lives under fishy.moe")
    assert.equal(serverFor(undefined, "kawata.pw"), "kawata")
    assert.equal(serverFor(undefined, "fishy-player"), "fishy")
    assert.equal(serverFor("Not A Name!", "fishy-player"), "fishy", "an invalid name falls back to the source")
    assert.equal(serverFor(undefined, ""), "other")
})

test("the duplicate check is per server: the same score id from two servers is two jobs", () => {
    const journal = freshJournal()
    journal.create(job({ server: "fishy", scoreId: "1234" }))
    assert.ok(journal.findActiveByScore("fishy", "1234"))
    assert.equal(journal.findActiveByScore("kawata", "1234"), undefined)
})

test("records written before the shared queue get their server from source", () => {
    const journal = freshJournal({
        version: 1,
        nextRenderID: 3,
        renders: [
            Object.assign(job({ source: "kawata.pw" }), { renderID: 1, status: "done", progress: "Done", queuePosition: 0, videoFile: null, errorCode: 0, errorMessage: "", removed: false, startedAt: null, finishedAt: null, slot: null, date: "2026-10-01T00:00:00Z", server: undefined }),
            Object.assign(job({ source: "fishy-player" }), { renderID: 2, status: "done", progress: "Done", queuePosition: 0, videoFile: null, errorCode: 0, errorMessage: "", removed: false, startedAt: null, finishedAt: null, slot: null, date: "2026-10-01T00:00:00Z", server: undefined }),
        ],
    })
    assert.equal(journal.get(1).server, "kawata")
    assert.equal(journal.get(2).server, "fishy")
})

test("typical duration: assumed until a render finishes, then the median of finished ones", () => {
    const journal = freshJournal()
    assert.deepEqual(typicalDuration(journal), { seconds: FALLBACK_RENDER_SECONDS, basis: "assumed" })
    for (const seconds of [100, 300, 200]) {
        const r = journal.create(job({}))
        journal.update(r.renderID, { status: "done", startedAt: "2026-10-04T10:00:00Z", finishedAt: new Date(Date.parse("2026-10-04T10:00:00Z") + seconds * 1000).toISOString() })
    }
    assert.deepEqual(typicalDuration(journal), { seconds: 200, basis: "measured" })
})

test("ETA simulates the slots across both servers: running jobs first, then FIFO", () => {
    const journal = freshJournal()
    const typical = { seconds: 200, basis: "measured" }
    const running = journal.create(job({ server: "fishy" }))
    journal.update(running.renderID, { status: "rendering", progress: "Rendering (50%)", startedAt: new Date().toISOString() })
    const a = journal.create(job({ server: "kawata" }))
    const b = journal.create(job({ server: "fishy" }))
    const c = journal.create(job({ server: "kawata" }))
    const eta = etaByRender(journal, 2, typical)
    assert.equal(eta.get(running.renderID), 100, "half of a typical render left")
    assert.equal(eta.get(a.renderID), 200, "the free slot takes the first queued job at once")
    assert.equal(eta.get(b.renderID), 300, "the next one waits for the running job")
    assert.equal(eta.get(c.renderID), 400, "then the slot freed by the first queued job")
})

test("serverCounts names only servers with active jobs", () => {
    const journal = freshJournal()
    journal.create(job({ server: "fishy" }))
    const r = journal.create(job({ server: "kawata" }))
    journal.update(r.renderID, { status: "rendering" })
    const done = journal.create(job({ server: "other" }))
    journal.update(done.renderID, { status: "done" })
    assert.deepEqual(serverCounts(journal), { fishy: { queued: 1, rendering: 0 }, kawata: { queued: 0, rendering: 1 } })
})

/** Serves the real HTTP routes over a stub scheduler; resolves to { base, close }. */
function serve(journal, apiKey) {
    const cfg = { fake: false, apiKey, maxQueue: 20, maxReplayBytes: 1 << 20, danserVersion: "test" }
    const scheduler = {
        slotCount: 2,
        /** FIFO place among queued jobs, 0 otherwise. */
        queuePosition: (r) => (r.status === "queued" ? journal.queued().findIndex((q) => q.renderID === r.renderID) + 1 : 0),
        /** No-op. */
        tick: () => {},
    }
    const server = createServer(cfg, journal, scheduler, () => {})
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
        const { port } = server.address()
        resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })
    }))
}

/** GET a JSON route; resolves to { status, body }. */
function getJson(url, headers) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers: headers || {} }, (res) => {
            let raw = ""
            res.on("data", (c) => (raw += c))
            res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
        }).on("error", reject)
    })
}

test("GET /health shares the per-server load and typical length; GET /queue lists both servers for staff", async () => {
    const journal = freshJournal()
    const r1 = journal.create(job({ server: "fishy", replayUsername: "fish" }))
    journal.update(r1.renderID, { status: "rendering", progress: "Rendering (25%)", startedAt: new Date().toISOString() })
    journal.create(job({ server: "kawata", replayUsername: "kawa", scoreId: "9" }))
    const old = journal.create(job({ server: "kawata" }))
    journal.update(old.renderID, { status: "failed", errorMessage: "map missing", finishedAt: new Date().toISOString() })
    const { base, close } = await serve(journal, "k3y")
    try {
        const health = await getJson(base + "/health")
        assert.equal(health.status, 200)
        assert.deepEqual(health.body.servers, { fishy: { queued: 0, rendering: 1 }, kawata: { queued: 1, rendering: 0 } })
        assert.equal(health.body.maxQueue, 20)
        assert.equal(health.body.typicalBasis, "assumed")

        assert.equal((await getJson(base + "/queue")).status, 401, "the job list needs the key")
        const queue = await getJson(base + "/queue?recent=5", { "x-render-key": "k3y" })
        assert.equal(queue.status, 200)
        assert.deepEqual(queue.body.jobs.map((j) => [j.server, j.status, j.queuePosition]), [["fishy", "rendering", 0], ["kawata", "queued", 1]])
        assert.equal(queue.body.jobs[0].progressPercent, 25)
        assert.ok(queue.body.jobs[1].etaSeconds > 0, "queued jobs carry the shared ETA")
        assert.deepEqual(queue.body.recent.map((j) => [j.server, j.status, j.errorMessage]), [["kawata", "failed", "map missing"]])

        const renders = await getJson(base + "/renders", { "x-render-key": "k3y" })
        const kawataJob = renders.body.renders.find((r) => r.server === "kawata" && r.status === "queued")
        assert.equal(kawataJob.etaBasis, "assumed")
        assert.ok(kawataJob.etaSeconds > 0)
    } finally {
        close()
    }
})
