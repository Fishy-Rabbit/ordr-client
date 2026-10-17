/*
 * Windowed renders: the optional `start`/`end` request fields, the danser
 * flags they become, and the option a windowed render forces.
 *
 * Times are whole seconds of song position (map time: the clock the replay
 * frames, josu's SEEK and the hit timing chart use; with DT or NC it is not
 * the video's own clock). danser drops every hit object outside the window
 * before playback, so a windowed clip's score, combo and pp counters restart
 * at the window and its results screen would show a score that never
 * happened: a windowed render never shows it.
 */
import type { RenderOptions } from "./renderers/danser/prepare"

export type RenderWindow = { start: number; end: number }

/** The latest `end` accepted: a day of song time, far past any beatmap. */
export const MAX_WINDOW_END_SECONDS = 86400

export type WindowParse = { ok: true; window: RenderWindow | null } | { ok: false; message: string }

const WHOLE_SECONDS = /^\d{1,5}$/

/** Read the two multipart fields: blank or absent = no window; both or neither; whole seconds; 0 <= start < end <= a day. */
export function parseRenderWindow(startRaw: string | undefined, endRaw: string | undefined): WindowParse {
    const start = (startRaw ?? "").trim()
    const end = (endRaw ?? "").trim()
    if (start === "" && end === "") return { ok: true, window: null }
    if (start === "" || end === "") return { ok: false, message: "start and end go together: send both or neither" }
    if (!WHOLE_SECONDS.test(start) || !WHOLE_SECONDS.test(end)) return { ok: false, message: "start and end must be whole seconds" }
    const s = Number(start)
    const e = Number(end)
    if (s >= e) return { ok: false, message: `start (${s}) must be before end (${e})` }
    if (e > MAX_WINDOW_END_SECONDS) return { ok: false, message: `end must be at most ${MAX_WINDOW_END_SECONDS} seconds` }
    return { ok: true, window: { start: s, end: e } }
}

/** danser's own flags for a window (float64 seconds in danser 0.11.0); none for a full render. */
export function windowArgs(window: RenderWindow | null): string[] {
    return window ? [`-start=${window.start}`, `-end=${window.end}`] : []
}

/** The options danser is given: a windowed render never shows the results screen. Never mutates `options`. */
export function windowedOptions(options: RenderOptions, window: RenderWindow | null): RenderOptions {
    return window ? { ...options, showResultScreen: false } : options
}
