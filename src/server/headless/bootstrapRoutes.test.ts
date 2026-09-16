import { createHash } from "crypto"
import express from "express"
import fs from "fs"
import type { Server } from "http"
import type { AddressInfo } from "net"
import os from "os"
import path from "path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { zipEntries } from "../../shared/data/zip"
import { setAuthToken } from "./auth"
import { pruneExpiredBootstrapSessions } from "./bootstrapSession"
import { registerBootstrapRoutes } from "./bootstrapRoutes"
import { getStore } from "./data/headlessStore"
import { setDataRoot } from "./data/dataPaths"
import { readFolderContent } from "./data/persistence"
import { resetMediaHashCache } from "./mediaHash"
import { registerMediaRoutes } from "./mediaRoutes"

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

// ----- staged (atomic) bootstrap sessions: snapshot + media go live together at commit -----
describe("staged bootstrap sessions (/bootstrap/start|commit, staged uploads)", () => {
    let server2: Server
    let base2 = ""
    let tmp2 = ""
    let stagedRestored: any[]
    let liveUploads: string[]
    let committedMedia: string[][]

    beforeAll(async () => {
        setAuthToken("")
        stagedRestored = []
        liveUploads = []
        committedMedia = []
        const app = express()
        registerBootstrapRoutes(app, {
            onRestore: (r) => void stagedRestored.push(r),
            onMediaCommitted: (rels) => void committedMedia.push(rels)
        })
        registerMediaRoutes(app, { onUpload: (rel) => void liveUploads.push(rel) })
        await new Promise<void>((resolve) => {
            server2 = app.listen(0, resolve)
        })
        base2 = `http://localhost:${(server2.address() as AddressInfo).port}`
    })

    afterAll(() => {
        server2?.close()
    })

    beforeEach(() => {
        if (tmp2) fs.rmSync(tmp2, { recursive: true, force: true })
        tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bootstrap-staged-"))
        setDataRoot(tmp2)
        resetMediaHashCache()
        stagedRestored = []
        liveUploads = []
        committedMedia = []
    })

    afterEach(() => {
        if (tmp2) fs.rmSync(tmp2, { recursive: true, force: true })
        tmp2 = ""
    })

    async function start(force = false): Promise<{ status: number; body: any }> {
        const res = await fetch(`${base2}/bootstrap/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force })
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
    }

    async function restoreStaged(session: string, entries: { name: string; content: string }[]): Promise<Response> {
        const zip = await zipEntries(entries)
        return fetch(`${base2}/bootstrap/restore?session=${session}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: zip as any
        })
    }

    async function uploadMedia(session: string | null, folder: string, name: string, bytes: string): Promise<Response> {
        return fetch(`${base2}/media/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}${session ? `&staging=${session}` : ""}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: Buffer.from(bytes) as any
        })
    }

    async function commit(session: string): Promise<{ status: number; body: any }> {
        const res = await fetch(`${base2}/bootstrap/commit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session })
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
    }

    async function abort(session: string): Promise<number> {
        const res = await fetch(`${base2}/bootstrap/session?session=${session}`, { method: "DELETE" })
        return res.status
    }

    async function manifest(paths: string[]): Promise<any> {
        const res = await fetch(`${base2}/media/manifest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths })
        })
        return res.json()
    }

    const SHOW = { name: "SHOWS/Staged.show", content: JSON.stringify(["staged1", { name: "Staged", slides: {} }]) }

    it("activates the snapshot and staged media together at commit (invisible before)", async () => {
        const started = await start()
        expect(started.status).toBe(200)
        const session = started.body.session as string
        expect(typeof session).toBe("string")

        // nothing is live yet
        expect(await (await fetch(`${base2}/bootstrap/status`)).json()).toMatchObject({ empty: true })

        const staged = await restoreStaged(session, [SHOW])
        expect(staged.status).toBe(200)
        expect(await staged.json()).toMatchObject({ finished: true })
        expect(fs.existsSync(path.join(tmp2, "Shows", "Staged.show"))).toBe(false)

        expect((await uploadMedia(session, "Media", "bg.jpg", "BG_BYTES")).status).toBe(200)
        expect((await uploadMedia(session, "Audio", "bed.mp3", "BED_BYTES")).status).toBe(200)
        // staged bytes are not servable and not in the manifest yet
        expect((await fetch(`${base2}/media?path=${encodeURIComponent("Media/bg.jpg")}`)).status).toBe(404)
        expect(await manifest(["Media/bg.jpg", "Audio/bed.mp3"])).toMatchObject({ files: [] })
        // ... and no live-upload broadcasts fired for staged bytes
        expect(liveUploads).toEqual([])

        const committed = await commit(session)
        expect(committed.status).toBe(200)
        expect(committed.body).toMatchObject({ finished: true, restoredShowIds: ["staged1"], replaced: false })

        // now everything is live at once
        expect(fs.existsSync(path.join(tmp2, "Shows", "Staged.show"))).toBe(true)
        expect(fs.readFileSync(path.join(tmp2, "Media", "bg.jpg"), "utf8")).toBe("BG_BYTES")
        expect(fs.readFileSync(path.join(tmp2, "Audio", "bed.mp3"), "utf8")).toBe("BED_BYTES")
        expect((await fetch(`${base2}/media?path=${encodeURIComponent("Media/bg.jpg")}`)).status).toBe(200)
        expect((await manifest(["Media/bg.jpg"])).files).toHaveLength(1)
        expect(await (await fetch(`${base2}/bootstrap/status`)).json()).toMatchObject({ shows: 1, empty: false })

        // hash contract the desktop resume relies on: server hashes are plain
        // sha1 hex of the bytes (verified here with node:crypto directly, not
        // through either side's hashing helper)
        const expected = createHash("sha1").update("BG_BYTES").digest("hex")
        const meta = await (await fetch(`${base2}/media/meta?path=${encodeURIComponent("Media/bg.jpg")}`)).json()
        expect(meta).toMatchObject({ size: 8, hash: expected })
        expect((await manifest(["Media/bg.jpg"])).files[0]).toMatchObject({ size: 8, hash: expected })

        // restore broadcast fired once; committed media broadcast with live paths
        expect(stagedRestored).toHaveLength(1)
        expect(stagedRestored[0].restoredShowIds).toEqual(["staged1"])
        expect(committedMedia).toHaveLength(1)
        expect(committedMedia[0].map((p) => p.replace(/\\/g, "/")).sort()).toEqual(["Audio/bed.mp3", "Media/bg.jpg"])

        // staging cleaned up; the session is single-use
        expect(fs.existsSync(path.join(tmp2, ".bootstrap-staging", session))).toBe(false)
        expect((await commit(session)).status).toBe(404)
    })

    it("keeps staged files invisible to reads and folder listings", async () => {
        const { body } = await start()
        const session = body.session as string
        await restoreStaged(session, [SHOW])
        await uploadMedia(session, "Media", "hidden.jpg", "HIDDEN")

        // direct reads of staging paths are forbidden
        const sneak = await fetch(`${base2}/media?path=${encodeURIComponent(`.bootstrap-staging/${session}/files/Media/hidden.jpg`)}`)
        expect(sneak.status).toBe(403)
        const sneakMeta = await fetch(`${base2}/media/meta?path=${encodeURIComponent(`.bootstrap-staging/${session}/files/Media/hidden.jpg`)}`)
        expect(sneakMeta.status).toBe(403)

        // folder listings never surface the staging dir
        const listing = readFolderContent({ path: "", depth: 2 })
        expect(Object.keys(listing).some((k) => k.includes(".bootstrap-staging"))).toBe(false)
        expect(Object.keys(listing).some((k) => k.includes("hidden.jpg"))).toBe(false)

        expect(await abort(session)).toBe(200)
    })

    it("abort discards staged state without touching the live library", async () => {
        const { body } = await start()
        const session = body.session as string
        await restoreStaged(session, [SHOW])
        await uploadMedia(session, "Media", "bg.jpg", "BG_BYTES")

        expect(await abort(session)).toBe(200)
        expect(await abort(session)).toBe(404) // already gone
        expect((await commit(session)).status).toBe(404)
        expect(await (await fetch(`${base2}/bootstrap/status`)).json()).toMatchObject({ empty: true })
        expect(fs.existsSync(path.join(tmp2, ".bootstrap-staging", session))).toBe(false)
        expect(fs.existsSync(path.join(tmp2, "Shows", "Staged.show"))).toBe(false)
    })

    it("rejects corrupt staged snapshots without touching live state", async () => {
        const { body } = await start()
        const session = body.session as string
        const res = await fetch(`${base2}/bootstrap/restore?session=${session}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: Buffer.from("definitely not a zip") as any
        })
        expect(res.status).toBe(400)
        // failed staging auto-cleans (no leak for the client to mop up)
        expect((await commit(session)).status).toBe(404)
        expect(await (await fetch(`${base2}/bootstrap/status`)).json()).toMatchObject({ empty: true })
    })

    it("commit re-validates the snapshot: post-staging corruption never touches live state", async () => {
        // seed the live library first (another client's data)
        const seed = await (async () => {
            const zip = await zipEntries([{ name: "SHOWS/Orig.show", content: JSON.stringify(["orig1", { name: "Orig", slides: {} }]) }])
            return fetch(`${base2}/bootstrap/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: zip as any })
        })()
        expect(seed.status).toBe(200)

        const { body } = await start(true)
        const session = body.session as string
        const staged = await restoreStaged(session, [SHOW])
        expect(staged.status).toBe(200)

        // corrupt the staged snapshot between staging and commit (disk fault mid-flight)
        fs.writeFileSync(path.join(tmp2, ".bootstrap-staging", session, "snapshot.zip"), "garbage")

        const committed = await commit(session)
        expect(committed.status).toBe(400)
        expect(committed.body.error).toBe("corrupt_snapshot")

        // live library is exactly as before: original show intact, staged show absent,
        // and the replace-mode wipe never ran
        expect(fs.existsSync(path.join(tmp2, "Shows", "Orig.show"))).toBe(true)
        expect(JSON.parse(fs.readFileSync(path.join(tmp2, "Shows", "Orig.show"), "utf8"))[0]).toBe("orig1")
        expect(fs.existsSync(path.join(tmp2, "Shows", "Staged.show"))).toBe(false)
        expect(await (await fetch(`${base2}/bootstrap/status`)).json()).toMatchObject({ shows: 1 })
        expect(fs.existsSync(path.join(tmp2, ".bootstrap-staging", session))).toBe(false)
    })

    it("commit conflicts when another client seeded after start (non-force)", async () => {
        const { body } = await start(false)
        const session = body.session as string
        await restoreStaged(session, [SHOW])

        // someone else seeds the live library before we commit
        const zip = await zipEntries([{ name: "SHOWS/Other.show", content: JSON.stringify(["other1", { name: "Other", slides: {} }]) }])
        const seed = await fetch(`${base2}/bootstrap/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: zip as any })
        expect(seed.status).toBe(200)

        const committed = await commit(session)
        expect(committed.status).toBe(409)
        expect(committed.body.error).toBe("not_empty")
        // the other client's data wins; our staged snapshot never landed
        expect(fs.existsSync(path.join(tmp2, "Shows", "Other.show"))).toBe(true)
        expect(fs.existsSync(path.join(tmp2, "Shows", "Staged.show"))).toBe(false)
    })

    it("start refuses a non-empty library without force (with counts)", async () => {
        const zip = await zipEntries([{ name: "SHOWS/Seeded.show", content: JSON.stringify(["s1", { name: "Seeded", slides: {} }]) }])
        await fetch(`${base2}/bootstrap/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: zip as any })

        const refused = await start(false)
        expect(refused.status).toBe(409)
        expect(refused.body).toMatchObject({ error: "not_empty", shows: 1 })

        const forced = await start(true)
        expect(forced.status).toBe(200)
        expect(typeof forced.body.session).toBe("string")
        await abort(forced.body.session)
    })

    it("prunes expired staging sessions", async () => {
        // a stale foreign dir (e.g. from a crashed client) is swept...
        const stale = path.join(tmp2, ".bootstrap-staging", "stale-session")
        fs.mkdirSync(stale, { recursive: true })
        fs.writeFileSync(path.join(stale, "snapshot.zip"), "x")
        const ancient = new Date(Date.now() - 48 * 3600 * 1000)
        fs.utimesSync(stale, ancient, ancient)

        // ... while a fresh session survives
        const { body } = await start(false)
        const live = path.join(tmp2, ".bootstrap-staging", body.session as string)
        expect(fs.existsSync(live)).toBe(true)

        pruneExpiredBootstrapSessions(60 * 1000)
        expect(fs.existsSync(stale)).toBe(false)
        expect(fs.existsSync(live)).toBe(true)
        await abort(body.session)
    })
})
