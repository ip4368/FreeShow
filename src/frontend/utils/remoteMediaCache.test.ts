// Regression test: file introspection (codec, subtitles, exif, audio metadata)
// must never ask the LOCAL disk for a SERVER library path. On remote clients
// resolveProbePath returns the persistent cache copy when available, else null
// (caller skips the probe). Probing the server path locally produced ENOENT
// stack-trace spam from the mp4box prober on every video render.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { Main } from "../../types/IPC/channels"

// remoteMediaCache pulls in IPC/stores; stub the collaborators like search.test.ts does.
const h = vi.hoisted(() => ({
    socket: false,
    remoteConfig: null as null | { enabled: boolean; url: string; token?: string },
    requestMain: vi.fn()
}))
vi.mock("../IPC/main", () => ({ requestMain: h.requestMain, sendMain: vi.fn() }))
vi.mock("../IPC/transport", () => ({
    isSocketTransport: () => h.socket,
    getRemoteServerConfig: () => h.remoteConfig,
    getConnectionToken: () => ""
}))
vi.mock("./common", () => ({ newToast: vi.fn() }))
vi.mock("../stores", () => {
    const stub = (v: unknown) => ({ subscribe: (fn: (val: unknown) => void) => (fn(v), () => undefined), set: () => undefined, update: () => undefined })
    return { activeProject: stub(null), activeShow: stub(null), overlays: stub({}), projects: stub({}), showsCache: stub({}), special: stub({}), templates: stub({}) }
})

import { normalizeCacheKey } from "../../shared/media/mediaCacheCore"
import { clearMediaCacheUI, ensureLocalMedia, isCachedLocalPath, normalizeKey, prefetchRemotePaths, resolveLocalMedia, resolveProbePath, resolveRemoteMedia, toRemoteMediaPath } from "./remoteMediaCache"

// localStorage stub (persist/snapshot paths); real browsers share it across windows
const lsStore = new Map<string, string>()
vi.stubGlobal("localStorage", {
    getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string) => void lsStore.set(k, v),
    removeItem: (k: string) => void lsStore.delete(k)
})

beforeEach(() => {
    h.socket = false
    h.remoteConfig = null
    h.requestMain.mockReset()
    lsStore.clear()
})

describe("resolveProbePath", () => {
    it("local clients probe the path itself with no IPC", async () => {
        await expect(resolveProbePath("C:/Media/clip.mp4")).resolves.toBe("C:/Media/clip.mp4")
        expect(h.requestMain).not.toHaveBeenCalled()
    })

    it("rejects empty/non-string input", async () => {
        await expect(resolveProbePath("")).resolves.toBeNull()
        await expect(resolveProbePath(undefined as any)).resolves.toBeNull()
        expect(h.requestMain).not.toHaveBeenCalled()
    })

    it("socket clients without a local main (web) skip probing with no IPC", async () => {
        h.socket = true
        await expect(resolveProbePath("Media/clip.mp4")).resolves.toBeNull()
        expect(h.requestMain).not.toHaveBeenCalled()
    })

    it("hybrid clients probe the cached local copy", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540", token: "t" }
        h.requestMain.mockResolvedValue({ cached: true, localPath: "/cache/abc123.mp4" })

        await expect(resolveProbePath("Media/cached.mp4")).resolves.toBe("/cache/abc123.mp4")
        expect(h.requestMain).toHaveBeenCalledWith(Main.MEDIA_CACHE_GET, { path: "Media/cached.mp4" })
    })

    it("hybrid clients with nothing cached return null and never probe the server path", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540", token: "t" }
        h.requestMain.mockImplementation((channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return Promise.resolve({ cached: false, localPath: null })
            return Promise.resolve(null) // background prefetch ack
        })

        await expect(resolveProbePath("Media/Screen Recording 2023-10-05 at 17.02.47.mov")).resolves.toBeNull()

        // let the fire-and-forget background prefetch settle, then verify no local
        // probe (codec/tracks/exif/audio/file-info) was ever issued for the server path
        await new Promise((r) => setTimeout(r, 20))
        const channels = h.requestMain.mock.calls.map((c) => c[0])
        expect(channels.length).toBeGreaterThan(0)
        for (const channel of channels) {
            expect([Main.MEDIA_CACHE_GET, Main.MEDIA_CACHE_PREFETCH]).toContain(channel)
        }
    })

    it("returns null when the cache lookup fails", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockRejectedValue(new Error("ipc down"))

        await expect(resolveProbePath("Media/other.mp4")).resolves.toBeNull()
    })
})

describe("normalizeKey parity", () => {
    it("matches the core's normalizeCacheKey on tricky inputs", () => {
        const inputs = ["Media\\a.png", "file://Media/a.png", "Media//a.png", "/abs/Media/a.png", "C:\\Media\\a.png", "  Media/a.png  "]
        for (const input of inputs) expect(normalizeKey(input)).toBe(normalizeCacheKey(input))
    })
})

describe("isCachedLocalPath", () => {
    it("recognizes known mappings, the shared prefix, and file:// / separator variants", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockResolvedValue({ cached: true, localPath: "/cache/dir/abc.mp4" })
        await ensureLocalMedia("Media/known.mp4")
        expect(isCachedLocalPath("/cache/dir/abc.mp4")).toBe(true)

        lsStore.set("freeshow_media_cache_dir", "/cache/dir")
        expect(isCachedLocalPath("/cache/dir/other.mp4")).toBe(true)
        expect(isCachedLocalPath("file:///cache/dir/other.mp4")).toBe(true)
        expect(isCachedLocalPath("/other/place.mp4")).toBe(false)
        expect(isCachedLocalPath("")).toBe(false)
    })
})

describe("prefetch dedupe", () => {
    const summary = { requested: 4, downloaded: 0, skipped: 4, failed: [], bytes: 0, evicted: [] }

    it("dedupes identical concurrent prefetches", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockImplementation(() => new Promise((r) => setTimeout(() => r(summary), 20)))

        const paths = ["Media/a.mp4", "Media/b.mp4"]
        const [first, second] = await Promise.all([prefetchRemotePaths(paths), prefetchRemotePaths(paths)])
        expect([first === null, second === null].filter(Boolean)).toHaveLength(1)
        expect(h.requestMain.mock.calls.filter((c) => c[0] === Main.MEDIA_CACHE_PREFETCH)).toHaveLength(1)
    })

    it("does not dedupe different sets with the same length and first files", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockResolvedValue(summary)

        const a = await prefetchRemotePaths(["Media/a.mp4", "Media/b.mp4", "Media/c.mp4", "Media/x.mp4"])
        const b = await prefetchRemotePaths(["Media/a.mp4", "Media/b.mp4", "Media/c.mp4", "Media/y.mp4"])
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
        expect(h.requestMain.mock.calls.filter((c) => c[0] === Main.MEDIA_CACHE_PREFETCH)).toHaveLength(2)
    })
})

describe("eviction and clear invalidation", () => {
    it("drops evicted mappings from the lookup map", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return { cached: true, localPath: "/cache/dir/old.mp4" }
            return { requested: 1, downloaded: 1, skipped: 0, failed: [], bytes: 1, evicted: ["Media/old.mp4"] }
        })

        await ensureLocalMedia("Media/old.mp4")
        expect(resolveLocalMedia("Media/old.mp4")).toBe("/cache/dir/old.mp4")
        await prefetchRemotePaths(["Media/new.mp4"])
        expect(resolveLocalMedia("Media/old.mp4")).toBe("")
    })

    it("clear drops every mapping", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return { cached: true, localPath: "/cache/dir/c.mp4" }
            if (channel === Main.MEDIA_CACHE_CLEAR) return { clearedFiles: 1, freedBytes: 1 }
            return null
        })

        await ensureLocalMedia("Media/c.mp4")
        expect(resolveLocalMedia("Media/c.mp4")).toBe("/cache/dir/c.mp4")
        await clearMediaCacheUI()
        expect(resolveLocalMedia("Media/c.mp4")).toBe("")
    })

    it("adopts the cross-window snapshot for output windows", () => {
        lsStore.set("freeshow_media_map", JSON.stringify({ entries: [["Media/shared.mp4", "/cache/dir/s.mp4"]], dropped: [], clearGen: 0 }))
        lsStore.set("freeshow_media_map_version", "snap-v1")
        expect(resolveLocalMedia("Media/shared.mp4")).toBe("/cache/dir/s.mp4")
    })
})

describe("background fetch coalescing", () => {
    it("merges rapid misses into one prefetch", async () => {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return { cached: false, localPath: null }
            return { requested: 2, downloaded: 2, skipped: 0, failed: [], bytes: 2, evicted: [] }
        })

        // flush any background-fetch timer left queued by earlier tests
        await new Promise((r) => setTimeout(r, 600))
        h.requestMain.mockClear()

        await ensureLocalMedia("Media/miss1.mp4")
        await ensureLocalMedia("Media/miss2.mp4")
        await new Promise((r) => setTimeout(r, 700))
        const prefetchCalls = h.requestMain.mock.calls.filter((c) => c[0] === Main.MEDIA_CACHE_PREFETCH)
        expect(prefetchCalls).toHaveLength(1)
        expect(prefetchCalls[0][1].paths.sort()).toEqual(["Media/miss1.mp4", "Media/miss2.mp4"])
    })
})

describe("reverse lookup (cached local path -> remote path)", () => {
    // Hybrid outputs carry cache-local paths (getMedia resolves through the
    // cache), while drawers list server-relative paths. Highlight/active
    // comparisons must canonicalize through this reverse map or the same
    // show highlights on web but not on hybrid desktop.
    function hybridWithCached(remotePath: string, localPath: string) {
        h.socket = true
        h.remoteConfig = { enabled: true, url: "http://server:5540" }
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return { cached: true, localPath }
            return null
        })
        return ensureLocalMedia(remotePath)
    }

    it("returns the remote path for a known cached file", async () => {
        await hybridWithCached("Media/rev1.mp4", "/cache/dir/rev1.mp4")
        expect(resolveRemoteMedia("/cache/dir/rev1.mp4")).toBe("Media/rev1.mp4")
    })

    it("tolerates file:// and separator variants on lookup", async () => {
        await hybridWithCached("Media/rev2.mp4", "/cache/dir/rev2.mp4")
        expect(resolveRemoteMedia("file:///cache/dir/rev2.mp4")).toBe("Media/rev2.mp4")
    })

    it("returns empty for unknown, empty, and remote paths", async () => {
        await hybridWithCached("Media/rev3.mp4", "/cache/dir/rev3.mp4")
        expect(resolveRemoteMedia("/cache/dir/never-seen.mp4")).toBe("")
        expect(resolveRemoteMedia("")).toBe("")
        expect(resolveRemoteMedia(undefined as any)).toBe("")
        expect(resolveRemoteMedia("Media/rev3.mp4")).toBe("")
    })

    it("toRemoteMediaPath is identity for remote and unknown paths", async () => {
        await hybridWithCached("Media/rev4.mp4", "/cache/dir/rev4.mp4")
        expect(toRemoteMediaPath("/cache/dir/rev4.mp4")).toBe("Media/rev4.mp4")
        expect(toRemoteMediaPath("Media/rev4.mp4")).toBe("Media/rev4.mp4")
        expect(toRemoteMediaPath("/cache/dir/unknown.mp4")).toBe("/cache/dir/unknown.mp4")
        expect(toRemoteMediaPath("")).toBe("")
    })

    it("drops the reverse entry when the mapping is evicted", async () => {
        await hybridWithCached("Media/rev5.mp4", "/cache/dir/rev5.mp4")
        expect(resolveRemoteMedia("/cache/dir/rev5.mp4")).toBe("Media/rev5.mp4")
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_GET) return { cached: false, localPath: null }
            return { requested: 1, downloaded: 1, skipped: 0, failed: [], bytes: 1, evicted: ["Media/rev5.mp4"] }
        })
        await prefetchRemotePaths(["Media/rev5b.mp4"])
        expect(resolveRemoteMedia("/cache/dir/rev5.mp4")).toBe("")
    })

    it("drops every reverse entry on clear", async () => {
        await hybridWithCached("Media/rev6.mp4", "/cache/dir/rev6.mp4")
        expect(resolveRemoteMedia("/cache/dir/rev6.mp4")).toBe("Media/rev6.mp4")
        h.requestMain.mockImplementation(async (channel: string) => {
            if (channel === Main.MEDIA_CACHE_CLEAR) return { clearedFiles: 1, freedBytes: 1 }
            return null
        })
        await clearMediaCacheUI()
        expect(resolveRemoteMedia("/cache/dir/rev6.mp4")).toBe("")
    })
})
