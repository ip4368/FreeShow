import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setDataRoot } from "./dataPaths"
import { bumpMediaLibraryVersion, getMediaLibraryVersion } from "./libraryVersion"

let tmp = ""

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-libver-"))
    setDataRoot(tmp)
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

beforeEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
})

describe("media library version epoch", () => {
    it("starts at 0 when never bumped", () => {
        expect(getMediaLibraryVersion()).toBe(0)
    })

    it("bumps monotonically and persists across reads", () => {
        expect(bumpMediaLibraryVersion()).toBe(1)
        expect(bumpMediaLibraryVersion()).toBe(2)
        expect(getMediaLibraryVersion()).toBe(2)
        expect(JSON.parse(fs.readFileSync(path.join(tmp, "Config", "media-library-version.json"), "utf8"))).toEqual({ version: 2 })
    })

    it("treats a missing or corrupt file as 0", () => {
        expect(getMediaLibraryVersion()).toBe(0)
        fs.mkdirSync(path.join(tmp, "Config"), { recursive: true })
        fs.writeFileSync(path.join(tmp, "Config", "media-library-version.json"), "not json{{{")
        expect(getMediaLibraryVersion()).toBe(0)
        fs.writeFileSync(path.join(tmp, "Config", "media-library-version.json"), JSON.stringify({ version: "high" }))
        expect(getMediaLibraryVersion()).toBe(0)
        // recovery: next bump starts the epoch cleanly
        expect(bumpMediaLibraryVersion()).toBe(1)
    })
})
