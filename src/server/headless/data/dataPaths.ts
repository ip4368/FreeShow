// ----- FreeShow -----
// Data folder resolution for the headless server. Mirrors the folder names used
// by the desktop app (src/electron/utils/files.ts dataFolderNames) so a data
// directory is interchangeable in layout. The root is chosen from (in order):
//   1. explicit setDataRoot() (CLI --data)
//   2. env FREESHOW_DATA
//   3. ~/.freeshow

import os from "os"
import path from "path"
import { ensureDir, joinPath } from "../../../shared/data/fsCore"

export const dataFolderNames: { [key: string]: string } = {
    shows: "Shows",
    backups: "Backups",
    scriptures: "Bibles",
    onlineMedia: "Online",
    media: "Media",
    exports: "Exports",
    imports: "Imports",
    lessons: "Lessons",
    planningcenter: "Planning Center",
    recordings: "Recordings",
    audio: "Audio",
    userData: "Config",
    cloud: "Cloud",
    trash: "Trash"
}

let dataRoot = ""

export function setDataRoot(root: string) {
    dataRoot = root
}

export function getDataFolderRoot(): string {
    if (dataRoot) return dataRoot
    if (process.env.FREESHOW_DATA) return process.env.FREESHOW_DATA
    return joinPath(os.homedir(), ".freeshow")
}

export function getDataFolderPath(id: string): string {
    const folderName = dataFolderNames[id] || id
    return ensureDir(joinPath(getDataFolderRoot(), folderName))
}

// ----- SANDBOX -----
// Remote clients only ever see/use paths RELATIVE to this root, and can never escape it.
// This both hides the server's absolute directory structure and confines file access.

export function getSandboxRoot(): string {
    return path.resolve(getDataFolderRoot())
}

/**
 * Resolve a client-provided path (relative to the sandbox root, or an absolute path that
 * happens to be inside it) to an absolute path INSIDE the sandbox. Returns null if the
 * path escapes the sandbox (../ traversal, or an absolute path outside the root).
 */
export function resolveInSandbox(requested: string | undefined): string | null {
    const root = getSandboxRoot()
    if (!requested) return root

    let p = requested
    if (p.startsWith("file://")) p = p.slice("file://".length)

    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)
    if (abs === root || abs.startsWith(root + path.sep)) return abs
    return null
}

/** Absolute sandbox path -> path relative to the sandbox root ("" for the root itself). */
export function toSandboxRelative(abs: string): string {
    return path.relative(getSandboxRoot(), abs)
}

/** True when a sandbox-relative path is inside Trash (for serving/listing exclusion). */
export function isTrashRel(rel: string): boolean {
    const norm = rel.replace(/\\/g, "/").toLowerCase()
    return norm === "trash" || norm.startsWith("trash/")
}

/**
 * True when a sandbox-relative path is inside the bootstrap staging area (see
 * bootstrapSession.ts). Staged bytes are invisible until commit: same
 * serving/listing exclusion as Trash. Case-sensitive on purpose — the staging
 * dir name is server-generated, never user input.
 */
export function isBootstrapStagingRel(rel: string): boolean {
    const norm = rel.replace(/\\/g, "/")
    return norm === ".bootstrap-staging" || norm.startsWith(".bootstrap-staging/")
}
