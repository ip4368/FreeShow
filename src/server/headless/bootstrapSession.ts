// ----- FreeShow -----
// Staged bootstrap sessions: a publish lands in a per-session staging dir and
// goes live only at commit, so an interrupted/corrupt publish never leaves the
// live library half-seeded (and a replace never wipes the live library before
// its replacement is fully uploaded + validated).
//
// Layout (inside the data root, so commit moves are same-filesystem renames):
//   <dataRoot>/.bootstrap-staging/<session>/snapshot.zip   validated library zip
//   <dataRoot>/.bootstrap-staging/<session>/files/**       staged media bytes
//
// Staged paths are invisible to clients: reads/listing exclude them (see
// isBootstrapStagingRel in dataPaths.ts). Sessions expire after 24h; expiry is
// swept on /bootstrap/start so crashed clients can't leak staging dirs.

import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import { getDataFolderRoot } from "./data/dataPaths"

export const BOOTSTRAP_STAGING_DIR = ".bootstrap-staging"
export const BOOTSTRAP_SESSION_TTL_MS = 24 * 3600 * 1000

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

interface BootstrapSession {
    force: boolean
    createdAt: number
}

const sessions = new Map<string, BootstrapSession>()

export function getBootstrapStagingRoot(): string {
    return path.join(getDataFolderRoot(), BOOTSTRAP_STAGING_DIR)
}

/** Absolute staging dir for a session id, or null when the id is malformed. */
export function getSessionDir(session: string): string | null {
    if (typeof session !== "string" || !SESSION_ID_RE.test(session)) return null
    const dir = path.join(getBootstrapStagingRoot(), session)
    // containment belt-and-braces (the regex already excludes separators/traversal)
    if (dir !== path.join(getBootstrapStagingRoot(), path.basename(dir))) return null
    return dir
}

export function getSessionFilesDir(session: string): string | null {
    const dir = getSessionDir(session)
    return dir ? path.join(dir, "files") : null
}

export function getSessionSnapshotPath(session: string): string | null {
    const dir = getSessionDir(session)
    return dir ? path.join(dir, "snapshot.zip") : null
}

export function createBootstrapSession(force: boolean): { session: string; expiresAt: number } {
    pruneExpiredBootstrapSessions()
    const session = randomUUID().replace(/-/g, "")
    const createdAt = Date.now()
    sessions.set(session, { force, createdAt })
    fs.mkdirSync(path.join(getSessionDir(session)!, "files"), { recursive: true })
    return { session, expiresAt: createdAt + BOOTSTRAP_SESSION_TTL_MS }
}

export function getBootstrapSession(session: string): (BootstrapSession & { dir: string }) | null {
    if (typeof session !== "string" || !SESSION_ID_RE.test(session)) return null
    const record = sessions.get(session)
    if (!record) return null
    if (Date.now() - record.createdAt > BOOTSTRAP_SESSION_TTL_MS) {
        abortBootstrapSession(session)
        return null
    }
    const dir = getSessionDir(session)!
    if (!fs.existsSync(dir)) {
        sessions.delete(session)
        return null
    }
    return { ...record, dir }
}

/** Forget a session and remove its staging dir (best-effort; missing = no-op). */
export function abortBootstrapSession(session: string): void {
    sessions.delete(session)
    const dir = typeof session === "string" && SESSION_ID_RE.test(session) ? getSessionDir(session) : null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * Remove staging dirs (and session records) older than maxAgeMs. The default
 * is the session TTL; pass an explicit age in tests.
 */
export function pruneExpiredBootstrapSessions(maxAgeMs: number = BOOTSTRAP_SESSION_TTL_MS): void {
    const root = getBootstrapStagingRoot()
    let entries: string[]
    try {
        entries = fs.readdirSync(root)
    } catch {
        return // no staging root yet — nothing to prune
    }
    const now = Date.now()
    for (const entry of entries) {
        // the staging root only ever holds session dirs (created above), so any
        // directory in it past the TTL is a crashed-client leftover — sweep it
        const dir = path.join(root, entry)
        let stat: fs.Stats
        try {
            stat = fs.statSync(dir)
        } catch {
            continue
        }
        if (!stat.isDirectory()) continue
        if (now - stat.mtimeMs > maxAgeMs) {
            sessions.delete(entry)
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
    // drop expired in-memory records whose dirs are already gone
    for (const [session, record] of sessions) {
        if (now - record.createdAt > maxAgeMs) sessions.delete(session)
    }
}
