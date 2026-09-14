// ----- FreeShow -----
// Local media probing: codec info (HEVC detection) and embedded subtitle tracks.
// Kept Electron-free (plain node:fs + mp4box) so it runs in the main process and
// in unit tests. Callers must only pass LOCALLY READABLE paths — remote library
// paths are resolved to the persistent media cache first (or skipped) by the
// frontend, see resolveProbePath in src/frontend/utils/remoteMediaCache.ts.

import fs from "fs"
import path from "path"
import type { Subtitle } from "../../types/Main"
import { mimeTypes } from "./media"

/**
 * Probing buffers the whole file (mp4box needs random box access), so cap it:
 * above this size the probe is skipped with an empty result rather than
 * risking a multi-GB allocation in the main process. 512 MiB covers real
 * service media while bounding transient RAM to ~1 GiB.
 */
export const MAX_PROBE_BYTES = 512 * 1024 * 1024

/** A probe that never settles (truncated boxes, zero-sample tracks) resolves empty. */
export const PROBE_TIMEOUT_MS = 15000

/**
 * Best-effort read for probing. A file this machine can't read (a server-relative
 * library path on a hybrid client, a moved/deleted file, a directory) is a routine
 * "can't probe" outcome — return null WITHOUT logging, so a missing file doesn't
 * spam the log with a stack trace on every probe. Other I/O errors still throw
 * and are logged by the caller's catch as before.
 */
function readProbeBufferSync(filePath: string): Buffer | null {
    try {
        // oversized files are a routine skip (like a missing file): probing would
        // buffer the whole file twice, so return empty without logging
        if (fs.statSync(filePath).size > MAX_PROBE_BYTES) return null
        return fs.readFileSync(filePath)
    } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EISDIR" || err?.code === "ENOTDIR") return null
        throw err
    }
}

// GET MEDIA CODEC
export async function getMediaCodec(data: { path: string }) {
    return await extractCodecInfo(data)
}

type MediaCodecInfo = { path: string; codecs: string[]; mimeType: string; mimeCodec: string }

function getEmptyCodecInfo(data: { path: string }): MediaCodecInfo {
    return { ...data, codecs: [], mimeType: getMimeType(data.path), mimeCodec: "" }
}

async function extractCodecInfo(data: { path: string }): Promise<MediaCodecInfo> {
    const MP4Box = require("mp4box")

    return new Promise((resolve) => {
        const emptyResult = getEmptyCodecInfo(data)
        const mimeType = emptyResult.mimeType

        try {
            const buffer = readProbeBufferSync(data.path)
            if (!buffer?.length || !hasIsoBmffHeader(buffer)) return resolve(emptyResult)

            const uint8Array = new Uint8Array(buffer)
            const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength) as ArrayBuffer & { fileStart?: number }
            if (!arrayBuffer) return resolve(emptyResult)

            const mp4boxfile = MP4Box.createFile()
            let settled = false
            const timer = setTimeout(() => {
                try {
                    mp4boxfile.stop?.()
                } catch {
                    // ignore — settling empty below regardless
                }
                resolveOnce(emptyResult)
            }, PROBE_TIMEOUT_MS)
            // don't hold the process open for a hung probe
            if (typeof timer.unref === "function") timer.unref()
            const resolveOnce = (result: MediaCodecInfo) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(result)
            }

            mp4boxfile.onError = (err: Error) => {
                console.error("MP4Box error:", err)
                resolveOnce(emptyResult)
            }
            mp4boxfile.onReady = (info: { tracks: { codec: string }[]; [key: string]: any }) => {
                if (!Array.isArray(info?.tracks)) {
                    resolveOnce(emptyResult)
                    return
                }

                const codecs = info.tracks.map((track: { codec: string }) => track?.codec).filter((codec: string | undefined): codec is string => Boolean(codec))
                if (!codecs.length) return resolveOnce(emptyResult)

                const mimeCodec = `${mimeType}; codecs="${codecs.join(", ")}"`
                resolveOnce({ ...data, codecs, mimeType, mimeCodec })
            }

            arrayBuffer.fileStart = 0
            try {
                mp4boxfile.appendBuffer(arrayBuffer)
                mp4boxfile.flush()
            } catch (err) {
                console.error("MP4Box append/flush error:", err)
                resolveOnce(emptyResult)
            }
        } catch (err) {
            console.error("MP4Box error catch:", err)
            resolve(emptyResult)
            return
        }
    })
}

function hasIsoBmffHeader(buffer: Buffer) {
    // MP4/ISO-BMFF files should contain an 'ftyp' box near the beginning.
    let offset = 0
    const maxBytes = Math.min(buffer.length, 256 * 1024)

    while (offset + 8 <= maxBytes) {
        const size32 = buffer.readUInt32BE(offset)
        const type = buffer.toString("ascii", offset + 4, offset + 8)
        if (type === "ftyp") return true

        // size==0 means box extends to EOF; size==1 means extended 64-bit size follows.
        if (size32 === 0) break

        if (size32 === 1) {
            if (offset + 16 > maxBytes) break
            const size64 = Number(buffer.readBigUInt64BE(offset + 8))
            if (!Number.isFinite(size64) || size64 < 16) break
            offset += size64
            continue
        }

        // Invalid box size, stop scanning to avoid infinite loops.
        if (size32 < 8) break
        offset += size32
    }

    return false
}

function getMimeType(filePath: string) {
    if (typeof filePath !== "string") return ""

    const ext = path.extname(filePath).toLowerCase().slice(1)
    return mimeTypes[ext] || ""
}

// get embedded subtitles/captions
export function getMediaTracks(data: { path: string }) {
    return extractSubtitles(data)
}

async function extractSubtitles(data: { path: string }): Promise<{ path: string; tracks: Subtitle[] }> {
    const MP4Box = require("mp4box")

    let arrayBuffer: (ArrayBuffer & { fileStart?: number }) | null = null
    let buffer: Buffer | null
    try {
        buffer = readProbeBufferSync(data.path)
        if (!buffer?.length || !hasIsoBmffHeader(buffer)) return { ...data, tracks: [] }

        const uint8Array = new Uint8Array(buffer)
        arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength) as ArrayBuffer & { fileStart?: number }
    } catch (err) {
        console.error(err)
        return { ...data, tracks: [] }
    }

    if (!arrayBuffer) return { ...data, tracks: [] }
    const mp4ArrayBuffer = arrayBuffer

    return new Promise((resolve) => {
        const mp4boxfile = MP4Box.createFile()
        let settled = false
        const timer = setTimeout(() => {
            try {
                mp4boxfile.stop?.()
            } catch {
                // ignore — settling empty below regardless
            }
            resolveOnce({ ...data, tracks: [] })
        }, PROBE_TIMEOUT_MS)
        if (typeof timer.unref === "function") timer.unref()
        const resolveOnce = (result: { path: string; tracks: Subtitle[] }) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }
        mp4boxfile.onError = (e: Error) => {
            console.error("MP4Box error:", e)
            resolveOnce({ ...data, tracks: [] })
        }
        mp4boxfile.onReady = (info: any) => {
            if (!Array.isArray(info?.tracks)) {
                resolveOnce({ ...data, tracks: [] })
                return
            }

            const subtitleTracks = info.tracks.filter((track: any) => track?.type === "subtitles" || track?.type === "text")
            if (!subtitleTracks.length) {
                resolveOnce({ ...data, tracks: [] })
                return
            }

            const tracks: Subtitle[] = []
            let completed = 0
            const pendingByTrackId = new Set<number>(subtitleTracks.map((track: any) => track.id))
            const trackVtt = new Map<number, { lines: string[]; index: number; language: string }>()

            subtitleTracks.forEach((track: any) => {
                const vttLines = ["WEBVTT\n"]
                trackVtt.set(track.id, { lines: vttLines, index: 1, language: track.language || "" })

                mp4boxfile.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples })
            })

            mp4boxfile.onSamples = (id: number, _user: any, samples: { data: BufferSource; cts: number; duration: number }[]) => {
                if (!pendingByTrackId.has(id)) return

                const trackInfo = subtitleTracks.find((track: any) => track.id === id)
                const vttInfo = trackVtt.get(id)
                if (!trackInfo || !vttInfo) return

                const timescale = trackInfo.timescale || 1
                const utf8Decoder = new TextDecoder("utf-8")

                samples.forEach((sample) => {
                    let subtitleText = utf8Decoder.decode(sample.data).trim()
                    // strip control/format characters but keep all printable text
                    // (accents, CJK, emoji) — tab/newline/CR are preserved
                    subtitleText = subtitleText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\p{Cf}]/gu, "")
                    if (!subtitleText) return

                    const startTime = formatTimestamp((sample.cts / timescale) * 1000)
                    const endTime = formatTimestamp(((sample.cts + sample.duration) / timescale) * 1000)

                    vttInfo.lines.push(`${vttInfo.index}`)
                    vttInfo.lines.push(`${startTime} --> ${endTime}`)
                    vttInfo.lines.push(`${subtitleText}\n`)
                    vttInfo.index++
                })

                pendingByTrackId.delete(id)
                completed++

                if (vttInfo.lines.length > 1) {
                    tracks.push({ lang: vttInfo.language.slice(0, 2), name: vttInfo.language, vtt: vttInfo.lines.join("\n"), embedded: true })
                }

                if (completed === subtitleTracks.length) resolveOnce({ ...data, tracks })
            }

            mp4boxfile.start()
        }

        mp4ArrayBuffer.fileStart = 0
        try {
            mp4boxfile.appendBuffer(mp4ArrayBuffer)
            mp4boxfile.flush()
        } catch (err) {
            console.error("MP4Box append/flush error:", err)
            resolveOnce({ ...data, tracks: [] })
        }
    })
}

// format timestamp in WebVTT format (HH:MM:SS.mmm)
function formatTimestamp(timestamp: number) {
    const hours = Math.floor(timestamp / 3600000)
    const minutes = Math.floor((timestamp % 3600000) / 60000)
    const seconds = Math.floor((timestamp % 60000) / 1000)
    const milliseconds = Math.floor(timestamp % 1000)

    const formatted = [hours.toString().padStart(2, "0"), minutes.toString().padStart(2, "0"), seconds.toString().padStart(2, "0") + "." + milliseconds.toString().padStart(3, "0")].join(":")
    return formatted
}
