import { createHash } from "crypto"
import express from "express"
import fs from "fs"
import type { Server } from "http"
import type { AddressInfo } from "net"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setAuthToken } from "./auth"
import { setDataRoot } from "./data/dataPaths"
import { resetMediaHashCache } from "./mediaHash"
import { registerMediaRoutes } from "./mediaRoutes"

let server: Server
let base = ""
let tmpDir = ""

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex")

beforeAll(async () => {
    setAuthToken("")
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-manifest-"))
    setDataRoot(tmpDir)
    resetMediaHashCache()
    fs.mkdirSync(path.join(tmpDir, "Media"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "Media", "a.png"), "AAA_BYTES")
    fs.writeFileSync(path.join(tmpDir, "Media", "b.mp4"), "BBB_BYTES_LONGER")
    fs.writeFileSync(path.join(tmpDir, "Media", "slides.pptx"), "PPTX_BYTES")
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "secret")

    const app = express()
    registerMediaRoutes(app)
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve)
    })
    base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
    server?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    resetMediaHashCache()
})

describe("GET /media/meta", () => {
    it("returns size, mtimeMs, hash and mime", async () => {
        const res = await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}`)
        expect(res.status).toBe(200)
        const meta = await res.json()
        expect(meta.path).toBe(path.join("Media", "a.png"))
        expect(meta.size).toBe("AAA_BYTES".length)
        expect(typeof meta.mtimeMs).toBe("number")
        expect(meta.hash).toBe(sha1("AAA_BYTES"))
        expect(meta.mime).toBe("image/png")
    })

    it("hash changes when the file changes (mtime/size invalidation)", async () => {
        const before = await (await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}`)).json()
        fs.writeFileSync(path.join(tmpDir, "Media", "a.png"), "AAA_BYTES_v2!!")
        const after = await (await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}`)).json()
        expect(after.hash).toBe(sha1("AAA_BYTES_v2!!"))
        expect(after.hash).not.toBe(before.hash)
        expect(after.size).not.toBe(before.size)
    })

    it("rejects traversal, non-media and missing files like /media", async () => {
        expect((await fetch(`${base}/media/meta?path=${encodeURIComponent("../../x.png")}`)).status).toBe(403)
        expect((await fetch(`${base}/media/meta?path=${encodeURIComponent("notes.txt")}`)).status).toBe(415)
        expect((await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/nope.png")}`)).status).toBe(404)
        expect((await fetch(`${base}/media/meta`)).status).toBe(400)
    })
})

describe("POST /media/manifest", () => {
    it("returns batch meta with cached hashes, missing with reasons", async () => {
        // prime the hash cache for a.png via the single-file endpoint
        await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}`)
        const res = await fetch(`${base}/media/manifest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: ["Media/a.png", "Media/b.mp4", "Media/nope.png", "notes.txt", "../../x.png"] })
        })
        expect(res.status).toBe(200)
        const { files, missing } = await res.json()
        expect(files).toHaveLength(2)
        expect(missing).toHaveLength(3)
        const byPath = Object.fromEntries(files.map((f: any) => [f.path, f]))
        // a.png was hashed via /meta, so its hash is cached; b.mp4 may or may not be cached — size+mtime always present
        expect(byPath[path.join("Media", "a.png")].hash).toBe(sha1("AAA_BYTES_v2!!"))
        expect(byPath[path.join("Media", "b.mp4")].size).toBe("BBB_BYTES_LONGER".length)
        expect(typeof byPath[path.join("Media", "b.mp4")].mtimeMs).toBe("number")
    })

    it("rejects a missing paths array and oversized batches", async () => {
        const bad = await fetch(`${base}/media/manifest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
        expect(bad.status).toBe(400)
        const huge = await fetch(`${base}/media/manifest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: new Array(2001).fill("Media/a.png") })
        })
        expect(huge.status).toBe(400)
    })
})

describe("presentation files", () => {
    it("serves pptx through the gateway and manifest (hybrid clients cache + open locally)", async () => {
        const res = await fetch(`${base}/media?path=${encodeURIComponent("Media/slides.pptx")}`)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation")
        const meta = await (await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/slides.pptx")}`)).json()
        expect(meta.hash).toBe(sha1("PPTX_BYTES"))
    })
})

describe("GET /media cache headers", () => {
    it("sets ETag + Last-Modified and honors If-None-Match with 304", async () => {
        const first = await fetch(`${base}/media?path=${encodeURIComponent("Media/b.mp4")}`)
        expect(first.status).toBe(200)
        const etag = first.headers.get("etag")
        expect(etag).toBeTruthy()
        expect(first.headers.get("last-modified")).toBeTruthy()
        const second = await fetch(`${base}/media?path=${encodeURIComponent("Media/b.mp4")}`, { headers: { "If-None-Match": etag! } })
        expect(second.status).toBe(304)
    })

    it("requires the token when one is configured", async () => {
        setAuthToken("secret")
        try {
            expect((await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}`)).status).toBe(401)
            expect((await fetch(`${base}/media/meta?path=${encodeURIComponent("Media/a.png")}&token=secret`)).status).toBe(200)
            const denied = await fetch(`${base}/media/manifest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [] }) })
            expect(denied.status).toBe(401)
        } finally {
            setAuthToken("")
        }
    })
})
