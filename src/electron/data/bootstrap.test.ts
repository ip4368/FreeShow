import fs from "fs"
import os from "os"
import path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { unzipBuffer } from "../../shared/data/zip"
import { ToMain } from "../../types/IPC/ToMain"
import { sendToMain } from "../IPC/main"
import { getStore } from "./store"
import { publishBootstrap } from "./bootstrap"

vi.mock("../IPC/main", () => ({ sendMain: vi.fn(), sendToMain: vi.fn() }))

// real fs against tmp dirs (the real module pulls in Electron via ../index)
const h = vi.hoisted(() => ({ localRoot: "", outsideRoot: "", stores: {} as Record<string, any> }))
vi.mock("../utils/files", () => {
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const names: Record<string, string> = { shows: "Shows", scriptures: "Bibles", media: "Media", audio: "Audio", userData: "Config" }
    return {
        createFolder: vi.fn((p: string) => {
            fs.mkdirSync(p, { recursive: true })
            return p
        }),
        doesPathExist: vi.fn((p: string) => {
            try {
                return fs.existsSync(p)
            } catch {
                return false
            }
        }),
        getDataFolderRoot: vi.fn(() => h.localRoot),
        getDataFolderPath: vi.fn((id: string) => {
            const dir = path.join(h.localRoot, names[id] || id)
            fs.mkdirSync(dir, { recursive: true })
            return dir
        }),
        readFile: vi.fn((p: string) => {
            try {
                return fs.readFileSync(p, "utf8")
            } catch {
                return ""
            }
        }),
        readFolder: vi.fn((p: string) => {
            try {
                return fs.readdirSync(p)
            } catch {
                return []
            }
        })
    }
})

vi.mock("./store", () => ({
    _store: {},
    getStore: vi.fn((id: string) => h.stores[id] ?? {})
}))

let fetchMock: ReturnType<typeof vi.fn>
let localRoot = ""
let outsideRoot = ""
let uploaded: { url: string }[]
let manifestBodies: any[]

const SHOW_ID = "show-e2e-1"

function fixtureShow() {
    return {
        name: "E2E Service",
        slides: {
            s1: {
                settings: { backgroundImage: path.join(h.localRoot, "Media", "bg.jpg") },
                items: [{ src: path.join(h.outsideRoot, "clip.mp4"), type: "media" }],
                timeline: { actions: [] }
            }
        },
        layouts: {},
        media: { m1: { path: path.join(h.localRoot, "Audio", "bed.mp3") } },
        settings: {}
    }
}

function setupLibrary() {
    localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-boot-local-"))
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-boot-outside-"))
    h.localRoot = localRoot
    h.outsideRoot = outsideRoot

    fs.mkdirSync(path.join(localRoot, "Shows"), { recursive: true })
    fs.mkdirSync(path.join(localRoot, "Media"), { recursive: true })
    fs.mkdirSync(path.join(localRoot, "Audio"), { recursive: true })
    fs.mkdirSync(path.join(localRoot, "Bibles"), { recursive: true })
    fs.writeFileSync(path.join(localRoot, "Shows", "E2E Service.show"), JSON.stringify([SHOW_ID, fixtureShow()]))
    fs.writeFileSync(path.join(localRoot, "Media", "bg.jpg"), "BG_BYTES")
    fs.writeFileSync(path.join(localRoot, "Audio", "bed.mp3"), "BED_BYTES")
    fs.writeFileSync(path.join(outsideRoot, "clip.mp4"), "CLIP_BYTES")
    fs.writeFileSync(path.join(localRoot, "Bibles", "KJV.fsb"), JSON.stringify(["kjv", { name: "KJV", books: [] }]))

    h.stores = {
        SETTINGS: { dataPath: "/should/strip", language: "en" },
        SYNCED_SETTINGS: { language: "en" },
        THEMES: {},
        PROJECTS: { projects: { p1: { name: "P", shows: [{ id: path.join(localRoot, "Media", "bg.jpg"), type: "image" }] } }, folders: {}, projectTemplates: {} },
        STAGE: {},
        OVERLAYS: {},
        TEMPLATES: {},
        EVENTS: {},
        MEDIA: { "Media/bg.jpg": { favourite: true } }
    }
}

function mockServer(opts: { status?: any; statusError?: boolean; restore?: any; restoreStatus?: number; manifest?: any; upload?: (url: string) => any } = {}) {
    uploaded = []
    manifestBodies = []
    fetchMock = vi.fn(async (url: string, init: any) => {
        if (url.includes("/bootstrap/status")) {
            if (opts.statusError) throw new Error("network down")
            return { ok: true, status: 200, json: async () => opts.status ?? { shows: 0, bibles: 0, empty: true } }
        }
        if (url.includes("/bootstrap/restore")) {
            return {
                ok: (opts.restoreStatus ?? 200) < 300,
                status: opts.restoreStatus ?? 200,
                json: async () => opts.restore ?? { finished: true, restoredShowIds: [SHOW_ID], restoredBibles: 1 },
                text: async () => "err"
            }
        }
        if (url.includes("/media/manifest")) {
            manifestBodies.push(JSON.parse(init.body))
            return { ok: true, status: 200, json: async () => opts.manifest ?? { files: [], missing: [] } }
        }
        if (url.includes("/media/upload")) {
            uploaded.push({ url })
            // consume the streamed body so the read stream closes cleanly
            try {
                const body = init.body
                if (body && typeof body[Symbol.asyncIterator] === "function") for await (const _ of body) void _
            } catch {
                // ignore
            }
            const custom = opts.upload?.(url)
            if (custom) return custom
            return { ok: true, status: 200, json: async () => ({}), text: async () => "" }
        }
        throw new Error("unexpected url " + url)
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

beforeEach(() => {
    vi.clearAllMocks()
    if (localRoot) fs.rmSync(localRoot, { recursive: true, force: true })
    if (outsideRoot) fs.rmSync(outsideRoot, { recursive: true, force: true })
    setupLibrary()
})

describe("publishBootstrap (Electron publish path)", () => {
    it("builds a remapped zip, restores, and streams media uploads", async () => {
        const fetch = mockServer()
        const result = await publishBootstrap({ serverUrl: "http://server:5540", token: "t", destFolder: "Media" })

        expect(result.success).toBe(true)
        expect(result.shows).toBe(1)
        expect(result.bibles).toBe(1)
        expect(result.media?.failed).toEqual([])

        // zip body: shows rewritten to server-relative, settings stripped, bibles included
        const restoreCall = fetch.mock.calls.find(([u]) => String(u).includes("/bootstrap/restore"))
        expect(restoreCall).toBeDefined()
        expect(String(restoreCall![0])).toContain("token=t")
        expect(String(restoreCall![0])).not.toContain("force=true")
        const entries = await unzipBuffer((restoreCall![1] as any).body)
        const names = entries.map((e) => e.name)
        expect(names).toContain("SHOWS/E2E Service.show")
        expect(names).toContain("BIBLE_KJV.fsb")
        expect(names).toContain("MEDIA.json")
        const showEntry = entries.find((e) => e.name === "SHOWS/E2E Service.show")!
        const [, show] = JSON.parse(showEntry.content)
        expect(show.slides.s1.settings.backgroundImage).toBe("Media/bg.jpg") // inside root: structure kept
        expect(show.slides.s1.items[0].src).toBe("Media/clip.mp4") // outside root: dest folder + basename
        expect(show.media.m1.path).toBe("Audio/bed.mp3")
        const settings = JSON.parse(entries.find((e) => e.name === "SETTINGS.json")!.content)
        expect(settings.dataPath).toBeUndefined()

        // manifest asked for every referenced file (resume check)
        expect(manifestBodies.length).toBe(1)
        expect(manifestBodies[0].paths).toEqual(expect.arrayContaining(["Media/bg.jpg", "Media/clip.mp4", "Audio/bed.mp3"]))

        // one streamed upload per file, token attached
        expect(uploaded.length).toBe(3)
        expect(uploaded.map((u) => u.url).sort()).toEqual([expect.stringContaining("/media/upload?path=Audio&name=bed.mp3"), expect.stringContaining("/media/upload?path=Media&name=bg.jpg"), expect.stringContaining("/media/upload?path=Media&name=clip.mp4")])
        for (const u of uploaded) expect(u.url).toContain("token=t")

        // progress streamed back to the renderer through every phase
        const phases = vi
            .mocked(sendToMain)
            .mock.calls.filter(([c]) => c === ToMain.BOOTSTRAP_PROGRESS)
            .map(([, p]) => (p as any).phase)
        expect(phases).toEqual(expect.arrayContaining(["build", "restore", "manifest", "media", "done"]))
    })

    it("refuses when the server is not empty and replace is off", async () => {
        const fetch = mockServer({ status: { shows: 4, bibles: 1, empty: false } })
        const result = await publishBootstrap({ serverUrl: "http://server:5540" })
        expect(result).toMatchObject({ success: false, error: "not_empty", status: { shows: 4 } })
        expect(fetch.mock.calls.some(([u]) => String(u).includes("/bootstrap/restore"))).toBe(false)
        expect(uploaded).toEqual([])
    })

    it("replace mode forces the restore", async () => {
        const fetch = mockServer({ status: { shows: 2, bibles: 0, empty: false }, restore: { finished: true, restoredShowIds: [SHOW_ID], replaced: true } })
        const result = await publishBootstrap({ serverUrl: "http://server:5540/", replace: true, includeMedia: false })
        expect(result.success).toBe(true)
        expect(result.replaced).toBe(true)
        const restoreCall = fetch.mock.calls.find(([u]) => String(u).includes("/bootstrap/restore"))
        expect(String(restoreCall![0])).toContain("force=true")
    })

    it("treats a 409 restore as not_empty when the status check was unreachable", async () => {
        mockServer({ statusError: true, restoreStatus: 409, restore: { finished: false, error: "not_empty", shows: 3, bibles: 0 } })
        const result = await publishBootstrap({ serverUrl: "http://server:5540" })
        expect(result).toMatchObject({ success: false, error: "not_empty", status: { shows: 3, empty: false } })
    })

    it("skips files the server already has at the same size (manifest resume)", async () => {
        mockServer({
            manifest: {
                files: [
                    { path: "Media/bg.jpg", size: 8 },
                    { path: "Audio/bed.mp3", size: 9 }
                ],
                missing: []
            }
        })
        const result = await publishBootstrap({ serverUrl: "http://server:5540" })
        expect(result.success).toBe(true)
        expect(result.media?.skipped).toBe(2)
        expect(result.media?.uploaded).toBe(1)
        expect(uploaded.length).toBe(1)
        expect(uploaded[0].url).toContain("clip.mp4")
    })

    it("honors the media and bibles toggles", async () => {
        const fetch = mockServer()
        const result = await publishBootstrap({ serverUrl: "http://server:5540", includeMedia: false, includeBibles: false })
        expect(result.success).toBe(true)
        expect(result.media).toMatchObject({ uploaded: 0, skipped: 0 })
        expect(fetch.mock.calls.some(([u]) => String(u).includes("/media/"))).toBe(false)
        const restoreCall = fetch.mock.calls.find(([u]) => String(u).includes("/bootstrap/restore"))
        const entries = await unzipBuffer((restoreCall![1] as any).body)
        expect(entries.map((e) => e.name).some((n) => n.startsWith("BIBLE_"))).toBe(false)
    })

    it("collects upload failures without failing the publish", async () => {
        mockServer({
            upload: (url: string) => (url.includes("clip.mp4") ? { ok: false, status: 500, json: async () => ({}), text: async () => "disk full" } : undefined)
        })
        const result = await publishBootstrap({ serverUrl: "http://server:5540" })
        expect(result.success).toBe(true)
        expect(result.media?.uploaded).toBe(2)
        expect(result.media?.failed).toEqual([{ path: "Media/clip.mp4", reason: "disk full" }])
    })

    it("sends outside-root files to the chosen destination folder", async () => {
        mockServer()
        await publishBootstrap({ serverUrl: "http://server:5540", destFolder: "Uploads" })
        expect(uploaded.map((u) => u.url).sort()).toEqual([expect.stringContaining("/media/upload?path=Audio&name=bed.mp3"), expect.stringContaining("/media/upload?path=Media&name=bg.jpg"), expect.stringContaining("/media/upload?path=Uploads&name=clip.mp4")])
    })

    it("sends outside-root audio to the audio destination folder", async () => {
        const song = path.join(outsideRoot, "song.mp3")
        fs.writeFileSync(song, "SONG_BYTES")
        const audioShow = { name: "Audio Show", slides: { s1: { settings: {}, items: [], timeline: { actions: [{ data: { path: song } }] } } }, layouts: {}, media: {} }
        fs.writeFileSync(path.join(localRoot, "Shows", "Audio Show.show"), JSON.stringify(["audio-show-1", audioShow]))

        // default audio destination
        mockServer()
        await publishBootstrap({ serverUrl: "http://server:5540" })
        expect(uploaded.map((u) => u.url)).toContainEqual(expect.stringContaining("/media/upload?path=Audio&name=song.mp3"))

        // custom audio destination (media destination unaffected)
        const fetch = mockServer()
        await publishBootstrap({ serverUrl: "http://server:5540", destFolder: "Uploads", audioDestFolder: "Sounds" })
        expect(uploaded.map((u) => u.url)).toContainEqual(expect.stringContaining("/media/upload?path=Sounds&name=song.mp3"))
        expect(uploaded.map((u) => u.url)).toContainEqual(expect.stringContaining("/media/upload?path=Uploads&name=clip.mp4"))

        const restoreCall = fetch.mock.calls.find(([u]) => String(u).includes("/bootstrap/restore"))
        const entries = await unzipBuffer((restoreCall![1] as any).body)
        const [, rewritten] = JSON.parse(entries.find((e) => e.name === "SHOWS/Audio Show.show")!.content)
        expect(rewritten.slides.s1.timeline.actions[0].data.path).toBe("Sounds/song.mp3")
    })

    it("requires a server URL", async () => {
        mockServer()
        await expect(publishBootstrap({ serverUrl: "  " })).resolves.toMatchObject({ success: false, error: "missing_server_url" })
    })
})
