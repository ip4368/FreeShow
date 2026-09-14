import { describe, expect, it, vi } from "vitest"
import { Main } from "../../types/IPC/channels"
import type { PersistenceAdapter, Platform } from "../platform/Platform"
import { createPortableResponses } from "./createPortableResponses"

function createPlatform() {
    const data: PersistenceAdapter = {
        getStore: vi.fn((id) => ({ id })),
        setStore: vi.fn(),
        getStoreValue: vi.fn(),
        setStoreValue: vi.fn(),
        save: vi.fn(),
        loadShow: vi.fn(),
        loadShows: vi.fn(() => ({ kind: "index" })),
        loadAllShows: vi.fn(() => ({ kind: "all" })),
        loadScripture: vi.fn(),
        readBiblesFolder: vi.fn(),
        getDataFolderRoot: vi.fn(() => "/data"),
        getDataFolderPath: vi.fn(() => "/data/media"),
        getPaths: vi.fn(() => ({ media: "/data/media" })),
        readFile: vi.fn(() => "contents"),
        readFolder: vi.fn(),
        readFolderContent: vi.fn(),
        createFolder: vi.fn()
    }
    const platform: Platform = {
        id: "electron",
        capabilities: {} as Platform["capabilities"],
        data,
        isDevelopment: vi.fn(() => true),
        getCachePath: vi.fn(() => "/cache"),
        getVersion: vi.fn(() => "1.2.3"),
        getOS: vi.fn(),
        getDeviceId: vi.fn(() => "device"),
        getDeviceName: vi.fn(() => "name"),
        getLocalIPs: vi.fn(),
        checkRamUsage: vi.fn()
    }
    return { data, platform }
}

describe("createPortableResponses", () => {
    it("delegates runtime and store channels through the platform adapter", () => {
        const { data, platform } = createPlatform()
        const responses = createPortableResponses(platform)

        expect(responses[Main.VERSION]?.()).toBe("1.2.3")
        expect(responses[Main.SETTINGS]?.()).toEqual({ id: "SETTINGS" })
        expect(data.getStore).toHaveBeenCalledWith("SETTINGS")
    })

    it("keeps the show index and full-show operations distinct", () => {
        const { platform } = createPlatform()
        const responses = createPortableResponses(platform)

        expect(responses[Main.SHOWS]?.()).toEqual({ kind: "index" })
        expect(responses[Main.FULL_SHOWS_LIST]?.()).toEqual({ kind: "all" })
    })

    it("preserves the READ_FILE response envelope", () => {
        const { data, platform } = createPlatform()
        const responses = createPortableResponses(platform)

        expect(responses[Main.READ_FILE]?.({ path: "/data/file" })).toEqual({ content: "contents" })
        expect(data.readFile).toHaveBeenCalledWith("/data/file")
    })
})
