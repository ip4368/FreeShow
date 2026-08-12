import { execFileSync, spawn, spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { buildEncoderCommand } from "./encoderProfiles"

// only encoder resolution is faked; the ffmpeg processes are real
const mocked = vi.hoisted(() => ({ encoder: "x264" }))
vi.mock("./encoderDetection", () => ({
    resolveEncoder: async () => mocked.encoder,
    getRtmpEncoderSetting: () => mocked.encoder
}))
vi.mock("./ffmpegManager", () => ({ resolveFfmpegPath: async () => "ffmpeg" }))

const { RtmpStreamer, setRtmpStatusListener, setRtmpNoticeListener } = await import("./RtmpStreamer")

function hasFfmpeg(): boolean {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
        return true
    } catch {
        return false
    }
}

const WIDTH = 320
const HEIGHT = 180
const FPS = 15

function bgraFrame(value: number): Buffer {
    return Buffer.alloc(WIDTH * HEIGHT * 4, value)
}

function probe(file: string): any {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" })
    return JSON.parse(out)
}

const describeIfFfmpeg = hasFfmpeg() ? describe : describe.skip

describeIfFfmpeg("RTMP pipeline (real ffmpeg)", () => {
    let tmpDir: string

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "freeshow-rtmp-"))
    })

    afterEach(() => {
        RtmpStreamer.stopAll()
        mocked.encoder = "x264"
        setRtmpNoticeListener(() => {})
    })

    function feed(id: string, size = { width: WIDTH, height: HEIGHT }) {
        let i = 0
        const frame = Buffer.alloc(size.width * size.height * 4)
        return setInterval(() => {
            frame.fill((i++ * 8) % 256)
            RtmpStreamer.updateFrame(id, frame, size)
        }, 1000 / FPS)
    }

    it("encodes raw BGRA into a valid mpegts stream on stdout", async () => {
        const args = buildEncoderCommand({
            encoderId: "x264",
            inputWidth: WIDTH,
            inputHeight: HEIGHT,
            outputWidth: WIDTH,
            outputHeight: HEIGHT,
            fps: FPS,
            bitrate: 500,
            enableAudio: false
        })

        const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] })
        const chunks: Buffer[] = []
        ffmpeg.stdout.on("data", (c) => chunks.push(c))

        // paced like the real encoder writes them: video timestamps come from the wall clock, so
        // dumping every frame at once would stamp them all alike and ffmpeg would drop the lot
        let written = 0
        await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                ffmpeg.stdin.write(bgraFrame(written * 8))
                if (++written >= FPS * 2) {
                    clearInterval(timer)
                    resolve()
                }
            }, 1000 / FPS)
        })
        ffmpeg.stdin.end()

        // the silent audio input never ends, which is what we want for a live stream, so stop it explicitly
        await new Promise((r) => setTimeout(r, 3000))
        ffmpeg.kill("SIGTERM")
        await new Promise((resolve) => ffmpeg.on("exit", resolve))

        const output = Buffer.concat(chunks)
        expect(output.length).toBeGreaterThan(0)
        // every mpegts packet starts with the 0x47 sync byte
        expect(output[0]).toBe(0x47)

        const tsFile = path.join(tmpDir, "encoded.ts")
        fs.writeFileSync(tsFile, output)
        const info = probe(tsFile)
        const video = info.streams.find((s: any) => s.codec_type === "video")
        expect(video.codec_name).toBe("h264")
        expect(video.width).toBe(WIDTH)
        expect(video.height).toBe(HEIGHT)
    }, 30000)

    it("fans one encode out to two destinations without re-encoding", async () => {
        const outA = path.join(tmpDir, "a.flv")
        const outB = path.join(tmpDir, "b.flv")

        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [
            { id: "a", url: outA, key: "", enabled: true },
            { id: "b", url: outB, key: "", enabled: true }
        ])

        // the encoder spawns on the first frame, using its actual dimensions
        let i = 0
        const feed = setInterval(() => RtmpStreamer.updateFrame("test-output", bgraFrame((i++ * 8) % 256), { width: WIDTH, height: HEIGHT }), 1000 / FPS)
        await new Promise((r) => setTimeout(r, 5000))
        clearInterval(feed)

        const status = RtmpStreamer.getStatus("test-output")
        expect(status.a?.state).toBe("live")
        expect(status.b?.state).toBe("live")

        RtmpStreamer.stopAll()
        await new Promise((r) => setTimeout(r, 1500))

        for (const file of [outA, outB]) {
            expect(fs.existsSync(file), `${file} should exist`).toBe(true)
            const video = probe(file).streams.find((s: any) => s.codec_type === "video")
            expect(video.codec_name).toBe("h264")
            expect(video.width).toBe(WIDTH)
            expect(video.height).toBe(HEIGHT)
        }
    }, 30000)

    it("pushes destination status through the registered listener", async () => {
        const pushes: { outputId: string; states: string[] }[] = []
        setRtmpStatusListener((outputId, destinations) => pushes.push({ outputId, states: Object.values(destinations).map((d) => d.state) }))

        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [{ id: "a", url: path.join(tmpDir, "listener.flv"), key: "", enabled: true }])

        let i = 0
        const feed = setInterval(() => RtmpStreamer.updateFrame("test-output", bgraFrame((i++ * 8) % 256), { width: WIDTH, height: HEIGHT }), 1000 / FPS)
        await new Promise((r) => setTimeout(r, 4000))
        clearInterval(feed)

        expect(pushes.length).toBeGreaterThan(0)
        expect(pushes.every((p) => p.outputId === "test-output")).toBe(true)
        expect(pushes.some((p) => p.states.includes("live"))).toBe(true)

        setRtmpStatusListener(() => {})
    }, 30000)

    it("recovers to a healthy destination after falling back to software encoding", async () => {
        // nvenc does not exist in a macOS ffmpeg build, so the encoder really fails and the
        // hardware -> software fallback path runs for real
        mocked.encoder = "nvenc"
        const notices: string[] = []
        setRtmpNoticeListener((message) => notices.push(message))

        const out = path.join(tmpDir, "fallback.flv")
        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "nvenc" }, [{ id: "a", url: out, key: "", enabled: true }])

        const feeding = feed("test-output")
        await new Promise((r) => setTimeout(r, 8000))
        clearInterval(feeding)

        expect(notices.some((n) => n.includes("software"))).toBe(true)

        // the destination must end up healthy, not pinned to the informational error
        const status = RtmpStreamer.getStatus("test-output")
        expect(status.a?.state).toBe("live")
        expect(status.a?.error).toBeUndefined()

        RtmpStreamer.stopAll()
        await new Promise((r) => setTimeout(r, 1500))

        const video = probe(out).streams.find((s: any) => s.codec_type === "video")
        expect(video.codec_name).toBe("h264")
    }, 40000)

    it("reconnects relays when the encoder respawns, so timestamps do not jump backwards", async () => {
        const out = path.join(tmpDir, "respawn.flv")
        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [{ id: "a", url: out, key: "", enabled: true }])

        let feeding = feed("test-output")
        await new Promise((r) => setTimeout(r, 3500))
        expect(RtmpStreamer.getStatus("test-output").a?.state).toBe("live")
        clearInterval(feeding)

        // a capture size change forces a new encoder, which restarts its mpegts clock at zero
        const bigger = { width: WIDTH * 2, height: HEIGHT * 2 }
        feeding = feed("test-output", bigger)
        await new Promise((r) => setTimeout(r, 500))

        // the relay must be torn down rather than left connected across the timestamp discontinuity
        expect(RtmpStreamer.getStatus("test-output").a?.state).toBe("reconnecting")

        await new Promise((r) => setTimeout(r, 4500))
        clearInterval(feeding)

        // and it must come back on its own
        expect(RtmpStreamer.getStatus("test-output").a?.state).toBe("live")

        RtmpStreamer.stopAll()
        await new Promise((r) => setTimeout(r, 1500))

        // the broadcast size is the configured one throughout; the larger capture is scaled down
        const video = probe(out).streams.find((s: any) => s.codec_type === "video")
        expect(video.codec_name).toBe("h264")
        expect(video.width).toBe(WIDTH)
    }, 40000)

    it("drops a frame whose buffer does not match the declared size", async () => {
        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [{ id: "a", url: path.join(tmpDir, "mismatch.flv"), key: "", enabled: true }])

        // a truncated buffer would otherwise desync -f rawvideo and shear the broadcast
        RtmpStreamer.updateFrame("test-output", Buffer.alloc(WIDTH * HEIGHT * 4 - 16), { width: WIDTH, height: HEIGHT })

        expect(RtmpStreamer.getStatus("test-output").a?.state).toBe("idle")
    }, 30000)

    it("does not leave a stream running when stopped mid-startup", async () => {
        const out = path.join(tmpDir, "cancelled.flv")

        const starting = RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [{ id: "a", url: out, key: "", enabled: true }])
        RtmpStreamer.stop("test-output")
        await starting

        expect(RtmpStreamer.isRunning("test-output")).toBe(false)
    }, 30000)

    it("applies a destination added while start() was still resolving", async () => {
        const destA = { id: "a", url: path.join(tmpDir, "pending-a.flv"), key: "", enabled: true }
        const destB = { id: "b", url: path.join(tmpDir, "pending-b.flv"), key: "", enabled: true }
        const config = { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }

        const starting = RtmpStreamer.start("test-output", config, [destA])
        // arrives before start() has registered the streamer, so it would be dropped without the pending queue
        RtmpStreamer.update("test-output", config, [destA, destB])
        await starting
        await new Promise((r) => setTimeout(r, 200))

        const status = RtmpStreamer.getStatus("test-output")
        expect(Object.keys(status).sort()).toEqual(["a", "b"])
    }, 30000)

    it("keeps the other destination live when one is removed", async () => {
        const outA = path.join(tmpDir, "keep.flv")
        const outB = path.join(tmpDir, "drop.flv")
        const destA = { id: "a", url: outA, key: "", enabled: true }
        const destB = { id: "b", url: outB, key: "", enabled: true }

        await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: false, encoder: "x264" }, [destA, destB])

        let i = 0
        const feed = setInterval(() => RtmpStreamer.updateFrame("test-output", bgraFrame((i++ * 8) % 256), { width: WIDTH, height: HEIGHT }), 1000 / FPS)
        await new Promise((r) => setTimeout(r, 3000))

        RtmpStreamer.syncDestinations("test-output", [destA])
        await new Promise((r) => setTimeout(r, 2000))
        clearInterval(feed)

        const status = RtmpStreamer.getStatus("test-output")
        expect(status.a?.state).toBe("live")
        expect(status.b).toBeUndefined()
        expect(RtmpStreamer.isRunning("test-output")).toBe(true)
    }, 30000)

    describe("audio", () => {
        const SAMPLE_RATE = 48000
        const BYTES_PER_FRAME = 4

        /**
         * Feed a continuous 1kHz sine at real-time rate in MediaRecorder-sized slices, stalling
         * once a second for longer than the filler's tolerance. That is what render jank does to
         * the renderer -> IPC -> Opus decode path, and the audio itself never actually stops.
         */
        function feedSine(durationMs: number, sliceMs: number, stallMs: number) {
            const start = Date.now()
            let written = 0
            let phase = 0
            let stallUntil = 0
            let lastSecond = -1

            return setInterval(() => {
                const now = Date.now()
                const second = Math.floor((now - start) / 1000)
                if (stallMs && second !== lastSecond) {
                    lastSecond = second
                    stallUntil = now + stallMs
                }
                if (now < stallUntil || now - start > durationMs) return

                const due = Math.round(((now - start) / 1000) * SAMPLE_RATE)
                const count = due - written
                if (count <= 0) return

                const buffer = Buffer.alloc(count * BYTES_PER_FRAME)
                for (let i = 0; i < count; i++) {
                    const sample = Math.round(Math.sin((2 * Math.PI * 1000 * (phase + i)) / SAMPLE_RATE) * 12000)
                    buffer.writeInt16LE(sample, i * BYTES_PER_FRAME)
                    buffer.writeInt16LE(sample, i * BYTES_PER_FRAME + 2)
                }
                phase += count
                written += count
                RtmpStreamer.updateAudio(buffer)
            }, sliceMs)
        }

        /** Number of places the muxed audio drops to silence. A continuous sine must have none. */
        function silenceSplices(file: string): number {
            // silencedetect reports on stderr, so this cannot use execFileSync's stdout
            const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-45dB:d=0.02", "-f", "null", "-"], { encoding: "utf8" })
            return (stderr.match(/silence_start/g) || []).length
        }

        const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

        /**
         * Every AAC sequence header in an FLV, read the way an ingest reads them. FLV's own rate
         * field is two bits wide and always reports "44kHz" for AAC, so the AudioSpecificConfig
         * carried in these headers is the only place the real rate is stated.
         */
        function aacSequenceHeaders(file: string) {
            const flv = fs.readFileSync(file)
            const headers: { objectType: number; sampleRate: number; channels: number }[] = []

            let at = 9 + 4 // file header, then the first back-pointer
            while (at < flv.length - 11) {
                const tagType = flv[at]
                const bodySize = (flv[at + 1] << 16) | (flv[at + 2] << 8) | flv[at + 3]
                const body = at + 11

                // tag 8 is audio, high nibble 10 is AAC, and a second byte of 0 marks a config packet
                if (tagType === 8 && flv[body] >> 4 === 10 && flv[body + 1] === 0) {
                    const [a, b] = [flv[body + 2], flv[body + 3]]
                    headers.push({ objectType: a >> 3, sampleRate: ASC_RATES[((a & 7) << 1) | (b >> 7)], channels: (b >> 3) & 15 })
                }

                at = body + bodySize + 4
            }
            return headers
        }

        function lastPts(file: string, stream: "v" | "a"): number {
            const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { encoding: "utf8" })
            const times = out.trim().split("\n").filter(Boolean)
            return parseFloat(times[times.length - 1])
        }

        it("does not splice silence into audio that never stopped", async () => {
            const out = path.join(tmpDir, "sine.flv")
            await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: true, encoder: "x264" }, [{ id: "a", url: out, key: "", enabled: true }])

            let i = 0
            const video = setInterval(() => RtmpStreamer.updateFrame("test-output", bgraFrame((i++ * 8) % 256), { width: WIDTH, height: HEIGHT }), 1000 / FPS)
            const audio = feedSine(10000, 42, 150)

            await new Promise((r) => setTimeout(r, 10000))
            clearInterval(video)
            clearInterval(audio)
            RtmpStreamer.stopAll()
            await new Promise((r) => setTimeout(r, 1500))

            expect(silenceSplices(out)).toBe(0)
        }, 40000)

        it("declares the real sample rate in the first sequence header a receiver reads", async () => {
            const out = path.join(tmpDir, "asc.flv")
            await RtmpStreamer.start("test-output", { width: WIDTH, height: HEIGHT, fps: FPS, bitrate: 500, enableAudio: true, encoder: "x264" }, [{ id: "a", url: out, key: "", enabled: true }])

            let i = 0
            const video = setInterval(() => RtmpStreamer.updateFrame("test-output", bgraFrame((i++ * 8) % 256), { width: WIDTH, height: HEIGHT }), 1000 / FPS)
            const audio = feedSine(5000, 42, 0)

            await new Promise((r) => setTimeout(r, 5000))
            clearInterval(video)
            clearInterval(audio)
            RtmpStreamer.stopAll()
            await new Promise((r) => setTimeout(r, 1500))

            const headers = aacSequenceHeaders(out)
            expect(headers.length).toBeGreaterThan(0)

            // a receiver configures its decoder from the first one and need never look again, so
            // it is not enough for a later header to be right
            for (const header of headers) {
                expect(header.sampleRate).toBe(SAMPLE_RATE)
                expect(header.channels).toBe(2)
                expect(header.objectType).toBe(2) // AAC-LC
            }
        }, 30000)

        it("keeps both timelines on the wall clock so they cannot drift apart", async () => {
            // a broadcast-sized frame, so writing one takes long enough that the pacing interval
            // really does skip ticks; a 320x180 frame flushes instantly and hides the drift
            const size = { width: 1280, height: 720 }
            const frame = Buffer.alloc(size.width * size.height * 4)
            const out = path.join(tmpDir, "sync.flv")

            await RtmpStreamer.start("test-output", { ...size, fps: 30, bitrate: 2500, enableAudio: true, encoder: "x264" }, [{ id: "a", url: out, key: "", enabled: true }])

            let i = 0
            const video = setInterval(() => {
                frame.fill((i++ * 8) % 256)
                RtmpStreamer.updateFrame("test-output", frame, size)
            }, 1000 / 30)
            const audio = feedSine(12000, 42, 150)

            // block the main thread hard once a second. A live app does this constantly (slide
            // transitions, media decode), and it is what makes the pacing interval lose ticks --
            // without it the pipes keep up and the drift is too small to detect.
            const jank = setInterval(() => {
                const until = Date.now() + 200
                while (Date.now() < until) {
                    /* spin */
                }
            }, 1000)

            const started = Date.now()
            await new Promise((r) => setTimeout(r, 12000))
            const elapsed = (Date.now() - started) / 1000
            clearInterval(video)
            clearInterval(audio)
            clearInterval(jank)
            RtmpStreamer.stopAll()
            await new Promise((r) => setTimeout(r, 1500))

            // Lost ticks must cost frames, not time. With the timeline at frames/fps instead of the
            // clock these stalls put video ~2s behind over this run, and the gap only ever grows.
            expect(lastPts(out, "v")).toBeGreaterThan(elapsed - 0.5)
            expect(Math.abs(lastPts(out, "a") - lastPts(out, "v"))).toBeLessThan(0.3)
        }, 45000)
    })
})
