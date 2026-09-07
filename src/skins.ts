import fs from "fs"
import path from "path"

export type SkinEntry = { id: number; skin: string; presentationName: string }

/**
 * Skins are folders the operator extracts into the skins volume by hand (an
 * .osk is a zip). id 0 is danser's built-in default skin, which needs no
 * folder at all; the rest are numbered in sorted folder order, so ids are
 * stable until a folder is added or removed.
 */
export function listSkins(skinsDir: string): SkinEntry[] {
    const entries: SkinEntry[] = [{ id: 0, skin: "default", presentationName: "Default (danser built-in)" }]
    if (!fs.existsSync(skinsDir)) return entries
    const folders = fs
        .readdirSync(skinsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "default")
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b))
    folders.forEach((folder, i) => {
        entries.push({ id: i + 1, skin: folder, presentationName: readSkinName(path.join(skinsDir, folder)) ?? folder })
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

/** Accepts the folder name, the numeric id, the display name, or nothing (default). */
export function resolveSkin(skinsDir: string, requested: string): string | null {
    const wanted = (requested ?? "").trim()
    if (wanted === "" || wanted === "0" || wanted.toLowerCase() === "default") return "default"
    const skins = listSkins(skinsDir)
    if (/^\d+$/.test(wanted)) {
        const byId = skins.find(s => s.id === Number(wanted))
        if (byId) return byId.skin
    }
    const byFolder = skins.find(s => s.skin === wanted)
    if (byFolder) return byFolder.skin
    const byName = skins.find(s => s.presentationName.toLowerCase() === wanted.toLowerCase())
    return byName ? byName.skin : null
}
