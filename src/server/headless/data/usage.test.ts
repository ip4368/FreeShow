import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDataRoot } from "./dataPaths"
import { setStore } from "./headlessStore"
import { findMediaUsage } from "./usage"

let tmp = ""

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-usage-"))
    setDataRoot(tmp)
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(path.join(tmp, "Media"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "Audio"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "Shows"), { recursive: true })

    fs.writeFileSync(path.join(tmp, "Media", "a.png"), "PNG")
    fs.writeFileSync(path.join(tmp, "Media", "b.mp4"), "MP4")
    fs.writeFileSync(path.join(tmp, "Media", "unused.png"), "UNUSED")
    fs.writeFileSync(path.join(tmp, "Audio", "song.mp3"), "MP3")

    // show referencing a.png (slide bg + item), song.mp3 (layout audio), b.mp4 (absolute form)
    const show = {
        name: "Morning Service",
        settings: { activeLayout: "L1", template: null },
        timestamps: { created: 0, modified: null, used: null },
        meta: {},
        slides: {
            s1: { group: "V1", settings: { backgroundImage: "Media/a.png" }, items: [{ type: "image", src: "Media/a.png" }], timeline: { actions: [] } },
            s2: { group: "V2", settings: {}, items: [{ type: "video", src: path.join(tmp, "Media", "b.mp4") }], timeline: { actions: [] } }
        },
        layouts: { L1: { name: "Default", slides: [{ id: "s1", background: "m1", audio: ["m2"], overlays: ["o1"] }], timeline: { actions: [] } } },
        // m3 is orphaned (left over from a deleted slide): referenced nowhere, must NOT count as usage
        media: { m1: { path: "Media/a.png", name: "a" }, m2: { path: "Audio/song.mp3", name: "song" }, m3: { path: "Media/unused.png", name: "orphan" } }
    }
    fs.writeFileSync(path.join(tmp, "Shows", "Morning Service.show"), JSON.stringify(["show1", show]))

    setStore("OVERLAYS", { o1: { name: "Lower Third", items: [{ type: "image", src: "Media/a.png" }] } })
    setStore("TEMPLATES", {})
    setStore("PROJECTS", {
        projects: { p1: { name: "Sunday", shows: [{ id: "show1", type: "show" }] } },
        folders: {},
        projectTemplates: {}
    })
})

describe("findMediaUsage (delete-confirm scan)", () => {
    it("attributes show + overlay references to a file", () => {
        const result = findMediaUsage(["Media/a.png"])

        expect(result.missing).toEqual([])
        // containing projects annotate the show ref instead of listing as owners,
        // and the show's 3 references (bg, item, media map) collapse to one entry
        expect(result.usage["Media/a.png"]).toEqual([
            { kind: "show", id: "show1", name: "Morning Service", projects: [{ id: "p1", name: "Sunday" }] },
            { kind: "overlay", id: "o1", name: "Lower Third" }
        ])
        expect(result.summary).toEqual({ files: 1, usedFiles: 1 })
    })

    it("annotates one show ref when the show sits in two projects", () => {
        setStore("PROJECTS", {
            projects: {
                p1: { name: "Example", shows: [{ id: "show1", type: "show" }] },
                p2: { name: "test", shows: [{ id: "show1", type: "show" }] }
            },
            folders: {},
            projectTemplates: {}
        })

        const result = findMediaUsage(["Media/a.png"])
        expect(result.usage["Media/a.png"]).toEqual([
            {
                kind: "show",
                id: "show1",
                name: "Morning Service",
                projects: [
                    { id: "p1", name: "Example" },
                    { id: "p2", name: "test" }
                ]
            },
            { kind: "overlay", id: "o1", name: "Lower Third" }
        ])
    })

    it("matches absolute-form references against relative inputs (mixed libraries)", () => {
        const result = findMediaUsage(["Media/b.mp4"])
        expect(result.usage["Media/b.mp4"]).toContainEqual({ kind: "show", id: "show1", name: "Morning Service", projects: [{ id: "p1", name: "Sunday" }] })
    })

    it("matches layout-audio references and reports unreferenced files empty", () => {
        const result = findMediaUsage(["Audio/song.mp3", "Media/unused.png"])

        expect(result.usage["Audio/song.mp3"]).toContainEqual({ kind: "show", id: "show1", name: "Morning Service", projects: [{ id: "p1", name: "Sunday" }] })
        // unused.png is pointed at ONLY by the orphaned m3 entry: not usage
        expect(result.usage["Media/unused.png"]).toEqual([])
        expect(result.summary).toEqual({ files: 2, usedFiles: 1 })
    })

    it("expands folder inputs to their files", () => {
        const result = findMediaUsage(["Media"])

        expect(Object.keys(result.usage).sort()).toEqual(["Media/a.png", "Media/b.mp4", "Media/unused.png"])
        expect(result.summary).toEqual({ files: 3, usedFiles: 2 })
    })

    it("reports missing/forbidden inputs instead of throwing", () => {
        const result = findMediaUsage(["Media/nope.png", "../../escape.png"])

        expect(result.usage).toEqual({})
        expect(result.missing).toEqual([
            { path: "Media/nope.png", reason: "not found" },
            { path: "../../escape.png", reason: "forbidden" }
        ])
    })

    it("finds direct project media items", () => {
        setStore("PROJECTS", {
            projects: { p1: { name: "Sunday", shows: [{ id: "Media/unused.png", type: "image", name: "unused" }] } },
            folders: {},
            projectTemplates: {}
        })

        const result = findMediaUsage(["Media/unused.png"])
        expect(result.usage["Media/unused.png"]).toContainEqual({ kind: "project", id: "p1", name: "Sunday" })
    })

    it("finds audio playlist songs", () => {
        setStore("SETTINGS", { audioPlaylists: { pl1: { name: "Worship Set", songs: ["Audio/song.mp3"] } } })

        const result = findMediaUsage(["Audio/song.mp3"])
        expect(result.usage["Audio/song.mp3"]).toContainEqual({ kind: "playlist", id: "pl1", name: "Worship Set" })
    })

    it("ignores malformed playlists instead of throwing", () => {
        setStore("SETTINGS", { audioPlaylists: { broken: { name: "Broken" }, junk: null, notSongs: { name: "x", songs: "Audio/song.mp3" } } })

        const result = findMediaUsage(["Audio/song.mp3"])
        expect(result.usage["Audio/song.mp3"].filter((r) => r.kind === "playlist")).toEqual([])
    })

    it("reports orphaned media-map entries as weak refs only when opted in", () => {
        // default: m3's orphan pointer at unused.png is NOT usage
        expect(findMediaUsage(["Media/unused.png"]).usage["Media/unused.png"]).toEqual([])

        const result = findMediaUsage(["Media/unused.png"], { includeOrphans: true })
        expect(result.usage["Media/unused.png"]).toEqual([{ kind: "show", id: "show1", name: "Morning Service", projects: [{ id: "p1", name: "Sunday" }], weak: true }])
    })

    it("never marks strongly referenced files as weak", () => {
        const result = findMediaUsage(["Media/a.png"], { includeOrphans: true })
        // a.png is slide-referenced (m1 resolves it): strong refs only, no weak dupes
        expect(result.usage["Media/a.png"].every((r) => !r.weak)).toBe(true)
        expect(result.usage["Media/a.png"]).toHaveLength(2)
    })
})
