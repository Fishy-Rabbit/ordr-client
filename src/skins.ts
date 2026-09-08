import fs from "fs"
import path from "path"

export type SkinEntry = {
    id: number
    /** The wire value a client sends back as `skin` in `POST /renders`. */
    skin: string
    presentationName: string
    /** For the two aliases (`default`, `danser`): the danser skin name they resolve to. */
    resolvesTo?: string
}

/** danser's own name for its embedded skin (no folder needed). */
export const DANSER_BUILTIN = "default"
/** The wire value meaning "the server default": `RENDER_DEFAULT_SKIN` when set, else the built-in. */
export const WIRE_DEFAULT = "default"
/** The wire value that always means danser's built-in skin, whatever the server default is. */
export const WIRE_DANSER = "danser"

/**
 * The configured default skin, or null when none is configured or its folder
 * is not (or no longer) in the skins volume. Checked on every call on purpose:
 * the operator provisions skin folders by hand while the worker runs, and a
 * default that was missing at boot becomes live the moment its folder lands.
 */
export function defaultSkinFolder(skinsDir: string, defaultSkin: string): string | null {
    const name = (defaultSkin ?? "").trim()
    if (name === "" || name === DANSER_BUILTIN || name === WIRE_DANSER || name.includes("/") || name.includes("\\")) return null
    try {
        return fs.statSync(path.join(skinsDir, name)).isDirectory() ? name : null
    } catch {
        return null
    }
}

/**
 * Skins are folders the operator extracts into the skins volume by hand (an
 * .osk is a zip). Entry 0 is always the wire value `default`: the server
 * default (`RENDER_DEFAULT_SKIN`) when one is configured and present, else
 * danser's built-in. When a server default exists, entry 1 is `danser`, the
 * built-in under its own name, so it stays pickable. The folders follow in
 * sorted order (the default folder included under its own name, so a pick
 * survives the default moving elsewhere); their ids are stable until a folder
 * is added or removed.
 */
export function listSkins(skinsDir: string, defaultSkin = ""): SkinEntry[] {
    const def = defaultSkinFolder(skinsDir, defaultSkin)
    const entries: SkinEntry[] = []
    if (def) {
        entries.push({ id: 0, skin: WIRE_DEFAULT, presentationName: `Server default: ${readSkinName(path.join(skinsDir, def)) ?? def}`, resolvesTo: def })
        entries.push({ id: 1, skin: WIRE_DANSER, presentationName: "Default (danser built-in)", resolvesTo: DANSER_BUILTIN })
    } else {
        entries.push({ id: 0, skin: WIRE_DEFAULT, presentationName: "Default (danser built-in)", resolvesTo: DANSER_BUILTIN })
    }
    if (!fs.existsSync(skinsDir)) return entries
    const folders = fs
        .readdirSync(skinsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== DANSER_BUILTIN && d.name !== WIRE_DANSER)
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
    const firstId = entries.length
    folders.forEach((folder, i) => {
        entries.push({ id: firstId + i, skin: folder, presentationName: readSkinName(path.join(skinsDir, folder)) ?? folder })
    })
    return entries
}

function readSkinName(folder: string): string | null {
    const ini = path.join(folder, "skin.ini")
    try {
        const fd = fs.openSync(ini, "r")
        const buf = Buffer.alloc(8192)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        fs.closeSync(fd)
        const match = buf.toString("utf8", 0, n).match(/^\s*Name\s*:\s*(.+?)\s*$/m)
        return match ? match[1] : null
    } catch {
        return null
    }
}

/**
 * Turns a client's `skin` value into the folder name danser is given
 * (`Skin.CurrentSkin`), or null when nothing matches. Accepts the wire
 * aliases (`default` = server default, `danser` = built-in), a numeric id or
 * display name from `/skins`, a folder name, or nothing (= `default`). The
 * return value is what the render record stores, so `GET /renders` reports
 * the skin danser actually used rather than the alias the panel sent.
 */
export function resolveSkin(skinsDir: string, requested: string, defaultSkin = ""): string | null {
    const wanted = (requested ?? "").trim()
    const lower = wanted.toLowerCase()
    if (wanted === "" || wanted === "0" || lower === WIRE_DEFAULT) return defaultSkinFolder(skinsDir, defaultSkin) ?? DANSER_BUILTIN
    if (lower === WIRE_DANSER) return DANSER_BUILTIN
    const skins = listSkins(skinsDir, defaultSkin)
    const folderOf = (entry: SkinEntry): string => entry.resolvesTo ?? entry.skin
    if (/^\d+$/.test(wanted)) {
        const byId = skins.find(s => s.id === Number(wanted))
        if (byId) return folderOf(byId)
    }
    const byFolder = skins.find(s => s.skin === wanted)
    if (byFolder) return folderOf(byFolder)
    const byName = skins.find(s => s.presentationName.toLowerCase() === lower)
    return byName ? folderOf(byName) : null
}
