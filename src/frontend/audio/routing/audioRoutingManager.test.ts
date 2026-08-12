import { beforeEach, describe, expect, it, vi } from "vitest"

// A routing update must leave the audible graph exactly as it found it when nothing
// relevant changed. The bug this guards: executeRoutingUpdate disconnects the merger
// from everything, and the cached-effect-chain path then returned the chain output
// without restoring the edge into it — so any channel with an effect enabled went
// mute from the second update onwards.

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
        audioRouting: makeStore({ channels: [], connections: [] }),
        audioEffects: makeStore({}),
        audioChannelsData: makeStore({}),
        outputs: makeStore({}),
        disabledServers: makeStore({}),
        serverData: makeStore({}),
        segments: [] as { input: FakeNode; output: FakeNode }[]
    }
})

vi.mock("../../stores", () => ({
    audioRouting: h.audioRouting,
    audioEffects: h.audioEffects,
    audioChannelsData: h.audioChannelsData,
    outputs: h.outputs,
    disabledServers: h.disabledServers,
    serverData: h.serverData
}))
vi.mock("../../components/helpers/array", () => ({ keysToID: (o: object) => Object.entries(o || {}).map(([id, v]) => ({ ...(v as object), id })) }))
vi.mock("../audioAnalyser", () => ({ AudioAnalyser: { recorderActivate: vi.fn() } }))
vi.mock("./audioRoutingInit", () => ({ deduplicateConnections: (c: unknown) => c }))
vi.mock("./audioInputCapture", () => ({
    AudioInputCapture: {
        getInstance: () => ({ captureInput: vi.fn(), removeInput: vi.fn(), pruneStaleInputs: vi.fn(), onNodeDisconnected: vi.fn(), captureDesktopAudio: vi.fn(), stopDesktopAudio: vi.fn() })
    }
}))

// one real-shaped effect: an input node wired to a separate output node
const effectMock = (name: string) => ({
    [name]: class {
        input: FakeNode
        output: FakeNode
        constructor(ctx: FakeContext) {
            this.input = ctx.createGain()
            this.output = ctx.createGain()
            this.input.connect(this.output)
            h.segments.push({ input: this.input, output: this.output })
        }
        getNodes() {
            return { input: this.input, output: this.output }
        }
        initialize() {}
        dispose() {}
    }
})
vi.mock("../effects/audioCompressor", () => effectMock("AudioCompressor"))
vi.mock("../effects/audioEqualizer", () => effectMock("AudioEqualizer"))
vi.mock("../effects/audioFilter", () => effectMock("AudioFilter"))
vi.mock("../effects/audioNoiseGate", () => effectMock("AudioNoiseGate"))
vi.mock("../effects/audioReverb", () => effectMock("AudioReverb"))
vi.mock("../effects/audioDelay", () => effectMock("AudioDelay"))
vi.mock("../effects/audioLimiter", () => effectMock("AudioLimiter"))
vi.mock("../effects/audioStereoShaper", () => effectMock("AudioStereoShaper"))

// minimal Web Audio graph that records edges, with spec disconnect/dedupe semantics
interface FakeNode {
    kind: string
    connect(dest: FakeNode, out?: number, inp?: number): FakeNode
    disconnect(dest?: FakeNode): void
    [key: string]: unknown
}

class FakeContext {
    edges: [FakeNode, FakeNode][] = []
    currentTime = 0
    destination = this.node("destination")
    state = "running"

    node(kind: string, extra: Record<string, unknown> = {}): FakeNode {
        const ctx = this
        const node: FakeNode = {
            kind,
            channelCount: 2,
            numberOfOutputs: 1,
            connect(dest: FakeNode) {
                if (!ctx.edges.some(([f, t]) => f === node && t === dest)) ctx.edges.push([node, dest])
                return dest
            },
            disconnect(dest?: FakeNode) {
                ctx.edges = ctx.edges.filter(([f, t]) => !(f === node && (dest === undefined || t === dest)))
            },
            ...extra
        }
        return node
    }

    createGain() {
        return this.node("gain", { gain: { value: 1, setValueAtTime: vi.fn() } })
    }
    createDelay() {
        return this.node("delay", { delayTime: { setValueAtTime: vi.fn() } })
    }
    createChannelSplitter() {
        return this.node("splitter")
    }
    createChannelMerger() {
        return this.node("merger")
    }
    createAnalyser() {
        return this.node("analyser", { fftSize: 256, smoothingTimeConstant: 0.8 })
    }
    createMediaStreamDestination() {
        return this.node("streamDest", { stream: { getAudioTracks: () => [] } })
    }
}

let frames: (() => void)[] = []
const flush = () => {
    const queued = frames
    frames = []
    queued.forEach((fn) => fn())
}

let ctx: FakeContext
let manager: import("./audioRoutingManager").AudioRoutingManager

async function setup(effects: object) {
    h.segments.length = 0
    frames = []
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn) as unknown as number)

    h.audioRouting._set({ channels: [{ id: "main", name: "Main" }], connections: [{ from: "main", to: "speaker_default" }] })
    h.audioEffects._set(effects)

    vi.resetModules()
    const mod = await import("./audioRoutingManager")
    manager = mod.AudioRoutingManager.getInstance()

    ctx = new FakeContext()
    manager.setAudioContext(ctx as unknown as AudioContext)
    flush()
}

const edgeKey = (edges: [FakeNode, FakeNode][]) =>
    edges
        .map(([f, t]) => `${f.kind}->${t.kind}`)
        .sort()
        .join("|")
const edgesInto = (node: FakeNode) => ctx.edges.filter(([, t]) => t === node)

beforeEach(() => {
    h.audioChannelsData._set({})
    h.outputs._set({})
})

describe("routing updates with an effect chain on the channel", () => {
    it("keeps the merger feeding the chain across repeated updates", async () => {
        await setup({ main: { compressor: { enabled: true } } })
        expect(h.segments).toHaveLength(1)
        const chainHead = h.segments[0].input

        expect(edgesInto(chainHead)).toHaveLength(1)

        manager.updateRoutingNodes()
        flush()
        expect(edgesInto(chainHead)).toHaveLength(1)

        manager.updateRoutingNodes()
        flush()
        expect(edgesInto(chainHead)).toHaveLength(1)
    })

    it("leaves the graph unchanged when nothing relevant changed", async () => {
        await setup({ main: { compressor: { enabled: true } } })
        const before = edgeKey(ctx.edges)

        manager.updateRoutingNodes()
        flush()

        expect(edgeKey(ctx.edges)).toBe(before)
    })

    it("does not rebuild the chain when the config is unchanged", async () => {
        await setup({ main: { compressor: { enabled: true } } })

        manager.updateRoutingNodes()
        flush()

        expect(h.segments).toHaveLength(1)
    })

    it("stops feeding a destination once its connection is removed", async () => {
        await setup({ main: { compressor: { enabled: true } } })
        const chainOutput = h.segments[0].output
        const destination = ctx.edges.find(([, t]) => t === ctx.destination)?.[0]
        expect(destination).toBeDefined()
        expect(ctx.edges.some(([f, t]) => f === chainOutput && t === destination)).toBe(true)

        h.audioRouting._set({ channels: [{ id: "main", name: "Main" }], connections: [] })
        flush()

        expect(ctx.edges.some(([f, t]) => f === chainOutput && t === destination)).toBe(false)
    })
})

describe("routing updates without an effect chain", () => {
    it("still reaches the destination after repeated updates", async () => {
        await setup({})
        const destination = ctx.edges.find(([, t]) => t === ctx.destination)?.[0] as FakeNode
        expect(edgesInto(destination)).toHaveLength(1)

        manager.updateRoutingNodes()
        flush()

        expect(edgesInto(destination)).toHaveLength(1)
    })
})
