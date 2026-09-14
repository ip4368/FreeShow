// ----- FreeShow -----
// Collect every library-media file path a show / project needs for playback.
// Used by the remote-media cache to prefetch a whole project (or show) at open
// time, so a low-bandwidth client can play from its local disk instead of
// streaming every file from the server's /media gateway.
//
// Pure + dependency-free (no Electron / Svelte) so it runs in the Electron main
// process, the headless server, the frontend, and unit tests.

import type { Project, ProjectShowRef } from "../../types/Projects"
import type { Item, Media, Overlays, Show, Shows, Templates } from "../../types/Show"

// Project item types whose `id` IS a media file path (added via "add files to project").
const DIRECT_MEDIA_TYPES = new Set(["image", "video", "audio", "pdf", "ppt"])

/** Strings that are never library-media paths (streams, embedded data, protected urls). */
export function isCacheableMediaPath(value: unknown): value is string {
    if (typeof value !== "string") return false
    const p = value.trim()
    if (!p) return false
    const lower = p.toLowerCase()
    if (lower.startsWith("http://") || lower.startsWith("https://")) return false
    if (lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("freeshow-protected://")) return false
    // gateway URLs are resolved paths, not library paths — unwrap instead of caching as-is
    if (/(^|\/)(media|thumbnail)\?path=/.test(p)) return false
    // strip a query string before the path-likeness check (?v= cache-busters etc.)
    const bare = p.split("?")[0]
    // camera / screen / ndi ids and overlay/template/media ids are not file paths:
    // require something path-like (a separator or a file extension)
    if (!bare.includes("/") && !bare.includes("\\") && !/\.[a-z0-9]{2,5}$/i.test(bare)) return false
    return true
}

function addPath(into: Set<string>, value: unknown) {
    if (isCacheableMediaPath(value)) into.add(value)
}

/** show.media[id] holds the file in `path` (older shows: `id`). */
function mediaEntryPath(entry: Media | undefined): string {
    if (!entry) return ""
    if (typeof entry.path === "string" && entry.path) return entry.path
    if (typeof entry.id === "string" && entry.id) return entry.id
    return ""
}

function collectFromItems(into: Set<string>, items: Item[] | undefined) {
    if (!Array.isArray(items)) return
    for (const item of items) {
        if (!item) continue
        addPath(into, item.src)
        // Item.media is untyped legacy storage; pick up a path if one is stored there
        const legacy: any = (item as any).media
        if (typeof legacy === "string") addPath(into, legacy)
        else if (legacy && typeof legacy === "object") {
            addPath(into, legacy.path)
            addPath(into, legacy.src)
        }
    }
}

function collectFromShowMedia(into: Set<string>, media: Show["media"] | undefined) {
    if (!media) return
    for (const entry of Object.values(media)) addPath(into, mediaEntryPath(entry))
}

export interface ShowCollectorContext {
    overlays?: Overlays
    templates?: Templates
}

/**
 * Every media file a single show can reference during playback:
 * slide backgrounds (direct path + media-id indirection + ghost fallback), media
 * items, layout audio/backgrounds, timeline audio, referenced overlays/templates.
 */
export function collectMediaPathsFromShow(show: Show | undefined | null, ctx: ShowCollectorContext = {}): string[] {
    const out = new Set<string>()
    if (!show) return []

    collectFromShowMedia(out, show.media)

    // slides: direct background image + media items
    for (const slide of Object.values(show.slides || {})) {
        if (!slide) continue
        addPath(out, slide.settings?.backgroundImage)
        collectFromItems(out, slide.items)
        // timeline audio actions reference a file path directly
        for (const action of slide.timeline?.actions || []) addPath(out, (action as any)?.data?.path)
    }

    // layouts: background/audio are MEDIA IDs into show.media; overlays are
    // OVERLAY IDs into the global overlays store
    for (const layout of Object.values(show.layouts || {})) {
        if (!layout) continue
        for (const action of layout.timeline?.actions || []) addPath(out, (action as any)?.data?.path)
        for (const slideData of layout.slides || []) {
            if (!slideData) continue
            if (slideData.background) {
                const resolved = mediaEntryPath(show.media?.[slideData.background])
                if (resolved) addPath(out, resolved)
                else addPath(out, slideData.background) // already a path (defensive)
            }
            for (const audioId of slideData.audio || []) {
                const resolved = mediaEntryPath(show.media?.[audioId])
                if (resolved) addPath(out, resolved)
                else addPath(out, audioId)
            }
            collectFromOverlayIds(out, slideData.overlays, ctx.overlays)
        }
    }

    // template referenced by the show (background image + template media items)
    const templateId = show.settings?.template
    if (templateId && ctx.templates?.[templateId]) {
        const template = ctx.templates[templateId]
        addPath(out, template.settings?.backgroundPath)
        collectFromItems(out, template.items)
        if (template.settings?.overlayId) collectFromOverlayIds(out, [template.settings.overlayId], ctx.overlays)
    }

    // custom fonts ship as files too (small, but part of faithful playback)
    for (const font of show.settings?.customFonts || []) addPath(out, (font as any)?.path)

    return [...out]
}

function collectFromOverlayIds(into: Set<string>, ids: string[] | undefined, overlays: Overlays | undefined) {
    if (!Array.isArray(ids) || !overlays) return
    for (const id of ids) {
        const overlay = overlays[id]
        if (overlay) collectFromItems(into, overlay.items)
    }
}

export interface ProjectCollectorContext extends ShowCollectorContext {
    showsById?: Shows
}

/**
 * Every media file a project needs: direct media items (id IS the path) plus
 * the full transitive closure of every show it references. Assumes the project
 * is played as a whole (the normal Sunday-morning case), so prefetching this
 * set up front covers the entire service.
 */
export function collectMediaPathsFromProject(project: Project | undefined | null, ctx: ProjectCollectorContext = {}): string[] {
    const out = new Set<string>()
    if (!project) return []

    const showsById = ctx.showsById || {}
    for (const ref of project.shows || []) {
        collectFromProjectRef(out, ref, showsById, ctx)
    }

    for (const action of project.timeline?.actions || []) addPath(out, (action as any)?.data?.path)

    return [...out]
}

function collectFromProjectRef(into: Set<string>, ref: ProjectShowRef, showsById: Shows, ctx: ShowCollectorContext) {
    if (!ref) return
    // a referenced show: expand to everything that show needs
    const show = showsById[ref.id]
    if (show) {
        for (const p of collectMediaPathsFromShow(show, ctx)) into.add(p)
        return
    }
    // otherwise the ref itself may be a direct media item
    if (ref.type && DIRECT_MEDIA_TYPES.has(ref.type)) {
        addPath(into, ref.id)
        return
    }
    // typeless / unknown refs: include when the id is path-like (defensive)
    if (!ref.type) addPath(into, ref.id)
}
