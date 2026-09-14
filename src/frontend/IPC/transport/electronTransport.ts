import type { BackendTransport } from "./types"

export function getElectronApi(): BackendTransport | undefined {
    if (typeof window === "undefined") return undefined
    return window.electronAPI || window.api
}
