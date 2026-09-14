import { getElectronApi } from "./electronTransport"
import type { BackendTransport } from "./types"

let activeTransport: BackendTransport | undefined

export function setTransport(transport: BackendTransport): BackendTransport {
    window.api = transport
    activeTransport = transport
    return transport
}

export function getTransport(): BackendTransport {
    const transport = activeTransport || window.api
    if (!transport) throw new Error("No renderer backend transport has been installed")
    return transport
}

export function installTransport(transport = getElectronApi()): BackendTransport {
    if (!transport) throw new Error("Electron preload did not expose a backend transport")
    return setTransport(transport)
}

export type { BackendTransport } from "./types"
