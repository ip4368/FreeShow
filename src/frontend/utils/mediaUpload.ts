// ----- FreeShow -----
// Client-side queue for media/audio uploads to a remote server (web build or a
// hybrid desktop connected to a server). Each queued file becomes a placeholder
// entry rendered at the top of the target drawer's folder — uploads keep running
// when the user navigates away, and placeholders are scoped by target folder so
// they reappear when navigating back.
//
// Completion needs no explicit refresh here: the server emits a
// MEDIA_LIBRARY_CHANGED broadcast on every upload, and the drawers already
// re-request their view on change — the real file simply replaces the placeholder.

import { get, writable } from "svelte/store"
import { uid } from "uid"
import type { UploadProgressOptions, UploadResult } from "./mediaGateway"

/** Injectable transport so tests can drive the queue without XHR/network. */
export type MediaUploader = (folderPath: string, file: File, options?: UploadProgressOptions) => Promise<UploadResult>

export type MediaUploadDrawer = "media" | "audio"
export type MediaUploadStatus = "queued" | "uploading" | "complete" | "error"

export interface MediaUpload {
    id: string
    drawer: MediaUploadDrawer
    folderPath: string
    fileName: string
    mime: string
    size: number
    status: MediaUploadStatus
    loaded: number
    total: number
    /** Local object-URL preview for images/video (null for audio/unknown). */
    previewUrl: string | null
    /** Short failure reason (only when status === "error"). */
    error: string
    /** Kept so failed uploads can retry without re-picking the file. */
    file: File
    /**
     * A library refresh already covered this folder since the upload started
     * (the broadcast usually beats the HTTP response), so skip the completion
     * linger — the real file is already listed.
     */
    skipLinger: boolean
}

/** Max simultaneous POSTs — enough to overlap latency, low enough to not fight itself. */
export const MAX_CONCURRENT_UPLOADS = 3
/** How long a finished placeholder lingers at 100% before the real file takes over. */
export const COMPLETE_HOLD_MS = 1500

export const mediaUploads = writable(new Map<string, MediaUpload>())

// Per-upload runtime handles (kept out of the store: never rendered, never serialized).
const abortControllers = new Map<string, AbortController>()
const uploaders = new Map<string, MediaUploader>()

function patchUpload(id: string, patch: Partial<MediaUpload>) {
    mediaUploads.update((current) => {
        const entry = current.get(id)
        if (!entry) return current
        const next = new Map(current)
        next.set(id, { ...entry, ...patch })
        return next
    })
}

function makePreviewUrl(file: File): string | null {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) return null
    try {
        if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") return URL.createObjectURL(file)
    } catch {
        // environments without blob URLs (or non-Blob files in tests) — no preview
    }
    return null
}

function revokePreview(entry: MediaUpload) {
    if (!entry.previewUrl) return
    try {
        URL.revokeObjectURL(entry.previewUrl)
    } catch {
        // already revoked — nothing to do
    }
}

/** Queue files for upload into a server folder. Returns the created entry ids. */
export function queueMediaUploads(folderPath: string, files: File[], drawer: MediaUploadDrawer, uploader: MediaUploader): string[] {
    if (!folderPath || !files.length) return []

    const ids: string[] = []
    mediaUploads.update((current) => {
        const next = new Map(current)
        for (const file of files) {
            const id = uid()
            ids.push(id)
            uploaders.set(id, uploader)
            next.set(id, {
                id,
                drawer,
                folderPath,
                fileName: file.name,
                mime: file.type,
                size: file.size,
                status: "queued",
                loaded: 0,
                total: file.size,
                previewUrl: makePreviewUrl(file),
                error: "",
                file,
                skipLinger: false
            })
        }
        return next
    })
    pumpQueue()
    return ids
}

function activeUploadCount(): number {
    let count = 0
    for (const entry of get(mediaUploads).values()) {
        if (entry.status === "uploading") count++
    }
    return count
}

/** Start queued uploads until all concurrency slots are filled. */
function pumpQueue() {
    while (activeUploadCount() < MAX_CONCURRENT_UPLOADS) {
        const next = [...get(mediaUploads).values()].find((entry) => entry.status === "queued")
        if (!next) return
        // flip synchronously so the next loop iteration sees the taken slot
        patchUpload(next.id, { status: "uploading" })
        void runUpload(next.id)
    }
}

async function runUpload(id: string) {
    const entry = get(mediaUploads).get(id)
    const uploader = uploaders.get(id)
    if (!entry || !uploader) return

    const controller = new AbortController()
    abortControllers.set(id, controller)

    let result: UploadResult
    try {
        result = await uploader(entry.folderPath, entry.file, {
            signal: controller.signal,
            onProgress: (loaded, total) => patchUpload(id, { loaded, total: total || entry.size })
        })
    } catch (err) {
        result = { ok: false, status: 0, error: err instanceof Error ? err.message : "upload failed" }
    } finally {
        abortControllers.delete(id)
    }

    // cancelled while in flight: cancelMediaUpload already removed the entry
    if (!get(mediaUploads).has(id)) {
        pumpQueue()
        return
    }
    if (result.aborted) {
        removeUpload(id)
        pumpQueue()
        return
    }
    if (result.ok) {
        // broadcast already refreshed this folder: the file is listed, drop the
        // placeholder at once instead of doubling it during the linger (re-read:
        // skipLinger may have been set while the upload was in flight)
        if (get(mediaUploads).get(id)?.skipLinger) {
            removeUpload(id)
        } else {
            patchUpload(id, { status: "complete", loaded: entry.size, total: entry.size })
            // linger at 100% so the completion reads, then let the broadcast refresh take over
            setTimeout(() => removeUpload(id), COMPLETE_HOLD_MS)
        }
    } else {
        patchUpload(id, { status: "error", error: result.error || `HTTP ${result.status}` })
    }
    pumpQueue()
}

function removeUpload(id: string) {
    const entry = get(mediaUploads).get(id)
    abortControllers.delete(id)
    uploaders.delete(id)
    if (!entry) return
    revokePreview(entry)
    mediaUploads.update((current) => {
        if (!current.has(id)) return current
        const next = new Map(current)
        next.delete(id)
        return next
    })
}

/** Abort an in-flight (or queued) upload and drop its placeholder. */
export function cancelMediaUpload(id: string) {
    // abort first: runUpload's post-await check then no-ops on the removed entry
    abortControllers.get(id)?.abort()
    abortControllers.delete(id)
    removeUpload(id)
    pumpQueue()
}

/** Re-queue a failed upload (no-op unless it errored). */
export function retryMediaUpload(id: string) {
    const entry = get(mediaUploads).get(id)
    if (!entry || entry.status !== "error") return
    patchUpload(id, { status: "queued", loaded: 0, total: entry.size, error: "", skipLinger: false })
    pumpQueue()
}

/** Drop a failed/finished placeholder without retrying. */
export function dismissMediaUpload(id: string) {
    removeUpload(id)
}

/**
 * A library broadcast just refreshed this folder: cut short any lingering
 * `complete` placeholders (their files are now listed) and mark in-flight ones
 * to skip the linger when they finish. Errors are left for the user to retry.
 */
export function acknowledgeFolderUploads(folderPath: string, drawer: MediaUploadDrawer) {
    if (!folderPath) return
    for (const entry of get(mediaUploads).values()) {
        if (entry.folderPath !== folderPath || entry.drawer !== drawer) continue
        if (entry.status === "complete") removeUpload(entry.id)
        else if (entry.status === "uploading" || entry.status === "queued") patchUpload(entry.id, { skipLinger: true })
    }
}

/**
 * Uploads to show for one drawer folder — drives placeholders + tray badge.
 * Takes the store Map (instead of `get()`) so components stay reactively subscribed.
 */
export function uploadsForFolder(uploads: Map<string, MediaUpload>, folderPath: string, drawer: MediaUploadDrawer): MediaUpload[] {
    if (!folderPath) return []
    return [...uploads.values()].filter((entry) => entry.drawer === drawer && entry.folderPath === folderPath)
}
