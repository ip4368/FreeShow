import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { zipEntries, unzipBuffer } from "../../../shared/data/zip"
import { getStore } from "./headlessStore"
import { setDataRoot } from "./dataPaths"
import { buildBackupZip, createFolder, loadShow, loadShows, restoreEntries, readFolderContent } from "./persistence"

let tmp = ""

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-readfolder-"))
    setDataRoot(tmp) // sandbox root
    fs.mkdirSync(path.join(tmp, "Media"))
    fs.mkdirSync(path.join(tmp, "Media", "Songs"))
    fs.writeFileSync(path.join(tmp, "Media", "a.png"), "x")
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("headless readFolderContent (sandboxed server browsing)", () => {
    it("browses the root with SANDBOX-RELATIVE paths (no absolute base exposed)", () => {
        const map = readFolderContent({ path: "", depth: 0 })
        // root is keyed as "" (relative), and children are relative
        expect(map[""]?.isFolder).toBe(true)
        expect(map["Media"]?.isFolder).toBe(true)
        // no absolute paths leak into the keys
        expect(Object.keys(map).every((k) => !path.isAbsolute(k))).toBe(true)
    })

    it("lists nested folders/files with relative paths", () => {
        const map = readFolderContent({ path: "Media", depth: 0 })
        expect(map["Media/Songs"]?.isFolder).toBe(true)
        expect(map[path.join("Media", "a.png")]).toMatchObject({ isFolder: false, name: "a.png" })
    })

    it("ignores paths that escape the sandbox", () => {
        expect(readFolderContent({ path: "../../.." })).toEqual({})
        expect(readFolderContent({ path: "/etc" })).toEqual({})
    })
})

describe("headless createFolder (sandboxed)", () => {
    it("creates a subfolder and returns its relative path", () => {
        const rel = createFolder({ path: "Media", name: "New Set" })
        expect(rel).toBe(path.join("Media", "New Set"))
        expect(fs.existsSync(path.join(tmp, "Media", "New Set"))).toBe(true)
    })

    it("refuses to create outside the sandbox", () => {
        expect(createFolder({ path: "..", name: "escaped" })).toBe("")
        expect(createFolder({ path: "Media", name: "../../escaped" })).toBe("")
        expect(fs.existsSync(path.join(tmp, "..", "escaped"))).toBe(false)
    })
})

describe("headless loadShow", () => {
    it("finds a show by id when the client doesn't know the file name yet", () => {
        // a client that just received the index broadcast requests the show before its
        // local index updates, so `name` is undefined -> must still resolve by id
        fs.mkdirSync(path.join(tmp, "Shows"), { recursive: true })
        fs.writeFileSync(path.join(tmp, "Shows", "My New Song.show"), JSON.stringify(["show123", { name: "My New Song", slides: {} }]))

        const byName = loadShow({ id: "show123", name: "My New Song" })
        expect(byName.error).toBeUndefined()

        const byIdOnly = loadShow({ id: "show123", name: "" })
        expect(byIdOnly.error).toBeUndefined()
        expect(byIdOnly.content?.[1]?.name).toBe("My New Song")
    })

    it("still reports not_found for a genuinely missing show", () => {
        expect(loadShow({ id: "nope", name: "" }).error).toBe("not_found")
    })
})

describe("headless restoreEntries (web/hybrid backup restore)", () => {
    it("restores shows and a portable store from a zipped backup, and rebuilds the index", async () => {
        const zip = await zipEntries([
            { name: "SHOWS/Restored Song.show", content: JSON.stringify(["restored1", { name: "Restored Song", slides: {} }]) },
            { name: "SYNCED_SETTINGS.json", content: JSON.stringify({ language: "en" }) }
        ])
        const entries = await unzipBuffer(zip)

        const result = restoreEntries(entries)

        expect(result.finished).toBe(true)
        expect(result.restoredShowIds).toEqual(["restored1"])
        expect(result.changed?.SHOWS?.restored1).toMatchObject({ name: "Restored Song" })
        expect(result.changed?.SYNCED_SETTINGS).toMatchObject({ language: "en" })

        expect(fs.existsSync(path.join(tmp, "Shows", "Restored Song.show"))).toBe(true)
        expect(getStore("SYNCED_SETTINGS")).toMatchObject({ language: "en" })
        expect(loadShows().restored1).toMatchObject({ name: "Restored Song" })
    })

    it("strips dataPath/showsPath from a restored SETTINGS entry", () => {
        const result = restoreEntries([{ name: "SETTINGS.json", content: JSON.stringify({ dataPath: "/should/not/persist", showsPath: "/should/not/persist", language: "en" }) }])

        expect(result.finished).toBe(true)
        expect(getStore("SETTINGS")).toMatchObject({ language: "en" })
        expect(getStore("SETTINGS").dataPath).toBeUndefined()
    })

    it("reports failure instead of throwing on garbage input", () => {
        const result = restoreEntries([{ name: "SHOWS/broken.show", content: "not json" }])
        expect(result.finished).toBe(true) // bad entries are skipped, not fatal
        expect(result.restoredShowIds).toEqual([])
    })
})

describe("headless buildBackupZip (web/hybrid backup download)", () => {
    it("zips the current library and round-trips through restoreEntries into an equivalent copy", async () => {
        fs.mkdirSync(path.join(tmp, "Shows"), { recursive: true })
        fs.writeFileSync(path.join(tmp, "Shows", "Backup Fixture.show"), JSON.stringify(["backupFixture", { name: "Backup Fixture", slides: {} }]))

        const zip = await buildBackupZip()
        const entries = await unzipBuffer(zip)

        const showEntry = entries.find((e) => e.name === "SHOWS/Backup Fixture.show")
        expect(showEntry).toBeDefined()
        expect(JSON.parse(showEntry!.content)).toMatchObject(["backupFixture", { name: "Backup Fixture" }])

        // restoring the zip into a fresh, empty root reproduces the same show
        const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-restore-roundtrip-"))
        setDataRoot(otherRoot)
        try {
            const result = restoreEntries(entries)
            expect(result.finished).toBe(true)
            expect(fs.existsSync(path.join(otherRoot, "Shows", "Backup Fixture.show"))).toBe(true)
        } finally {
            setDataRoot(tmp)
            fs.rmSync(otherRoot, { recursive: true, force: true })
        }
    })
})
