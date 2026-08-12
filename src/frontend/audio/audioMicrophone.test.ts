import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The invariant under test: a device stays open for exactly as long as something
// asked for it. An armed microphone holds its own playback reference and is never
// disturbed by a meter appearing or disappearing; a capture opened only to draw a
// meter is handed back as soon as that meter goes away.

const h = vi.hoisted(() => {
    const makeStore = (initial: unknown) => {
        let value = initial
        const subscribers = new Set<(v: unknown) => void>()
        return {
            subscribe(fn: (v: unknown) => void) {
                subscribers.add(fn)
                fn(value)
                return () => subscribers.delete(fn)
            },
            _set(v: unknown) {
                value = v
                subscribers.forEach((fn) => fn(value))
            }
        }
    }

    return {
        outLocked: makeStore(false),
        playingAudio: makeStore({}),
        registerInputNode: vi.fn(),
        unregisterInputNode: vi.fn(),
        removeInput: vi.fn(),
        getVisualizerData: vi.fn(() => null),
        createMediaStreamSource: vi.fn(() => ({ tag: "source" }))
    }
})

vi.mock("../stores", () => ({ outLocked: h.outLocked, playingAudio: h.playingAudio }))
vi.mock("../IPC/main", () => ({ sendMain: vi.fn() }))
vi.mock("./audioFading", () => ({ clearAudio: vi.fn() }))
vi.mock("./audioPlayer", () => ({ AudioPlayer: { audioExists: () => false, stop: vi.fn(), playStream: vi.fn() } }))
vi.mock("./audioAnalyser", () => ({
    AudioAnalyser: { getAudioContext: () => ({ createMediaStreamSource: h.createMediaStreamSource }) }
}))
vi.mock("./routing/audioRoutingManager", () => ({
    AudioRoutingManager: { getInstance: () => ({ registerInputNode: h.registerInputNode, unregisterInputNode: h.unregisterInputNode }) }
}))
vi.mock("./routing/audioInputCapture", () => ({
    AudioInputCapture: { getInstance: () => ({ removeInput: h.removeInput, getVisualizerData: h.getVisualizerData }) }
}))

const DEVICE = "airpods-device-id"

let getUserMedia: ReturnType<typeof vi.fn>
let stops: ReturnType<typeof vi.fn>[]
let AudioMicrophone: typeof import("./audioMicrophone").AudioMicrophone
let acquire: typeof import("./microphoneStream").acquireMicrophoneStream

beforeEach(async () => {
    stops = []
    getUserMedia = vi.fn(async () => {
        const stop = vi.fn()
        stops.push(stop)
        return { getTracks: () => [{ stop }] } as unknown as MediaStream
    })
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } })

    h.playingAudio._set({})
    vi.clearAllMocks()

    // AudioMicrophone keeps static state, so give each test a fresh module
    vi.resetModules()
    AudioMicrophone = (await import("./audioMicrophone")).AudioMicrophone
    acquire = (await import("./microphoneStream")).acquireMicrophoneStream
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("a capture opened only for metering", () => {
    it("is closed when the meter goes away", async () => {
        await AudioMicrophone.startListening(DEVICE, "meter")
        AudioMicrophone.stopListening(DEVICE, "meter")

        expect(stops[0]).toHaveBeenCalledTimes(1)
        expect(h.unregisterInputNode).toHaveBeenCalledTimes(1)
        expect(h.removeInput).toHaveBeenCalledTimes(1)
    })

    it("is closed even mid-service, since nothing is routed through it", async () => {
        h.playingAudio._set({ mic_sub_other: { isMic: true } })

        await AudioMicrophone.startListening(DEVICE, "meter")
        AudioMicrophone.stopListening(DEVICE, "meter")

        expect(stops[0]).toHaveBeenCalledTimes(1)
    })

    it("stays open while another meter is still watching it", async () => {
        await AudioMicrophone.startListening(DEVICE, "meter-a")
        await AudioMicrophone.startListening(DEVICE, "meter-b")

        AudioMicrophone.stopListening(DEVICE, "meter-a")
        expect(stops[0]).not.toHaveBeenCalled()

        AudioMicrophone.stopListening(DEVICE, "meter-b")
        expect(stops[0]).toHaveBeenCalledTimes(1)
    })
})

describe("a capture an armed microphone is using", () => {
    it("survives the meter being closed and reopened", async () => {
        // the microphone being armed, which takes the playback reference
        await acquire(DEVICE, "playback")
        await AudioMicrophone.startListening(DEVICE, "meter")

        // the audio drawer tab being switched away from, mid-service
        AudioMicrophone.stopListening(DEVICE, "meter")
        expect(stops[0]).not.toHaveBeenCalled()

        await expect(AudioMicrophone.startListening(DEVICE, "meter")).resolves.toBe(true)
        expect(getUserMedia).toHaveBeenCalledTimes(1)
        expect(stops[0]).not.toHaveBeenCalled()
    })
})
