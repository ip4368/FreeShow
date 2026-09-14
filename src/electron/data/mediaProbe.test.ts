// Regression test: probing a file this machine can't read (a server-relative
// library path on a hybrid client, or a moved/deleted file) must resolve to an
// empty result WITHOUT spamming the log with a stack trace per probe.

import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getMediaCodec, getMediaTracks } from "./mediaProbe"

// Minimal real-MP4 fixtures (generated once with ffmpeg: 16x16 black, 0.2s;
// the subs variant adds one mov_text cue "Héllo wörld"). Embedded so the
// happy-path probe behavior is pinned without depending on ffmpeg at test time.
const CODEC_MP4_BASE64 =
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMVbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABYoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALFAAAAAQAAABRzdGNvAAAAAAAAAAEAAANFAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAAAIZnJlZQAAAs1tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAQZYiEABX//vfJ78Cm69vfgQ=="
const SUBS_MP4_BASE64 =
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAt5tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAQZYiEABX//vfJ78Cm69vfgQANSMOpbGxvIHfDtnJsZAAAAAAFBW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAI/dHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAD6AAAAAAAAQAAAAABt21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAEAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAWJtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEic3RibAAAAL5zdHNkAAAAAAAAAAEAAACuYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwAIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAWKAAAFigAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACxQAAAAEAAAAUc3RjbwAAAAAAAAABAAAAMAAAAfB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAJYAAAAAAAAAAAAAAAMAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAACWAAAAAAABAAAAAAFobWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAACSfBVxAAAAAAAMGhkbHIAAAAAAAAAAHNidGwAAAAAAAAAAAAAAABTdWJ0aXRsZUhhbmRsZXIAAAABEG1pbmYAAAAMbm1oZAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADYc3RibAAAAGRzdHNkAAAAAAAAAAEAAABUdHgzZwAAAAAAAAABAAAAAAH/AAAA/wAAAAAAAAAAAAAAAAABABD/////AAAAEmZ0YWIAAQABBUFyaWFsAAAAFGJ0cnQAAAAAAAADigAAA4oAAAAgc3R0cwAAAAAAAAACAAAAAQACSfAAAAABAAAAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAA8AAAACAAAAFHN0Y28AAAAAAAAAAQAAAvUAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMg=="

function writeFixture(dir: string, name: string, base64: string): string {
    const file = path.join(dir, name)
    fs.writeFileSync(file, Buffer.from(base64, "base64"))
    return file
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("mediaProbe missing-file behavior", () => {
    it("getMediaCodec returns empty codecs and stays quiet when the file is missing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        // a server-relative library path, as sent by a hybrid client before the fix
        const missing = path.join("Media", "Screen Recording 2023-10-05 at 17.02.47.mov")

        const result = await getMediaCodec({ path: missing })

        expect(result.codecs).toEqual([])
        expect(result.mimeCodec).toBe("")
        expect(result.mimeType).toBe("video/quicktime")
        expect(errorSpy).not.toHaveBeenCalled()
    })

    it("getMediaTracks returns no tracks and stays quiet when the file is missing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const missing = path.join("Media", "gone.mp4")

        const result = await getMediaTracks({ path: missing })

        expect(result.tracks).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
    })

    it("returns empty results (quietly) for an existing non-media file", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-probe-"))
        try {
            const file = path.join(dir, "notes.mp4")
            fs.writeFileSync(file, "definitely not an mp4")

            expect((await getMediaCodec({ path: file })).codecs).toEqual([])
            expect((await getMediaTracks({ path: file })).tracks).toEqual([])
            expect(errorSpy).not.toHaveBeenCalled()
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("detects codecs in a real mp4 (happy path is pinned, not just empty results)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-probe-"))
        try {
            const file = writeFixture(dir, "clip.mp4", CODEC_MP4_BASE64)
            const result = await getMediaCodec({ path: file })
            expect(result.codecs.length).toBeGreaterThan(0)
            expect(result.codecs[0]).toMatch(/avc1/i)
            expect(result.mimeCodec).toContain("codecs=")
            expect(result.mimeType).toBe("video/mp4")
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("extracts embedded subtitle text including non-ASCII characters", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-probe-"))
        try {
            const file = writeFixture(dir, "subbed.mp4", SUBS_MP4_BASE64)
            const result = await getMediaTracks({ path: file })
            expect(result.tracks.length).toBeGreaterThan(0)
            expect(result.tracks[0].vtt).toContain("Héllo wörld")
            expect(result.tracks[0].embedded).toBe(true)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }, 30000)
})
