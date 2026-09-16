// ----- FreeShow -----
// Bootstrap: one-shot seed of a headless server from a local desktop client.
//
// Staged flow (what the desktop publisher uses — snapshot + media go live
// together at commit, so an interrupted/corrupt publish never leaves the live
// library half-seeded):
//
//   POST /bootstrap/start { force? }      -> { session, expiresAt } (409 when
//                                           non-empty without force, with counts)
//   POST /bootstrap/restore?session=<id>  raw zip bytes -> validated + staged
//                                           ( NOT activated yet)
//   POST /media/upload?...&staging=<id>   media bytes -> staged (invisible until
//                                           commit; no live broadcasts)
//   POST /bootstrap/commit { session }    validate -> move staged media live ->
//                                           restore snapshot -> broadcast
//   DELETE /bootstrap/session?session=<id> discard staged state
//
// Every failed commit/stage auto-cleans its session (no leaks), and expired
// sessions are swept on start (see bootstrapSession.ts).
//
// Legacy single-shot (kept for old clients):
//   POST /bootstrap/restore (no session)  raw zip bytes -> immediate restore

import type { Express, Request, Response } from "express"
import express from "express"
import fs from "fs"
import os from "os"
import path from "path"
import { unzipBuffer } from "../../shared/data/zip"
import type { RestoreResult } from "../../shared/platform/Platform"
import { httpAuth } from "./auth"
import { abortBootstrapSession, createBootstrapSession, getBootstrapSession, getSessionFilesDir, getSessionSnapshotPath } from "./bootstrapSession"
import { clearLibraryForReplace, getBootstrapStatus, restoreEntries } from "./data/persistence"
import { resolveInSandbox, toSandboxRelative } from "./data/dataPaths"
import { bumpMediaLibraryVersion } from "./data/libraryVersion"
import { streamRequestBodyToFile } from "./mediaRoutes"

const MAX_BOOTSTRAP_BYTES = 500 * 1024 * 1024 // 500MB — shows/stores/bibles only, media uploads separately

export interface BootstrapRouteOptions {
    /** Called after a successful restore so the server can invalidate docs + broadcast. */
    onRestore?: (result: RestoreResult & { clearedShows?: string[]; replaced?: boolean }) => void
    /** Called at commit with the sandbox-relative paths of newly activated media. */
    onMediaCommitted?: (relPaths: string[]) => void
}

/** All regular files under a dir, recursively (symlinks and friends skipped). */
function collectStagedFiles(dir: string): string[] {
    const out: string[] = []
    const walk = (current: string) => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (entry.isFile()) out.push(full)
        }
    }
    walk(dir)
    return out
}

export function registerBootstrapRoutes(app: Express, options: BootstrapRouteOptions = {}) {
    app.get("/bootstrap/status", httpAuth, (_req: Request, res: Response) => {
        return void res.json(getBootstrapStatus())
    })

    app.post("/bootstrap/start", httpAuth, express.json({ limit: "100kb" }), (req: Request, res: Response) => {
        const force = (req.body as any)?.force === true
        const status = getBootstrapStatus()
        if (!status.empty && !force) {
            return void res.status(409).json({ error: "not_empty", ...status })
        }
        return void res.json(createBootstrapSession(force))
    })

    app.post("/bootstrap/restore", httpAuth, async (req: Request, res: Response) => {
        const session = typeof req.query.session === "string" ? req.query.session : ""
        if (session) return void stageSnapshot(req, res, session)

        // legacy immediate path (no session): today's behavior, unchanged
        const force = req.query.force === "true" || req.query.force === "1"
        const status = getBootstrapStatus()
        if (!status.empty && !force) {
            return void res.status(409).json({ finished: false, error: "not_empty", ...status })
        }

        // stream to a temp file (never buffer hundreds of MB in RAM), then unzip from disk
        const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fs-bootstrap-")), "bootstrap.zip")
        try {
            await streamRequestBodyToFile(req, tmpPath, MAX_BOOTSTRAP_BYTES)
        } catch (err: any) {
            fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
            if (err?.overLimit) return void res.status(413).send("bootstrap too large")
            console.error("Bootstrap upload failed:", err)
            return void res.status(500).send("write failed")
        }

        let buffer: Buffer
        try {
            buffer = fs.readFileSync(tmpPath)
        } catch (err) {
            fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
            console.error("Bootstrap read failed:", err)
            return void res.status(500).send("read failed")
        } finally {
            fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
        }
        if (!buffer.length) return void res.status(400).send("empty body")

        let clearedShows: string[] = []
        if (force && !status.empty) clearedShows = clearLibraryForReplace().clearedShows

        try {
            const entries = await unzipBuffer(buffer)
            const result = restoreEntries(entries)
            if (!result.finished) return void res.status(500).json(result)
            try {
                options.onRestore?.({ ...result, clearedShows, replaced: force && !status.empty })
            } catch (err) {
                console.error("Bootstrap broadcast failed:", err)
            }
            return void res.json({ ...result, replaced: force && !status.empty })
        } catch (err: any) {
            console.error("Bootstrap restore failed:", err)
            return void res.status(400).json({ finished: false, error: err?.message || "restore_failed" })
        }
    })

    app.post("/bootstrap/commit", httpAuth, express.json({ limit: "100kb" }), async (req: Request, res: Response) => {
        const session = (req.body as any)?.session
        const record = typeof session === "string" ? getBootstrapSession(session) : null
        if (!record) return void res.status(404).json({ finished: false, error: "unknown_session" })

        const fail = (status: number, body: any) => {
            // every failed commit cleans up — clients never mop up staging
            abortBootstrapSession(session)
            return void res.status(status).json(body)
        }

        // re-validate the staged snapshot BEFORE touching anything live (it may
        // have been corrupted after staging)
        const snapshotPath = getSessionSnapshotPath(session)!
        let snapshot: Buffer
        try {
            snapshot = fs.readFileSync(snapshotPath)
        } catch {
            return fail(400, { finished: false, error: "missing_snapshot" })
        }
        let stagedEntries: { name: string; content: string }[]
        try {
            stagedEntries = await unzipBuffer(snapshot)
        } catch {
            return fail(400, { finished: false, error: "corrupt_snapshot" })
        }

        // re-check the replace guard (another client may have seeded since start)
        const status = getBootstrapStatus()
        if (!status.empty && !record.force) {
            return fail(409, { finished: false, error: "not_empty", ...status })
        }

        // media first: moves are additive, so a failure here still leaves the
        // live library committable on retry (same tolerance as upload failures)
        const movedRels: string[] = []
        const moveFailed: { path: string; reason: string }[] = []
        const filesDir = getSessionFilesDir(session)!
        for (const abs of collectStagedFiles(filesDir)) {
            const rel = path.relative(filesDir, abs)
            const target = resolveInSandbox(rel)
            if (!target) {
                moveFailed.push({ path: rel, reason: "forbidden" })
                continue
            }
            try {
                fs.mkdirSync(path.dirname(target), { recursive: true })
                fs.renameSync(abs, target)
                movedRels.push(toSandboxRelative(target))
            } catch (err) {
                moveFailed.push({ path: rel, reason: (err as Error)?.message?.slice(0, 120) || "move failed" })
            }
        }
        if (movedRels.length) bumpMediaLibraryVersion()

        // the replace-mode wipe runs here — after everything staged + validated —
        // not upfront, so the data-loss window is milliseconds, not minutes
        let clearedShows: string[] = []
        if (record.force && !status.empty) clearedShows = clearLibraryForReplace().clearedShows

        // restoreEntries is per-entry lenient (bad entries are skipped, writes are
        // best-effort), so finished:false here means something unexpected threw;
        // report it — the snapshot was already validated twice, so this is a
        // disk/process fault, not a bad publish
        const result = restoreEntries(stagedEntries)
        if (!result.finished) return fail(500, result)

        abortBootstrapSession(session)
        try {
            options.onRestore?.({ ...result, clearedShows, replaced: record.force && !status.empty })
        } catch (err) {
            console.error("Bootstrap broadcast failed:", err)
        }
        try {
            options.onMediaCommitted?.(movedRels)
        } catch (err) {
            console.error("Bootstrap media broadcast failed:", err)
        }
        return void res.json({ ...result, replaced: record.force && !status.empty, media: { moved: movedRels.length, failed: moveFailed } })
    })

    app.delete("/bootstrap/session", httpAuth, (req: Request, res: Response) => {
        const session = typeof req.query.session === "string" ? req.query.session : ""
        if (!getBootstrapSession(session)) return void res.status(404).json({ error: "unknown_session" })
        abortBootstrapSession(session)
        return void res.json({ aborted: true })
    })
}

/** Validate + stage a snapshot zip (NOT activated — commit does that). */
async function stageSnapshot(req: Request, res: Response, session: string) {
    if (!getBootstrapSession(session)) return void res.status(404).json({ finished: false, error: "unknown_session" })
    const snapshotPath = getSessionSnapshotPath(session)!

    const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fs-bootstrap-")), "bootstrap.zip")
    try {
        await streamRequestBodyToFile(req, tmpPath, MAX_BOOTSTRAP_BYTES)
    } catch (err: any) {
        fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
        if (err?.overLimit) return void res.status(413).send("bootstrap too large")
        console.error("Bootstrap upload failed:", err)
        return void res.status(500).send("write failed")
    }

    let buffer: Buffer
    try {
        buffer = fs.readFileSync(tmpPath)
    } catch (err) {
        fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
        console.error("Bootstrap read failed:", err)
        return void res.status(500).send("read failed")
    } finally {
        fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true })
    }
    if (!buffer.length) return void res.status(400).send("empty body")

    // validate BEFORE staging: an invalid zip never becomes committable state
    let entries: { name: string; content: string }[]
    try {
        entries = await unzipBuffer(buffer)
    } catch {
        abortBootstrapSession(session)
        return void res.status(400).json({ finished: false, error: "corrupt_snapshot" })
    }

    try {
        fs.writeFileSync(snapshotPath, buffer)
    } catch (err) {
        console.error("Bootstrap stage failed:", err)
        return void res.status(500).send("write failed")
    }
    return void res.json({ finished: true, staged: { entries: entries.length } })
}
