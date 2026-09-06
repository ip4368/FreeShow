import type { OS } from "../../types/Main"
import type { CapabilitySet } from "./capabilities"

export interface SaveResult {
    changed: Record<string, any>
    complete: { closeWhenFinished: boolean; customTriggers: any }
}

export interface PersistenceAdapter {
    getStore(id: string): any
    setStore(id: string, value: any): void
    getStoreValue(data: { file: string; key: string }): any
    setStoreValue(data: { file: string; key: string; value: any }): void

    loadShow(data: { id: string; name: string }): any
    loadShows(): any
    loadAllShows(): any
    save(data: any): SaveResult | void | Promise<SaveResult | void>

    loadScripture(data: { id: string; name: string }): any
    readBiblesFolder(): { path: string; name: string }[]

    readFile(path: string): string
    readFolder(path: string): string[]
    readFolderContent(data: { path: string | string[]; depth?: number; captureFolderContent?: boolean; generateThumbnails?: boolean }): any
    createFolder(data: { path: string; name: string }): string

    getDataFolderRoot(): string
    getDataFolderPath(id: string): string
    getPaths(): any

    restoreEntries?(entries: { name: string; content: string }[]): RestoreResult
    buildBackupZip?(): Promise<Buffer>
}

/** Result of applying a restore: which library stores changed (for live broadcast) + status. */
export interface RestoreResult {
    finished: boolean
    error?: string
    changed?: Record<string, any>
    /** IDs of shows written by this restore, so callers can invalidate resident CRDT documents. */
    restoredShowIds?: string[]
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
