// The worker's settings and credentials never reach a child process (added 2026-11-10): danser
// and xz read replays and map sets that callers send, so a crafted input that takes one of them
// over must not find the API keys in its environment. Runs against build/.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")

const { childEnv } = require("../build/childenv")
const { slotEnv } = require("../build/job")
const { decompressFrames } = require("../build/playlength")

/** Set environment variables for this test only; the previous values come back when it ends. */
function withEnv(t, vars) {
    const before = {}
    for (const [name, value] of Object.entries(vars)) {
        before[name] = process.env[name]
        process.env[name] = value
    }
    t.after(() => {
        for (const [name, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })
}

test("childEnv drops the worker's settings and anything that reads as a credential, and keeps the rest", () => {
    const env = childEnv({
        PATH: "/bin", HOME: "/h", LANG: "C.UTF-8", LD_LIBRARY_PATH: "/l", XKB_KEYMAP: "us", KEYBOARD: "x", MONKEY: "1", PASSAGE: "1",
        RENDER_API_KEY: "s", RENDER_SCOPED_KEYS: "d", RENDER_MAX_QUEUE: "20", render_api_key: "s", ORDR_API_KEY: "s", API_KEYS: "s",
        GITHUB_TOKEN: "s", DB_PASSWORD: "s", SMTP_PASS: "s", AWS_SECRET_ACCESS_KEY: "s", SOME_CREDENTIALS: "s",
    })
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "KEYBOARD", "LANG", "LD_LIBRARY_PATH", "MONKEY", "PASSAGE", "PATH", "XKB_KEYMAP"])
})

test("danser's slot environment carries no worker key", (t) => {
    withEnv(t, { RENDER_API_KEY: "staff-secret", RENDER_SCOPED_KEYS: "hinai=abc" })
    const env = slotEnv({ threadsPerSlot: 2 }, { index: 0, display: ":99", root: "/r", danserDir: "/d", songsDir: "/s", videosDir: "/v" })
    assert.equal(env.RENDER_API_KEY, undefined)
    assert.equal(env.RENDER_SCOPED_KEYS, undefined)
    assert.equal(env.DISPLAY, ":99")
    assert.equal(env.LP_NUM_THREADS, "2")
    assert.equal(env.HOME, "/r")
    assert.equal(env.PATH, process.env.PATH, "the rest of the environment passes through")
})

test("xz reads a replay without the worker's keys in its environment", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "childenv-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    // A stand-in xz that prints the environment it was given instead of decompressing.
    const stub = path.join(dir, "xz")
    fs.writeFileSync(stub, "#!/bin/sh\ncat >/dev/null\nenv\n", { mode: 0o755 })
    withEnv(t, { RENDER_API_KEY: "staff-secret" })
    // A real frame block: decompressFrames refuses anything shorter than the 13-byte LZMA header
    // before it starts xz at all.
    const frames = fs.readFileSync(path.join(__dirname, "fixtures", "frames-30s.lzma"))
    const out = await decompressFrames(frames, { xzPath: stub })
    assert.ok(out !== null && /^PATH=/m.test(out), "the stand-in ran and printed its environment")
    assert.doesNotMatch(out, /RENDER_API_KEY|staff-secret/)
})
