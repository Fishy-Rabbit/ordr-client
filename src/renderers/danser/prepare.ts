/*
 * Adapted from the o!rdr client (MasterIO02/ordr-client, src/renderers/danser/prepare.ts)
 * Copyright (c) 2025, issou.best and contributors. BSD-3-Clause; see LICENSE.
 *
 * The 55-option job mapping of the original is reduced to the eight options
 * this worker's clients send; every other danser knob keeps the value o!rdr
 * used for its default renders, so the output looks like an o!rdr video.
 */
import fs from "fs"
import path from "path"
import { Preset } from "../../config"

export type RenderOptions = {
    showPPCounter: boolean
    showHitErrorMeter: boolean
    showResultScreen: boolean
    showDanserLogo: boolean
    loadVideo: boolean
    loadStoryboard: boolean
    inGameBGDim: number
    cursorSize: number
}

export const DEFAULT_OPTIONS: RenderOptions = {
    showPPCounter: true,
    showHitErrorMeter: true,
    showResultScreen: true,
    showDanserLogo: true,
    loadVideo: true,
    loadStoryboard: true,
    inGameBGDim: 75,
    cursorSize: 1
}

export type Json = Record<string, unknown>

function set(root: Json, dotted: string, value: unknown): void {
    const parts = dotted.split(".")
    let node: Json = root
    for (let i = 0; i < parts.length - 1; i++) {
        const next = node[parts[i]]
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            node[parts[i]] = {}
        }
        node = node[parts[i]] as Json
    }
    node[parts[parts.length - 1]] = value
}

export type SettingsArgs = {
    songsDir: string
    skinsDir: string
    outputDir: string
    preset: Preset
    options: RenderOptions
    skin: string
}

/**
 * Build the per-render danser settings document. `base` is the defaults file
 * danser itself generated at boot (or `{}`: danser fills any key we leave out
 * with its own default when it loads the file).
 */
export function buildDanserSettings(base: Json, args: SettingsArgs): Json {
    const s = structuredClone(base)
    const { preset, options: o } = args

    set(s, "General.OsuSongsDir", args.songsDir)
    set(s, "General.OsuSkinsDir", args.skinsDir)
    set(s, "Recording.OutputDir", args.outputDir)

    set(s, "Recording.FrameWidth", preset.width)
    set(s, "Recording.FrameHeight", preset.height)
    set(s, "Recording.FPS", preset.fps)
    set(s, "Recording.Filters", "")
    set(s, "Recording.MotionBlur.Enabled", false)

    // CPU encoder only: the same libx264 profile o!rdr's "cpu" renderers use.
    set(s, "Recording.Encoder", "libx264")
    set(s, "Recording.libx264.CRF", preset.turbo ? 51 : 21)
    set(s, "Recording.libx264.Preset", preset.turbo ? "ultrafast" : "faster")
    set(s, "Recording.libx264.AdditionalOptions", "-g 450")
    set(s, "Recording.AudioCodec", "aac")
    set(s, "Recording.aac.Bitrate", preset.turbo ? "24k" : "160k")

    // o!rdr's default mix: 50% master, music and hitsounds.
    set(s, "Audio.GeneralVolume", 0.5)
    set(s, "Audio.MusicVolume", 0.5)
    set(s, "Audio.SampleVolume", 0.5)
    set(s, "Audio.IgnoreBeatmapSamples", false)
    set(s, "Audio.PlayNightcoreSamples", true)
    set(s, "Audio.OnlineOffset", false)

    set(s, "Gameplay.IgnoreFailsInReplays", false)
    set(s, "Gameplay.HitErrorMeter.Show", o.showHitErrorMeter)
    set(s, "Gameplay.HitErrorMeter.ShowUnstableRate", true)
    set(s, "Gameplay.Score.Show", true)
    set(s, "Gameplay.HpBar.Show", true)
    set(s, "Gameplay.ComboCounter.Show", true)
    set(s, "Gameplay.KeyOverlay.Show", true)
    // No scoreboard: it would need the osu! API, which this worker never talks to.
    set(s, "Gameplay.ScoreBoard.Show", false)
    set(s, "Gameplay.ScoreBoard.HideOthers", true)
    set(s, "Gameplay.ScoreBoard.ShowAvatars", false)
    set(s, "Gameplay.PPCounter.Show", o.showPPCounter)
    set(s, "Gameplay.PPCounter.Align", "TopLeft")
    set(s, "Gameplay.HitCounter.Show", false)
    set(s, "Gameplay.HitCounter.ShowSliderBreaks", false)
    set(s, "Gameplay.AimErrorMeter.Show", false)
    set(s, "Gameplay.StrainGraph.Show", false)
    set(s, "Gameplay.Boundaries.Enabled", true)
    set(s, "Gameplay.Mods.Show", true)
    set(s, "Gameplay.ShowResultsScreen", o.showResultScreen)

    set(s, "Skin.CurrentSkin", args.skin)
    set(s, "Skin.FallbackSkin", "default")
    set(s, "Skin.UseBeatmapColors", true)
    set(s, "Skin.UseColorsFromSkin", true)
    set(s, "Skin.Cursor.UseSkinCursor", true)
    set(s, "Skin.Cursor.Scale", o.cursorSize)
    set(s, "Skin.Cursor.ForceLongTrail", false)
    set(s, "Skin.Cursor.LongTrailDensity", 1)
    set(s, "Skin.Cursor.LongTrailLength", 2048)

    set(s, "Cursor.ScaleToCS", false)
    set(s, "Cursor.Colors.EnableRainbow", false)
    set(s, "Cursor.EnableTrailGlow", true)
    set(s, "Cursor.CursorRipples", false)

    set(s, "Objects.DrawFollowPoints", true)
    set(s, "Objects.DrawComboNumbers", true)
    set(s, "Objects.ScaleToTheBeat", false)
    set(s, "Objects.Sliders.SliderMerge", false)
    set(s, "Objects.Sliders.Snaking.In", true)
    set(s, "Objects.Sliders.Snaking.Out", true)
    set(s, "Objects.Colors.Sliders.Border.Color.FlashToTheBeat", false)
    set(s, "Objects.Colors.Sliders.Body.Color.FlashToTheBeat", false)
    set(s, "Objects.Colors.Sliders.Body.UseHitCircleColor", true)

    set(s, "Playfield.Background.FlashToTheBeat", false)
    set(s, "Playfield.SeizureWarning.Enabled", false)
    set(s, "Playfield.Background.LoadStoryboards", o.loadStoryboard)
    set(s, "Playfield.Background.LoadVideos", o.loadVideo)
    set(s, "Playfield.Background.Dim.Intro", 0)
    set(s, "Playfield.Background.Dim.Normal", Math.min(100, Math.max(0, o.inGameBGDim)) / 100)
    set(s, "Playfield.Background.Dim.Breaks", 0.3)
    set(s, "Playfield.Background.Parallax.Amount", 0)
    set(s, "Playfield.Logo.Dim.Intro", o.showDanserLogo ? 0 : 1)
    set(s, "Playfield.OsuShift", true)

    return s
}

/** Write `settings/<name>.json` inside a slot's private danser directory. */
export function writeSlotSettings(danserDir: string, name: string, settings: Json): string {
    const dir = path.join(danserDir, "settings")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${name}.json`)
    fs.writeFileSync(file, JSON.stringify(settings, null, 1), "utf-8")
    return file
}
