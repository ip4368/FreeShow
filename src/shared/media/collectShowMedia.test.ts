import { describe, expect, it } from "vitest"
import type { Project } from "../../types/Projects"
import type { Overlays, Show, Templates } from "../../types/Show"
import { collectMediaPathsFromProject, collectMediaPathsFromShow, isCacheableMediaPath } from "./collectShowMedia"

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
