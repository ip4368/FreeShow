// ----- FreeShow -----
// Bootstrap media-path remapping (pure, no fs).
//
// Local desktop libraries store ABSOLUTE media paths (e.g. /Users/x/Documents/FreeShow/Media/a.mp4
// or C:\Users\x\Documents\FreeShow\Media\a.mp4), while the headless server only serves
// SANDBOX-RELATIVE paths (e.g. Media/a.mp4). A bootstrap must therefore rewrite every media
// reference before the library can play on the server.
//
// Mapping rule (toServerRelative):
//   - already-relative cacheable paths pass through normalized (posix separators)
//   - absolute paths inside the local data root become data-root-relative (structure preserved)
//   - absolute paths OUTSIDE the data root land in the user-chosen destination folder by
//     basename — audio files in the audio destination (default "Audio"), everything else
//     in the media destination (default "Media"), so each drawer finds its own files
//
// Rewrite traversal mirrors collectShowMedia.ts exactly — every field it collects from is
// rewritten here. Media-map indirection is preserved: ID-shaped values that resolve in
// show.media are left alone (the media entry itself is rewritten); only genuinely
// path-shaped values are remapped.

import { isCacheableMediaPath } from "./collectShowMedia"

export type RemapFn = (oldPath: string) => string | null

function stripFileProtocol(p: string): string {
    let out = (p || "").trim()
    if (out.startsWith("file://")) out = out.slice("file://".length)
    return out
}

function toPosix(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}

function isAbsolutePath(p: string): boolean {
    const s = stripFileProtocol(p)
    if (!s) return false
    if (s.startsWith("/")) return true
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true
    if (s.startsWith("\\\\")) return true
    return false
}

// Audio extensions the server can serve (mirrors MEDIA_MIME audio keys in
// src/server/headless/mediaRoutes.ts — the authority for what is playable).
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "weba"])

function cleanFolder(folder: string | undefined, fallback: string): string {
    return toPosix((folder || fallback).trim() || fallback).replace(/^\/+|\/+$/g, "") || fallback
}

/**
 * Map a local media path to its server-relative destination.
 * Returns null when the value is not a mappable library path (streams, embedded, ids).
 */
export function toServerRelative(localPath: string, dataRoot: string, destFolder: string, audioDestFolder = "Audio"): string | null {
    if (!isCacheableMediaPath(localPath)) return null
    const stripped = stripFileProtocol(String(localPath)).split("?")[0]
    const dest = cleanFolder(destFolder, "Media")
    const audioDest = cleanFolder(audioDestFolder, "Audio")

    if (!isAbsolutePath(stripped)) {
        // already relative — normalize separators, strip leading ./, never emit absolute
        const rel = toPosix(stripped)
            .replace(/^\.\/+/, "")
            .replace(/^\/+/, "")
        return rel || null
    }

    // absolute: preserve structure when inside the data root
    const root = toPosix(stripFileProtocol(dataRoot)).replace(/\/+$/, "")
    const abs = toPosix(stripped)
    const rootLower = root.toLowerCase()
    const absLower = abs.toLowerCase()
    // drive-letter case-insensitive compare on Windows-style paths
    if (root && (absLower === rootLower || absLower.startsWith(rootLower + "/"))) {
        const rel = abs.slice(root.length).replace(/^\/+/, "")
        return rel || null
    }

    // outside the data root — flatten into the destination folder by basename
    const base = abs.split("/").filter(Boolean).pop() || ""
    if (!base) return null
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : ""
    if (AUDIO_EXTENSIONS.has(ext)) return `${audioDest}/${base}`
    return `${dest}/${base}`
}

/** Apply remap to a single string field in place; records the mapping. */
function rewriteField(holder: any, key: string, remap: RemapFn, mappings: [string, string][]): void {
    const value = holder?.[key]
    if (typeof value !== "string" || !value) return
    if (!isCacheableMediaPath(value)) return
    const next = remap(value)
    if (typeof next === "string" && next && next !== value) {
        mappings.push([value, next])
        holder[key] = next
    }
}

/** Rewrite legacy Item.media storage (string id/path or {path,src} object). */
function rewriteItemMedia(item: any, media: any, remap: RemapFn, mappings: [string, string][]): void {
    if (!item) return
    const legacy: any = item.media
    if (typeof legacy === "string") {
        if (legacy && media?.[legacy]) return // media-map id — the entry itself is rewritten
        if (!isCacheableMediaPath(legacy)) return
        const next = remap(legacy)
        if (typeof next === "string" && next && next !== legacy) {
            mappings.push([legacy, next])
            item.media = next
        }
        return
    }
    if (legacy && typeof legacy === "object") {
        rewriteField(legacy, "path", remap, mappings)
        rewriteField(legacy, "src", remap, mappings)
    }
}

function rewriteItems(items: any[] | undefined, media: any, remap: RemapFn, mappings: [string, string][]): void {
    if (!Array.isArray(items)) return
    for (const item of items) {
        if (!item) continue
        rewriteField(item, "src", remap, mappings)
        rewriteItemMedia(item, media, remap, mappings)
    }
}

function rewriteTimelineActions(actions: any[] | undefined, remap: RemapFn, mappings: [string, string][]): void {
    if (!Array.isArray(actions)) return
    for (const action of actions) {
        const data = action?.data
        if (data && typeof data === "object") rewriteField(data, "path", remap, mappings)
    }
}

/**
 * Rewrite layout slide-data background/audio ids that are actually paths.
 * IDs resolving in show.media are media-map references (left alone); anything else
 * path-shaped is rewritten in place (mirrors collectSlideDataMediaIds traversal).
 */
function rewriteSlideDataIds(slideData: any, media: any, remap: RemapFn, mappings: [string, string][]): void {
    if (!slideData) return
    const bg = slideData.background
    if (typeof bg === "string" && bg && !media?.[bg] && isCacheableMediaPath(bg)) {
        const next = remap(bg)
        if (typeof next === "string" && next && next !== bg) {
            mappings.push([bg, next])
            slideData.background = next
        }
    }
    if (Array.isArray(slideData.audio)) {
        for (let i = 0; i < slideData.audio.length; i++) {
            const id = slideData.audio[i]
            if (typeof id !== "string" || !id || media?.[id] || !isCacheableMediaPath(id)) continue
            const next = remap(id)
            if (typeof next === "string" && next && next !== id) {
                mappings.push([id, next])
                slideData.audio[i] = next
            }
        }
    }
    const children = slideData.children
    if (children && typeof children === "object" && !Array.isArray(children)) {
        for (const child of Object.values(children)) rewriteSlideDataIds(child, media, remap, mappings)
    }
}

export interface RewriteResult<T> {
    value: T
    rewritten: number
    mappings: [string, string][]
}

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))

/** Rewrite every media path inside a single show (pure — input untouched). */
export function rewriteShowMediaPaths(show: any, remap: RemapFn): RewriteResult<any> {
    if (!show || typeof show !== "object") return { value: show, rewritten: 0, mappings: [] }
    const out = clone(show)
    const mappings: [string, string][] = []
    const media = out.media

    // slides: background + items + timeline
    for (const slide of Object.values<any>(out.slides || {})) {
        if (!slide) continue
        const bg = slide.settings?.backgroundImage
        if (typeof bg === "string" && bg && !media?.[bg]) rewriteField(slide.settings, "backgroundImage", remap, mappings)
        rewriteItems(slide.items, media, remap, mappings)
        // item.media-as-id resolving in the map is covered by the media entries below
        rewriteTimelineActions(slide.timeline?.actions, remap, mappings)
    }

    // layouts: timeline + slide-data ids
    for (const layout of Object.values<any>(out.layouts || {})) {
        if (!layout) continue
        rewriteTimelineActions(layout.timeline?.actions, remap, mappings)
        for (const slideData of layout.slides || []) rewriteSlideDataIds(slideData, media, remap, mappings)
    }

    // media map entries (the indirection targets themselves)
    if (media && typeof media === "object") {
        for (const entry of Object.values<any>(media)) {
            if (!entry || typeof entry !== "object") continue
            if (typeof entry.path === "string" && entry.path) rewriteField(entry, "path", remap, mappings)
            else if (typeof entry.id === "string" && entry.id) rewriteField(entry, "id", remap, mappings)
        }
    }

    // custom fonts
    for (const font of out.settings?.customFonts || []) {
        if (font && typeof font === "object") rewriteField(font, "path", remap, mappings)
    }

    return { value: out, rewritten: mappings.length, mappings }
}

/** Rewrite overlay items (pure). */
export function rewriteOverlayMediaPaths(overlay: any, remap: RemapFn): RewriteResult<any> {
    if (!overlay || typeof overlay !== "object") return { value: overlay, rewritten: 0, mappings: [] }
    const out = clone(overlay)
    const mappings: [string, string][] = []
    rewriteItems(out.items, undefined, remap, mappings)
    return { value: out, rewritten: mappings.length, mappings }
}

/** Rewrite template background + items + overlay refs stay as ids (pure). */
export function rewriteTemplateMediaPaths(template: any, remap: RemapFn): RewriteResult<any> {
    if (!template || typeof template !== "object") return { value: template, rewritten: 0, mappings: [] }
    const out = clone(template)
    const mappings: [string, string][] = []
    if (out.settings && typeof out.settings === "object") rewriteField(out.settings, "backgroundPath", remap, mappings)
    rewriteItems(out.items, undefined, remap, mappings)
    return { value: out, rewritten: mappings.length, mappings }
}

const DIRECT_MEDIA_TYPES = new Set(["image", "video", "audio", "pdf", "ppt"])

/** Rewrite direct media refs inside a project (pure). Show refs (by id) are untouched. */
export function rewriteProjectMediaPaths(project: any, remap: RemapFn): RewriteResult<any> {
    if (!project || typeof project !== "object") return { value: project, rewritten: 0, mappings: [] }
    const out = clone(project)
    const mappings: [string, string][] = []
    for (const ref of out.shows || []) {
        if (!ref || typeof ref.id !== "string") continue
        const isDirect = (ref.type && DIRECT_MEDIA_TYPES.has(ref.type)) || (!ref.type && isCacheableMediaPath(ref.id))
        if (!isDirect || !isCacheableMediaPath(ref.id)) continue
        const next = remap(ref.id)
        if (typeof next === "string" && next && next !== ref.id) {
            mappings.push([ref.id, next])
            ref.id = next
        }
    }
    rewriteTimelineActions(out.timeline?.actions, remap, mappings)
    return { value: out, rewritten: mappings.length, mappings }
}
