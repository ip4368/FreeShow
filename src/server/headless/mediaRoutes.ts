// ----- FreeShow -----
// Media/audio virtual filesystem: serves library media referenced by shows to remote
// clients (browser + hybrid desktop) that can't reach the server's disk directly.
//
//   GET /media?path=<path>&token=<token>            stream bytes (Range supported)
//   GET /media/meta?path=<path>&token=<token>       { path, size, mtimeMs, hash, mime }
//   POST /media/manifest { paths: [...] }           batch meta for prefetching
//
// Only serves known media extensions (a basic safety allowlist on top of token auth),
// and never serves Trash contents (trashed files must restore before they resolve).
// /media sets ETag (size+mtime) + Last-Modified with `Cache-Control: private,
// no-cache` and honors If-None-Match, so clients revalidate cheaply (304) instead
// of serving stale bytes for trashed-then-restored files; the meta/manifest
// endpoints back the persistent local media cache on hybrid desktop clients
// (hash-validated, project-level prefetch).

import type { Express, Request, Response } from "express"
import express from "express"
import fs from "fs"
import path from "path"
import type { Readable } from "stream"
import { httpAuth } from "./auth"
import { isTrashRel, resolveInSandbox, toSandboxRelative } from "./data/dataPaths"
import { bumpMediaLibraryVersion } from "./data/libraryVersion"
import { getMediaHash, peekCachedHash } from "./mediaHash"

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2gb — enforced while streaming, never buffered

/**
 * Stream a request body straight to a file (uploads must not sit in RAM:
 * a 2gb express.raw buffer per upload is a trivial OOM). Resolves with the
 * byte count; rejects with an `overLimit` error past maxBytes, cleaning up
 * the partial file in every failure mode.
 */
export function streamRequestBodyToFile(stream: Readable, tmpPath: string, maxBytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath)
        let bytes = 0
        let settled = false
        const fail = (err: Error) => {
            if (settled) return
            settled = true
            try {
                stream.destroy()
            } catch {
                // already gone
            }
            out.destroy()
            fs.rmSync(tmpPath, { force: true })
            reject(err)
        }
        out.on("error", fail)
        stream.on("error", fail)
        stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > maxBytes) {
                const err = new Error(`upload exceeds ${maxBytes} bytes`) as Error & { overLimit: boolean }
                err.overLimit = true
                fail(err)
                return
            }
            if (!out.write(chunk)) {
                stream.pause()
                out.once("drain", () => stream.resume())
            }
        })
        stream.on("end", () => {
            if (settled) return
            settled = true
            out.end(() => resolve(bytes))
        })
    })
}

const MEDIA_MIME: { [ext: string]: string } = {
    // images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    ico: "image/x-icon",
    // video
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
    // audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    weba: "audio/webm",
    // documents
    pdf: "application/pdf",
    // presentations (hybrid clients cache + open these in a local presentation app)
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
}

/** True when the path's extension is a servable (and trashable) media type. */
export function isSupportedMediaPath(filePath: string): boolean {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    return !!MEDIA_MIME[ext]
}

export interface MediaMeta {
    /** sandbox-relative path (the cache key clients use) */
    path: string
    size: number
    mtimeMs: number
    /** sha1 of the content; null in the manifest when not hashed yet (see below) */
    hash: string | null
    mime: string
}

const MAX_MANIFEST_PATHS = 2000

/** Resolve + stat + allowlist a client-provided media path. */
function resolveMediaFile(raw: unknown): { filePath: string; stat: fs.Stats; mime: string; rel: string } | { status: number; message: string } {
    if (typeof raw !== "string" || !raw || raw.includes("\0")) return { status: 400, message: "missing path" }

    // confine to the sandbox root: rejects ../ traversal and absolute paths outside it
    const filePath = resolveInSandbox(raw)
    if (!filePath) return { status: 403, message: "forbidden" }

    // never serve Trash contents (applies to /media, /media/meta, and /media/manifest)
    if (isTrashRel(toSandboxRelative(filePath))) return { status: 403, message: "forbidden" }

    // safety: only serve known media extensions (token auth already applied above)
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mime = MEDIA_MIME[ext]
    if (!mime) return { status: 415, message: "unsupported media type" }

    let stat: fs.Stats
    try {
        stat = fs.statSync(filePath)
    } catch {
        return { status: 404, message: "not found" }
    }
    if (!stat.isFile()) return { status: 404, message: "not found" }

    return { filePath, stat, mime, rel: toSandboxRelative(filePath) }
}

/**
 * Stream a file to the response with an error handler attached: without one, a
 * file deleted between stat and stream (or a mid-stream disk error) throws an
 * uncaught exception that can crash the headless server.
 */
export function pipeFile(req: Request, res: Response, filePath: string, options?: { start: number; end: number }) {
    const stream = options ? fs.createReadStream(filePath, options) : fs.createReadStream(filePath)
    stream.on("error", () => {
        try {
            if (!res.headersSent) res.status(500)
            res.end()
        } catch {
            // response already gone — nothing to do
        }
    })
    req.on("close", () => stream.destroy())
    stream.pipe(res)
}

export interface MediaRouteOptions {
    /** Called with the sandbox-relative path after a successful upload (for live broadcasts). */
    onUpload?: (relPath: string) => void
}

export function registerMediaRoutes(app: Express, options: MediaRouteOptions = {}) {
    app.get("/media", httpAuth, (req: Request, res: Response) => {
        const resolved = resolveMediaFile(req.query.path)
        if ("status" in resolved) return void res.status(resolved.status).send(resolved.message)
        const { filePath, stat, mime } = resolved

        const etag = `"${stat.size}-${stat.mtimeMs}"`

        res.setHeader("Content-Type", mime)
        res.setHeader("Accept-Ranges", "bytes")
        // private + always revalidate: the library is mutable (trash/restore/
        // upload), so a shared max-age would serve stale bytes for paths that
        // changed; the ETag below keeps revalidation at a cheap 304
        res.setHeader("Cache-Control", "private, no-cache")
        res.setHeader("ETag", etag)
        res.setHeader("Last-Modified", stat.mtime.toUTCString())
        // hash header when already cached — the hot path never hashes (see mediaHash.ts)
        const cachedHash = peekCachedHash(filePath, stat)
        if (cachedHash) res.setHeader("X-Media-Hash", cachedHash)

        // cheap revalidation for cached clients (and browsers)
        if (req.headers["if-none-match"] === etag) return void res.status(304).end()

        // NOTE: Range support is intentionally simple (single explicit byte range,
        // no suffix/multi-range or If-Range) — enough for media seeking.
        const range = req.headers.range
        if (range) {
            const match = /bytes=(\d*)-(\d*)/.exec(range)
            let start = match && match[1] ? parseInt(match[1], 10) : 0
            let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1
            if (isNaN(start) || start < 0) start = 0
            if (isNaN(end) || end >= stat.size) end = stat.size - 1
            if (start > end) {
                res.status(416).setHeader("Content-Range", `bytes */${stat.size}`)
                return void res.end()
            }
            res.status(206)
            res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`)
            res.setHeader("Content-Length", end - start + 1)
            pipeFile(req, res, filePath, { start, end })
            return
        }

        res.setHeader("Content-Length", stat.size)
        pipeFile(req, res, filePath)
        return
    })

    // Single-file metadata for cache validation (computes + caches the content hash):
    //   GET /media/meta?path=<path>&token=<token>  -> { path, size, mtimeMs, hash, mime }
    app.get("/media/meta", httpAuth, async (req: Request, res: Response) => {
        const resolved = resolveMediaFile(req.query.path)
        if ("status" in resolved) return void res.status(resolved.status).send(resolved.message)
        const { filePath, stat, mime, rel } = resolved

        try {
            const hash = await getMediaHash(filePath, stat)
            const meta: MediaMeta = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash, mime }
            return void res.json(meta)
        } catch (err) {
            console.error("Hash failed:", filePath, err)
            return void res.status(500).send("hash failed")
        }
    })

    // Batch metadata for project-level prefetch:
    //   POST /media/manifest { paths: [...] }  -> { files: MediaMeta[], missing: { path, reason }[] }
    // Returns size+mtime for every file plus the hash WHEN already cached (hash: null
    // otherwise) — hashing gigabytes synchronously would stall prefetch, so uncached
    // files are hashed on first GET /media/meta (or first prefetch download verify).
    app.post("/media/manifest", httpAuth, express.json({ limit: "1mb" }), (req: Request, res: Response) => {
        const paths = (req.body as any)?.paths
        if (!Array.isArray(paths)) return void res.status(400).send("missing paths array")
        if (paths.length > MAX_MANIFEST_PATHS) return void res.status(400).send("too many paths")

        const files: MediaMeta[] = []
        const missing: { path: string; reason: string }[] = []

        for (const raw of paths) {
            const resolved = resolveMediaFile(raw)
            if ("status" in resolved) {
                missing.push({ path: String(raw ?? ""), reason: resolved.message })
                continue
            }
            const { filePath, stat, mime, rel } = resolved
            files.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash: peekCachedHash(filePath, stat), mime })
        }

        return void res.json({ files, missing })
    })

    // Upload a media file into a sandboxed folder:
    //   POST /media/upload?path=<relative folder>&name=<file name>   (raw body = file bytes)
    // Same guards as reads: token auth, sandbox confinement, media-extension allowlist.
    app.post("/media/upload", httpAuth, async (req: Request, res: Response) => {
        const rawName = typeof req.query.name === "string" ? req.query.name : ""
        const name = path.basename(rawName).trim() // strip any directory component
        if (!name || name.includes("\0")) return void res.status(400).send("missing name")

        const ext = path.extname(name).slice(1).toLowerCase()
        if (!MEDIA_MIME[ext]) return void res.status(415).send("unsupported media type")

        const folder = resolveInSandbox(typeof req.query.path === "string" ? req.query.path : "")
        if (!folder) return void res.status(403).send("forbidden")

        const target = resolveInSandbox(path.join(toSandboxRelative(folder), name))
        if (!target) return void res.status(403).send("forbidden")

        // stream to a sibling tmp file (same filesystem, so the rename is atomic)
        // instead of buffering the whole body in RAM
        const tmpPath = `${target}.upload-${process.pid}-${Date.now()}`
        fs.mkdirSync(path.dirname(target), { recursive: true })
        let bytes = 0
        try {
            bytes = await streamRequestBodyToFile(req, tmpPath, MAX_UPLOAD_BYTES)
        } catch (err: any) {
            if (err?.overLimit) return void res.status(413).send("upload too large")
            console.error("Upload failed:", target, err)
            return void res.status(500).send("write failed")
        }
        if (!bytes) {
            fs.rmSync(tmpPath, { force: true })
            return void res.status(400).send("empty body")
        }
        try {
            fs.renameSync(tmpPath, target)
        } catch (err) {
            fs.rmSync(tmpPath, { force: true })
            console.error("Upload failed:", target, err)
            return void res.status(500).send("write failed")
        }
        bumpMediaLibraryVersion()
        const rel = toSandboxRelative(target)
        // live-refresh every client (without this only the epoch file changes and
        // nobody re-requests the folder — the upload would stay invisible)
        try {
            options.onUpload?.(rel)
        } catch (err) {
            console.error("Upload broadcast failed:", rel, err)
        }

        return void res.json({ path: rel, name })
    })
}
