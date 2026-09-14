import { get } from "svelte/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COMPLETE_HOLD_MS, MAX_CONCURRENT_UPLOADS, acknowledgeFolderUploads, cancelMediaUpload, dismissMediaUpload, mediaUploads, queueMediaUploads, retryMediaUpload, uploadsForFolder, type MediaUploader } from "./mediaUpload"
import type { UploadProgressOptions } from "./mediaGateway"

function makeFile(name: string, type = "image/png", size = 100): File {
    return new File(["x".repeat(size)], name, { type })
}

interface RecordedCall {
    folderPath: string
    file: File
    options?: UploadProgressOptions
    resolve: (value: { ok: boolean; status: number; error?: string }) => void
}

/** Uploader that only resolves when the test says so. */
function controllableUploader() {
    const calls: RecordedCall[] = []
    const uploader: MediaUploader = (folderPath, file, options) =>
        new Promise((resolve) => {
            calls.push({ folderPath, file, options, resolve })
        })
    return { calls, uploader }
}

function okUploader(): MediaUploader {
    return () => Promise.resolve({ ok: true, status: 200 })
}

function statuses(): string[] {
    return [...get(mediaUploads).values()].map((u) => u.status)
}

beforeEach(() => {
    mediaUploads.set(new Map())
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    mediaUploads.set(new Map())
})

describe("queueMediaUploads", () => {
    it("creates one queued/uploading entry per file with metadata", () => {
        const { uploader } = controllableUploader()
        const ids = queueMediaUploads("/lib/folder", [makeFile("a.png"), makeFile("b.mp4", "video/mp4")], "media", uploader)

        expect(ids).toHaveLength(2)
        const entries = [...get(mediaUploads).values()]
        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({ folderPath: "/lib/folder", fileName: "a.png", drawer: "media", status: "uploading", loaded: 0, total: 100 })
        expect(entries[0].previewUrl).toBeTruthy()
        expect(entries[1].previewUrl).toBeTruthy()
    })

    it("skips preview URLs for audio files", () => {
        const { uploader } = controllableUploader()
        queueMediaUploads("/lib/audio", [makeFile("s.mp3", "audio/mpeg")], "audio", uploader)

        const entries = [...get(mediaUploads).values()]
        expect(entries).toHaveLength(1)
        expect(entries[0].previewUrl).toBeNull()
    })

    it("returns [] and queues nothing without a folder or files", () => {
        const { uploader, calls } = controllableUploader()
        expect(queueMediaUploads("", [makeFile("a.png")], "media", uploader)).toEqual([])
        expect(queueMediaUploads("/lib/folder", [], "media", uploader)).toEqual([])
        expect(calls).toHaveLength(0)
        expect(get(mediaUploads).size).toBe(0)
    })

    it("caps concurrent uploads and starts the next one when a slot frees", () => {
        const { calls, uploader } = controllableUploader()
        const files = Array.from({ length: MAX_CONCURRENT_UPLOADS + 2 }, (_, i) => makeFile(`f${i}.png`))
        queueMediaUploads("/lib/folder", files, "media", uploader)

        expect(calls).toHaveLength(MAX_CONCURRENT_UPLOADS)
        expect(statuses().filter((s) => s === "uploading")).toHaveLength(MAX_CONCURRENT_UPLOADS)
        expect(statuses().filter((s) => s === "queued")).toHaveLength(2)

        // free one slot: the next queued upload starts
        calls[0].resolve({ ok: true, status: 200 })
        return Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
                expect(calls).toHaveLength(MAX_CONCURRENT_UPLOADS + 1)
            })
    })
})

describe("progress + completion", () => {
    it("applies onProgress updates to the entry", () => {
        const { calls, uploader } = controllableUploader()
        queueMediaUploads("/lib/folder", [makeFile("a.png", "image/png", 200)], "media", uploader)

        calls[0].options?.onProgress?.(50, 200)
        const entry = [...get(mediaUploads).values()][0]
        expect(entry.loaded).toBe(50)
        expect(entry.total).toBe(200)
        expect(entry.status).toBe("uploading")
    })

    it("marks complete at 100% then removes the placeholder after the hold", async () => {
        vi.useFakeTimers()
        const { calls, uploader } = controllableUploader()
        queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        calls[0].resolve({ ok: true, status: 200 })
        await vi.advanceTimersByTimeAsync(0)

        const entries = [...get(mediaUploads).values()]
        expect(entries).toHaveLength(1)
        expect(entries[0].status).toBe("complete")
        expect(entries[0].loaded).toBe(entries[0].total)

        await vi.advanceTimersByTimeAsync(COMPLETE_HOLD_MS)
        expect(get(mediaUploads).size).toBe(0)
    })
})

describe("failure + retry + dismiss", () => {
    it("marks errored uploads with the server message", async () => {
        const { calls, uploader } = controllableUploader()
        queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        calls[0].resolve({ ok: false, status: 415, error: "unsupported media type" })
        await Promise.resolve()
        await Promise.resolve()

        const entries = [...get(mediaUploads).values()]
        expect(entries).toHaveLength(1)
        expect(entries[0].status).toBe("error")
        expect(entries[0].error).toBe("unsupported media type")
    })

    it("converts a throwing uploader into an error entry", async () => {
        const throwing: MediaUploader = () => Promise.reject(new Error("boom"))
        queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", throwing)
        await Promise.resolve()
        await Promise.resolve()

        const entries = [...get(mediaUploads).values()]
        expect(entries[0].status).toBe("error")
        expect(entries[0].error).toBe("boom")
    })

    it("retry re-queues a failed upload and it can then succeed", async () => {
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        calls[0].resolve({ ok: false, status: 500, error: "write failed" })
        await Promise.resolve()
        await Promise.resolve()
        expect(get(mediaUploads).get(id)?.status).toBe("error")

        retryMediaUpload(id)
        expect(get(mediaUploads).get(id)?.status).toBe("uploading")
        expect(calls).toHaveLength(2)

        calls[1].resolve({ ok: true, status: 200 })
        await Promise.resolve()
        await Promise.resolve()
        expect(get(mediaUploads).get(id)?.status).toBe("complete")
    })

    it("retry clears skipLinger set while the upload was in flight", async () => {
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        // broadcast arrives mid-upload, then the upload fails
        acknowledgeFolderUploads("/lib/folder", "media")
        expect(get(mediaUploads).get(id)?.skipLinger).toBe(true)

        calls[0].resolve({ ok: false, status: 500, error: "write failed" })
        await Promise.resolve()
        await Promise.resolve()
        expect(get(mediaUploads).get(id)?.status).toBe("error")

        retryMediaUpload(id)
        expect(get(mediaUploads).get(id)?.skipLinger).toBe(false)
    })

    it("retry is a no-op for non-errored uploads", () => {
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        retryMediaUpload(id)
        expect(calls).toHaveLength(1)
        expect(get(mediaUploads).get(id)?.status).toBe("uploading")

        retryMediaUpload("missing-id")
        expect(get(mediaUploads).size).toBe(1)
    })

    it("dismiss drops the entry", () => {
        const { uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        dismissMediaUpload(id)
        expect(get(mediaUploads).size).toBe(0)
    })
})

describe("cancelMediaUpload", () => {
    it("aborts an in-flight upload and removes its placeholder", () => {
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/folder", [makeFile("a.png")], "media", uploader)

        cancelMediaUpload(id)
        expect(calls[0].options?.signal?.aborted).toBe(true)
        expect(get(mediaUploads).size).toBe(0)
        expect(get(mediaUploads).has(id)).toBe(false)
    })

    it("removes a queued upload without starting it", () => {
        const { calls, uploader } = controllableUploader()
        const files = Array.from({ length: MAX_CONCURRENT_UPLOADS + 1 }, (_, i) => makeFile(`f${i}.png`))
        const ids = queueMediaUploads("/lib/folder", files, "media", uploader)
        const queuedId = ids[ids.length - 1]
        expect(get(mediaUploads).get(queuedId)?.status).toBe("queued")

        cancelMediaUpload(queuedId)
        expect(get(mediaUploads).has(queuedId)).toBe(false)
        expect(calls).toHaveLength(MAX_CONCURRENT_UPLOADS)
    })

    it("frees a slot so the next queued upload starts", async () => {
        const { calls, uploader } = controllableUploader()
        const files = Array.from({ length: MAX_CONCURRENT_UPLOADS + 1 }, (_, i) => makeFile(`f${i}.png`))
        const ids = queueMediaUploads("/lib/folder", files, "media", uploader)

        cancelMediaUpload(ids[0])
        await Promise.resolve()
        await Promise.resolve()
        expect(calls).toHaveLength(MAX_CONCURRENT_UPLOADS + 1)
    })
})

describe("acknowledgeFolderUploads", () => {
    it("drops lingering complete placeholders for the refreshed folder only", async () => {
        vi.useFakeTimers()
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/a", [makeFile("a.png")], "media", uploader)
        queueMediaUploads("/lib/b", [makeFile("b.png")], "media", uploader)

        calls[0].resolve({ ok: true, status: 200 })
        calls[1].resolve({ ok: true, status: 200 })
        await vi.advanceTimersByTimeAsync(0)
        expect(get(mediaUploads).get(id)?.status).toBe("complete")

        // other folders/drawers are untouched (their views didn't refresh)
        acknowledgeFolderUploads("/lib/a", "media")
        expect(get(mediaUploads).has(id)).toBe(false)
        expect(get(mediaUploads).size).toBe(1)

        acknowledgeFolderUploads("", "media")
        expect(get(mediaUploads).size).toBe(1)
    })

    it("marks in-flight uploads to skip the linger once they finish", async () => {
        vi.useFakeTimers()
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/a", [makeFile("a.png")], "media", uploader)

        // broadcast beat the HTTP response: refresh already lists the file
        acknowledgeFolderUploads("/lib/a", "media")
        expect(get(mediaUploads).get(id)?.status).toBe("uploading")
        expect(get(mediaUploads).get(id)?.skipLinger).toBe(true)

        calls[0].resolve({ ok: true, status: 200 })
        await vi.advanceTimersByTimeAsync(0)
        // gone at once — no linger doubling the freshly listed file
        expect(get(mediaUploads).has(id)).toBe(false)
    })

    it("leaves errored uploads for the user to retry", async () => {
        const { calls, uploader } = controllableUploader()
        const [id] = queueMediaUploads("/lib/a", [makeFile("a.png")], "media", uploader)

        calls[0].resolve({ ok: false, status: 500, error: "write failed" })
        await Promise.resolve()
        await Promise.resolve()

        acknowledgeFolderUploads("/lib/a", "media")
        expect(get(mediaUploads).get(id)?.status).toBe("error")
    })
})

describe("uploadsForFolder", () => {
    it("scopes placeholders by folder and drawer", () => {
        const uploader = okUploader()
        queueMediaUploads("/lib/a", [makeFile("a.png")], "media", uploader)
        queueMediaUploads("/lib/b", [makeFile("b.png")], "media", uploader)
        queueMediaUploads("/lib/a", [makeFile("c.mp3", "audio/mpeg")], "audio", uploader)

        const map = get(mediaUploads)
        expect(uploadsForFolder(map, "/lib/a", "media").map((u) => u.fileName)).toEqual(["a.png"])
        expect(uploadsForFolder(map, "/lib/b", "media").map((u) => u.fileName)).toEqual(["b.png"])
        expect(uploadsForFolder(map, "/lib/a", "audio").map((u) => u.fileName)).toEqual(["c.mp3"])
        expect(uploadsForFolder(map, "", "media")).toEqual([])
    })
})
