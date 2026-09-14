// ----- FreeShow -----
// On-demand "used by" scan for trash deletes: which shows/projects/overlays/
// templates reference these library files. Runs at delete-confirm time over the
// .show files (fast: ~200ms for 1000 large shows), so no persistent ref-count
// index is needed. Reuses the prefetch collector (shared/media/collectShowMedia)
// so the reference definition stays identical everywhere.

import fs from "fs"
import path from "path"
import type { Show } from "../../../types/Show"
import { joinPath, parseJSON, readFile, readFolder } from "../../../shared/data/fsCore"
import { collectMediaPathsFromShow, isCacheableMediaPath, projectRefDirectPath } from "../../../shared/media/collectShowMedia"
import { getDataFolderPath, resolveInSandbox, toSandboxRelative } from "./dataPaths"
import { getStore } from "./headlessStore"
import { normalizeRel } from "./trash"

export interface UsageRef {
    kind: "show" | "project" | "overlay" | "template" | "playlist"
    id: string
    name: string
    /** show refs only: projects containing the show (attribution, not extra owners) */
    projects?: { id: string; name: string }[]
    /** media-map-only (orphan) reference: not reachable from any slide/layout */
    weak?: boolean
}

export interface UsageOptions {
    /**
     * Also report show.media-map entries that no slide/layout reaches (opt-in
     * because slide deletion never prunes the map, so orphans are common and
     * deleting their files breaks nothing at playback — but the delete confirm
     * shows them as weak references so nothing is silently dropped).
     */
    includeOrphans?: boolean
}

export interface MediaUsage {
    /** normalized rel path -> referencing library items (empty when unreferenced) */
    usage: Record<string, UsageRef[]>
    missing: { path: string; reason: string }[]
    summary: { files: number; usedFiles: number }
}

/**
 * Match key for a referenced path: show files store a mix of absolute server
 * paths and sandbox-relative paths, so absolutize-then-relativize anything
 * inside the sandbox and compare the normalized relative form. Both the raw
 * and lowercase keys are matched (macOS/Windows servers are case-insensitive).
 */
function matchKeys(value: string): string[] {
    const keys = new Set<string>()
    let p = value.trim()
    if (p.startsWith("file://")) p = p.slice("file://".length)
    const abs = resolveInSandbox(p)
    const rel = abs ? normalizeRel(toSandboxRelative(abs)) : normalizeRel(p)
    keys.add(rel)
    keys.add(rel.toLowerCase())
    return [...keys]
}

function collectFilesRecursive(absDir: string, out: string[]) {
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const full = path.join(absDir, entry.name)
        if (entry.isDirectory()) collectFilesRecursive(full, out)
        else if (entry.isFile()) out.push(full)
    }
}

/** Overlay/template standalone items (mirrors collectShowMedia's item walk). */
function collectStandalonePaths(items: any[] | undefined, into: Set<string>) {
    if (!Array.isArray(items)) return
    for (const item of items) {
        if (!item) continue
        if (isCacheableMediaPath(item.src)) into.add(item.src)
        const legacy: any = (item as any).media
        if (typeof legacy === "string" && isCacheableMediaPath(legacy)) into.add(legacy)
        else if (legacy && typeof legacy === "object") {
            if (isCacheableMediaPath(legacy.path)) into.add(legacy.path)
            if (isCacheableMediaPath(legacy.src)) into.add(legacy.src)
        }
    }
}

export function findMediaUsage(paths: string[], options?: UsageOptions): MediaUsage {
    const usage: Record<string, UsageRef[]> = {}
    const missing: { path: string; reason: string }[] = []
    // match key -> canonical result key (normalized rel path)
    const targets = new Map<string, string>()

    const addTarget = (rel: string) => {
        if (usage[rel]) return
        usage[rel] = []
        for (const key of [rel, rel.toLowerCase()]) {
            if (!targets.has(key)) targets.set(key, rel)
        }
    }

    for (const raw of Array.isArray(paths) ? paths : []) {
        const label = String(raw ?? "")
        const abs = typeof raw === "string" ? resolveInSandbox(raw) : null
        if (!abs) {
            missing.push({ path: label, reason: "forbidden" })
            continue
        }
        let stat: fs.Stats
        try {
            stat = fs.statSync(abs)
        } catch {
            missing.push({ path: label, reason: "not found" })
            continue
        }
        if (stat.isDirectory()) {
            const files: string[] = []
            collectFilesRecursive(abs, files)
            if (!files.length) addTarget(normalizeRel(toSandboxRelative(abs)))
            for (const f of files) addTarget(normalizeRel(toSandboxRelative(f)))
        } else {
            addTarget(normalizeRel(toSandboxRelative(abs)))
        }
    }

    if (!targets.size) return { usage, missing, summary: { files: 0, usedFiles: 0 } }

    const seen = new Set<string>() // target + kind:id dedupe
    const record = (referenced: string, ref: UsageRef) => {
        for (const key of matchKeys(referenced)) {
            const target = targets.get(key)
            if (!target) continue
            const dedupe = `${target}|${ref.kind}|${ref.id}`
            if (seen.has(dedupe)) continue
            seen.add(dedupe)
            usage[target].push(ref)
        }
    }

    const overlays = getStore("OVERLAYS") || {}
    const templates = getStore("TEMPLATES") || {}

    // shows (+ their overlay/template references via the shared collector)
    const showsPath = getDataFolderPath("shows")
    const showsById: Record<string, Show> = {}
    const showNames: Record<string, string> = {}
    for (const file of readFolder(showsPath)) {
        if (!file.toLowerCase().endsWith(".show")) continue
        const parsed = parseJSON<[string, Show]>(readFile(joinPath(showsPath, file)) || "")
        if (!parsed?.[0] || !parsed[1]) continue
        showsById[parsed[0]] = parsed[1]
        showNames[parsed[0]] = parsed[1].name || file.slice(0, -5)
    }
    // projects first: show refs are CONTAINMENT (annotated onto the show ref),
    // direct media items + timeline actions are genuine project-level owners
    const projectsStore = getStore("PROJECTS") || {}
    const projects = projectsStore.projects || projectsStore
    const showProjects: Record<string, { id: string; name: string }[]> = {}
    const recordProjectDirect = (p: string, id: string, name: string) => record(p, { kind: "project", id, name })
    for (const [id, project] of Object.entries<any>(projects)) {
        if (!project) continue
        const name = project.name || id
        for (const ref of project.shows || []) {
            if (!ref) continue
            if (showsById[ref.id]) {
                const list = (showProjects[ref.id] = showProjects[ref.id] || [])
                if (!list.some((e) => e.id === id)) list.push({ id, name })
                continue
            }
            const direct = projectRefDirectPath(ref)
            if (direct) recordProjectDirect(direct, id, name)
        }
        for (const action of project.timeline?.actions || []) {
            if (isCacheableMediaPath(action?.data?.path)) recordProjectDirect(action.data.path, id, name)
        }
    }

    for (const [id, show] of Object.entries(showsById)) {
        const ref: UsageRef = { kind: "show", id, name: showNames[id] }
        if (showProjects[id]?.length) ref.projects = showProjects[id]
        const collected = collectMediaPathsFromShow(show, { overlays, templates })
        for (const p of collected) {
            record(p, ref)
        }
        // opt-in orphan pass: media-map entries whose paths match a target but
        // are NOT reachable from any slide/layout (slide deletion never prunes
        // the map). Reported weak so the confirm can show them distinctly.
        if (options?.includeOrphans && show.media && typeof show.media === "object") {
            const strongKeys = new Set<string>()
            for (const p of collected) {
                for (const key of matchKeys(p)) strongKeys.add(key)
            }
            for (const entry of Object.values<any>(show.media)) {
                const raw = typeof entry?.path === "string" && entry.path ? entry.path : typeof entry?.id === "string" ? entry.id : ""
                if (!isCacheableMediaPath(raw)) continue
                const keys = matchKeys(raw)
                if (!keys.some((k) => targets.has(k))) continue
                if (keys.some((k) => strongKeys.has(k))) continue
                record(raw, { ...ref, weak: true })
            }
        }
    }

    // standalone overlays/templates (referenced even when no show uses them yet)
    for (const [id, overlay] of Object.entries<any>(overlays)) {
        if (!overlay) continue
        const found = new Set<string>()
        collectStandalonePaths(overlay.items, found)
        for (const p of found) record(p, { kind: "overlay", id, name: overlay.name || id })
    }
    for (const [id, template] of Object.entries<any>(templates)) {
        if (!template) continue
        const found = new Set<string>()
        collectStandalonePaths(template.items, found)
        if (isCacheableMediaPath(template.settings?.backgroundPath)) found.add(template.settings.backgroundPath)
        for (const p of found) record(p, { kind: "template", id, name: template.name || id })
    }

    // audio playlists (SETTINGS.audioPlaylists): each song is a library-audio path
    const playlists = getStore("SETTINGS")?.audioPlaylists || {}
    for (const [id, playlist] of Object.entries<any>(playlists)) {
        if (!playlist || !Array.isArray(playlist.songs)) continue
        const name = playlist.name || id
        for (const song of playlist.songs) {
            if (isCacheableMediaPath(song)) record(song, { kind: "playlist", id, name })
        }
    }

    const keys = Object.keys(usage)
    return { usage, missing, summary: { files: keys.length, usedFiles: keys.filter((k) => usage[k].length > 0).length } }
}
