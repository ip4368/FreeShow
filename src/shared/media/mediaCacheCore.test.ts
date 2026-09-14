import express from "express"
import fs from "fs"
import type { Server } from "http"
import type { AddressInfo } from "net"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setAuthToken } from "../../server/headless/auth"
import { setDataRoot } from "../../server/headless/data/dataPaths"
import { resetMediaHashCache } from "../../server/headless/mediaHash"
import { registerMediaRoutes } from "../../server/headless/mediaRoutes"
import { cacheFileName, clearMediaCache, evictIfNeeded, getCacheStats, isEntryFresh, loadManifest, mergeAndSaveManifest, mtimeEqual, normalizeCacheKey, prefetchMedia, resolveCachedEntry, saveManifest, touchCacheEntry, type CacheEntry, type CacheManifest } from "./mediaCacheCore"

describe("mediaCacheCore pure helpers", () => {
    it("normalizes keys and derives stable file names", () => {
        expect(normalizeCacheKey("Media\\a.png")).toBe("Media/a.png")
        expect(normalizeCacheKey("file://Media/a.png")).toBe("Media/a.png")
        expect(cacheFileName("Media/a.png")).toBe(cacheFileName("Media\\a.png"))
        expect(cacheFileName("Media/a.png")).toMatch(/^[a-f0-9]{40}\.png$/)
        expect(cacheFileName("noext")).toMatch(/^[a-f0-9]{40}\.bin$/)
    })

    it("mtimeEqual tolerates JSON float wobble", () => {
        expect(mtimeEqual(1725891234567.89, 1725891234567.891)).toBe(true)
        expect(mtimeEqual(1000, 1005)).toBe(false)
    })

    it("isEntryFresh requires size+mtime, and hash when both known", () => {
        const entry: CacheEntry = { remotePath: "Media/a.png", file: "x.png", size: 10, mtimeMs: 1000, hash: "h1", mime: "image/png", lastUsed: 0, downloadedAt: 0 }
        expect(isEntryFresh(entry, { path: "Media/a.png", size: 10, mtimeMs: 1000, hash: "h1", mime: "image/png" })).toBe(true)
        expect(isEntryFresh(entry, { path: "Media/a.png", size: 11, mtimeMs: 1000, hash: "h1", mime: "image/png" })).toBe(false)
        expect(isEntryFresh(entry, { path: "Media/a.png", size: 10, mtimeMs: 2000, hash: "h1", mime: "image/png" })).toBe(false)
        expect(isEntryFresh(entry, { path: "Media/a.png", size: 10, mtimeMs: 1000, hash: "h2", mime: "image/png" })).toBe(false)
        // unknown hash on either side falls back to size+mtime
        expect(isEntryFresh(entry, { path: "Media/a.png", size: 10, mtimeMs: 1000, hash: null, mime: "image/png" })).toBe(true)
        expect(isEntryFresh({ ...entry, hash: null }, { path: "Media/a.png", size: 10, mtimeMs: 1000, hash: "h1", mime: "image/png" })).toBe(true)
    })

    it("loadManifest tolerates a missing/corrupt manifest", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-manifest-"))
        try {
            expect(loadManifest(dir)).toEqual({ version: 1, entries: {} })
            fs.writeFileSync(path.join(dir, "manifest.json"), "not json{{{")
            expect(loadManifest(dir)).toEqual({ version: 1, entries: {} })
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("evictIfNeeded prunes missing files and LRU-evicts over the cap", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-evict-"))
        try {
            fs.writeFileSync(path.join(dir, "old.bin"), "0123456789")
            fs.writeFileSync(path.join(dir, "new.bin"), "0123456789")
            const manifest: CacheManifest = {
                version: 1,
                entries: {
                    "Media/old.mp4": { remotePath: "Media/old.mp4", file: "old.bin", size: 10, mtimeMs: 1, hash: null, mime: "video/mp4", lastUsed: 100, downloadedAt: 100 },
                    "Media/new.mp4": { remotePath: "Media/new.mp4", file: "new.bin", size: 10, mtimeMs: 1, hash: null, mime: "video/mp4", lastUsed: 200, downloadedAt: 200 },
                    "Media/gone.mp4": { remotePath: "Media/gone.mp4", file: "gone.bin", size: 10, mtimeMs: 1, hash: null, mime: "video/mp4", lastUsed: 300, downloadedAt: 300 }
                }
            }
            // unlimited: only prunes the missing file
            expect(evictIfNeeded(dir, manifest, 0)).toEqual({ evicted: [], freedBytes: 0 })
            expect(Object.keys(manifest.entries).sort()).toEqual(["Media/new.mp4", "Media/old.mp4"])
            // cap of 10 bytes: evicts oldest first
            const { evicted, freedBytes } = evictIfNeeded(dir, manifest, 10)
            expect(evicted).toEqual(["Media/old.mp4"])
            expect(freedBytes).toBe(10)
            expect(fs.existsSync(path.join(dir, "old.bin"))).toBe(false)
            expect(fs.existsSync(path.join(dir, "new.bin"))).toBe(true)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe("mediaCacheCore prefetch (integration, tmp only)", () => {
    let server: Server
    let base = ""
    let serverRoot = ""
    let cacheDir = ""

    beforeAll(async () => {
        setAuthToken("")
        serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-server-"))
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-client-"))
        setDataRoot(serverRoot)
        resetMediaHashCache()
        fs.mkdirSync(path.join(serverRoot, "Media"), { recursive: true })
        fs.writeFileSync(path.join(serverRoot, "Media", "a.png"), "AAA_BYTES")
        fs.writeFileSync(path.join(serverRoot, "Media", "b.mp4"), "BBB_BYTES_LONGER")

        const app = express()
        registerMediaRoutes(app)
        await new Promise<void>((resolve) => {
            server = app.listen(0, resolve)
        })
        base = `http://localhost:${(server.address() as AddressInfo).port}`
    })

    afterAll(() => {
        server?.close()
        fs.rmSync(serverRoot, { recursive: true, force: true })
        fs.rmSync(cacheDir, { recursive: true, force: true })
        resetMediaHashCache()
    })

    it("downloads missing files, then skips them as fresh", async () => {
        const first = await prefetchMedia({ cacheDir, paths: ["Media/a.png", "Media/b.mp4"], baseUrl: base, token: "" })
        expect(first.failed).toEqual([])
        expect(first.downloaded).toBe(2)
        expect(first.skipped).toBe(0)
        expect(first.bytes).toBe("AAA_BYTES".length + "BBB_BYTES_LONGER".length)

        const manifest = loadManifest(cacheDir)
        expect(Object.keys(manifest.entries).sort()).toEqual(["Media/a.png", "Media/b.mp4"].sort())
        for (const key of ["Media/a.png", "Media/b.mp4"]) {
            const hit = resolveCachedEntry(cacheDir, manifest, key)
            expect(hit).not.toBeNull()
            expect(fs.readFileSync(hit!.localPath, "utf8")).toBe(fs.readFileSync(path.join(serverRoot, key), "utf8"))
            expect(hit!.entry.hash).toBeTruthy() // verified + stored
        }

        const second = await prefetchMedia({ cacheDir, paths: ["Media/a.png", "Media/b.mp4"], baseUrl: base, token: "" })
        expect(second.failed).toEqual([])
        expect(second.downloaded).toBe(0)
        expect(second.skipped).toBe(2)
    })

    it("re-downloads when the server file changes", async () => {
        fs.writeFileSync(path.join(serverRoot, "Media", "a.png"), "AAA_BYTES_v2_LONGER")
        const res = await prefetchMedia({ cacheDir, paths: ["Media/a.png", "Media/b.mp4"], baseUrl: base, token: "" })
        expect(res.failed).toEqual([])
        expect(res.downloaded).toBe(1)
        expect(res.skipped).toBe(1)
        const hit = resolveCachedEntry(cacheDir, loadManifest(cacheDir), "Media/a.png")
        expect(fs.readFileSync(hit!.localPath, "utf8")).toBe("AAA_BYTES_v2_LONGER")
    })

    it("reports missing files without throwing", async () => {
        const res = await prefetchMedia({ cacheDir, paths: ["Media/nope.png"], baseUrl: base, token: "" })
        expect(res.downloaded).toBe(0)
        expect(res.failed).toHaveLength(1)
        expect(res.failed[0].path).toBe("Media/nope.png")
    })

    it("cached files still resolve when the server is unreachable (offline fallback)", async () => {
        const res = await prefetchMedia({ cacheDir, paths: ["Media/a.png"], baseUrl: "http://127.0.0.1:1", token: "" })
        expect(res.failed).toHaveLength(1)
        const hit = resolveCachedEntry(cacheDir, loadManifest(cacheDir), "Media/a.png")
        expect(hit).not.toBeNull()
        expect(fs.existsSync(hit!.localPath)).toBe(true)
    })

    it("reports stats and clears", async () => {
        const stats = getCacheStats(cacheDir, loadManifest(cacheDir))
        expect(stats.files).toBe(2)
        expect(stats.bytes).toBe("AAA_BYTES_v2_LONGER".length + "BBB_BYTES_LONGER".length)
        // persist lastUsed touches before clearing is irrelevant; just clear
        const cleared = clearMediaCache(cacheDir)
        expect(cleared.clearedFiles).toBe(2)
        expect(loadManifest(cacheDir).entries).toEqual({})
        expect(resolveCachedEntry(cacheDir, loadManifest(cacheDir), "Media/a.png")).toBeNull()
    })

    it("round-trips the manifest through save/load", () => {
        const manifest: CacheManifest = {
            version: 1,
            entries: { "Media/x.png": { remotePath: "Media/x.png", file: `${"a".repeat(40)}.png`, size: 1, mtimeMs: 2, hash: "h", mime: "image/png", lastUsed: 3, downloadedAt: 4 } }
        }
        saveManifest(cacheDir, manifest)
        expect(loadManifest(cacheDir)).toEqual(manifest)
    })

    it("matches absolute-in-sandbox requests by full relative path, not basename", async () => {
        fs.mkdirSync(path.join(serverRoot, "Archive"), { recursive: true })
        fs.writeFileSync(path.join(serverRoot, "Media", "dup.png"), "MEDIA_DUP")
        fs.writeFileSync(path.join(serverRoot, "Archive", "dup.png"), "ARCHIVE_DUP")
        const abs = path.join(serverRoot, "Archive", "dup.png")

        const res = await prefetchMedia({ cacheDir, paths: [abs], baseUrl: base, token: "" })
        expect(res.failed).toEqual([])
        expect(res.downloaded).toBe(1)
        const hit = resolveCachedEntry(cacheDir, loadManifest(cacheDir), path.join("Archive", "dup.png"))
        expect(hit).not.toBeNull()
        expect(fs.readFileSync(hit!.localPath, "utf8")).toBe("ARCHIVE_DUP")
    })

    it("re-downloads a same-size corrupted local file instead of adopting the hash", async () => {
        await prefetchMedia({ cacheDir, paths: ["Media/b.mp4"], baseUrl: base, token: "" })
        const key = path.join("Media", "b.mp4")
        const before = resolveCachedEntry(cacheDir, loadManifest(cacheDir), key)!
        expect(before.entry.hash).toBeTruthy()
        // corrupt the bytes but keep the size; simulate a pre-hash entry
        fs.writeFileSync(before.localPath, "X".repeat("BBB_BYTES_LONGER".length))
        const manifest = loadManifest(cacheDir)
        manifest.entries[key].hash = null
        saveManifest(cacheDir, manifest)

        const res = await prefetchMedia({ cacheDir, paths: ["Media/b.mp4"], baseUrl: base, token: "" })
        expect(res.failed).toEqual([])
        expect(res.downloaded).toBe(1)
        expect(res.skipped).toBe(0)
        const after = resolveCachedEntry(cacheDir, loadManifest(cacheDir), key)!
        expect(fs.readFileSync(after.localPath, "utf8")).toBe("BBB_BYTES_LONGER")
        expect(after.entry.hash).toBeTruthy()
    })

    it("drops tampered manifest entries that escape the cache dir", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-tamper-"))
        try {
            fs.writeFileSync(
                path.join(dir, "manifest.json"),
                JSON.stringify({
                    version: 1,
                    entries: {
                        evil: { remotePath: "evil", file: "../../outside.png", size: 1, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1, downloadedAt: 1 },
                        ok: { remotePath: "Media/x.png", file: `${"b".repeat(40)}.png`, size: 1, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1, downloadedAt: 1 }
                    }
                })
            )
            expect(Object.keys(loadManifest(dir).entries)).toEqual(["ok"])
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("touchCacheEntry reports whether the touch changed anything", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-touch-"))
        try {
            const file = `${"c".repeat(40)}.png`
            fs.writeFileSync(path.join(dir, file), "DATA")
            saveManifest(dir, {
                version: 1,
                entries: { "Media/x.png": { remotePath: "Media/x.png", file, size: 4, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1000, downloadedAt: 1 } }
            })
            const before = fs.statSync(path.join(dir, "manifest.json")).mtimeMs
            const hit = touchCacheEntry(dir, "Media/x.png")
            expect(hit?.touched).toBe(true) // lastUsed was ancient -> touched + saved
            expect(fs.statSync(path.join(dir, "manifest.json")).mtimeMs).toBeGreaterThanOrEqual(before)
            expect(touchCacheEntry(dir, "Media/x.png")?.touched).toBe(false) // same minute bucket -> no write
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("mergeAndSaveManifest keeps entries written by a concurrent call", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-merge-"))
        try {
            saveManifest(dir, { version: 1, entries: {} })
            const aEntry: CacheEntry = { remotePath: "Media/a.png", file: `${"d".repeat(40)}.png`, size: 1, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1, downloadedAt: 1 }
            const bEntry: CacheEntry = { remotePath: "Media/b.png", file: `${"e".repeat(40)}.png`, size: 1, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1, downloadedAt: 1 }
            // two overlapping writers, each starting from the same stale snapshot
            mergeAndSaveManifest(dir, { "Media/a.png": aEntry })
            mergeAndSaveManifest(dir, { "Media/b.png": bEntry })
            expect(Object.keys(loadManifest(dir).entries).sort()).toEqual(["Media/a.png", "Media/b.png"])
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("clearMediaCache sweeps tmp partials and orphans with honest byte counts", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-cache-sweep-"))
        try {
            const file = `${"f".repeat(40)}.png`
            fs.writeFileSync(path.join(dir, file), "12345678")
            fs.writeFileSync(path.join(dir, `${file}.123-abc.tmp`), "partial")
            fs.writeFileSync(path.join(dir, `${"0".repeat(40)}.mp4`), "orphan!")
            fs.writeFileSync(path.join(dir, "keep.txt"), "not ours")
            saveManifest(dir, {
                version: 1,
                entries: { "Media/x.png": { remotePath: "Media/x.png", file, size: 8, mtimeMs: 1, hash: null, mime: "image/png", lastUsed: 1, downloadedAt: 1 } }
            })
            const cleared = clearMediaCache(dir)
            expect(cleared).toEqual({ clearedFiles: 3, freedBytes: 8 + 7 + 7 })
            expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true)
            expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true)
            expect(fs.existsSync(path.join(dir, file))).toBe(false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
