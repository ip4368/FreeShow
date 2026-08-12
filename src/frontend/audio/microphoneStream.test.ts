import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { acquireMicrophoneStream, getMicrophoneConstraints, isMicrophoneStreamOpen, releaseMicrophoneStream, resetMicrophoneStreams } from "./microphoneStream"

// A device must be opened exactly once and stay open until the last consumer
// lets go. Anything else reconfigures the capture underneath a live microphone.

function makeStream() {
    const track = { stop: vi.fn() }
    return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

let getUserMedia: ReturnType<typeof vi.fn>
let streams: ReturnType<typeof makeStream>[]

beforeEach(() => {
    streams = []
    getUserMedia = vi.fn(async () => {
        const created = makeStream()
        streams.push(created)
        return created.stream
    })
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } })
})

afterEach(() => {
    resetMicrophoneStreams()
    vi.unstubAllGlobals()
})

describe("microphone capture constraints", () => {
    it("disables every audio processing option, so all consumers ask for the same capture", () => {
        expect(getMicrophoneConstraints("dev-1")).toEqual({
            audio: { deviceId: { exact: "dev-1" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
    })
})

describe("acquireMicrophoneStream", () => {
    it("opens the device once and hands the same stream to every consumer", async () => {
        const [a, b] = await Promise.all([acquireMicrophoneStream("dev-1", "playback"), acquireMicrophoneStream("dev-1", "monitor")])

        expect(getUserMedia).toHaveBeenCalledTimes(1)
        expect(a).toBe(b)
    })

    it("opens each device separately", async () => {
        await Promise.all([acquireMicrophoneStream("dev-1", "playback"), acquireMicrophoneStream("dev-2", "playback")])

        expect(getUserMedia).toHaveBeenCalledTimes(2)
    })

    it("re-opens a device that was fully released", async () => {
        await acquireMicrophoneStream("dev-1", "playback")
        releaseMicrophoneStream("dev-1", "playback")
        await acquireMicrophoneStream("dev-1", "playback")

        expect(getUserMedia).toHaveBeenCalledTimes(2)
    })

    it("rejects with the getUserMedia error and allows a retry", async () => {
        const error = Object.assign(new Error("busy"), { name: "NotReadableError" })
        getUserMedia.mockRejectedValueOnce(error)

        await expect(acquireMicrophoneStream("dev-1", "playback")).rejects.toBe(error)
        expect(isMicrophoneStreamOpen("dev-1")).toBe(false)

        await expect(acquireMicrophoneStream("dev-1", "playback")).resolves.toBeTruthy()
    })
})

describe("releaseMicrophoneStream", () => {
    it("keeps the device open while another consumer still needs it", async () => {
        await acquireMicrophoneStream("dev-1", "playback")
        await acquireMicrophoneStream("dev-1", "monitor")

        // this is the drawer tab being closed while the microphone is live
        expect(releaseMicrophoneStream("dev-1", "monitor")).toBe(false)
        expect(streams[0].track.stop).not.toHaveBeenCalled()
        expect(isMicrophoneStreamOpen("dev-1")).toBe(true)
    })

    it("stops the tracks once the last consumer releases", async () => {
        await acquireMicrophoneStream("dev-1", "playback")
        await acquireMicrophoneStream("dev-1", "monitor")

        releaseMicrophoneStream("dev-1", "monitor")
        expect(releaseMicrophoneStream("dev-1", "playback")).toBe(true)

        expect(streams[0].track.stop).toHaveBeenCalledTimes(1)
        expect(isMicrophoneStreamOpen("dev-1")).toBe(false)
    })

    it("ignores a consumer that never acquired, so it can't close someone else's capture", async () => {
        await acquireMicrophoneStream("dev-1", "playback")

        expect(releaseMicrophoneStream("dev-1", "monitor")).toBe(false)
        expect(releaseMicrophoneStream("dev-2", "playback")).toBe(false)
        expect(streams[0].track.stop).not.toHaveBeenCalled()
    })

    it("stops a stream that arrives after everyone released it", async () => {
        const pending = acquireMicrophoneStream("dev-1", "monitor")
        releaseMicrophoneStream("dev-1", "monitor")

        await expect(pending).resolves.toBeNull()
        expect(streams[0].track.stop).toHaveBeenCalledTimes(1)
    })

    it("does not let a late release close the capture a new consumer just opened", async () => {
        const first = acquireMicrophoneStream("dev-1", "monitor")
        releaseMicrophoneStream("dev-1", "monitor")

        const second = await acquireMicrophoneStream("dev-1", "playback")
        await first

        expect(getUserMedia).toHaveBeenCalledTimes(2)
        expect(second).toBe(streams[1].stream)
        expect(streams[1].track.stop).not.toHaveBeenCalled()
    })
})
