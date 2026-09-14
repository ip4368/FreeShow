// ----- FreeShow -----
// Client side of the server trash (remote drawer deletes): usage-aware delete
// confirms, restore/permanent-delete/empty flows, and list fetching. Refreshes
// after mutation come from the server's MEDIA_LIBRARY_CHANGED broadcast —
// callers never refresh manually, so every connected client stays in sync.

import type { MediaUsageRef, TrashEntryData } from "../../types/IPC/Main"
import { Main } from "../../types/IPC/Main"
import { requestMain } from "../IPC/main"
import { getFileName } from "../components/helpers/media"
import { newToast } from "./common"
import { translateText } from "./language"
import { confirmCustom } from "./popup"

// confirm prompts render as HTML ({@html}) — escape library/show names
export function escapeHtml(value: string): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

export interface TrashUsage {
    usage: Record<string, MediaUsageRef[]>
    missing: { path: string; reason: string }[]
    summary: { files: number; usedFiles: number }
}

const MAX_USAGE_LINES = 8
const MAX_REFS_PER_LINE = 3

function formatRef(ref: MediaUsageRef): string {
    const name = escapeHtml(ref.name)
    let label: string
    // containing projects annotate the show ("test show (in Example, test)")
    // instead of reading as additional owners
    if (ref.kind === "show" && ref.projects?.length) {
        const projects = ref.projects.map((p) => escapeHtml(p.name)).join(", ")
        label = `${name} (${translateText("trash.in_projects").replace("$1", projects)})`
    } else if (ref.kind !== "show") label = `${name} (${translateText(`trash.kind_${ref.kind}`)})`
    else label = name
    // orphan (media-map-only) references are worth knowing but break nothing
    if (ref.weak) label += ` (${translateText("trash.unused_ref")})`
    return label
}

function usageLines(usage: TrashUsage): string[] {
    const lines: string[] = []
    for (const [filePath, refs] of Object.entries(usage.usage)) {
        if (!refs.length) continue
        const names = refs.slice(0, MAX_REFS_PER_LINE).map(formatRef)
        const extra = refs.length - names.length
        lines.push(`• ${escapeHtml(getFileName(filePath))} — ${names.join(", ")}${extra > 0 ? ` (+${extra})` : ""}`)
        if (lines.length >= MAX_USAGE_LINES) {
            const remaining = Object.values(usage.usage).filter((r) => r.length).length - lines.length
            if (remaining > 0) lines.push(`• … (+${remaining})`)
            break
        }
    }
    return lines
}

/**
 * Delete server paths (files and/or folders) after a usage-aware confirm.
 * Returns the trash result, or null when cancelled/failed/unreachable.
 */
export async function trashPathsWithConfirm(paths: string[]): Promise<{ trashed: TrashEntryData[]; failed: { path: string; reason: string }[] } | null> {
    const unique = [...new Set((paths || []).filter((p) => typeof p === "string" && p))]
    if (!unique.length) return null

    // what breaks if these go? (fast: ~200ms for 1000 shows server-side;
    // orphans included so nothing referenced is silently dropped from the confirm)
    const usage = await requestMain(Main.MEDIA_USAGE, { paths: unique, includeOrphans: true }).catch(() => null)
    if (!usage) {
        newToast(translateText("trash.server_unreachable"))
        return null
    }

    const count = translateText("trash.items_to_delete").replace("$1", String(unique.length))
    const lines = usageLines(usage)
    const prompt = lines.length ? `${count}<br><br>${translateText("trash.used_in")}:<br>${lines.join("<br>")}` : count
    if (!(await confirmCustom(prompt))) return null

    const result = await requestMain(Main.TRASH_FILES, { paths: unique }).catch(() => null)
    if (!result) {
        newToast(translateText("trash.server_unreachable"))
        return null
    }

    if (result.trashed.length) newToast(translateText("trash.moved").replace("$1", String(result.trashed.length)))
    for (const f of result.failed || []) newToast(`${translateText("trash.failed")}: ${f.path} (${f.reason})`)
    if (result.manifestError) newToast(translateText("trash.manifest_error"))
    return result
}

/** Restore trashed entries to their original paths. */
export async function restoreTrashEntries(ids: string[]): Promise<boolean> {
    const unique = [...new Set((ids || []).filter(Boolean))]
    if (!unique.length) return false
    const result = await requestMain(Main.TRASH_RESTORE, { ids: unique }).catch(() => null)
    if (!result) {
        newToast(translateText("trash.server_unreachable"))
        return false
    }
    if (result.restored?.length) newToast(translateText("trash.restored").replace("$1", String(result.restored.length)))
    for (const f of result.failed || []) newToast(`${translateText("trash.failed")}: ${f.path} (${f.reason})`)
    // renamed restores landed somewhere else: show the new names so the user can re-link
    const renamed = (result.restored || []).filter((r: any) => r?.renamed)
    if (renamed.length) newToast(`${translateText("trash.restored_renamed")}: ${renamed.map((r: any) => getFileName(r.path)).join(", ")}`)
    if (result.manifestError) newToast(translateText("trash.manifest_error"))
    return true
}

/** Permanently delete trashed entries (confirmed). */
export async function deleteTrashEntries(ids: string[], names: string[]): Promise<boolean> {
    const unique = [...new Set((ids || []).filter(Boolean))]
    if (!unique.length) return false
    const shown = names.slice(0, 5).map(escapeHtml).join("<br>• ")
    const prompt = `${translateText("trash.confirm_permanent")}<br><br>• ${shown}${names.length > 5 ? `<br>• … (+${names.length - 5})` : ""}`
    if (!(await confirmCustom(prompt))) return false
    const result = await requestMain(Main.TRASH_DELETE, { ids: unique }).catch(() => null)
    if (!result) {
        newToast(translateText("trash.server_unreachable"))
        return false
    }
    if (result.deleted?.length) newToast(translateText("trash.deleted").replace("$1", String(result.deleted.length)))
    if (result.manifestError) newToast(translateText("trash.manifest_error"))
    return true
}

/** Permanently delete the entire trash (confirmed). */
export async function emptyTrashBin(count: number): Promise<boolean> {
    if (!count) return false
    if (!(await confirmCustom(translateText("trash.confirm_empty").replace("$1", String(count))))) return false
    const result = await requestMain(Main.TRASH_EMPTY).catch(() => null)
    if (!result) {
        newToast(translateText("trash.server_unreachable"))
        return false
    }
    newToast(translateText("trash.emptied"))
    if (result.manifestError) newToast(translateText("trash.manifest_error"))
    return true
}

/** Current trash contents (newest first). */
export async function listTrashEntries(): Promise<{ entries: TrashEntryData[]; totalSize: number }> {
    const result = await requestMain(Main.TRASH_LIST).catch(() => null)
    return { entries: result?.entries || [], totalSize: result?.totalSize || 0 }
}
