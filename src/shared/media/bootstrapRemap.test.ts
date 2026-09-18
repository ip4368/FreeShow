import { describe, expect, it } from "vitest"
import { rewriteOverlayMediaPaths, rewriteProjectMediaPaths, rewriteShowMediaPaths, rewriteTemplateMediaPaths, toServerRelative } from "./bootstrapRemap"

const ROOT = "/Users/test/Documents/FreeShow"

describe("toServerRelative", () => {
    it("passes through already-relative paths normalized", () => {
        expect(toServerRelative("Media/bg.jpg", ROOT, "Media")).toBe("Media/bg.jpg")
        expect(toServerRelative("Media\\Songs\\a.mp4", ROOT, "Media")).toBe("Media/Songs/a.mp4")
        expect(toServerRelative("file://Media/a.png", ROOT, "Media")).toBe("Media/a.png")
    })

    it("preserves structure for absolute paths inside the data root", () => {
        expect(toServerRelative(`${ROOT}/Media/Songs/a.mp4`, ROOT, "Media")).toBe("Media/Songs/a.mp4")
        expect(toServerRelative(`${ROOT}/Audio/x.mp3`, ROOT, "Media")).toBe("Audio/x.mp3")
    })

    it("flattens outside-root absolute paths into the destination folder", () => {
        expect(toServerRelative("/Users/test/Downloads/clip.mp4", ROOT, "Media")).toBe("Media/clip.mp4")
        expect(toServerRelative("/Volumes/EXT/video.mov", ROOT, "Uploads")).toBe("Uploads/video.mov")
        expect(toServerRelative("C:\\Users\\test\\Videos\\v.mp4", "C:\\Users\\test\\Documents\\FreeShow", "Media")).toBe("Media/v.mp4")
    })

    it("routes outside-root audio into the audio destination folder", () => {
        expect(toServerRelative("/Users/test/Downloads/song.mp3", ROOT, "Media")).toBe("Audio/song.mp3")
        expect(toServerRelative("/Users/test/Downloads/song.mp3", ROOT, "Media", "Sounds")).toBe("Sounds/song.mp3")
        expect(toServerRelative("/Users/test/Downloads/bed.WAV", ROOT, "Media")).toBe("Audio/bed.WAV")
        // non-audio still goes to the media destination
        expect(toServerRelative("/Users/test/Downloads/clip.mp4", ROOT, "Media", "Sounds")).toBe("Media/clip.mp4")
    })

    it("keeps inside-root structure regardless of media type", () => {
        expect(toServerRelative(`${ROOT}/Audio/bed.mp3`, ROOT, "Media")).toBe("Audio/bed.mp3")
        expect(toServerRelative(`${ROOT}/Audio/bed.mp3`, ROOT, "Media", "Sounds")).toBe("Audio/bed.mp3")
    })

    it("returns null for non-library values", () => {
        expect(toServerRelative("https://example.com/x.mp4", ROOT, "Media")).toBeNull()
        expect(toServerRelative("camera-1", ROOT, "Media")).toBeNull()
        expect(toServerRelative("", ROOT, "Media")).toBeNull()
    })
})

describe("rewriteShowMediaPaths", () => {
    it("rewrites direct paths but preserves media-map indirection", () => {
        const show = {
            slides: {
                s1: {
                    settings: { backgroundImage: `${ROOT}/Media/bg.jpg` },
                    items: [{ src: `${ROOT}/Media/item.png`, type: "media" }],
                    timeline: { actions: [{ data: { path: `${ROOT}/Audio/t.mp3` } }] }
                },
                s2: { settings: { backgroundImage: "m1" }, items: [{ media: "m1", type: "media" }], timeline: { actions: [] } }
            },
            layouts: {},
            media: { m1: { path: `${ROOT}/Media/legacy.mp4` } },
            settings: { customFonts: [{ path: `${ROOT}/Media/font.ttf` }] }
        }
        const remap = (p: string) => toServerRelative(p, ROOT, "Media") || p
        const { value, rewritten } = rewriteShowMediaPaths(show, remap)

        expect(value.slides.s1.settings.backgroundImage).toBe("Media/bg.jpg")
        expect(value.slides.s1.items[0].src).toBe("Media/item.png")
        expect(value.slides.s1.timeline.actions[0].data.path).toBe("Audio/t.mp3")
        // id-shaped refs stay as ids; the entry itself is rewritten
        expect(value.slides.s2.settings.backgroundImage).toBe("m1")
        expect(value.media.m1.path).toBe("Media/legacy.mp4")
        expect(value.settings.customFonts[0].path).toBe("Media/font.ttf")
        expect(rewritten).toBeGreaterThan(0)
        // input untouched (pure)
        expect(show.slides.s1.settings.backgroundImage).toBe(`${ROOT}/Media/bg.jpg`)
    })

    it("rewrites outside-root files into the destination folder", () => {
        const show = { slides: { s1: { settings: { backgroundImage: "/tmp/drop.mp4" }, items: [] } }, layouts: {}, media: {} }
        const { value } = rewriteShowMediaPaths(show, (p) => toServerRelative(p, ROOT, "Uploads") || p)
        expect(value.slides.s1.settings.backgroundImage).toBe("Uploads/drop.mp4")
    })
})

describe("rewriteOverlay/Template/Project", () => {
    it("rewrites overlay + template items", () => {
        const remap = (p: string) => toServerRelative(p, ROOT, "Media") || p
        expect(rewriteOverlayMediaPaths({ items: [{ src: `${ROOT}/Media/o.png` }] }, remap).value.items[0].src).toBe("Media/o.png")
        const t = rewriteTemplateMediaPaths({ settings: { backgroundPath: `${ROOT}/Media/t.jpg` }, items: [] }, remap)
        expect(t.value.settings.backgroundPath).toBe("Media/t.jpg")
    })

    it("rewrites direct project media refs but leaves show refs alone", () => {
        const remap = (p: string) => toServerRelative(p, ROOT, "Media") || p
        const project = {
            shows: [
                { id: `${ROOT}/Media/d.mp4`, type: "video" },
                { id: "show-id-123", type: "show" }
            ],
            timeline: { actions: [] }
        }
        const { value } = rewriteProjectMediaPaths(project, remap)
        expect(value.shows[0].id).toBe("Media/d.mp4")
        expect(value.shows[1].id).toBe("show-id-123")
    })
})
