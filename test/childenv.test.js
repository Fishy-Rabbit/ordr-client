// The worker's settings and credentials never reach a child process (added 2026-11-10): danser
// and xz read replays and map sets that callers send, so a crafted input that takes one of them
// over must not find the API keys in its environment. Runs against build/.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")

const { childEnv, onlyEnv } = require("../build/childenv")
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
        XAUTHORITY: "/x", OAUTH_REDIRECT: "x",
        RENDER_API_KEY: "s", RENDER_SCOPED_KEYS: "d", RENDER_MAX_QUEUE: "20", render_api_key: "s", ORDR_API_KEY: "s", API_KEYS: "s",
        GITHUB_TOKEN: "s", DB_PASSWORD: "s", SMTP_PASS: "s", AWS_SECRET_ACCESS_KEY: "s", SOME_CREDENTIALS: "s",
        DOCKER_AUTH_CONFIG: "{}", SSH_AUTH_SOCK: "/run/agent.sock", BASIC_AUTH: "u:p",
        // The long words count inside other words too; AUTHORIZATION is a word of its own.
        AUTHORIZATION: "Bearer s", HTTP_AUTHORIZATION: "Bearer s", CLIENTSECRET: "s", OSU_CLIENTSECRET: "s",
        DBPASSWORD: "s", MYSQL_ROOTPASSWD: "s", APITOKEN: "s", GOOGLE_APPLICATION_CREDENTIALS: "/c.json",
    })
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "KEYBOARD", "LANG", "LD_LIBRARY_PATH", "MONKEY", "OAUTH_REDIRECT", "PASSAGE", "PATH", "XAUTHORITY", "XKB_KEYMAP"])
})

test("onlyEnv keeps the named variables and nothing else", () => {
    const base = { PATH: "/bin", LANG: "C", HOME: "/h", DATABASE_URL: "postgres://u:p@db/x" }
    assert.deepEqual(onlyEnv(["PATH", "LANG", "TZ"], base), { PATH: "/bin", LANG: "C" })
    assert.deepEqual(onlyEnv([], base), {})
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

test("xz reads a replay with PATH alone, so no credential reaches it under any name", async (t) => {
    // The stand-in goes under build/ (gitignored; the tests already run from it), not the temp
    // directory, which some systems mount noexec.
    const dir = fs.mkdtempSync(path.join(__dirname, "..", "build", "childenv-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    // A stand-in xz that prints the environment it was given instead of decompressing.
    const stub = path.join(dir, "xz")
    fs.writeFileSync(stub, "#!/bin/sh\ncat >/dev/null\nenv\n", { mode: 0o755 })
    // DATABASE_URL carries a password under a name no credential filter would catch.
    withEnv(t, { RENDER_API_KEY: "staff-secret", DATABASE_URL: "postgres://render:hunter2@db/x" })
    // A real frame block: decompressFrames refuses anything shorter than the 13-byte LZMA header
    // before it starts xz at all.
    const frames = fs.readFileSync(path.join(__dirname, "fixtures", "frames-30s.lzma"))
    const out = await decompressFrames(frames, { xzPath: stub })
    assert.ok(out !== null, `the stand-in xz in ${dir} did not run or failed; a directory mounted noexec is one cause`)
    assert.match(out, /^PATH=/m, "the stand-in printed its environment")
    assert.doesNotMatch(out, /RENDER_API_KEY|staff-secret|DATABASE_URL|hunter2/)
})
