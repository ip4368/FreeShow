// ----- FreeShow -----
// Bootstrap publish: push this machine's local library to a headless server so a
// working local setup becomes available online for co-editing (Option A).
//
// Runs in the Electron main process (it owns the disk): builds a backup-shaped zip
// with media paths rewritten to server-relative destinations, then runs the
// staged protocol — start a session, stage the snapshot, stage media uploads,
// commit (snapshot + media go live together). Anything short of commit leaves
// the live library untouched. Resume is hash-verified: a file is skipped only
// when the server's copy matches in both size and sha1 content hash.

import { createHash } from "crypto"
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
    phase: "build" | "restore" | "manifest" | "media" | "commit" | "done"
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

/**
 * Human-readable error from a failed bootstrap call. The server answers errors
 * as JSON ({ error }) or plain text depending on the endpoint — read the body
 * once as text and unpack JSON when it parses.
 */
async function readError(res: Response, fallback: string): Promise<string> {
    let text = ""
    try {
        text = ((await res.text()) || "").trim()
    } catch {
        return fallback
    }
    if (!text) return fallback
    try {
        const body = JSON.parse(text)
        if (typeof body?.error === "string" && body.error) return body.error.slice(0, 200)
    } catch {
        // plain-text error — return as-is below
    }
    return text.slice(0, 200)
}

/** Upload one file by streaming it from disk (never buffered in RAM). */
async function uploadMediaFile(base: string, token: string | undefined, session: string, item: BootstrapMediaItem): Promise<{ ok: boolean; reason?: string }> {
    const folder = path.posix.dirname(item.serverRel) === "." ? "" : path.posix.dirname(item.serverRel)
    const name = path.posix.basename(item.serverRel)
    const url = withToken(`${base}/media/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}&staging=${encodeURIComponent(session)}`, token)
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

/**
 * Streaming sha1 of a local file. Must match the server's hash exactly
 * (src/server/headless/mediaHash.ts: sha1 hex) — resume compares the two. Any
 * failure rejects, and callers treat that as "hash unknown, upload it".
 */
function sha1File(localAbs: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha1")
        const stream = fs.createReadStream(localAbs)
        stream.on("error", reject)
        stream.on("data", (chunk) => hash.update(chunk))
        stream.on("end", () => resolve(hash.digest("hex")))
    })
}

export async function publishBootstrap(options: BootstrapPublishOptions): Promise<BootstrapPublishResult> {
    const serverUrl = (options.serverUrl || "").trim().replace(/\/+$/, "")
    if (!serverUrl) return { success: false, error: "missing_server_url" }
    const destFolder = (options.destFolder || "Media").trim() || "Media"
    const audioDestFolder = (options.audioDestFolder || "Audio").trim() || "Audio"
    const includeMedia = options.includeMedia !== false
    const includeBibles = options.includeBibles !== false
    const base = baseUrl(serverUrl)
    let session = ""

    // best-effort session cleanup after any post-start failure (the server
    // auto-cleans on failed stage/commit too — this covers client-side faults)
    const abort = async () => {
        if (!session) return
        try {
            await fetch(withToken(`${base}/bootstrap/session?session=${encodeURIComponent(session)}`, options.token), { method: "DELETE" })
        } catch {
            // ignored — expiry sweep is the backstop
        }
    }
    const fail = async (error: string, status?: { shows: number; bibles: number; empty: boolean }): Promise<BootstrapPublishResult> => {
        await abort()
        report({ phase: "done" })
        return status ? { success: false, error, status } : { success: false, error }
    }

    try {
        report({ phase: "build" })
        const dataRoot = getDataFolderRoot()
        // ensure folders exist (also a permission probe before any network work)
        createFolder(dataRoot)

        const { shows, media } = buildShowsAndMedia(dataRoot, destFolder, audioDestFolder)
        const entries = [...buildStoreEntries(dataRoot, destFolder, audioDestFolder, media), ...shows.map((s) => ({ name: "SHOWS/" + s.fileName, content: s.content }))]
        if (includeBibles) entries.push(...buildBibleEntries())
        const zip = await zipEntries(entries)

        // start a staged session (this IS the replace-guard check now)
        const startRes = await fetch(withToken(`${base}/bootstrap/start`, options.token), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force: !!options.replace })
        }).catch(() => null)
        if (!startRes) return fail("unreachable")
        if (startRes.status === 404) return fail("server_outdated")
        if (startRes.status === 409) {
            const body = await startRes.json().catch(() => ({}))
            return fail("not_empty", { shows: body.shows ?? 0, bibles: body.bibles ?? 0, empty: false })
        }
        if (!startRes.ok) return fail(await readError(startRes, `start HTTP ${startRes.status}`))
        session = (await startRes.json().catch(() => ({})))?.session || ""
        if (!session) return fail("bad_session")

        report({ phase: "restore" })
        const restoreRes = await fetch(withToken(`${base}/bootstrap/restore?session=${encodeURIComponent(session)}`, options.token), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: zip as any
        }).catch(() => null)
        if (!restoreRes) return fail("unreachable")
        if (!restoreRes.ok) return fail(await readError(restoreRes, `stage HTTP ${restoreRes.status}`))
        const staged = await restoreRes.json().catch(() => ({}))
        if (!staged?.finished) return fail(staged?.error || "stage_failed")

        let uploaded = 0
        let skipped = 0
        let bytes = 0
        const failed: { path: string; reason: string }[] = []

        if (includeMedia && media.size) {
            // hash-verified resume: the manifest reports size + cached hash per
            // file; a file is skipped only when BOTH match the local copy.
            // Same size + different content is re-uploaded (overwrite).
            report({ phase: "manifest" })
            const items = [...media.values()]
            const present = new Map<string, { size: number; hash: string | null }>()
            try {
                const manifestRes = await fetch(withToken(`${base}/media/manifest`, options.token), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ paths: items.map((i) => i.serverRel) })
                })
                if (manifestRes.ok) {
                    const manifest = await manifestRes.json()
                    for (const f of manifest?.files || []) {
                        if (typeof f?.path === "string" && typeof f?.size === "number") present.set(f.path, { size: f.size, hash: typeof f?.hash === "string" ? f.hash : null })
                    }
                }
            } catch {
                // manifest failure is non-fatal — fall through to uploading everything
            }

            const total = items.length
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                const serverEntry = present.get(item.serverRel)
                // cheap gate first: only size-matching candidates pay for hashing
                if (serverEntry && serverEntry.size === item.size && (await shouldSkip(base, options.token, item, serverEntry.hash))) {
                    skipped++
                    report({ phase: "media", progress: (i + 1) / total, current: item.serverRel, uploaded: uploaded + skipped, total })
                    continue
                }
                report({ phase: "media", progress: i / total, current: item.serverRel, uploaded: uploaded + skipped, total })
                const result = await uploadMediaFile(base, options.token, session, item)
                if (result.ok) {
                    uploaded++
                    bytes += item.size
                } else {
                    failed.push({ path: item.serverRel, reason: result.reason || "upload failed" })
                }
                report({ phase: "media", progress: (i + 1) / total, current: item.serverRel, uploaded: uploaded + skipped, total })
            }
        }

        // commit: snapshot + staged media go live together (always runs, even
        // with media skipped — the staged snapshot still needs activating)
        report({ phase: "commit" })
        const commitRes = await fetch(withToken(`${base}/bootstrap/commit`, options.token), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session })
        }).catch(() => null)
        if (!commitRes) return fail("unreachable")
        if (commitRes.status === 409) {
            const body = await commitRes.json().catch(() => ({}))
            return fail("not_empty", { shows: body.shows ?? 0, bibles: body.bibles ?? 0, empty: false })
        }
        if (!commitRes.ok) return fail(await readError(commitRes, `commit HTTP ${commitRes.status}`))
        const committed = await commitRes.json().catch(() => ({}))
        if (!committed?.finished) return fail(committed?.error || "commit_failed")
        for (const f of committed?.media?.failed || []) {
            if (typeof f?.path === "string") failed.push({ path: f.path, reason: f?.reason || "commit failed" })
        }

        report({ phase: "done" })
        return {
            success: true,
            shows: committed.restoredShowIds?.length ?? shows.length,
            bibles: committed.restoredBibles ?? 0,
            replaced: !!committed.replaced,
            media: { uploaded, skipped, failed, bytes }
        }
    } catch (err) {
        return fail((err as Error)?.message?.slice(0, 200) || "bootstrap_failed")
    }
}

/**
 * True when the server's copy is byte-identical (size already matched — this
 * checks the content hash). Uncached server hashes are resolved on demand via
 * /media/meta (which computes + caches server-side). Any failure or mismatch
 * returns false: the safe direction is always "upload it".
 */
async function shouldSkip(base: string, token: string | undefined, item: BootstrapMediaItem, serverHash: string | null): Promise<boolean> {
    let localHash: string
    try {
        report({ phase: "manifest", current: item.serverRel })
        localHash = await sha1File(item.localAbs)
    } catch {
        return false
    }
    let remoteHash = serverHash
    if (!remoteHash) {
        try {
            const metaRes = await fetch(withToken(`${base}/media/meta?path=${encodeURIComponent(item.serverRel)}`, token))
            if (!metaRes.ok) return false
            const meta = await metaRes.json()
            if (meta?.size !== item.size || typeof meta?.hash !== "string") return false
            remoteHash = meta.hash
        } catch {
            return false
        }
    }
    return remoteHash === localHash
}
