// ----- FreeShow -----
// Server-side trash for remote library files: deleting from a remote client's
// media/audio drawer moves files/folders here instead of unlinking them, so an
// accidental (or another client's) delete is recoverable. Entries expire after
// 30 days via a periodic sweep (see startTrashSweep) plus a lazy sweep on list.
//
// Layout (all inside the sandbox, so restore can never escape it):
//   <root>/Trash/
//     trash.json        manifest: Record<id, TrashEntry>
//     <id>/             trashed node itself (file, or folder subtree preserved)

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { dropCachedHashes } from "../mediaHash"
import { isSupportedMediaPath } from "../mediaRoutes"
import { getDataFolderPath, resolveInSandbox, toSandboxRelative } from "./dataPaths"
import { bumpMediaLibraryVersion, getMediaLibraryVersion } from "./libraryVersion"

// re-exported for existing importers (serving/listing exclusion checks)
export { isTrashRel } from "./dataPaths"

export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface TrashEntry {
    id: string
    /** display name (file or folder) */
    name: string
    /** sandbox-relative original path (forward slashes) */
    originalPath: string
    isFolder: boolean
    /** epoch ms of deletion (server clock) */
    deletedAt: number
    /** bytes (file size, or recursive sum for folders) */
    size: number
    /** best-effort deleter label (client address) */
    deletedBy?: string
}

export interface TrashFailure {
    path: string
    reason: string
}

function trashRoot(): string {
    return getDataFolderPath("trash")
}

function manifestPath(): string {
    return path.join(trashRoot(), "trash.json")
}

function loadManifest(): Record<string, TrashEntry> {
    try {
        return JSON.parse(fs.readFileSync(manifestPath(), "utf8") || "{}")
    } catch {
        return {}
    }
}

/**
 * Persist the manifest (atomic tmp+rename). Returns false instead of throwing
 * so callers can roll back or report honestly — a trash move without its
 * manifest entry would orphan content no UI can recover.
 */
function saveManifest(manifest: Record<string, TrashEntry>): boolean {
    const target = manifestPath()
    const tmp = `${target}.${process.pid}.tmp`
    try {
        fs.writeFileSync(tmp, JSON.stringify(manifest))
        fs.renameSync(tmp, target)
        return true
    } catch (err) {
        console.error("Failed to write trash manifest:", err)
        try {
            fs.unlinkSync(tmp)
        } catch {
            // best-effort cleanup
        }
        return false
    }
}

/** Normalize a sandbox-relative path for comparisons (forward slashes). */
export function normalizeRel(p: string): string {
    return p.replace(/\\/g, "/")
}

// Top-level data dirs that must never be trashed (library + server state).
const PROTECTED_ROOTS = ["trash", "config", "shows", "backups"]

/** False for the sandbox root itself, Trash, and protected library/state dirs. */
function isTrashableRel(rel: string): boolean {
    const norm = normalizeRel(rel)
    if (!norm || norm === "." || norm === "/") return false
    const first = (norm.split("/")[0] || "").toLowerCase()
    return !PROTECTED_ROOTS.includes(first)
}

function baseName(p: string): string {
    return p.split(/[\\/]/).filter(Boolean).pop() || p
}

function dirSizeBytes(dir: string): number {
    let total = 0
    const stack = [dir]
    while (stack.length) {
        const current = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            try {
                if (entry.isDirectory()) stack.push(full)
                else total += fs.statSync(full).size
            } catch {
                // vanished mid-walk — skip
            }
        }
    }
    return total
}

/**
 * Original library rel-paths of every file inside a trashed folder: the trashed
 * dir mirrors the folder's content, so each inner path maps back 1:1. Used to
 * drop content-hash entries for the paths that no longer exist in the library.
 */
function trashedFileRels(trashedDir: string, originalRel: string): string[] {
    const out: string[] = []
    const stack = [trashedDir]
    while (stack.length) {
        const current = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) stack.push(full)
            else out.push(normalizeRel(path.join(originalRel, path.relative(trashedDir, full))))
        }
    }
    return out
}

/** Sandbox-relative file paths under a restored directory (for result expansion). */
function dirFileRels(absDir: string): string[] {
    const out: string[] = []
    const stack = [absDir]
    while (stack.length) {
        const current = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) stack.push(full)
            else out.push(normalizeRel(toSandboxRelative(full)))
        }
    }
    return out
}

/** Move with an EXDEV fallback (copy + remove) for exotic mounts. */
function movePath(src: string, dest: string) {
    try {
        fs.renameSync(src, dest)
    } catch (err: any) {
        if (err?.code !== "EXDEV") throw err
        fs.cpSync(src, dest, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
    }
}

// Collision-safe restore target: "name (restored).ext", "name (restored 2).ext", ...
function restoreTarget(originalAbs: string): string {
    if (!fs.existsSync(originalAbs)) return originalAbs
    const dir = path.dirname(originalAbs)
    const ext = path.extname(originalAbs)
    const stem = path.basename(originalAbs, ext)
    for (let i = 1; ; i++) {
        const suffix = i === 1 ? " (restored)" : ` (restored ${i})`
        const candidate = path.join(dir, stem + suffix + ext)
        if (!fs.existsSync(candidate)) return candidate
    }
}

export interface TrashResult {
    trashed: TrashEntry[]
    failed: TrashFailure[]
    /** file-level rel paths affected (folders expanded) — for client cache eviction */
    paths: string[]
}

/**
 * Move sandbox files/folders to Trash. Single files must be trashed media types;
 * folders move verbatim (any contents) since the drawer offers folder delete.
 * Returns per-path results — one bad path never aborts the rest of a batch.
 * All-or-nothing on the manifest: when it can't be persisted, every move in
 * this batch is rolled back and reported as failed (content without a manifest
 * entry would be unrecoverable from any UI).
 */
export function trashPaths(paths: string[], deletedBy?: string): TrashResult {
    const trashed: TrashEntry[] = []
    const failed: TrashFailure[] = []
    const affected: string[] = []
    if (!Array.isArray(paths) || !paths.length) return { trashed, failed, paths: affected }

    const manifest = loadManifest()
    const root = trashRoot()
    fs.mkdirSync(root, { recursive: true })
    const moved: { abs: string; dest: string }[] = []

    for (const raw of paths) {
        const label = String(raw ?? "")
        const abs = typeof raw === "string" ? resolveInSandbox(raw) : null
        if (!abs) {
            failed.push({ path: label, reason: "forbidden" })
            continue
        }
        const rel = normalizeRel(toSandboxRelative(abs))
        if (!isTrashableRel(rel)) {
            failed.push({ path: label, reason: "forbidden" })
            continue
        }

        let stat: fs.Stats
        try {
            stat = fs.statSync(abs)
        } catch {
            failed.push({ path: label, reason: "not found" })
            continue
        }

        const isFolder = stat.isDirectory()
        if (!isFolder && !stat.isFile()) {
            failed.push({ path: label, reason: "not found" })
            continue
        }
        // Single-file deletes are drawer files: keep the media allowlist so a
        // crafted request can't trash arbitrary server files (e.g. *.show data).
        if (!isFolder && !isSupportedMediaPath(abs)) {
            failed.push({ path: label, reason: "unsupported media type" })
            continue
        }

        const id = crypto.randomUUID()
        const dest = path.join(root, id)
        try {
            movePath(abs, dest)
            moved.push({ abs, dest })
        } catch (err) {
            console.error("Trash move failed:", abs, err)
            failed.push({ path: label, reason: "move failed" })
            continue
        }

        // the file no longer exists at its library path: drop its content-hash
        // entry so a future re-uploaded file with the same name re-hashes fresh
        const fileRels = isFolder ? trashedFileRels(dest, rel) : [rel]
        dropCachedHashes(fileRels)
        affected.push(...fileRels)

        const entry: TrashEntry = {
            id,
            name: baseName(abs),
            originalPath: rel,
            isFolder,
            deletedAt: Date.now(),
            size: isFolder ? dirSizeBytes(dest) : stat.size
        }
        if (deletedBy) entry.deletedBy = deletedBy
        manifest[id] = entry
        trashed.push(entry)
    }

    if (trashed.length) {
        if (!saveManifest(manifest)) {
            // persist failed: move everything back so no content is left
            // manifest-less, and report each path honestly instead of claiming success
            for (const { abs, dest } of moved) {
                try {
                    movePath(dest, abs)
                } catch (err) {
                    console.error("Trash rollback failed:", dest, err)
                }
            }
            for (const entry of trashed) failed.push({ path: entry.originalPath, reason: "manifest write failed" })
            return { trashed: [], failed, paths: [] }
        }
        bumpMediaLibraryVersion()
    }
    return { trashed, failed, paths: affected }
}

export interface RestoredEntry {
    id: string
    /** sandbox-relative path the entry actually landed at */
    path: string
    /** sandbox-relative path it was trashed from (for re-linking after a rename) */
    originalPath: string
    /** true when the original path was occupied and a suffixed name was used */
    renamed: boolean
}

export interface RestoreResult {
    restored: RestoredEntry[]
    failed: TrashFailure[]
    /** file-level rel paths restored (folders expanded) */
    paths: string[]
    /** set when content moved but the manifest couldn't be persisted */
    manifestError?: string
}

/**
 * Move trashed entries back to their original paths. A re-created file at the
 * original location is never overwritten — the restore takes a suffixed name
 * (reported via `renamed` + `originalPath` so the UI can offer re-linking;
 * show references are deliberately NOT rewritten — they now resolve to the
 * newer occupant, and stealing them would corrupt the newer file's usage).
 */
export function restoreTrash(ids: string[]): RestoreResult {
    const restored: RestoredEntry[] = []
    const failed: TrashFailure[] = []
    const affected: string[] = []
    if (!Array.isArray(ids) || !ids.length) return { restored, failed, paths: affected }

    const manifest = loadManifest()
    const root = trashRoot()
    let changed = false

    for (const id of ids) {
        const entry = manifest[String(id)]
        if (!entry) {
            failed.push({ path: String(id), reason: "not found" })
            continue
        }
        const src = path.join(root, entry.id)
        if (!fs.existsSync(src)) {
            // content gone without the manifest knowing — drop the stale entry
            delete manifest[entry.id]
            changed = true
            failed.push({ path: entry.originalPath, reason: "content missing" })
            continue
        }
        const originalAbs = resolveInSandbox(entry.originalPath)
        if (!originalAbs || !isTrashableRel(entry.originalPath)) {
            failed.push({ path: entry.originalPath, reason: "forbidden" })
            continue
        }
        try {
            fs.mkdirSync(path.dirname(originalAbs), { recursive: true })
            const target = restoreTarget(originalAbs)
            movePath(src, target)
            delete manifest[entry.id]
            changed = true
            const restoredRel = normalizeRel(toSandboxRelative(target))
            restored.push({ id: entry.id, path: restoredRel, originalPath: entry.originalPath, renamed: restoredRel !== normalizeRel(entry.originalPath) })
            affected.push(...(entry.isFolder ? dirFileRels(target) : [restoredRel]))
        } catch (err) {
            console.error("Trash restore failed:", src, err)
            failed.push({ path: entry.originalPath, reason: "restore failed" })
        }
    }

    // content already moved back: no rollback (un-restoring would strand the
    // user), but the stale manifest entry must be reported, not swallowed
    let manifestError: string | undefined
    if (changed) {
        if (!saveManifest(manifest)) manifestError = "manifest write failed"
        bumpMediaLibraryVersion()
    }
    return manifestError ? { restored, failed, paths: affected, manifestError } : { restored, failed, paths: affected }
}

function removeTrashedNode(root: string, id: string) {
    fs.rmSync(path.join(root, id), { recursive: true, force: true })
}

export interface PermanentDeleteResult {
    deleted: string[]
    failed: TrashFailure[]
    /** file-level rel paths removed (folders expanded) */
    paths: string[]
    /** set when content was deleted but the manifest couldn't be persisted */
    manifestError?: string
}

/** Permanently delete trashed entries (content + manifest). */
export function deleteTrashPermanent(ids: string[]): PermanentDeleteResult {
    const deleted: string[] = []
    const failed: TrashFailure[] = []
    const affected: string[] = []
    if (!Array.isArray(ids) || !ids.length) return { deleted, failed, paths: affected }

    const manifest = loadManifest()
    const root = trashRoot()
    let changed = false

    for (const id of ids) {
        const entry = manifest[String(id)]
        if (!entry) {
            failed.push({ path: String(id), reason: "not found" })
            continue
        }
        // collect affected files BEFORE removal (the content is still there)
        const fileRels = entry.isFolder ? trashedFileRels(path.join(root, entry.id), entry.originalPath) : [entry.originalPath]
        try {
            removeTrashedNode(root, entry.id)
        } catch (err) {
            console.error("Permanent trash delete failed:", entry.id, err)
            failed.push({ path: entry.originalPath, reason: "delete failed" })
            continue
        }
        // belt-and-braces for entries trashed before hash cleanup existed
        if (!entry.isFolder) dropCachedHashes([entry.originalPath])
        delete manifest[entry.id]
        changed = true
        deleted.push(entry.id)
        affected.push(...fileRels)
    }

    let manifestError: string | undefined
    if (changed) {
        if (!saveManifest(manifest)) manifestError = "manifest write failed"
        bumpMediaLibraryVersion()
    }
    return manifestError ? { deleted, failed, paths: affected, manifestError } : { deleted, failed, paths: affected }
}

/** Permanently delete every trashed entry. */
export function emptyTrash(): { deleted: string[]; paths: string[]; manifestError?: string } {
    const manifest = loadManifest()
    const ids = Object.keys(manifest)
    if (!ids.length) return { deleted: [], paths: [] }
    const result = deleteTrashPermanent(ids)
    return result.manifestError ? { deleted: result.deleted, paths: result.paths, manifestError: result.manifestError } : { deleted: result.deleted, paths: result.paths }
}

export interface TrashListing {
    entries: TrashEntry[]
    totalSize: number
    /** ids swept by the lazy expiry pass during this listing */
    swept: string[]
    /** current media-library version epoch (for reconnect reconciliation) */
    v: number
    /** set when the lazy sweep deleted content but couldn't persist the manifest */
    manifestError?: string
}

/**
 * Permanently delete entries older than the TTL. Runs on server start, on an
 * hourly interval (startTrashSweep), and lazily before every trash listing.
 */
export function sweepExpiredTrash(now: number = Date.now(), ttlMs: number = TRASH_TTL_MS): { swept: string[]; paths: string[]; manifestError?: string } {
    const manifest = loadManifest()
    const expired = Object.values(manifest).filter((e) => now - e.deletedAt >= ttlMs)
    if (!expired.length) return { swept: [], paths: [] }
    const result = deleteTrashPermanent(expired.map((e) => e.id))
    if (result.deleted.length) console.info(`Trash sweep: permanently deleted ${result.deleted.length} expired ${result.deleted.length === 1 ? "entry" : "entries"}`)
    if (result.manifestError) console.error("Trash sweep: deleted content but manifest persist failed — entries will be retried on the next sweep")
    return result.manifestError ? { swept: result.deleted, paths: result.paths, manifestError: result.manifestError } : { swept: result.deleted, paths: result.paths }
}

/** Trash contents, newest first, after enforcing expiry. */
export function listTrash(): TrashListing {
    const { swept, manifestError } = sweepExpiredTrash()
    const entries = Object.values(loadManifest()).sort((a, b) => b.deletedAt - a.deletedAt)
    const listing: TrashListing = { entries, totalSize: entries.reduce((sum, e) => sum + (e.size || 0), 0), swept, v: getMediaLibraryVersion() }
    if (manifestError) listing.manifestError = manifestError
    return listing
}

/** Hourly expiry sweep; `onSwept` fires only when something actually expired. */
export function startTrashSweep(onSwept: (swept: string[], paths: string[]) => void, intervalMs: number = 60 * 60 * 1000): () => void {
    const run = () => {
        try {
            const result = sweepExpiredTrash()
            if (result.swept.length) onSwept(result.swept, result.paths)
        } catch (err) {
            console.error("Trash sweep failed:", err)
        }
    }
    // enforce on startup too (the server may have been down past entries' expiry)
    run()
    const timer = setInterval(run, intervalMs)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    return () => clearInterval(timer)
}
