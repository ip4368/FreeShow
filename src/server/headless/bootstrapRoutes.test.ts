import express from "express"
import fs from "fs"
import type { Server } from "http"
import type { AddressInfo } from "net"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { zipEntries } from "../../shared/data/zip"
import { setAuthToken } from "./auth"
import { registerBootstrapRoutes } from "./bootstrapRoutes"
import { getStore } from "./data/headlessStore"
import { setDataRoot } from "./data/dataPaths"

let server: Server
let base = ""
let tmpDir = ""
let restored: any[] = []

beforeAll(async () => {
    setAuthToken("")
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bootstrap-"))
    setDataRoot(tmpDir)

    const app = express()
    registerBootstrapRoutes(app, { onRestore: (r) => void restored.push(r) })
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve)
    })
    base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
    server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function postZip(entries: { name: string; content: string }[], force = false): Promise<Response> {
    const zip = await zipEntries(entries)
    return fetch(`${base}/bootstrap/restore${force ? "?force=true" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: zip as any
    })
}

describe("bootstrap /bootstrap/status + /bootstrap/restore", () => {
    it("reports empty on a fresh data root", async () => {
        const res = await fetch(`${base}/bootstrap/status`)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ shows: 0, bibles: 0, empty: true })
    })

    it("restores shows, stores, bibles and MEDIA from a bootstrap zip", async () => {
        const res = await postZip([
            { name: "SHOWS/Seeded.show", content: JSON.stringify(["seed1", { name: "Seeded", slides: {} }]) },
            { name: "SYNCED_SETTINGS.json", content: JSON.stringify({ language: "en" }) },
            { name: "MEDIA.json", content: JSON.stringify({ "Media/a.mp4": { favourite: true } }) },
            { name: "BIBLE_KJV.fsb", content: JSON.stringify(["kjv", { name: "KJV", books: [] }]) }
        ])
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.finished).toBe(true)
        expect(body.restoredShowIds).toEqual(["seed1"])
        expect(body.restoredBibles).toBe(1)

        expect(fs.existsSync(path.join(tmpDir, "Shows", "Seeded.show"))).toBe(true)
        expect(fs.existsSync(path.join(tmpDir, "Bibles", "KJV.fsb"))).toBe(true)
        expect(getStore("MEDIA")).toMatchObject({ "Media/a.mp4": { favourite: true } })
        expect(restored.length).toBe(1)
        expect(restored[0].changed?.SHOWS?.seed1).toMatchObject({ name: "Seeded" })
    })

    it("reports non-empty after seeding", async () => {
        const res = await fetch(`${base}/bootstrap/status`)
        expect(await res.json()).toMatchObject({ shows: 1, bibles: 1, empty: false })
    })

    it("refuses a second seed with 409 unless forced", async () => {
        const res = await postZip([{ name: "SHOWS/Other.show", content: JSON.stringify(["other", { name: "Other", slides: {} }]) }])
        expect(res.status).toBe(409)
        expect((await res.json()).error).toBe("not_empty")
        expect(fs.existsSync(path.join(tmpDir, "Shows", "Other.show"))).toBe(false)
    })

    it("replace mode clears stale shows before restoring", async () => {
        const res = await postZip([{ name: "SHOWS/Replacement.show", content: JSON.stringify(["repl", { name: "Replacement", slides: {} }]) }], true)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.finished).toBe(true)
        expect(body.replaced).toBe(true)
        expect(fs.existsSync(path.join(tmpDir, "Shows", "Seeded.show"))).toBe(false)
        expect(fs.existsSync(path.join(tmpDir, "Shows", "Replacement.show"))).toBe(true)
        // cleared docs are reported so the server can invalidate resident CRDT state
        expect(restored.at(-1).clearedShows).toContain("seed1")
    })
})
