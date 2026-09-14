// ----- FreeShow -----
// Electron-side remote-media cache: this machine's persistent disk copy of the
// server's library media, so a hybrid desktop client plays shows locally even on
// a low-bandwidth link (or offline, when the project was prefetched).
//
// All logic lives in the portable core (src/shared/media/mediaCacheCore.ts);
// this module only supplies the local cache dir and the IPC-callable handlers.
// FREESHOW_MEDIA_CACHE_DIR overrides the location (used by tests so they never
// touch the real app-data folder).

import path from "path"
import { clearMediaCache as clearCore, DEFAULT_MAX_CACHE_BYTES, getCacheStats, loadManifest, prefetchMedia, touchCacheEntry } from "../../shared/media/mediaCacheCore"
import { sendToMain } from "../IPC/main"
import { appDataPath } from "./store"
import { ToMain } from "../../types/IPC/ToMain"

export function getMediaCacheDir(): string {
    if (process.env.FREESHOW_MEDIA_CACHE_DIR) return process.env.FREESHOW_MEDIA_CACHE_DIR
    return path.join(appDataPath, "remote-media-cache")
}

/** Resolve one remote path to a local cached file (no downloading — fast path for playback). */
export function getCachedMedia(data: { path: string }): { path: string; localPath: string | null; cached: boolean } | null {
    if (!data?.path || typeof data.path !== "string") return null
    try {
        const hit = touchCacheEntry(getMediaCacheDir(), data.path)
        if (hit) return { path: data.path, localPath: hit.localPath, cached: true }
        return { path: data.path, localPath: null, cached: false }
    } catch {
        // a failing touch-save (e.g. ENOSPC) must not break playback lookup
        return { path: data.path, localPath: null, cached: false }
    }
}

/** Prefetch a set of remote paths (project/show closure) into the local cache. */
export async function prefetchCachedMedia(data: { paths: string[]; serverUrl: string; token?: string; maxBytes?: number }) {
    const cacheDir = getMediaCacheDir()
    return prefetchMedia({
        cacheDir,
        paths: data?.paths || [],
        baseUrl: data?.serverUrl || "",
        token: data?.token || "",
        maxBytes: data?.maxBytes ?? DEFAULT_MAX_CACHE_BYTES,
        onFileProgress: ({ remotePath, name, progress, total, status }) => {
            // reuse the existing download-progress UI (keyed by url)
            sendToMain(ToMain.MEDIA_DOWNLOAD_PROGRESS, { url: remotePath, name, progress, total, status })
        }
    })
}

export function getMediaCacheStatus(): { files: number; bytes: number; dir: string } {
    const cacheDir = getMediaCacheDir()
    const stats = getCacheStats(cacheDir, loadManifest(cacheDir))
    return { ...stats, dir: cacheDir }
}

export function clearMediaCache(): { clearedFiles: number; freedBytes: number } {
    return clearCore(getMediaCacheDir())
}
