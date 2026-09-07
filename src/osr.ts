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
}

export const MOD_AUTOPLAY = 1 << 11

export class ReplayParseError extends Error {
    constructor(
        message: string,
        public readonly errorCode: number
    ) {
        super(message)
    }
}

class Reader {
    private offset = 0
    constructor(private readonly buf: Buffer) {}

    private need(n: number): void {
        if (this.offset + n > this.buf.length) throw new ReplayParseError("replay header is truncated", 5)
    }
    u8(): number {
        this.need(1)
        return this.buf[this.offset++]
    }
    u16(): number {
        this.need(2)
        const v = this.buf.readUInt16LE(this.offset)
        this.offset += 2
        return v
    }
    u32(): number {
        this.need(4)
        const v = this.buf.readUInt32LE(this.offset)
        this.offset += 4
        return v
    }
    i64(): bigint {
        this.need(8)
        const v = this.buf.readBigInt64LE(this.offset)
        this.offset += 8
        return v
    }
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
    if (mode > 3) throw new ReplayParseError(`unknown ruleset byte ${mode}`, 2)
    if (!/^[0-9a-f]{32}$/i.test(beatmapMd5)) throw new ReplayParseError("replay carries no beatmap md5", 2)
    return { mode, version, beatmapMd5: beatmapMd5.toLowerCase(), playerName, replayMd5, mods, timestamp, frameBytes }
}
