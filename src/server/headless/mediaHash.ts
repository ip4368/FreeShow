// ----- FreeShow -----
// Content hashes for library media, backing the remote-media cache.
// GET /media/meta and POST /media/manifest report { size, mtimeMs, hash } per
// file so a client can validate its local copy without re-downloading bytes.
//
// Hashing a multi-GB video on every request would be too slow, so hashes are
// cached in <dataRoot>/Config/media-hashes.json keyed by sandbox-relative path,
// and invalidated when the file's mtime or size changes. The /media hot path
// never computes — it only attaches a cached hash header when one is available.

import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { getDataFolderPath, toSandboxRelative } from "./data/dataPaths"

interface HashEntry {
    mtimeMs: number
    size: number
    hash: string
}

type HashCache = Record<string, HashEntry>

let memoryCache: HashCache | null = null

function cacheFilePath(): string {
    return path.join(getDataFolderPath("userData"), "media-hashes.json")
}

function loadCache(): HashCache {
    if (memoryCache) return memoryCache
    try {
        const raw = fs.readFileSync(cacheFilePath(), "utf8")
        memoryCache = JSON.parse(raw || "{}")
    } catch {
        memoryCache = {}
    }
    return memoryCache!
}

function saveCache(cache: HashCache) {
    memoryCache = cache
    // atomic tmp+rename: a crash mid-write must not corrupt the cache file
    const target = cacheFilePath()
    const tmp = `${target}.${process.pid}.tmp`
    try {
        fs.writeFileSync(tmp, JSON.stringify(cache))
        fs.renameSync(tmp, target)
    } catch (err) {
        console.error("Failed to write media hash cache:", err)
        try {
            fs.unlinkSync(tmp)
        } catch {
            // best-effort cleanup
        }
    }
}

/** Cached hash for this exact file version, or null (no I/O on the media file itself). */
export function peekCachedHash(absPath: string, stat: fs.Stats): string | null {
    const rel = toSandboxRelative(absPath)
    const entry = loadCache()[rel]
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return entry.hash
    return null
}

/** Streaming sha1 of a file (never buffers the whole file in memory). */
export function hashFile(absPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha1")
        const stream = fs.createReadStream(absPath)
        stream.on("error", reject)
        stream.on("data", (chunk) => hash.update(chunk))
        stream.on("end", () => resolve(hash.digest("hex")))
    })
}

/**
 * Hash for the current version of a file, using the cache when the file is
 * unchanged. Falls back to a fresh computation (and cache update) otherwise.
 */
export async function getMediaHash(absPath: string, stat: fs.Stats): Promise<string> {
    const cached = peekCachedHash(absPath, stat)
    if (cached) return cached

    const hash = await hashFile(absPath)

    // re-stat: if the file changed WHILE hashing, don't cache a hash of a torn read
    let fresh: fs.Stats
    try {
        fresh = fs.statSync(absPath)
    } catch {
        return hash
    }
    if (fresh.mtimeMs === stat.mtimeMs && fresh.size === stat.size) {
        const cache = loadCache()
        cache[toSandboxRelative(absPath)] = { mtimeMs: stat.mtimeMs, size: stat.size, hash }
        saveCache(cache)
    }
    return hash
}

/** Only for tests — forget the in-memory cache (e.g. after setDataRoot). */
export function resetMediaHashCache() {
    memoryCache = null
}
