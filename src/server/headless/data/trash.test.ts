import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { dropCachedHashes, getMediaHash, peekCachedHash, resetMediaHashCache } from "../mediaHash"
import { setDataRoot } from "./dataPaths"
import { getMediaLibraryVersion } from "./libraryVersion"
import { deleteTrashPermanent, emptyTrash, listTrash, restoreTrash, sweepExpiredTrash, trashPaths, TRASH_TTL_MS } from "./trash"

let tmp = ""

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-trash-"))
    setDataRoot(tmp)
    resetMediaHashCache()
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

beforeEach(() => {
    // fresh library per test (Trash/ included)
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    resetMediaHashCache()
})

function seedLibrary() {
    fs.mkdirSync(path.join(tmp, "Media", "Set"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "Audio"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "Media", "a.png"), "PNGDATA")
    fs.writeFileSync(path.join(tmp, "Media", "Set", "b.mp4"), "MP4DATA")
    fs.writeFileSync(path.join(tmp, "Media", "Set", "notes.txt"), "TXT")
    fs.writeFileSync(path.join(tmp, "Audio", "song.mp3"), "MP3DATA")
}

describe("trashPaths (move to trash)", () => {
    it("moves a media file to Trash with a manifest entry", () => {
        seedLibrary()
        const result = trashPaths(["Media/a.png"], "test-client")

        expect(result.failed).toEqual([])
        expect(result.trashed).toHaveLength(1)
        const entry = result.trashed[0]
        expect(entry).toMatchObject({ name: "a.png", originalPath: "Media/a.png", isFolder: false, deletedBy: "test-client" })
        expect(entry.size).toBeGreaterThan(0)
        expect(fs.existsSync(path.join(tmp, "Media", "a.png"))).toBe(false)
        expect(fs.readFileSync(path.join(tmp, "Trash", entry.id), "utf8")).toBe("PNGDATA")

        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "Trash", "trash.json"), "utf8"))
        expect(manifest[entry.id]).toMatchObject({ originalPath: "Media/a.png" })
    })

    it("moves a folder verbatim, preserving structure (incl. non-media files)", () => {
        seedLibrary()
        const result = trashPaths(["Media/Set"])

        expect(result.failed).toEqual([])
        const entry = result.trashed[0]
        expect(entry).toMatchObject({ name: "Set", isFolder: true })
        expect(fs.existsSync(path.join(tmp, "Media", "Set"))).toBe(false)
        expect(fs.readFileSync(path.join(tmp, "Trash", entry.id, "b.mp4"), "utf8")).toBe("MP4DATA")
        expect(fs.readFileSync(path.join(tmp, "Trash", entry.id, "notes.txt"), "utf8")).toBe("TXT")
        // folder results expand to file-level paths for client eviction
        expect(result.paths.sort()).toEqual(["Media/Set/b.mp4", "Media/Set/notes.txt"])
    })

    it("rejects traversal, protected dirs, non-media files, and missing paths", () => {
        seedLibrary()
        fs.mkdirSync(path.join(tmp, "Shows"), { recursive: true })
        fs.writeFileSync(path.join(tmp, "Shows", "s.show"), JSON.stringify(["s", {}]))

        const result = trashPaths(["../../etc/x.png", "Shows/s.show", "Config/settings.json", "Trash", "", "Media/Set/notes.txt", "Media/nope.png", "Media/a.png"])

        const byPath: Record<string, string> = {}
        for (const f of result.failed) byPath[f.path] = f.reason
        expect(byPath["../../etc/x.png"]).toBe("forbidden")
        expect(byPath["Shows/s.show"]).toBe("forbidden")
        expect(byPath["Config/settings.json"]).toBe("forbidden")
        expect(byPath["Trash"]).toBe("forbidden")
        expect(byPath[""]).toBe("forbidden")
        expect(byPath["Media/Set/notes.txt"]).toBe("unsupported media type")
        expect(byPath["Media/nope.png"]).toBe("not found")
        // one bad path never aborts the rest of the batch
        expect(result.trashed.map((t) => t.originalPath)).toEqual(["Media/a.png"])
    })

    it("drops content-hash entries for trashed paths", async () => {
        seedLibrary()
        const abs = path.join(tmp, "Media", "a.png")
        const hash = await getMediaHash(abs, fs.statSync(abs))
        expect(peekCachedHash(abs, fs.statSync(abs))).toBe(hash)

        trashPaths(["Media/a.png"])
        const cache = JSON.parse(fs.readFileSync(path.join(tmp, "Config", "media-hashes.json"), "utf8"))
        expect(Object.keys(cache).some((k) => k.replace(/\\/g, "/") === "Media/a.png")).toBe(false)
        // unknown paths are a safe no-op
        dropCachedHashes(["Media/never-hashed.png"])
    })
})

describe("restoreTrash", () => {
    it("moves entries back to their original paths", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/Set"])
        const result = restoreTrash([trashed[0].id])

        expect(result.failed).toEqual([])
        expect(result.restored).toEqual([{ id: trashed[0].id, path: "Media/Set", originalPath: "Media/Set", renamed: false }])
        expect(fs.readFileSync(path.join(tmp, "Media", "Set", "b.mp4"), "utf8")).toBe("MP4DATA")
        expect(listTrash().entries).toEqual([])
    })

    it("never overwrites: a re-created file forces a suffixed restore name", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png"])
        fs.writeFileSync(path.join(tmp, "Media", "a.png"), "NEWER")

        const result = restoreTrash([trashed[0].id])

        expect(result.failed).toEqual([])
        expect(result.restored[0].path).toBe(path.join("Media", "a (restored).png").replace(/\\/g, "/"))
        expect(result.restored[0]).toMatchObject({ originalPath: "Media/a.png", renamed: true })
        expect(fs.readFileSync(path.join(tmp, "Media", "a.png"), "utf8")).toBe("NEWER")
        expect(fs.readFileSync(path.join(tmp, result.restored[0].path), "utf8")).toBe("PNGDATA")
    })

    it("drops manifest entries whose content vanished", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png"])
        fs.rmSync(path.join(tmp, "Trash", trashed[0].id), { force: true })

        const result = restoreTrash([trashed[0].id, "bogus-id"])
        expect(result.restored).toEqual([])
        expect(result.failed).toEqual([
            { path: "Media/a.png", reason: "content missing" },
            { path: "bogus-id", reason: "not found" }
        ])
        expect(listTrash().entries).toEqual([])
    })
})

describe("permanent delete + expiry", () => {
    it("permanently deletes entries and empties the trash", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png", "Audio/song.mp3"])
        expect(listTrash().totalSize).toBeGreaterThan(0)

        const one = deleteTrashPermanent([trashed[0].id, "bogus"])
        expect(one.deleted).toEqual([trashed[0].id])
        expect(one.failed).toEqual([{ path: "bogus", reason: "not found" }])
        expect(fs.existsSync(path.join(tmp, "Trash", trashed[0].id))).toBe(false)

        const emptied = emptyTrash()
        expect(emptied.deleted).toHaveLength(1)
        expect(listTrash().entries).toEqual([])
        expect(listTrash().totalSize).toBe(0)
    })

    it("sweeps entries older than the TTL (default 30 days)", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png", "Audio/song.mp3"])
        expect(TRASH_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)

        // nothing expires yet
        expect(sweepExpiredTrash()).toEqual({ swept: [], paths: [] })

        // expire just the first entry by backdating the manifest
        const manifestPath = path.join(tmp, "Trash", "trash.json")
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        manifest[trashed[0].id].deletedAt = Date.now() - TRASH_TTL_MS - 1000
        fs.writeFileSync(manifestPath, JSON.stringify(manifest))

        const swept = sweepExpiredTrash()
        expect(swept.swept).toEqual([trashed[0].id])
        expect(swept.paths).toEqual(["Media/a.png"])
        expect(listTrash().entries.map((e) => e.id)).toEqual([trashed[1].id])
        expect(fs.existsSync(path.join(tmp, "Trash", trashed[0].id))).toBe(false)
    })

    it("listTrash enforces expiry lazily and returns newest-first entries", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png"])
        const manifestPath = path.join(tmp, "Trash", "trash.json")
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        manifest[trashed[0].id].deletedAt = 0
        fs.writeFileSync(manifestPath, JSON.stringify(manifest))

        const listing = listTrash()
        expect(listing.swept).toEqual([trashed[0].id])
        expect(listing.entries).toEqual([])
    })
})

/** Fail only the manifest persist (tmp -> trash.json rename); moves still work. */
function breakManifestPersist() {
    const realRename = fs.renameSync
    return vi.spyOn(fs, "renameSync").mockImplementation(((from: unknown, to: unknown) => {
        if (String(to).endsWith("trash.json")) throw new Error("EACCES: permission denied")
        return (realRename as (...args: unknown[]) => unknown)(from, to)
    }) as typeof fs.renameSync)
}

describe("manifest persist failures", () => {
    it("rolls back trash moves and reports each path failed (no orphaned content)", () => {
        seedLibrary()
        const spy = breakManifestPersist()
        try {
            const result = trashPaths(["Media/a.png", "Audio/song.mp3"])

            expect(result.trashed).toEqual([])
            expect(result.paths).toEqual([])
            expect(result.failed).toEqual([
                { path: "Media/a.png", reason: "manifest write failed" },
                { path: "Audio/song.mp3", reason: "manifest write failed" }
            ])
            // rolled back: files are back where they were, nothing left in Trash
            expect(fs.readFileSync(path.join(tmp, "Media", "a.png"), "utf8")).toBe("PNGDATA")
            expect(fs.readFileSync(path.join(tmp, "Audio", "song.mp3"), "utf8")).toBe("MP3DATA")
            expect(fs.readdirSync(path.join(tmp, "Trash")).filter((n) => n !== "trash.json")).toEqual([])
        } finally {
            spy.mockRestore()
        }
    })

    it("reports manifestError on restore when content moved but the manifest stuck", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png"])
        const spy = breakManifestPersist()
        try {
            const result = restoreTrash([trashed[0].id])

            expect(result.restored).toHaveLength(1)
            expect(result.manifestError).toBe("manifest write failed")
            // content IS back (no un-restoring), entry still listed (stale but visible)
            expect(fs.readFileSync(path.join(tmp, "Media", "a.png"), "utf8")).toBe("PNGDATA")
        } finally {
            spy.mockRestore()
        }
    })

    it("reports manifestError on permanent delete and empty when the manifest stuck", () => {
        seedLibrary()
        const { trashed } = trashPaths(["Media/a.png", "Audio/song.mp3"])
        const spy = breakManifestPersist()
        try {
            const one = deleteTrashPermanent([trashed[0].id])
            expect(one.deleted).toEqual([trashed[0].id])
            expect(one.manifestError).toBe("manifest write failed")

            // the stuck manifest still lists the first entry, so emptying
            // reports both ids (the first is already content-gone; delete is
            // ensure-gone, matching existing semantics)
            const emptied = emptyTrash()
            expect(emptied.deleted).toEqual([trashed[0].id, trashed[1].id])
            expect(emptied.manifestError).toBe("manifest write failed")
        } finally {
            spy.mockRestore()
        }
    })
})

describe("media library version epoch", () => {
    it("starts at 0 and bumps on every effective mutation", () => {
        seedLibrary()
        expect(getMediaLibraryVersion()).toBe(0)

        const { trashed } = trashPaths(["Media/a.png"])
        expect(getMediaLibraryVersion()).toBe(1)

        restoreTrash([trashed[0].id])
        expect(getMediaLibraryVersion()).toBe(2)

        const again = trashPaths(["Media/a.png", "Audio/song.mp3"])
        expect(getMediaLibraryVersion()).toBe(3)

        deleteTrashPermanent([again.trashed[0].id])
        expect(getMediaLibraryVersion()).toBe(4)

        emptyTrash()
        expect(getMediaLibraryVersion()).toBe(5)
    })

    it("does not bump when nothing changed", () => {
        seedLibrary()
        trashPaths(["Media/nope.png"])
        restoreTrash(["bogus-id"])
        deleteTrashPermanent(["bogus-id"])
        emptyTrash()
        expect(getMediaLibraryVersion()).toBe(0)
    })

    it("listTrash reports the current epoch", () => {
        seedLibrary()
        expect(listTrash().v).toBe(0)
        trashPaths(["Media/a.png"])
        expect(listTrash().v).toBe(1)
    })
})
