// The .osr header reader's string lengths. Runs against build/.
//
// A string length is a ULEB128 of at most five bytes. Until 2026-11-10 it was built with `<<`
// and `|=`, which work on signed 32-bit integers, so a fifth byte with its high bits set made the
// length negative: the bounds check passed and the cursor moved backwards, and the next read
// failed with a RangeError instead of a ReplayParseError (or re-read earlier bytes).
const test = require("node:test")
const assert = require("node:assert/strict")

const { parseReplayHeader, ReplayParseError } = require("../build/osr")

/** Mode 0, a version, two empty strings, then the replay md5 string with these raw ULEB bytes. */
function headerWithLength(ulebBytes) {
    const version = Buffer.alloc(4)
    version.writeUInt32LE(20251102)
    return Buffer.concat([Buffer.from([0]), version, Buffer.from([0x00, 0x00, 0x0b]), Buffer.from(ulebBytes), Buffer.alloc(64, 0x30)])
}

/** True when `fn` throws a ReplayParseError with this error code. */
function refusedWith(code) {
    return (err) => err instanceof ReplayParseError && err.errorCode === code
}

test("a five-byte length with the high bits set is a length past the end (code 5), never negative", () => {
    // 0x80 0x80 0x80 0x80 0x08 is 2^31: as a signed 32-bit value it was -2^31.
    assert.throws(() => parseReplayHeader(headerWithLength([0x80, 0x80, 0x80, 0x80, 0x08])), refusedWith(5))
    // 0xff 0xff 0xff 0xff 0x0f is 2^32 - 1: it was -1.
    assert.throws(() => parseReplayHeader(headerWithLength([0xff, 0xff, 0xff, 0xff, 0x0f])), refusedWith(5))
    // 0xff 0xff 0xff 0xff 0x7f is the largest five-byte value, 2^35 - 1.
    assert.throws(() => parseReplayHeader(headerWithLength([0xff, 0xff, 0xff, 0xff, 0x7f])), refusedWith(5))
})

test("a length longer than five bytes is refused as unreadable (code 2)", () => {
    assert.throws(() => parseReplayHeader(headerWithLength([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), refusedWith(2))
})

test("a multi-byte length that fits is read normally", () => {
    // 200 = 0xc8 0x01: the string is 200 bytes, then the header goes on (and here runs out: code 5).
    const buf = Buffer.concat([headerWithLength([0xc8, 0x01]).subarray(0, 10), Buffer.alloc(200, 0x61)])
    assert.throws(() => parseReplayHeader(buf), refusedWith(5))
    const md5 = "0123456789abcdef0123456789abcdef"
    const u16 = Buffer.alloc(2)
    const u32 = Buffer.alloc(4)
    const full = Buffer.concat([
        Buffer.from([0]), u32, Buffer.from([0x0b, 32]), Buffer.from(md5), Buffer.from([0x0b, 0xc8, 0x01]), Buffer.alloc(200, 0x61), Buffer.from([0x00]),
        u16, u16, u16, u16, u16, u16, u32, u16, Buffer.from([1]), u32, Buffer.from([0x00]), Buffer.alloc(8), u32,
    ])
    const header = parseReplayHeader(full)
    assert.equal(header.beatmapMd5, md5)
    assert.equal(header.playerName, "a".repeat(200))
    assert.equal(header.frameOffset, full.length)
})
