import { describe, expect, it } from "vitest"
import type { Project } from "../../types/Projects"
import type { Overlays, Show, Templates } from "../../types/Show"
import { collectMediaPathsFromProject, collectMediaPathsFromShow, collectReachableMediaIds, isCacheableMediaPath, pruneShowMedia } from "./collectShowMedia"

function showWith(overrides: Partial<Show> = {}): Show {
    return {
        name: "Test",
        category: null,
        settings: { activeLayout: "l1", template: null },
        timestamps: { created: 0, modified: null, used: null },
        meta: {},
        slides: {},
        layouts: {},
        media: {},
        ...overrides
    } as Show
}

describe("isCacheableMediaPath", () => {
    it("accepts path-like strings", () => {
        expect(isCacheableMediaPath("Media/video.mp4")).toBe(true)
        expect(isCacheableMediaPath("/abs/path/pic.jpg")).toBe(true)
        expect(isCacheableMediaPath("C:\\Media\\song.mp3")).toBe(true)
    })
    it("rejects streams, embedded and non-path ids", () => {
        expect(isCacheableMediaPath("https://example.com/x.mp4")).toBe(false)
        expect(isCacheableMediaPath("data:image/png;base64,xx")).toBe(false)
        expect(isCacheableMediaPath("blob:abc")).toBe(false)
        expect(isCacheableMediaPath("freeshow-protected://x")).toBe(false)
        expect(isCacheableMediaPath("/media?path=Media%2Fx.mp4")).toBe(false)
        expect(isCacheableMediaPath("overlayId123")).toBe(false)
        expect(isCacheableMediaPath("")).toBe(false)
        expect(isCacheableMediaPath(undefined)).toBe(false)
    })

    it("matches schemes case-insensitively and tolerates query strings on paths", () => {
        expect(isCacheableMediaPath("HTTP://example.com/x.mp4")).toBe(false)
        expect(isCacheableMediaPath("DATA:image/png;base64,xx")).toBe(false)
        expect(isCacheableMediaPath("Media/x.mp4?v=2")).toBe(true)
        expect(isCacheableMediaPath("x.mp4?v=2")).toBe(true)
    })
})

describe("collectMediaPathsFromShow", () => {
    it("collects slide backgroundImage, item src, media entries and layout refs", () => {
        const show = showWith({
            slides: {
                s1: { group: null, color: null, settings: { backgroundImage: "Media/bg.jpg" }, notes: "", items: [{ style: "", src: "Media/item.png", type: "media" } as any] } as any
            },
            layouts: {
                l1: {
                    name: "L",
                    notes: "",
                    slides: [{ id: "s1", background: "m1", audio: ["m2"], overlays: ["o1"] } as any]
                } as any
            },
            media: {
                m1: { path: "Media/layout-bg.mp4" } as any,
                m2: { path: "Audio/song.mp3" } as any
            }
        })
        const overlays: Overlays = { o1: { name: "O", color: null, category: null, items: [{ style: "", src: "Media/overlay.png", type: "media" } as any] } }
        const paths = collectMediaPathsFromShow(show, { overlays })
        expect(paths.sort()).toEqual(["Audio/song.mp3", "Media/bg.jpg", "Media/item.png", "Media/layout-bg.mp4", "Media/overlay.png"].sort())
    })

    it("resolves legacy media id-as-path and template background", () => {
        const show = showWith({
            settings: { activeLayout: "l1", template: "t1" } as any,
            media: { m1: { id: "Media/legacy.mp4" } as any },
            layouts: { l1: { name: "L", notes: "", slides: [{ id: "s1", background: "m1" } as any] } as any },
            slides: {}
        })
        const templates: Templates = { t1: { name: "T", color: null, category: null, settings: { backgroundPath: "Media/tpl.jpg" }, items: [] } }
        const paths = collectMediaPathsFromShow(show, { templates })
        expect(paths.sort()).toEqual(["Media/legacy.mp4", "Media/tpl.jpg"].sort())
    })

    it("collects timeline audio paths and ignores http", () => {
        const show = showWith({
            slides: {
                s1: {
                    group: null,
                    color: null,
                    settings: {},
                    notes: "",
                    items: [{ style: "", src: "https://example.com/stream.mp4", type: "media" } as any],
                    timeline: { actions: [{ id: "a", time: 0, name: "x", type: "audio", data: { path: "Audio/click.mp3" } }] }
                } as any
            }
        })
        expect(collectMediaPathsFromShow(show)).toEqual(["Audio/click.mp3"])
    })

    it("returns [] for missing shows", () => {
        expect(collectMediaPathsFromShow(undefined)).toEqual([])
        expect(collectMediaPathsFromShow(null)).toEqual([])
    })

    it("ignores orphan media entries (slide deletion never prunes show.media)", () => {
        const show = showWith({
            slides: { s1: { group: null, color: null, settings: {}, notes: "", items: [] } as any },
            layouts: { l1: { name: "L", notes: "", slides: [{ id: "s1", background: "m1" } as any] } as any },
            media: {
                m1: { path: "Media/used.mp4" } as any,
                // left over from a deleted slide: in the map, referenced nowhere
                orphan: { path: "Media/leftover.mp4" } as any
            }
        })
        expect(collectMediaPathsFromShow(show)).toEqual(["Media/used.mp4"])
    })

    it("collects legacy layout-slide children backgrounds", () => {
        const show = showWith({
            layouts: {
                l1: { name: "L", notes: "", slides: [{ id: "s1", children: { c1: { background: "m1", audio: ["m2"] } } } as any] } as any
            },
            media: { m1: { path: "Media/child-bg.mp4" } as any, m2: { path: "Audio/child.mp3" } as any }
        })
        expect(collectMediaPathsFromShow(show).sort()).toEqual(["Audio/child.mp3", "Media/child-bg.mp4"].sort())
    })

    it("resolves id-shaped legacy backgroundImage and item.media values", () => {
        const show = showWith({
            slides: {
                s1: { group: null, color: null, settings: { backgroundImage: "m1" }, notes: "", items: [{ style: "", media: "m2", type: "media" } as any] } as any
            },
            media: { m1: { path: "Media/legacy-bg.mp4" } as any, m2: { path: "Media/legacy-item.png" } as any }
        })
        expect(collectMediaPathsFromShow(show).sort()).toEqual(["Media/legacy-bg.mp4", "Media/legacy-item.png"].sort())
    })
})

describe("collectReachableMediaIds", () => {
    it("finds layout background/audio, children, backgroundImage-as-id, and item.media-as-id", () => {
        const show = showWith({
            slides: {
                s1: { group: null, color: null, settings: { backgroundImage: "m1" }, notes: "", items: [{ style: "", media: "m2", type: "media" } as any] } as any
            },
            layouts: {
                l1: { name: "L", notes: "", slides: [{ id: "s1", background: "m3", audio: ["m4"], children: { c1: { background: "m5" } } } as any] } as any
            },
            media: {
                m1: { path: "Media/a.mp4" } as any,
                m2: { path: "Media/b.png" } as any,
                m3: { path: "Media/c.mp4" } as any,
                m4: { path: "Audio/d.mp3" } as any,
                m5: { path: "Media/e.mp4" } as any,
                orphan: { path: "Media/leftover.mp4" } as any
            }
        })
        expect([...collectReachableMediaIds(show)].sort()).toEqual(["m1", "m2", "m3", "m4", "m5"])
    })

    it("ignores unknown ids (the collector treats those as raw paths, not map refs)", () => {
        const show = showWith({
            slides: { s1: { group: null, color: null, settings: { backgroundImage: "Media/direct.jpg" }, notes: "", items: [] } as any },
            layouts: { l1: { name: "L", notes: "", slides: [{ id: "s1", background: "Media/other.jpg" } as any] } as any },
            media: { m1: { path: "Media/x.mp4" } as any }
        })
        // direct paths are not map references, so nothing is reachable (m1 is orphaned)
        expect([...collectReachableMediaIds(show)]).toEqual([])
    })

    it("returns empty for missing shows and missing maps", () => {
        expect([...collectReachableMediaIds(undefined)]).toEqual([])
        expect([...collectReachableMediaIds(null)]).toEqual([])
        expect([...collectReachableMediaIds(showWith({ media: undefined } as any))]).toEqual([])
    })
})

describe("pruneShowMedia", () => {
    it("drops orphaned entries and reports the pruned ids", () => {
        const show = showWith({
            layouts: { l1: { name: "L", notes: "", slides: [{ id: "s1", background: "m1" } as any] } as any },
            media: { m1: { path: "Media/used.mp4" } as any, orphan: { path: "Media/leftover.mp4" } as any }
        })
        const result = pruneShowMedia(show)
        expect(result.pruned).toEqual(["orphan"])
        expect(Object.keys(result.media || {})).toEqual(["m1"])
        // input untouched (pure)
        expect(Object.keys(show.media || {}).sort()).toEqual(["m1", "orphan"])
    })

    it("keeps shared entries referenced by several slides", () => {
        const show = showWith({
            layouts: {
                l1: { name: "L", notes: "", slides: [{ id: "s1", background: "shared" } as any, { id: "s2", background: "shared" } as any] } as any
            },
            media: { shared: { path: "Media/bg.mp4" } as any }
        })
        const result = pruneShowMedia(show)
        expect(result.pruned).toEqual([])
        expect(result.media).toBe(show.media)
    })

    it("handles missing shows and missing maps", () => {
        expect(pruneShowMedia(undefined)).toEqual({ media: {}, pruned: [] })
        expect(pruneShowMedia(null)).toEqual({ media: {}, pruned: [] })
        expect(pruneShowMedia(showWith({ media: undefined } as any))).toEqual({ media: {}, pruned: [] })
    })
})

describe("collectMediaPathsFromProject", () => {
    it("expands show refs and includes direct media items", () => {
        const show = showWith({ slides: { s1: { group: null, color: null, settings: { backgroundImage: "Media/bg.jpg" }, notes: "", items: [] } as any } })
        const project: Project = {
            name: "P",
            created: 0,
            parent: "",
            shows: [
                { id: "show1", type: "show" },
                { id: "Media/direct.mp4", type: "video" },
                { id: "Media/slides.pptx", type: "ppt" },
                { id: "divider", type: "DIVIDER" }
            ]
        }
        const paths = collectMediaPathsFromProject(project, { showsById: { show1: show } })
        expect(paths.sort()).toEqual(["Media/bg.jpg", "Media/direct.mp4", "Media/slides.pptx"].sort())
    })
})
