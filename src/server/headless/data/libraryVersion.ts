// ----- FreeShow -----
// Persisted media-library version epoch: bumped on every library mutation
// (trash/restore/delete/empty/sweep/upload) so reconnecting clients can detect
// changes they missed while offline and revalidate instead of serving stale
// cached copies. Reported on MEDIA_LIBRARY_CHANGED, TRASH_LIST, and STARTUP.
// Read fresh from disk on every call (tiny file, infrequent writes).

import { joinPath, parseJSON, readFile, writeFile } from "../../../shared/data/fsCore"
import { getDataFolderPath } from "./dataPaths"

const VERSION_FILE = "media-library-version.json"

function versionFilePath(): string {
    return joinPath(getDataFolderPath("userData"), VERSION_FILE)
}

/** Current epoch (0 when never bumped or the file is missing/corrupt). */
export function getMediaLibraryVersion(): number {
    const parsed = parseJSON<{ version: unknown }>(readFile(versionFilePath()) || "")
    if (typeof parsed?.version === "number" && Number.isFinite(parsed.version) && parsed.version >= 0) return Math.floor(parsed.version)
    return 0
}

/** Bump the epoch after an effective library mutation; returns the new value. */
export function bumpMediaLibraryVersion(): number {
    const next = getMediaLibraryVersion() + 1
    try {
        writeFile(versionFilePath(), JSON.stringify({ version: next }))
    } catch (err) {
        console.error("Failed to write media library version:", err)
    }
    return next
}
