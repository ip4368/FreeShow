// ----- FreeShow -----
// Client-side tracking for the server's media-library version epoch: the server
// bumps a persisted counter on every library mutation (trash/restore/delete/
// empty/sweep/upload) and reports it on every MEDIA_LIBRARY_CHANGED broadcast,
// TRASH_LIST response, and STARTUP payload. A client that missed broadcasts
// while disconnected compares versions on reconnect and revalidates instead of
// serving stale cached copies.
//
// Pure + dependency-free (no Electron / Svelte) so it runs everywhere unit tests run.

export interface ReconcileDecision {
    /** true when the client missed library changes and must revalidate */
    reconcile: boolean
    /** version baseline to keep (adopted when previously unknown) */
    seen: number | null
}

/**
 * Compare the client's last-seen library version against the server's current
 * one. An unknown current (old server without the epoch) never triggers a
 * reconcile; an unknown baseline (first contact) is adopted, not reconciled.
 */
export function decideLibraryReconcile(lastSeen: number | null, current: unknown): ReconcileDecision {
    if (typeof current !== "number" || !Number.isFinite(current)) return { reconcile: false, seen: lastSeen }
    if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) return { reconcile: false, seen: current }
    if (current !== lastSeen) return { reconcile: true, seen: current }
    return { reconcile: false, seen: current }
}
