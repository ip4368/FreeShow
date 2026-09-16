// ----- FreeShow -----
// Bootstrap: one-shot seed of a headless server from a local desktop client.
//
//   GET  /bootstrap/status              { shows, bibles, empty } (replace-guard signal)
//   POST /bootstrap/restore?force=true  raw zip bytes -> restoreEntries (HTTP, not the
//                                      100MB-capped socket channel, so larger libraries fit)
//
// The zip format is the same backup shape RESTORE_UPLOAD accepts (SHOWS/*.show,
// <STORE>.json, BIBLE_*), so the write core is shared. On success the route reports
// which stores changed + which shows were written; the caller (index.ts) invalidates
// resident CRDT docs and broadcasts to connected clients, mirroring RESTORE_UPLOAD.

import type { Express, Request, Response } from "express"
import fs from "fs"
import os from "os"
import path from "path"
import { unzipBuffer } from "../../shared/data/zip"
import type { RestoreResult } from "../../shared/platform/Platform"
import { httpAuth } from "./auth"
import { clearLibraryForReplace, getBootstrapStatus, restoreEntries } from "./data/persistence"
import { streamRequestBodyToFile } from "./mediaRoutes"

const MAX_BOOTSTRAP_BYTES = 500 * 1024 * 1024 // 500MB — shows/stores/bibles only, media uploads separately

export interface BootstrapRouteOptions {
    /** Called after a successful restore so the server can invalidate docs + broadcast. */
    onRestore?: (result: RestoreResult & { clearedShows?: string[]; replaced?: boolean }) => void
}

export function registerBootstrapRoutes(app: Express, options: BootstrapRouteOptions = {}) {
    app.get("/bootstrap/status", httpAuth, (_req: Request, res: Response) => {
        return void res.json(getBootstrapStatus())
    })

    app.post("/bootstrap/restore", httpAuth, async (req: Request, res: Response) => {
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
}
