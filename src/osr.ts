/**
 * The head of an osu! .osr replay: enough to know the ruleset, the mods, who
 * played and which difficulty (by md5). The LZMA frame block is not decoded;
 * danser does that.
 */
export type ReplayHeader = {
    mode: number
    version: number
    beatmapMd5: string
    playerName: string
    replayMd5: string
    mods: number
    timestamp: bigint
    frameBytes: number
    /** Where the LZMA frame block starts in the file (it is frameBytes long). */
    frameOffset: number
}

/** The Autoplay mod bit: autoplay replays are refused (error code 11). */
export const MOD_AUTOPLAY = 1 << 11

/** A replay that cannot be read; `errorCode` is the error code the API reports for it (server.ts submit). */
export class ReplayParseError extends Error {
    /** `errorCode` is the o!rdr error code for this failure (2 = unreadable, 5 = truncated or too small). */
    constructor(
        message: string,
        public readonly errorCode: number
    ) {
        super(message)
    }
}

/**
 * A bounds-checked little-endian cursor over the replay bytes: a read past the end throws a
 * ReplayParseError (code 5).
 */
class Reader {
    private offset = 0
    /** Read `buf` from offset 0. */
    constructor(private readonly buf: Buffer) {}

    /** Bytes read so far. */
    get position(): number {
        return this.offset
    }

    /** Throw a truncated-header error (code 5) unless `n` more bytes remain. */
    private need(n: number): void {
        if (this.offset + n > this.buf.length) throw new ReplayParseError("replay header is truncated", 5)
    }
    /** One unsigned byte. */
    u8(): number {
        this.need(1)
        return this.buf[this.offset++]
    }
    /** An unsigned 16-bit little-endian integer. */
    u16(): number {
        this.need(2)
        const v = this.buf.readUInt16LE(this.offset)
        this.offset += 2
        return v
    }
    /** An unsigned 32-bit little-endian integer. */
    u32(): number {
        this.need(4)
        const v = this.buf.readUInt32LE(this.offset)
        this.offset += 4
        return v
    }
    /** A signed 64-bit little-endian integer (the replay timestamp). */
    i64(): bigint {
        this.need(8)
        const v = this.buf.readBigInt64LE(this.offset)
        this.offset += 8
        return v
    }
    /** A ULEB128 string length of at most five bytes; a longer one is refused (code 2). */
    uleb(): number {
        let result = 0
        let shift = 0
        for (;;) {
            const b = this.u8()
            result |= (b & 0x7f) << shift
            if ((b & 0x80) === 0) return result
            shift += 7
            if (shift > 28) throw new ReplayParseError("bad string length in replay header", 2)
        }
    }
    /**
     * An osu! string: 0x00 for empty, or 0x0b, a ULEB128 byte length and UTF-8 bytes; any other
     * marker is refused (code 2).
     */
    str(): string {
        const marker = this.u8()
        if (marker === 0x00) return ""
        if (marker !== 0x0b) throw new ReplayParseError("bad string marker in replay header", 2)
        const len = this.uleb()
        this.need(len)
        const s = this.buf.toString("utf8", this.offset, this.offset + len)
        this.offset += len
        return s
    }
}

/**
 * Read a .osr header up to the frame block. Refuses a buffer under 32 bytes or a truncated header
 * (code 5), and an unknown ruleset, a bad string or a missing beatmap md5 (code 2). The md5 comes
 * back lower-case.
 */
export function parseReplayHeader(buf: Buffer): ReplayHeader {
    if (buf.length < 32) throw new ReplayParseError("replay file is empty or far too small to be a .osr", 5)
    const r = new Reader(buf)
    const mode = r.u8()
    const version = r.u32()
    const beatmapMd5 = r.str()
    const playerName = r.str()
    const replayMd5 = r.str()
    for (let i = 0; i < 6; i++) r.u16() // 300 / 100 / 50 / geki / katu / miss
    r.u32() // total score
    r.u16() // max combo
    r.u8() // perfect
    const mods = r.u32()
    r.str() // life bar graph
    const timestamp = r.i64()
    const frameBytes = r.u32()
    const frameOffset = r.position
    if (mode > 3) throw new ReplayParseError(`unknown ruleset byte ${mode}`, 2)
    if (!/^[0-9a-f]{32}$/i.test(beatmapMd5)) throw new ReplayParseError("replay carries no beatmap md5", 2)
    return { mode, version, beatmapMd5: beatmapMd5.toLowerCase(), playerName, replayMd5, mods, timestamp, frameBytes, frameOffset }
}
