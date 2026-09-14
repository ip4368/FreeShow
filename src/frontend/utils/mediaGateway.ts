// ----- FreeShow -----
// Resolves library media to a server URL for remote clients. When the client is on
// the socket transport (web build, or a hybrid desktop connected to a server), the
// library and its media live on the server, so file paths in shows/overlays are the
// SERVER's paths and can't be read locally. We serve them via the server's /media
// gateway instead (see src/server/headless/mediaRoutes.ts).
//
// Local Electron clients don't use this (they read files directly).

import { getConnectionToken, getRemoteServerConfig, isSocketTransport } from "../IPC/transport"

/** True when media should be fetched from the server (web build or hybrid desktop). */
export function isRemoteMedia(): boolean {
    return isSocketTransport()
}

/**
 * Base URL + auth token for the gateway. The web build is same-origin (empty base) and
 * takes its token from the `?token=` it was opened with; a remote desktop uses the URL
 * and token saved in its connection settings.
 */
function gatewayTarget(): { base: string; token: string } {
    return { base: getRemoteServerConfig()?.url || "", token: getConnectionToken() }
}

/** True if this is already a gateway URL (absolute or origin-relative). */
export function isGatewayUrl(path: string): boolean {
    return typeof path === "string" && /(^|\/)(media|thumbnail)\?path=/.test(path)
}

/** Build a URL to the server's media gateway for a (server-side) file path. */
export function getServerMediaUrl(filePath: string): string {
    // idempotent: a resolved gateway URL can be fed back in (e.g. a cached thumbnailPath),
    // and wrapping it again would encode the whole URL as the path (-> 403).
    if (isGatewayUrl(filePath)) return filePath

    let filePathOnly = filePath
    if (filePathOnly.startsWith("file://")) filePathOnly = filePathOnly.slice("file://".length)

    const { base, token } = gatewayTarget()

    const params = new URLSearchParams({ path: filePathOnly })
    if (token) params.set("token", token)

    return `${base}/media?${params.toString()}`
}

/** URL for a server-generated thumbnail (falls back to the original server-side for video). */
export function getServerThumbnailUrl(filePath: string, size: number): string {
    if (isGatewayUrl(filePath)) return filePath

    let filePathOnly = filePath
    if (filePathOnly.startsWith("file://")) filePathOnly = filePathOnly.slice("file://".length)

    const { base, token } = gatewayTarget()

    const params = new URLSearchParams({ path: filePathOnly, size: String(Math.round(size) || 250) })
    if (token) params.set("token", token)

    return `${base}/thumbnail?${params.toString()}`
}

export interface UploadProgressOptions {
    /** Called with bytes sent so far (total falls back to file.size when not computable). */
    onProgress?: (loaded: number, total: number) => void
    /** Abort the in-flight request. Resolves with `aborted: true` instead of rejecting. */
    signal?: AbortSignal
}

export interface UploadResult {
    ok: boolean
    status: number
    /** True when the request was aborted via `signal` (not a failure to report). */
    aborted?: boolean
    /** Short server message or HTTP status (only when !ok && !aborted). */
    error?: string
    path?: string
    name?: string
}

/**
 * Upload a file into a (sandbox-relative) folder on the server, reporting progress.
 *
 * Uses XMLHttpRequest instead of fetch: fetch exposes no upload-progress events,
 * while `xhr.upload.onprogress` fires as request bytes are sent (works in both the
 * Electron renderer and the web build). The server endpoint is unchanged (single
 * POST with raw bytes), so no server work is needed for progress.
 */
export function uploadToServerWithProgress(folderPath: string, file: File, options: UploadProgressOptions = {}): Promise<UploadResult> {
    const { base, token } = gatewayTarget()

    const params = new URLSearchParams({ path: folderPath, name: file.name })
    if (token) params.set("token", token)

    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        let settled = false
        const finish = (result: UploadResult) => {
            if (settled) return
            settled = true
            options.signal?.removeEventListener("abort", onAbort)
            resolve(result)
        }
        const onAbort = () => {
            xhr.abort()
            // onabort below resolves; this just covers signal-after-settle
        }

        if (options.signal?.aborted) {
            finish({ ok: false, status: 0, aborted: true })
            return
        }
        options.signal?.addEventListener("abort", onAbort, { once: true })

        xhr.upload.onprogress = (e: ProgressEvent) => {
            options.onProgress?.(e.loaded, e.lengthComputable && e.total > 0 ? e.total : file.size)
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                let data: any = null
                try {
                    data = JSON.parse(xhr.responseText)
                } catch {
                    // non-JSON success body — path/name stay undefined
                }
                options.onProgress?.(file.size, file.size)
                finish({ ok: true, status: xhr.status, path: data?.path, name: data?.name })
                return
            }
            const serverMessage = typeof xhr.responseText === "string" ? xhr.responseText.trim().slice(0, 120) : ""
            finish({ ok: false, status: xhr.status, error: serverMessage || `HTTP ${xhr.status}` })
        }
        xhr.onerror = () => finish({ ok: false, status: 0, error: "network error" })
        xhr.onabort = () => finish({ ok: false, status: 0, aborted: true })

        try {
            xhr.open("POST", `${base}/media/upload?${params.toString()}`)
            xhr.setRequestHeader("Content-Type", "application/octet-stream")
            xhr.send(file)
        } catch (err) {
            finish({ ok: false, status: 0, error: err instanceof Error ? err.message : "send failed" })
        }
    })
}
