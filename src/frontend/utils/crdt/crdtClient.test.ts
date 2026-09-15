// ----- FreeShow -----
// Co-editing docs must rejoin after a reconnect: without a re-open the client
// keeps pushing edits from a diverged doc and never sees missed updates.

import { beforeAll, describe, expect, it, vi } from "vitest"
import { activeShow, connectionStatus } from "../../stores"
import { initCrdtClient, rejoinCrdtDocs } from "./crdtClient"

const sent: { channel: string; data: any }[] = []

beforeAll(() => {
    ;(globalThis as any).window = {
        api: {
            send: vi.fn((channel: string, data: any) => sent.push({ channel, data })),
            receive: vi.fn()
        }
    }
    initCrdtClient()
})

function opensFor(showId: string) {
    return sent.filter((s) => s.channel === "YJS" && s.data?.action === "open" && s.data?.showId === showId)
}

describe("crdt rejoin on reconnect", () => {
    it("sends nothing when no docs are open", () => {
        rejoinCrdtDocs()
        expect(sent).toEqual([])
    })

    it("opens the active show's doc", () => {
        activeShow.set({ id: "show1" } as any)
        expect(opensFor("show1")).toHaveLength(1)
    })

    it("re-opens docs after a drop (but not on the initial connect)", () => {
        // initial connect with no prior drop: no-op
        connectionStatus.set("connected")
        expect(opensFor("show1")).toHaveLength(1)
        // drop + reconnect: rejoin
        connectionStatus.set("disconnected")
        connectionStatus.set("connected")
        expect(opensFor("show1")).toHaveLength(2)
    })
})
