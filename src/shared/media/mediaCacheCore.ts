// ----- FreeShow -----
// Core of the persistent remote-media cache (platform-agnostic; the Electron main
// process and unit tests both use it).
//
// STRATEGY (project-level prefetch + hash validation):
// - On project/show open the client collects every media path the project needs
//   (see collectShowMedia.ts) and prefetches it: POST /media/manifest for
//   { size, mtimeMs, hash }, download only what is missing or stale.
// - Freshness = same size + same mtime (≈2ms tolerance for float round-trips) +
//   same content hash when known on both sides. A changed server file therefore
//   re-downloads automatically; an unchanged one plays from local disk.
// - Files are stored as <sha1(remotePath)>.<ext> under the cache dir with a
//   manifest.json mapping remote path -> entry. The cache is persistent ("never
//   delete" by default up to a size cap, then LRU) so a Sunday service plays
//   even on a poor link — or fully offline when everything is cached.
// - Downloads stream to tmp + rename (never a half-written cache hit) and are
//   hash-verified when the server knows the hash.

import { createHash, randomBytes } from "crypto"
import fs from "fs"
import path from "path"
import { pipeline, Readable } from "stream"
import { promisify } from "util"

const pipelineAsync = promisify(pipeline)

export interface RemoteMediaMeta {
    /** sandbox-relative path (the stable cache key) */
    path: string
    size: number
    mtimeMs: number
    /** sha1 of the content; null when the server hasn't hashed it yet */
    hash: string | null
    mime: string
}

export interface CacheEntry {
    remotePath: string
    /** file name inside the cache dir */
    file: string
    size: number
    mtimeMs: number
    hash: string | null
    mime: string
    lastUsed: number
    downloadedAt: number
}

export interface CacheManifest {
    version: 1
    entries: Record<string, CacheEntry>
}

export const MEDIA_CACHE_MANIFEST = "manifest.json"
/** Default cap before LRU eviction kicks in (20 GiB; 0 = unlimited). */
export const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024

export function normalizeCacheKey(remotePath: string): string {
    let p = remotePath.trim().replace(/\\/g, "/")
    if (p.startsWith("file://")) p = p.slice("file://".length)
    // collapse duplicate slashes (but keep a leading one for absolute paths)
    p = p.replace(/\/{2,}/g, "/")
    return p
}

function safeExt(remotePath: string): string {
    const raw = path
        .extname(remotePath)
        .slice(1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
    return raw.slice(0, 10) || "bin"
}

/** Deterministic file name for a remote path: <sha1(key)>.<ext>. */
export function cacheFileName(remotePath: string): string {
    const key = normalizeCacheKey(remotePath)
    return `${createHash("sha1").update(key).digest("hex")}.${safeExt(key)}`
}

/** File names we ever write: <sha1>.<ext>. Anything else is not ours. */
const CACHE_FILE_RE = /^[a-f0-9]{40}\.[a-z0-9]{1,10}$/

export function loadManifest(cacheDir: string): CacheManifest {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, MEDIA_CACHE_MANIFEST), "utf8"))
        if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            // validate: entry.file flows into path.join/unlink, so a tampered manifest
            // must not escape the cache dir (drop anything we didn't write)
            const entries: Record<string, CacheEntry> = {}
            for (const [key, entry] of Object.entries<any>(parsed.entries)) {
                if (typeof key !== "string" || !entry || typeof entry !== "object") continue
                if (typeof entry.file !== "string" || !CACHE_FILE_RE.test(entry.file)) continue
                if (typeof entry.remotePath !== "string") continue
                entries[key] = entry as CacheEntry
            }
            return { version: 1, entries }
        }
    } catch {
        // missing or corrupt -> start fresh (stale files are orphaned, not served)
    }
    return { version: 1, entries: {} }
}

export function saveManifest(cacheDir: string, manifest: CacheManifest): void {
    fs.mkdirSync(cacheDir, { recursive: true })
    const target = path.join(cacheDir, MEDIA_CACHE_MANIFEST)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(manifest))
    fs.renameSync(tmp, target)
}

/** mtimeMs survives a JSON round-trip with sub-millisecond wobble; tolerate it. */
export function mtimeEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < 2
}

/**
 * True when the cached entry is current for the server's meta. A hash mismatch
 * (both known) or size/mtime drift means the server file changed -> re-download.
 * Unknown hashes (either side) fall back to size+mtime.
 */
export function isEntryFresh(entry: CacheEntry, meta: RemoteMediaMeta): boolean {
    if (entry.size !== meta.size) return false
    if (!mtimeEqual(entry.mtimeMs, meta.mtimeMs)) return false
    if (entry.hash && meta.hash && entry.hash !== meta.hash) return false
    return true
}

export interface ResolvedCacheHit {
    entry: CacheEntry
    localPath: string
    /** true when the lastUsed touch actually changed the entry (caller can skip saving) */
    touched: boolean
}

/**
 * Manifest entry + file-on-disk check. Touches lastUsed (minute bucket) in the
 * passed manifest; the caller decides when to persist it.
 */
export function resolveCachedEntry(cacheDir: string, manifest: CacheManifest, remotePath: string): ResolvedCacheHit | null {
    const key = normalizeCacheKey(remotePath)
    const entry = manifest.entries[key]
    if (!entry) return null
    const localPath = path.join(cacheDir, entry.file)
    try {
        if (!fs.statSync(localPath).isFile()) return null
    } catch {
        return null
    }
    const bucket = Math.floor(Date.now() / 60000)
    let touched = false
    if (Math.floor(entry.lastUsed / 60000) !== bucket) {
        entry.lastUsed = Date.now()
        touched = true
    }
    return { entry, localPath, touched }
}

/**
 * Merge a set of entries into the on-disk manifest (reload + overlay + save).
 * Prefetches and playback lookups interleave in one process; a blind
 * read-modify-write would drop the other call's entries (last save wins).
 */
export function mergeAndSaveManifest(cacheDir: string, updated: Record<string, CacheEntry>): CacheManifest {
    const fresh = loadManifest(cacheDir)
    for (const [key, entry] of Object.entries(updated)) fresh.entries[key] = entry
    saveManifest(cacheDir, fresh)
    return fresh
}

/**
 * Resolve + persist the lastUsed touch, merged so a concurrent prefetch's
 * entries are never clobbered. No-op write when nothing changed. A failing
 * touch-save (e.g. ENOSPC) never fails the lookup — the hit is still served.
 */
export function touchCacheEntry(cacheDir: string, remotePath: string): ResolvedCacheHit | null {
    const manifest = loadManifest(cacheDir)
    const hit = resolveCachedEntry(cacheDir, manifest, remotePath)
    if (!hit) return null
    if (hit.touched) {
        try {
            mergeAndSaveManifest(cacheDir, { [normalizeCacheKey(remotePath)]: hit.entry })
        } catch {
            // write failed: keep serving the hit, skip the LRU touch
        }
    }
    return hit
}

export interface CacheStats {
    files: number
    bytes: number
}

export function getCacheStats(cacheDir: string, manifest: CacheManifest): CacheStats {
    let files = 0
    let bytes = 0
    for (const entry of Object.values(manifest.entries)) {
        try {
            const stat = fs.statSync(path.join(cacheDir, entry.file))
            if (stat.isFile()) {
                files++
                bytes += stat.size
            }
        } catch {
            // missing file: contributes nothing (pruned on next prefetch)
        }
    }
    return { files, bytes }
}

/**
 * Drop manifest entries whose files are gone, then LRU-evict oldest-used files
 * until under maxBytes (0 = unlimited, "never delete"). Returns what was evicted.
 */
export function evictIfNeeded(cacheDir: string, manifest: CacheManifest, maxBytes: number): { evicted: string[]; freedBytes: number } {
    const evicted: string[] = []
    let freedBytes = 0

    // prune entries with no file first (no bytes freed, keeps the manifest honest)
    for (const [key, entry] of Object.entries(manifest.entries)) {
        try {
            if (!fs.statSync(path.join(cacheDir, entry.file)).isFile()) delete manifest.entries[key]
        } catch {
            delete manifest.entries[key]
        }
    }

    if (!(maxBytes > 0)) return { evicted, freedBytes }

    let total = 0
    const sized: { key: string; size: number; lastUsed: number }[] = []
    for (const [key, entry] of Object.entries(manifest.entries)) {
        let size = 0
        try {
            size = fs.statSync(path.join(cacheDir, entry.file)).size
        } catch {
            continue
        }
        total += size
        sized.push({ key, size, lastUsed: entry.lastUsed })
    }

    sized.sort((a, b) => a.lastUsed - b.lastUsed)
    for (const { key, size } of sized) {
        if (total <= maxBytes) break
        const entry = manifest.entries[key]
        try {
            fs.unlinkSync(path.join(cacheDir, entry.file))
        } catch {
            // keep the entry dropped even if the unlink failed
        }
        delete manifest.entries[key]
        evicted.push(key)
        freedBytes += size
        total -= size
    }

    return { evicted, freedBytes }
}

/** Streaming sha1 (never buffers the whole file). */
export function hashFile(absPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha1")
        const stream = fs.createReadStream(absPath)
        stream.on("error", reject)
        stream.on("data", (chunk) => hash.update(chunk))
        stream.on("end", () => resolve(hash.digest("hex")))
    })
}

export type FetchImpl = typeof fetch

export interface PrefetchOptions {
    cacheDir: string
    /** remote paths (as stored in shows: sandbox-relative or absolute-in-sandbox) */
    paths: string[]
    /** server origin, e.g. http://192.168.1.10:8080 ("" = page origin, unused in main) */
    baseUrl: string
    token: string
    concurrency?: number
    maxBytes?: number
    fetchImpl?: FetchImpl
    onFileProgress?: (info: { remotePath: string; name: string; progress: number; total: number; status: "downloading" | "complete" | "error" }) => void
}

export interface PrefetchResult {
    requested: number
    downloaded: number
    skipped: number
    failed: { path: string; reason: string }[]
    bytes: number
    evicted: string[]
}

function manifestUrl(baseUrl: string): string {
    return `${baseUrl}/media/manifest`
}

function mediaUrl(baseUrl: string, remotePath: string): string {
    return `${baseUrl}/media?${new URLSearchParams({ path: remotePath }).toString()}`
}

function metaUrl(baseUrl: string, remotePath: string): string {
    return `${baseUrl}/media/meta?${new URLSearchParams({ path: remotePath }).toString()}`
}

/** Auth header for programmatic fetches (keeps the token out of server access logs). */
function authHeaders(token: string): Record<string, string> {
    return token ? { "X-Freeshow-Token": token } : {}
}

/** Bounded wait for small control requests (manifest/meta); downloads stream unbounded. */
function controlSignal(timeoutMs = 30000): AbortSignal | undefined {
    try {
        return AbortSignal.timeout(timeoutMs)
    } catch {
        return undefined // older fetch shims without AbortSignal.timeout
    }
}

async function streamToFile(fetchImpl: FetchImpl, url: string, headers: Record<string, string>, destTmp: string, onBytes?: (bytes: number) => void): Promise<void> {
    const res = await fetchImpl(url, Object.keys(headers).length ? { headers } : undefined)
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
    fs.mkdirSync(path.dirname(destTmp), { recursive: true })
    const fileStream = fs.createWriteStream(destTmp)
    try {
        const body = Readable.fromWeb(res.body as any)
        if (onBytes) body.on("data", (chunk: any) => onBytes(chunk.length))
        // pipeline resolves only after the file is fully written AND closed, so a
        // subsequent rename/stat can never race an open fd (Windows EPERM).
        await pipelineAsync(body, fileStream)
    } catch (err) {
        fs.unlink(destTmp, () => {
            /* best-effort cleanup of the partial tmp file */
        })
        throw err
    }
}

/** Unique tmp name per download (overlapping prefetches must never share one). */
function tmpDownloadPath(cacheDir: string, file: string): string {
    return path.join(cacheDir, `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
}

async function renameForCache(tmp: string, target: string): Promise<void> {
    // On Windows a rename over a currently-playing file fails; one short retry
    // before giving up (the failure is per-file and reported, never fatal).
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.renameSync(tmp, target)
            return
        } catch (err: any) {
            const retryable = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES"
            if (!retryable || attempt > 0) throw err
            await new Promise((r) => setTimeout(r, 150))
        }
    }
}

/**
 * Prefetch a set of remote paths into the local cache (project-level: pass the
 * whole project's closure). Downloads only missing/stale files, verifies sizes
 * and hashes, updates the manifest, and LRU-evicts over the cap. Never throws
 * for per-file failures — they land in `failed` so one bad file can't break
 * the whole service's prefetch.
 */
export async function prefetchMedia(options: PrefetchOptions): Promise<PrefetchResult> {
    const { cacheDir, baseUrl, token } = options
    const fetchImpl = options.fetchImpl || fetch
    const concurrency = Math.max(1, options.concurrency || 3)
    const configuredMax = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES
    const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 0 // 0 = unlimited
    const headers = authHeaders(token || "")

    // dedupe by NORMALIZED key (raw strings like `Media\a.png` vs `Media/a.png`
    // would otherwise queue the same file twice and race on one tmp path)
    const byKey = new Map<string, string>()
    for (const p of options.paths || []) {
        if (typeof p !== "string" || !p.trim()) continue
        const key = normalizeCacheKey(p)
        if (!byKey.has(key)) byKey.set(key, p)
    }
    const unique = [...byKey.values()]
    const result: PrefetchResult = { requested: unique.length, downloaded: 0, skipped: 0, failed: [], bytes: 0, evicted: [] }
    if (!unique.length) return result

    const manifest = loadManifest(cacheDir)
    // keys this call wrote/touched — merged over a fresh manifest at save time so
    // overlapping prefetches can't clobber each other's entries (M3)
    const touched = new Map<string, CacheEntry>()

    // 1. batch meta from the server
    let metas: (RemoteMediaMeta & { requested?: string })[]
    try {
        const res = await fetchImpl(manifestUrl(baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ paths: unique }),
            signal: controlSignal()
        })
        if (!res.ok) throw new Error(`manifest failed: ${res.status}`)
        const parsed = (await res.json()) as { files: RemoteMediaMeta[]; missing: { path: string; reason: string }[] }
        metas = parsed.files || []
        for (const m of parsed.missing || []) result.failed.push({ path: m.path, reason: m.reason })
    } catch (err) {
        // manifest unreachable (offline?): everything fails, but previously cached
        // files still play — the cache is the offline fallback, not the manifest
        for (const p of unique) result.failed.push({ path: p, reason: (err as Error)?.message || "manifest_failed" })
        return result
    }

    // requested path -> meta (the server keys by sandbox-relative path; the
    // request may have used an absolute-in-sandbox form, so match both — but only
    // on the FULL relative path, never a bare basename, which could match a
    // same-named file in another folder)
    const byRequested = new Map<string, RemoteMediaMeta>()
    const byRel = new Map<string, RemoteMediaMeta>()
    for (const meta of metas) {
        byRel.set(normalizeCacheKey(meta.path), meta)
    }
    for (const requested of unique) {
        const key = normalizeCacheKey(requested)
        const meta = byRel.get(key) || [...byRel.entries()].find(([rel]) => key.endsWith("/" + rel))?.[1]
        if (meta) byRequested.set(requested, meta)
        else if (!result.failed.find((f) => f.path === requested)) result.failed.push({ path: requested, reason: "no_meta" })
    }

    // 2. download what's missing/stale (bounded concurrency)
    const queue = [...byRequested.entries()]
    const workers: Promise<void>[] = []
    for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
        workers.push(
            (async () => {
                while (queue.length) {
                    const [requested, meta] = queue.shift()!
                    await prefetchOne(requested, meta)
                }
            })()
        )
    }
    await Promise.all(workers)

    async function prefetchOne(requested: string, meta: RemoteMediaMeta) {
        const key = normalizeCacheKey(meta.path)
        const name = key.split("/").pop() || key
        const existing = manifest.entries[key]

        // fresh hit (entry + file on disk, local size re-checked): skip the download.
        // A newly-known server hash is only adopted after hashing the local bytes —
        // adopting it blind would mark possibly-stale bytes as hash-verified.
        if (existing && isEntryFresh(existing, meta)) {
            try {
                const localPath = path.join(cacheDir, existing.file)
                const localStat = fs.statSync(localPath)
                if (localStat.isFile() && localStat.size === meta.size) {
                    if (!existing.hash && meta.hash) {
                        if ((await hashFile(localPath)) !== meta.hash) throw new Error("stale")
                        existing.hash = meta.hash
                    }
                    existing.lastUsed = Date.now()
                    touched.set(key, existing)
                    result.skipped++
                    return
                }
            } catch {
                // missing/corrupt/stale local file -> fall through to download
            }
        }

        const report = (progress: number, total: number, status: "downloading" | "complete" | "error") => options.onFileProgress?.({ remotePath: key, name, progress, total, status })

        const file = cacheFileName(key)
        const tmp = tmpDownloadPath(cacheDir, file)
        try {
            report(0, meta.size, "downloading")
            let progress = 0
            await streamToFile(fetchImpl, mediaUrl(baseUrl, requested), headers, tmp, (bytes) => {
                progress += bytes
                report(progress, meta.size, "downloading")
            })

            const stat = fs.statSync(tmp)
            if (stat.size !== meta.size) throw new Error(`size mismatch (got ${stat.size}, want ${meta.size})`)

            // hash-verify: prefer the manifest's hash; when the server hadn't
            // hashed yet, ask for single-file meta (computes + caches it there)
            let hash = meta.hash
            if (!hash) {
                try {
                    const res = await fetchImpl(metaUrl(baseUrl, requested), { headers, signal: controlSignal() })
                    if (res.ok) hash = ((await res.json()) as RemoteMediaMeta).hash || null
                } catch {
                    // offline mid-prefetch: keep the bytes, verify by size only
                }
            }
            if (hash) {
                const actual = await hashFile(tmp)
                if (actual !== hash) throw new Error("hash mismatch")
            }

            await renameForCache(tmp, path.join(cacheDir, file))
            const entry: CacheEntry = {
                remotePath: key,
                file,
                size: meta.size,
                mtimeMs: meta.mtimeMs,
                hash,
                mime: meta.mime,
                lastUsed: Date.now(),
                downloadedAt: Date.now()
            }
            manifest.entries[key] = entry
            touched.set(key, entry)
            result.downloaded++
            result.bytes += meta.size
            report(meta.size, meta.size, "complete")
        } catch (err) {
            fs.unlink(tmp, () => {
                /* best-effort cleanup of the partial tmp file */
            })
            result.failed.push({ path: requested, reason: (err as Error)?.message || "download_failed" })
            report(0, meta.size, "error")
        }
    }

    // 3. merge our touched entries over a FRESH manifest (a concurrent prefetch or
    // playback touch may have saved since we loaded), then enforce the cap
    const merged = loadManifest(cacheDir)
    for (const [key, entry] of touched) merged.entries[key] = entry
    const { evicted } = evictIfNeeded(cacheDir, merged, maxBytes)
    result.evicted = evicted
    saveManifest(cacheDir, merged)

    return result
}

/** Remove all cached files + the manifest (manual "clear cache"). */
export function clearMediaCache(cacheDir: string): { clearedFiles: number; freedBytes: number } {
    const manifest = loadManifest(cacheDir)
    let clearedFiles = 0
    let freedBytes = 0
    const removeFile = (file: string) => {
        try {
            const size = fs.statSync(path.join(cacheDir, file)).size
            fs.unlinkSync(path.join(cacheDir, file))
            freedBytes += size
            clearedFiles++
        } catch {
            // already gone (bytes only counted when the unlink succeeded)
        }
    }
    for (const entry of Object.values(manifest.entries)) removeFile(entry.file)
    // also sweep partial downloads (*.tmp) and orphaned cache files (e.g. left behind
    // when a corrupt manifest was reset) — only our own file-name shapes, never the manifest
    try {
        const referenced = new Set(Object.values(manifest.entries).map((e) => e.file))
        for (const name of fs.readdirSync(cacheDir)) {
            if (name === MEDIA_CACHE_MANIFEST || referenced.has(name)) continue
            if (name.includes(".tmp") || CACHE_FILE_RE.test(name)) removeFile(name)
        }
    } catch {
        // cache dir missing — nothing to sweep
    }
    saveManifest(cacheDir, { version: 1, entries: {} })
    return { clearedFiles, freedBytes }
}
