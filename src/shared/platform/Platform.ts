import type { OS } from "../../types/Main"
import type { CapabilitySet } from "./capabilities"

export interface PersistenceAdapter {
    getStore(id: string): any
    getStoreValue(data: any): any
    setStoreValue(data: any): any
    save(data: any): any
    loadShow(data: { id: string; name: string }): any
    loadShows(): any
    loadAllShows(): any
    loadScripture(data: { id: string; name: string }): any
    readBiblesFolder(): any
    getDataFolderRoot(): string
    getPaths(): any
    readFile(path: string): string
    readFolderContent(data: any): any
}

export interface Platform {
    readonly id: string
    capabilities: CapabilitySet
    data: PersistenceAdapter
    isDevelopment(): boolean
    getCachePath(): string
    getVersion(): string
    getOS(): OS
    getDeviceId(): string
    getDeviceName(): string
    getLocalIPs(): any
    checkRamUsage(): any
}
