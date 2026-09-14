// ----- FreeShow -----
// Remote-media cache client: keeps a hybrid desktop's local disk copy of the
// server's library media warm, so shows play locally on low-bandwidth links.
//
// - On project/show open we collect every media path the project (or show) needs
//   and ask the LOCAL main process to prefetch it (MEDIA_CACHE_PREFETCH). Fresh
//   files are skipped by hash/size/mtime; only missing/stale bytes download.
// - Playback stays cache-first: encodeFilePath()/getMedia() consult the local
//   map populated here and use a cached file:// path when available, otherwise
//   they fall back to the /media gateway URL (and queue a background fetch).
// - Pure web clients have no local main process; they warm the browser HTTP
//   cache for smaller files instead (best-effort, same triggers).

import { get } from "svelte/store"
import { collectMediaPathsFromProject, collectMediaPathsFromShow } from "../../shared/media/collectShowMedia"
import { decideLibraryReconcile } from "../../shared/media/mediaLibraryVersion"
import { Main } from "../../types/IPC/Main"
import { requestMain } from "../IPC/main"
import { getConnectionToken, getRemoteServerConfig, isSocketTransport } from "../IPC/transport"
import { activeProject, activeShow, connectionStatus, mediaLibraryVersion, overlays, projects, showsCache, special, templates } from "../stores"
import { newToast } from "./common"
import { getServerMediaUrl } from "./mediaGateway"

function isWebBuild(): boolean {
    return (import.meta as any).env?.VITE_TARGET === "web"
}

/** Desktop connected to a remote server: library lives remotely, disk is local. */
export function isHybridDesktop(): boolean {
    return !isWebBuild() && !!getRemoteServerConfig()
}

export function isMediaCacheEnabled(): boolean {
    return get(special)?.remoteMediaCache !== false
}

// ----- local-path map (sync fast path for encodeFilePath) -----

// mirrors normalizeCacheKey in mediaCacheCore.ts (kept local: the core is node-only)
export function normalizeKey(remotePath: string): string {
    let p = remotePath.trim().replace(/\\/g, "/")
    if (p.startsWith("file://")) p = p.slice("file://".length)
    return p.replace(/\/{2,}/g, "/")
}

const localByRemote = new Map<string, string>()
const knownLocalPaths = new Set<string>()

function rememberMapping(remotePath: string, localPath: string) {
    const key = normalizeKey(remotePath)
    if (localByRemote.get(key) === localPath) return
    localByRemote.set(key, localPath)
    knownLocalPaths.add(localPath)
    ownKeys.add(key)
    mapDirty = true
    void scheduleMapSnapshot()
}

/** Sync lookup for the render path: remote path -> cached local file ("" when not cached). */
export function resolveLocalMedia(remotePath: string): string {
    if (typeof remotePath !== "string" || !remotePath) return ""
    loadMapSnapshotIfStale()
    return localByRemote.get(normalizeKey(remotePath)) || ""
}

// ----- cross-window map snapshot -----
// Output windows render remote paths (e.g. backgrounds for direct video items) but
// never warm their own map, so without sharing they would always stream from the
// gateway. The main window persists its map to localStorage (shared by all windows
// of the desktop app); other windows merge it on lookup when the version changed.

const MAP_KEY = "freeshow_media_map"
const MAP_VERSION_KEY = "freeshow_media_map_version"
const MAP_CLEAR_KEY = "freeshow_media_map_clear_gen"
const MAX_SNAPSHOT_ENTRIES = 5000
let mapDirty = false
let seenMapVersion = ""
let seenClearGen = 0
let snapshotTimer: ReturnType<typeof setTimeout> | null = null
/** keys this window resolved itself (kept across snapshot replaces; pruned on forget) */
const ownKeys = new Set<string>()
/** keys dropped since the last persist (propagates evictions to other windows) */
let pendingDropped: string[] = []

function scheduleMapSnapshot() {
    if (snapshotTimer) return
    snapshotTimer = setTimeout(() => {
        snapshotTimer = null
        persistMapSnapshot()
    }, 500)
}

function persistMapSnapshot() {
    if (!mapDirty) return
    mapDirty = false
    try {
        if (typeof localStorage === "undefined") return
        const entries = [...localByRemote.entries()].slice(-MAX_SNAPSHOT_ENTRIES)
        const dropped = pendingDropped.slice(-2000)
        pendingDropped = []
        localStorage.setItem(MAP_KEY, JSON.stringify({ entries, dropped, clearGen: seenClearGen }))
        const version = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        seenMapVersion = version
        localStorage.setItem(MAP_VERSION_KEY, version)
    } catch {
        // storage disabled/quota — this window still has its in-memory map
    }
}

/**
 * Adopt the shared snapshot when another window published a newer version.
 * Replace (not merge) so deletions propagate; entries this window resolved
 * itself are re-applied on top unless they were dropped/cleared elsewhere.
 * Never marks dirty (avoids persist ping-pong).
 */
function loadMapSnapshotIfStale() {
    try {
        if (typeof localStorage === "undefined") return
        // a clear broadcasts immediately (the versioned snapshot follows ≤500ms later)
        const storedClearGen = Number(localStorage.getItem(MAP_CLEAR_KEY)) || 0
        if (storedClearGen > seenClearGen) {
            seenClearGen = storedClearGen
            localByRemote.clear()
            knownLocalPaths.clear()
            ownKeys.clear()
            resolveGeneration++
        }
        const version = localStorage.getItem(MAP_VERSION_KEY) || ""
        if (!version || version === seenMapVersion) return
        seenMapVersion = version
        const parsed = JSON.parse(localStorage.getItem(MAP_KEY) || "[]")
        // tolerate the legacy bare-array shape
        const entries: unknown = Array.isArray(parsed) ? parsed : parsed?.entries
        const dropped: unknown = Array.isArray(parsed) ? [] : parsed?.dropped
        const clearGen = Number(!Array.isArray(parsed) && parsed?.clearGen) || 0
        if (!Array.isArray(entries)) return
        if (clearGen > seenClearGen) {
            // a clear happened elsewhere: drop everything including own entries
            seenClearGen = clearGen
            localByRemote.clear()
            knownLocalPaths.clear()
            ownKeys.clear()
            resolveGeneration++
        }
        const own: [string, string][] = []
        for (const key of ownKeys) {
            const value = localByRemote.get(key)
            if (value) own.push([key, value])
        }
        localByRemote.clear()
        knownLocalPaths.clear()
        for (const [remote, local] of entries) {
            if (typeof remote !== "string" || typeof local !== "string") continue
            localByRemote.set(remote, local)
            knownLocalPaths.add(local)
        }
        for (const [key, value] of own) {
            localByRemote.set(key, value)
            knownLocalPaths.add(value)
        }
        if (Array.isArray(dropped)) {
            for (const key of dropped) {
                if (typeof key !== "string") continue
                localByRemote.delete(key)
                ownKeys.delete(key)
            }
            // rebuild the reverse set after deletions
            knownLocalPaths.clear()
            for (const local of localByRemote.values()) knownLocalPaths.add(local)
        }
    } catch {
        // corrupt snapshot — ignore, lookups fall back to the gateway
    }
}

/** Drop mappings (eviction/clear) across this window; the snapshot follows on next persist. */
function forgetMappings(remoteKeys: string[] | null) {
    if (remoteKeys === null) {
        localByRemote.clear()
        knownLocalPaths.clear()
        ownKeys.clear()
        // a clear is broadcast via the clear generation, not the dropped list
        pendingDropped = []
        seenClearGen = Date.now()
        try {
            localStorage.setItem(MAP_CLEAR_KEY, String(seenClearGen))
        } catch {
            // storage disabled — in-memory state is already cleared
        }
    } else {
        for (const key of remoteKeys) {
            localByRemote.delete(key)
            ownKeys.delete(key)
        }
        pendingDropped.push(...remoteKeys)
        // rebuild the reverse set from what remains
        knownLocalPaths.clear()
        for (const local of localByRemote.values()) knownLocalPaths.add(local)
    }
    mapDirty = true
    void scheduleMapSnapshot()
}

// ----- cache-dir prefix (shared across windows) -----
// Output windows render local cached paths handed to them by the main window (e.g.
// out.background.path) without ever resolving the remote path themselves, so their
// in-memory map is empty. The cache-dir prefix — shared via localStorage, which all
// windows of the desktop app share — lets every window recognize those paths.

const CACHE_DIR_KEY = "freeshow_media_cache_dir"
let cacheDirPrefix = ""

function getCacheDirPrefix(): string {
    if (cacheDirPrefix) return cacheDirPrefix
    try {
        cacheDirPrefix = (typeof localStorage !== "undefined" && localStorage.getItem(CACHE_DIR_KEY)) || ""
    } catch {
        cacheDirPrefix = ""
    }
    return cacheDirPrefix
}

/** Fetch the local cache dir once per window and share it via localStorage. */
export async function warmCacheDirPrefix(): Promise<void> {
    if (!isHybridDesktop()) return
    if (getCacheDirPrefix()) return
    try {
        const status = await requestMain(Main.MEDIA_CACHE_STATUS)
        if (status?.dir) {
            cacheDirPrefix = status.dir.replace(/\\/g, "/")
            try {
                localStorage.setItem(CACHE_DIR_KEY, cacheDirPrefix)
            } catch {
                // storage disabled — this window still has the in-memory prefix
            }
        }
    } catch {
        // main unreachable — gateway fallback still plays
    }
}

/** True when this absolute path is a file in our media cache (already local). */
export function isCachedLocalPath(localPath: string): boolean {
    if (typeof localPath !== "string" || !localPath) return false
    if (knownLocalPaths.has(localPath)) return true
    // normalize for the prefix check: callers pass file:// URLs and Windows paths
    // with either separator or drive-letter case
    let p = localPath.trim()
    if (p.startsWith("file://")) p = p.slice("file://".length)
    p = p.replace(/\\/g, "/")
    if (/^[a-z]:\//i.test(p)) p = p[0].toUpperCase() + p.slice(1)
    if (knownLocalPaths.has(p)) return true
    const prefix = getCacheDirPrefix()
    if (!prefix) return false
    return p.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")
}

// bumped on clear so in-flight lookups can't resurrect mappings for deleted files
let resolveGeneration = 0

/** Async resolve: map hit, else a fast LOCAL main lookup (no downloading). */
export async function ensureLocalMedia(remotePath: string): Promise<string | null> {
    const hit = resolveLocalMedia(remotePath)
    if (hit) return hit
    if (!isHybridDesktop()) return null

    const myGeneration = resolveGeneration
    try {
        const res = await requestMain(Main.MEDIA_CACHE_GET, { path: remotePath })
        if (myGeneration !== resolveGeneration) return null // cleared while looking up
        if (res?.cached && res.localPath) {
            rememberMapping(remotePath, res.localPath)
            return res.localPath
        }
    } catch {
        // main unreachable — fall back to streaming
    }

    // miss during playback: queue a coalesced background fetch (see queueBackgroundFetch)
    queueBackgroundFetch(remotePath)
    return null
}

/**
 * Local path for file introspection (codec, subtitles, exif, audio metadata).
 * Local clients probe the path itself; remote clients can only probe their
 * persistent local cache copy — null when not cached, in which case the caller
 * must SKIP the probe rather than ask the local disk for a server file (that
 * is what spammed ENOENT stack traces from the mp4box prober).
 */
export async function resolveProbePath(filePath: string): Promise<string | null> {
    if (typeof filePath !== "string" || !filePath) return null
    if (!isSocketTransport()) return filePath
    if (!isHybridDesktop()) return null // web build: no local main process at all
    return ensureLocalMedia(filePath).catch(() => null)
}

/** Populate the map for already-cached paths (bounded concurrency, chunked). */
export async function warmLocalMap(paths: string[]): Promise<void> {
    if (!isHybridDesktop() || !paths.length) return
    const queue = [...new Set(paths)]
    const workers: Promise<void>[] = []
    for (let w = 0; w < Math.min(6, queue.length); w++) {
        workers.push(
            (async () => {
                while (queue.length) {
                    const p = queue.shift()!
                    if (resolveLocalMedia(p)) continue
                    try {
                        const res = await requestMain(Main.MEDIA_CACHE_GET, { path: p })
                        if (res?.cached && res.localPath) rememberMapping(p, res.localPath)
                    } catch {
                        // ignore — gateway fallback still plays
                    }
                }
            })()
        )
    }
    await Promise.all(workers)
}

// ----- collection -----

export function collectProjectPaths(projectId: string): string[] {
    const project = get(projects)[projectId]
    if (!project) return []
    return collectMediaPathsFromProject(project, { showsById: get(showsCache), overlays: get(overlays), templates: get(templates) })
}

export function collectShowPaths(showId: string): string[] {
    const show = get(showsCache)[showId]
    if (!show) return []
    return collectMediaPathsFromShow(show, { overlays: get(overlays), templates: get(templates) })
}

// ----- prefetch -----

export interface PrefetchSummary {
    requested: number
    downloaded: number
    skipped: number
    failed: { path: string; reason: string }[]
    bytes: number
    /** manifest keys evicted by LRU during this prefetch (mappings dropped) */
    evicted: string[]
}

const inFlight = new Set<string>()

/** Stable dedupe key over the FULL path set (a length+first-3 prefix collides). */
function prefetchKey(paths: string[]): string {
    const sorted = [...paths].sort().join("\n")
    let hash = 5381
    for (let i = 0; i < sorted.length; i++) hash = ((hash << 5) + hash + sorted.charCodeAt(i)) | 0
    return `prefetch:${paths.length}:${(hash >>> 0).toString(16)}`
}

function finishToast(label: string, r: PrefetchSummary) {
    if (r.downloaded > 0 && r.failed.length > 0) newToast(`Media cache (${label}): ${r.downloaded} downloaded, ${r.failed.length} failed`)
    else if (r.downloaded > 0) newToast(`Media cached (${label}): ${r.downloaded} file${r.downloaded === 1 ? "" : "s"} ready offline`)
    else if (r.failed.length > 0) newToast(`Media cache (${label}): ${r.failed.length} file${r.failed.length === 1 ? "" : "s"} unavailable`)
}

/** Prefetch explicit remote paths via the LOCAL main (hybrid only). */
export async function prefetchRemotePaths(paths: string[], options: { silent?: boolean; label?: string } = {}): Promise<PrefetchSummary | null> {
    if (!isHybridDesktop() || !paths.length) return null
    const remote = getRemoteServerConfig()
    if (!remote?.url) return null

    const key = prefetchKey(paths)
    if (inFlight.has(key)) return null
    inFlight.add(key)
    try {
        const res = await requestMain(Main.MEDIA_CACHE_PREFETCH, { paths, serverUrl: remote.url, token: getConnectionToken() }, undefined, 10 * 60 * 1000)
        if (!res) return null
        const summary: PrefetchSummary = { requested: res.requested, downloaded: res.downloaded, skipped: res.skipped, failed: res.failed, bytes: res.bytes, evicted: res.evicted || [] }
        if (summary.evicted.length) dropEvictedMappings(summary.evicted)
        if (!options.silent) finishToast(options.label || "media", summary)
        return summary
    } catch {
        return null
    } finally {
        inFlight.delete(key)
    }
}

/** Forget LRU-evicted mappings so playback re-resolves (gateway) instead of 404ing locally. */
function dropEvictedMappings(evicted: string[]) {
    forgetMappings(evicted.map((k) => normalizeKey(k)))
    invalidateCachedReplacedPaths()
}

/**
 * Forget mappings for server-deleted paths (trash broadcast): playback must
 * re-resolve (gateway 404 = missing) instead of serving a stale local copy.
 */
export function forgetLocalMediaMappings(remotePaths: string[]) {
    if (!Array.isArray(remotePaths) || !remotePaths.length) return
    forgetMappings(remotePaths.map((p) => normalizeKey(p)))
    invalidateCachedReplacedPaths()
}

// ----- library-version tracking (reconnect reconciliation) -----
// The server bumps a persisted epoch on every library mutation. Broadcasts
// carry it while connected; on reconnect we fetch TRASH_LIST (cheap, carries
// the epoch too) and compare — a mismatch means broadcasts were missed while
// away, so every mapping is dropped and playback re-resolves from the gateway.

const MAP_LIB_VERSION_KEY = "freeshow_media_lib_version"
let seenLibraryVersion: number | null = null

/** Adopt a server-reported epoch (broadcast / list / startup). Ignores garbage. */
export function noteMediaLibraryVersion(v: unknown) {
    if (typeof v !== "number" || !Number.isFinite(v)) return
    seenLibraryVersion = v
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(MAP_LIB_VERSION_KEY, String(v))
    } catch {
        // storage disabled — the in-memory baseline still covers this session
    }
}

/** Last-seen epoch: memory first, then the persisted baseline (cross-restart). */
export function getSeenMediaLibraryVersion(): number | null {
    if (typeof seenLibraryVersion === "number") return seenLibraryVersion
    try {
        if (typeof localStorage !== "undefined") {
            const stored = Number(localStorage.getItem(MAP_LIB_VERSION_KEY))
            if (Number.isFinite(stored)) seenLibraryVersion = stored
        }
    } catch {
        // storage disabled — no baseline
    }
    return seenLibraryVersion
}

/**
 * Revalidate after a reconnect: when the epoch moved while away, drop every
 * mapping + rendered-path entry (bytes stay on disk; prefetch re-resolves by
 * hash) and poke drawers to refresh. resolveGeneration is NOT bumped — that
 * guard is for in-flight resolves, and a reconnect has none of ours.
 */
export async function reconcileMediaLibraryAfterReconnect(): Promise<boolean> {
    const list = await requestMain(Main.TRASH_LIST).catch(() => null)
    const decision = decideLibraryReconcile(getSeenMediaLibraryVersion(), list?.v)
    noteMediaLibraryVersion(decision.seen)
    if (!decision.reconcile) return false
    invalidateCachedReplacedPaths()
    forgetMappings(null)
    mediaLibraryVersion.update((v) => ({ kind: "reconnected", n: v.n + 1 }))
    return true
}

// coalesced background fetch for cache misses during playback: N misses in quick
// succession become ONE manifest round-trip instead of N (F5)
const bgFetchQueue = new Set<string>()
let bgFetchTimer: ReturnType<typeof setTimeout> | null = null

function queueBackgroundFetch(remotePath: string) {
    if (!isHybridDesktop()) return
    bgFetchQueue.add(normalizeKey(remotePath))
    if (bgFetchTimer) return
    bgFetchTimer = setTimeout(async () => {
        bgFetchTimer = null
        const paths = [...bgFetchQueue]
        bgFetchQueue.clear()
        if (!paths.length) return
        try {
            const res = await prefetchRemotePaths(paths, { silent: true })
            if (res && res.downloaded > 0) void warmLocalMap(paths)
        } catch {
            // best-effort only — the gateway fallback already played
        }
    }, 500)
}

/** Prefetch a whole project's closure (assumes the project plays as a whole). */
export async function prefetchProjectMedia(projectId: string, options: { silent?: boolean } = {}): Promise<PrefetchSummary | null> {
    if (!isSocketTransport()) return null
    const paths = collectProjectPaths(projectId)
    if (!paths.length) return null

    if (!isHybridDesktop()) {
        // web client: warm the browser cache for smaller files (best-effort)
        void warmBrowserCache(paths)
        return null
    }

    const label = get(projects)[projectId]?.name || "project"
    const res = await prefetchRemotePaths(paths, { silent: options.silent, label })
    if (res && res.downloaded + res.skipped > 0) void warmLocalMap(paths)
    return res
}

/** Prefetch one show (drawer opens outside any project). */
export async function prefetchShowMedia(showId: string, options: { silent?: boolean } = {}): Promise<PrefetchSummary | null> {
    if (!isSocketTransport()) return null
    const paths = collectShowPaths(showId)
    if (!paths.length) return null

    if (!isHybridDesktop()) {
        void warmBrowserCache(paths)
        return null
    }

    const label = get(showsCache)[showId]?.name || "show"
    const res = await prefetchRemotePaths(paths, { silent: options.silent ?? true, label })
    if (res && res.downloaded + res.skipped > 0) void warmLocalMap(paths)
    return res
}

// ----- web fallback: warm the browser HTTP cache for smaller files -----

const WEB_WARM_MAX_BYTES = 20 * 1024 * 1024
const WEB_WARM_MAX_FILES = 200
const WEB_WARM_MAX_TOTAL_BYTES = 200 * 1024 * 1024

async function warmBrowserCache(paths: string[]): Promise<void> {
    const base = getRemoteServerConfig()?.url || ""
    const token = getConnectionToken()
    const unique = [...new Set(paths)].slice(0, WEB_WARM_MAX_FILES)
    if (!unique.length) return

    // ask for sizes first so we don't pull gigabytes into memory-temp fetch bodies
    const sizes = new Map<string, number>()
    try {
        const params = new URLSearchParams()
        if (token) params.set("token", token)
        const query = params.toString()
        const res = await fetch(`${base}/media/manifest${query ? `?${query}` : ""}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: unique })
        })
        if (res.ok) {
            const parsed = await res.json()
            for (const f of parsed.files || []) sizes.set(f.path, f.size)
        }
    } catch {
        return
    }

    const small = unique.filter((p) => {
        const size = sizes.get(p) ?? sizes.get(p.replace(/\\/g, "/"))
        return size !== undefined && size <= WEB_WARM_MAX_BYTES
    })
    // total budget as well: 200 small files could still be ~4 GB of fetch bodies
    let budget = WEB_WARM_MAX_TOTAL_BYTES
    const queue = small.filter((p) => {
        const size = sizes.get(p) ?? sizes.get(p.replace(/\\/g, "/")) ?? 0
        if (size > budget) return false
        budget -= size
        return true
    })
    const workers: Promise<void>[] = []
    for (let w = 0; w < Math.min(3, queue.length); w++) {
        workers.push(
            (async () => {
                while (queue.length) {
                    const p = queue.shift()!
                    try {
                        const res = await fetch(getServerMediaUrl(p))
                        // consume the body so the response lands in the HTTP cache
                        await res.arrayBuffer()
                    } catch {
                        // best-effort only
                    }
                }
            })()
        )
    }
    await Promise.all(workers)
}

// ----- auto-prefetch triggers -----

let initialized = false

export function initRemoteMediaCache() {
    if (initialized || !isSocketTransport()) return
    initialized = true

    // share the cache-dir prefix early so output windows recognize cached paths
    void warmCacheDirPrefix()

    let projectTimer: ReturnType<typeof setTimeout> | null = null
    let lastProjectSig = ""

    // project open -> prefetch the whole project (debounced: startup fires several)
    activeProject.subscribe((projectId) => {
        if (!projectId || !isMediaCacheEnabled()) return
        if (projectTimer) clearTimeout(projectTimer)
        projectTimer = setTimeout(() => void prefetchProjectMedia(projectId, { silent: true }), 800)
    })

    // show open outside the active project (drawer) -> prefetch just that show
    let lastShowId = ""
    activeShow.subscribe((ref) => {
        const id = ref?.id || ""
        if (!id || id === lastShowId || !isMediaCacheEnabled()) return
        lastShowId = id
        const project = get(projects)[get(activeProject) || ""]
        if (project?.shows?.find((s) => s.id === id)) return // covered by the project prefetch
        setTimeout(() => void prefetchShowMedia(id, { silent: true }), 800)
    })

    // shows load asynchronously after project open: prefetch only the DELTA (newly
    // loaded shows) instead of re-collecting the whole project every time (F6)
    let prefetchedShowIds = new Set<string>()
    showsCache.subscribe((cache) => {
        const projectId = get(activeProject)
        if (!projectId || !isMediaCacheEnabled()) return
        const project = get(projects)[projectId]
        if (!project) return
        const loaded = project.shows.map((s) => s.id).filter((id) => cache[id])
        const sig = [...loaded].sort().join(",")
        if (!sig || sig === lastProjectSig) return
        lastProjectSig = sig
        const fresh = loaded.filter((id) => !prefetchedShowIds.has(id))
        for (const id of loaded) prefetchedShowIds.add(id)
        if (!fresh.length) return
        if (projectTimer) clearTimeout(projectTimer)
        projectTimer = setTimeout(() => {
            const paths = fresh.flatMap((id) => collectShowPaths(id))
            if (!paths.length) return
            if (!isHybridDesktop()) {
                void warmBrowserCache(paths)
                return
            }
            void prefetchRemotePaths(paths, { silent: true, label: get(projects)[projectId]?.name || "project" }).then((res) => {
                if (res && res.downloaded + res.skipped > 0) void warmLocalMap(paths)
            })
        }, 1500)
    })

    // switching projects resets the delta tracker (the project subscriber prefetches whole)
    activeProject.subscribe((projectId) => {
        lastProjectSig = ""
        prefetchedShowIds = new Set<string>()
        if (!projectId) return
    })

    // reconnect after a drop: broadcasts were missed while away, so compare the
    // library epoch and revalidate when it moved (no-op on the initial connect)
    let wasAway = false
    connectionStatus.subscribe((status) => {
        if (status === "disconnected" || status === "reconnecting") {
            wasAway = true
            return
        }
        if (status === "connected" && wasAway) {
            wasAway = false
            void reconcileMediaLibraryAfterReconnect()
        }
    })
}

// ----- settings UI -----

// media.ts registers its replaced-paths invalidator here (avoids an import cycle)
let replacedPathsInvalidator: (() => void) | null = null
export function registerReplacedPathsInvalidator(fn: () => void) {
    replacedPathsInvalidator = fn
}

function invalidateCachedReplacedPaths() {
    try {
        replacedPathsInvalidator?.()
    } catch {
        // never break the cache flow on a UI-cache hiccup
    }
}

export async function getMediaCacheStatus(): Promise<{ files: number; bytes: number; dir: string } | null> {
    if (!isHybridDesktop()) return null
    try {
        return (await requestMain(Main.MEDIA_CACHE_STATUS)) || null
    } catch {
        return null
    }
}

export async function clearMediaCacheUI(): Promise<{ clearedFiles: number; freedBytes: number } | null> {
    if (!isHybridDesktop()) return null
    try {
        const res = await requestMain(Main.MEDIA_CACHE_CLEAR)
        if (res) {
            // drop every mapping + rendered-path cache entry so nothing serves
            // deleted files (invalidate BEFORE clearing, while paths still match)
            invalidateCachedReplacedPaths()
            forgetMappings(null)
            resolveGeneration++
            try {
                localStorage.removeItem(MAP_KEY)
                localStorage.removeItem(MAP_VERSION_KEY)
                seenMapVersion = ""
            } catch {
                // storage disabled — in-memory state is already cleared
            }
            return res
        }
        return null
    } catch {
        return null
    }
}

export function setMediaCacheEnabled(enabled: boolean) {
    special.update((a) => ({ ...a, remoteMediaCache: enabled }))
}
