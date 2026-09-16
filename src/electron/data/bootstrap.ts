// ----- FreeShow -----
// Bootstrap publish: push this machine's local library to a headless server so a
// working local setup becomes available online for co-editing (Option A).
//
// Runs in the Electron main process (it owns the disk): builds a backup-shaped zip
// with media paths rewritten to server-relative destinations, POSTs it to the
// server's HTTP /bootstrap/restore endpoint, then uploads referenced media bytes
// via /media/upload with manifest-based resume (same-size files are skipped).

import fs from "fs"
import path from "path"
import { collectMediaPathsFromProject, collectMediaPathsFromShow } from "../../shared/media/collectShowMedia"
import { rewriteOverlayMediaPaths, rewriteProjectMediaPaths, rewriteShowMediaPaths, rewriteTemplateMediaPaths, toServerRelative } from "../../shared/media/bootstrapRemap"
import { zipEntries } from "../../shared/data/zip"
import { ToMain } from "../../types/IPC/ToMain"
import { sendToMain } from "../IPC/main"
import { _store, getStore } from "./store"
import { createFolder, doesPathExist, getDataFolderPath, getDataFolderRoot, readFile, readFolder } from "../utils/files"

export interface BootstrapMediaItem {
    /** absolute local path on this machine */
    localAbs: string
    /** sandbox-relative destination on the server (e.g. Media/Songs/a.mp4) */
    serverRel: string
    size: number
}

export interface BootstrapPublishOptions {
    serverUrl: string
    token?: string
    /** server folder for media files that live outside the local data root (default "Media") */
    destFolder?: string
    /** server folder for outside-root AUDIO files, so the audio drawer finds them (default "Audio") */
    audioDestFolder?: string
    includeMedia?: boolean
    includeBibles?: boolean
    /** replace a non-empty remote (default false = refuse when not empty) */
    replace?: boolean
}

export interface BootstrapPublishResult {
    success: boolean
    error?: string
    status?: { shows: number; bibles: number; empty: boolean }
    shows?: number
    bibles?: number
    replaced?: boolean
    media?: { uploaded: number; skipped: number; failed: { path: string; reason: string }[]; bytes: number }
}

export interface BootstrapProgress {
    phase: "build" | "restore" | "manifest" | "media" | "done"
    /** 0..1 within the media phase (files completed / total) */
    progress?: number
    current?: string
    uploaded?: number
    total?: number
}

const BOOTSTRAP_STORES = ["SYNCED_SETTINGS", "THEMES", "PROJECTS", "STAGE", "OVERLAYS", "TEMPLATES", "EVENTS"] as const

function report(progress: BootstrapProgress) {
    sendToMain(ToMain.BOOTSTRAP_PROGRESS, progress)
}

function resolveLocalAbs(oldPath: string, dataRoot: string): string | null {
    let p = oldPath.trim()
    if (p.startsWith("file://")) p = p.slice("file://".length)
    if (!p) return null
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.join(dataRoot, p)
    if (!doesPathExist(abs)) return null
    try {
        if (!fs.statSync(abs).isFile()) return null
    } catch {
        return null
    }
    return abs
}

/** Read + rewrite every show; collect the media manifest from the remappings. */
function buildShowsAndMedia(dataRoot: string, destFolder: string, audioDestFolder: string): { shows: { id: string; fileName: string; content: string }[]; media: Map<string, BootstrapMediaItem> } {
    const showsPath = getDataFolderPath("shows")
    const shows: { id: string; fileName: string; content: string }[] = []
    const media = new Map<string, BootstrapMediaItem>()
    const remap = (old: string) => toServerRelative(old, dataRoot, destFolder, audioDestFolder)

    const remember = (oldPath: string, serverRel: string) => {
        if (media.has(serverRel)) return
        const localAbs = resolveLocalAbs(oldPath, dataRoot)
        if (!localAbs) return
        try {
            media.set(serverRel, { localAbs, serverRel, size: fs.statSync(localAbs).size })
        } catch {
            // unreadable — skipped, reported at upload time via the failed list
        }
    }

    if (doesPathExist(showsPath)) {
        for (const fileName of readFolder(showsPath)) {
            if (!fileName.toLowerCase().endsWith(".show")) continue
            let parsed: [string, any] | null = null
            try {
                parsed = JSON.parse(readFile(path.join(showsPath, fileName)) || "")
            } catch {
                continue
            }
            if (!parsed?.[0] || !parsed[1]) continue
            const { value, mappings } = rewriteShowMediaPaths(parsed[1], (o) => remap(o) || o)
            for (const [old, next] of mappings) remember(old, next)
            // also record already-relative refs (remap is identity for them, so no mapping
            // entry) — they still need their bytes uploaded
            for (const ref of collectMediaPathsFromShow(parsed[1], {})) {
                const serverRel = remap(ref)
                if (serverRel) remember(ref, serverRel)
            }
            shows.push({ id: parsed[0], fileName, content: JSON.stringify([parsed[0], value]) })
        }
    }

    return { shows, media }
}

function buildStoreEntries(dataRoot: string, destFolder: string, audioDestFolder: string, media: Map<string, BootstrapMediaItem>): { name: string; content: string }[] {
    const entries: { name: string; content: string }[] = []
    const remap = (old: string) => toServerRelative(old, dataRoot, destFolder, audioDestFolder)
    const remember = (oldPath: string, serverRel: string) => {
        if (media.has(serverRel)) return
        const localAbs = resolveLocalAbs(oldPath, dataRoot)
        if (!localAbs) return
        try {
            media.set(serverRel, { localAbs, serverRel, size: fs.statSync(localAbs).size })
        } catch {
            // ignore
        }
    }

    // SETTINGS without machine paths (same stripping restore applies server-side)
    try {
        const settings = JSON.parse(JSON.stringify(getStore("SETTINGS") || {}))
        delete settings.dataPath
        delete settings.showsPath
        entries.push({ name: "SETTINGS.json", content: JSON.stringify(settings) })
    } catch {
        // ignore
    }

    for (const key of BOOTSTRAP_STORES) {
        try {
            const store = (_store as any)[key]?.store ?? getStore(key as any)
            if (store === undefined) continue
            if (key === "OVERLAYS") {
                const out: any = {}
                for (const [id, overlay] of Object.entries<any>(store || {})) {
                    const { value, mappings } = rewriteOverlayMediaPaths(overlay, (o) => remap(o) || o)
                    for (const [old, next] of mappings) remember(old, next)
                    out[id] = value
                }
                entries.push({ name: key + ".json", content: JSON.stringify(out) })
            } else if (key === "TEMPLATES") {
                const out: any = {}
                for (const [id, template] of Object.entries<any>(store || {})) {
                    const { value, mappings } = rewriteTemplateMediaPaths(template, (o) => remap(o) || o)
                    for (const [old, next] of mappings) remember(old, next)
                    out[id] = value
                }
                entries.push({ name: key + ".json", content: JSON.stringify(out) })
            } else if (key === "PROJECTS") {
                const out = JSON.parse(JSON.stringify(store || {}))
                for (const group of ["projects", "projectTemplates"] as const) {
                    for (const [id, project] of Object.entries<any>(out[group] || {})) {
                        const { value, mappings } = rewriteProjectMediaPaths(project, (o) => remap(o) || o)
                        for (const [old, next] of mappings) remember(old, next)
                        // identity-remapped relative refs still need bytes
                        try {
                            for (const ref of collectMediaPathsFromProject(project, {})) {
                                const serverRel = remap(ref)
                                if (serverRel) remember(ref, serverRel)
                            }
                        } catch {
                            // ignore
                        }
                        out[group][id] = value
                    }
                }
                entries.push({ name: key + ".json", content: JSON.stringify(out) })
            } else {
                entries.push({ name: key + ".json", content: JSON.stringify(store) })
            }
        } catch {
            // one unreadable store must not fail the whole bootstrap
        }
    }

    // MEDIA metadata store (cloud-sync parity)
    try {
        entries.push({ name: "MEDIA.json", content: JSON.stringify(getStore("MEDIA") || {}) })
    } catch {
        // ignore
    }

    return entries
}

function buildBibleEntries(): { name: string; content: string }[] {
    const entries: { name: string; content: string }[] = []
    const biblesPath = getDataFolderPath("scriptures")
    if (!doesPathExist(biblesPath)) return entries
    for (const fileName of readFolder(biblesPath)) {
        if (!fileName.toLowerCase().endsWith(".fsb")) continue
        const content = readFile(path.join(biblesPath, fileName))
        if (content) entries.push({ name: "BIBLE_" + fileName, content })
    }
    return entries
}

function withToken(url: string, token?: string): string {
    if (!token) return url
    const sep = url.includes("?") ? "&" : "?"
    return `${url}${sep}token=${encodeURIComponent(token)}`
}

function baseUrl(serverUrl: string): string {
    return serverUrl.replace(/\/+$/, "")
}

/** Upload one file by streaming it from disk (never buffered in RAM). */
async function uploadMediaFile(base: string, token: string | undefined, item: BootstrapMediaItem): Promise<{ ok: boolean; reason?: string }> {
    const folder = path.posix.dirname(item.serverRel) === "." ? "" : path.posix.dirname(item.serverRel)
    const name = path.posix.basename(item.serverRel)
    const url = withToken(`${base}/media/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, token)
    try {
        const stat = fs.statSync(item.localAbs)
        if (!stat.isFile() || !stat.size) return { ok: false, reason: "unreadable" }
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "Content-Length": String(stat.size) },
            body: fs.createReadStream(item.localAbs),
            duplex: "half"
        } as any)
        if (res.ok) return { ok: true }
        return { ok: false, reason: (await res.text().catch(() => ""))?.trim().slice(0, 120) || `HTTP ${res.status}` }
    } catch (err) {
        return { ok: false, reason: (err as Error)?.message?.slice(0, 120) || "network error" }
    }
}

export async function publishBootstrap(options: BootstrapPublishOptions): Promise<BootstrapPublishResult> {
    const serverUrl = (options.serverUrl || "").trim().replace(/\/+$/, "")
    if (!serverUrl) return { success: false, error: "missing_server_url" }
    const destFolder = (options.destFolder || "Media").trim() || "Media"
    const audioDestFolder = (options.audioDestFolder || "Audio").trim() || "Audio"
    const includeMedia = options.includeMedia !== false
    const includeBibles = options.includeBibles !== false
    const base = baseUrl(serverUrl)

    try {
        report({ phase: "build" })
        const dataRoot = getDataFolderRoot()
        // ensure folders exist (also a permission probe before any network work)
        createFolder(dataRoot)

        const { shows, media } = buildShowsAndMedia(dataRoot, destFolder, audioDestFolder)
        const entries = [...buildStoreEntries(dataRoot, destFolder, audioDestFolder, media), ...shows.map((s) => ({ name: "SHOWS/" + s.fileName, content: s.content }))]
        if (includeBibles) entries.push(...buildBibleEntries())
        const zip = await zipEntries(entries)

        // replace-guard check (server also enforces it — this is the friendly early error)
        let status: { shows: number; bibles: number; empty: boolean } | undefined
        try {
            const statusRes = await fetch(withToken(`${base}/bootstrap/status`, options.token))
            if (statusRes.ok) status = await statusRes.json()
        } catch {
            // unreachable status endpoint — the restore POST below reports the real error
        }
        if (status && !status.empty && !options.replace) {
            report({ phase: "done" })
            return { success: false, error: "not_empty", status }
        }

        report({ phase: "restore" })
        const restoreRes = await fetch(withToken(`${base}/bootstrap/restore${options.replace ? "?force=true" : ""}`, options.token), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: zip as any
        })
        if (restoreRes.status === 409) {
            const body = await restoreRes.json().catch(() => ({}))
            report({ phase: "done" })
            return { success: false, error: "not_empty", status: { shows: body.shows ?? 0, bibles: body.bibles ?? 0, empty: false } }
        }
        if (!restoreRes.ok) {
            report({ phase: "done" })
            return { success: false, error: (await restoreRes.text().catch(() => ""))?.trim().slice(0, 200) || `restore HTTP ${restoreRes.status}` }
        }
        const restoreBody = await restoreRes.json().catch(() => ({}))
        if (!restoreBody?.finished) {
            report({ phase: "done" })
            return { success: false, error: restoreBody?.error || "restore_failed" }
        }

        const summary: BootstrapPublishResult = {
            success: true,
            status,
            shows: restoreBody.restoredShowIds?.length ?? shows.length,
            bibles: restoreBody.restoredBibles ?? 0,
            replaced: !!restoreBody.replaced
        }

        if (!includeMedia || !media.size) {
            report({ phase: "done" })
            return { ...summary, media: { uploaded: 0, skipped: 0, failed: [], bytes: 0 } }
        }

        // manifest resume: skip files the server already has at the same size
        report({ phase: "manifest" })
        const items = [...media.values()]
        const presentSizes = new Map<string, number>()
        try {
            const manifestRes = await fetch(withToken(`${base}/media/manifest`, options.token), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths: items.map((i) => i.serverRel) })
            })
            if (manifestRes.ok) {
                const manifest = await manifestRes.json()
                for (const f of manifest?.files || []) {
                    if (typeof f?.path === "string" && typeof f?.size === "number") presentSizes.set(f.path, f.size)
                }
            }
        } catch {
            // manifest failure is non-fatal — fall through to uploading everything
        }

        let uploaded = 0
        let skipped = 0
        let bytes = 0
        const failed: { path: string; reason: string }[] = []
        const total = items.length
        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            const serverSize = presentSizes.get(item.serverRel)
            if (serverSize === item.size) {
                skipped++
                report({ phase: "media", progress: (i + 1) / total, current: item.serverRel, uploaded: uploaded + skipped, total })
                continue
            }
            report({ phase: "media", progress: i / total, current: item.serverRel, uploaded: uploaded + skipped, total })
            const result = await uploadMediaFile(base, options.token, item)
            if (result.ok) {
                uploaded++
                bytes += item.size
            } else {
                failed.push({ path: item.serverRel, reason: result.reason || "upload failed" })
            }
            report({ phase: "media", progress: (i + 1) / total, current: item.serverRel, uploaded: uploaded + skipped, total })
        }

        report({ phase: "done" })
        return { ...summary, media: { uploaded, skipped, failed, bytes } }
    } catch (err) {
        report({ phase: "done" })
        return { success: false, error: (err as Error)?.message?.slice(0, 200) || "bootstrap_failed" }
    }
}
