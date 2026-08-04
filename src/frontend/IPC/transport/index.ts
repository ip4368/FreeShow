// ----- FreeShow -----
// Transport installation: choose which `window.api` implementation the frontend
// uses, and install it before startup() runs.
//
// Selection order:
//   1. Web build (VITE_TARGET === "web")            -> Socket.IO to the serving origin
//   2. Desktop with a persisted remote connection   -> Socket.IO to that server (Phase 3 GUI)
//   3. Otherwise (desktop default)                   -> Electron IPC (preload's window.api)

import { connectionStatus } from "../../stores"
import { showWebLogin } from "../../utils/webLogin"
import { getElectronApi } from "./electronTransport"
import { createHybridApi } from "./hybridTransport"
import { createSocketApi } from "./socketTransport"
import type { FreeShowApi } from "./types"

const onStatus = (status: "connected" | "disconnected" | "reconnecting") => connectionStatus.set(status)

// Local, NON-synced storage for a desktop -> remote-server connection.
// Kept in localStorage (never the synced data folder) so credentials don't propagate to other devices.
const REMOTE_SERVER_KEY = "freeshow_remote_server"

interface RemoteServerConfig {
    enabled: boolean
    url: string
    token?: string
}

export function getRemoteServerConfig(): RemoteServerConfig | null {
    try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(REMOTE_SERVER_KEY) : null
        if (!raw) return null
        const config = JSON.parse(raw) as RemoteServerConfig
        return config?.enabled && config.url ? config : null
    } catch {
        return null
    }
}

export function setRemoteServerConfig(config: RemoteServerConfig | null) {
    if (typeof localStorage === "undefined") return
    if (!config) localStorage.removeItem(REMOTE_SERVER_KEY)
    else localStorage.setItem(REMOTE_SERVER_KEY, JSON.stringify(config))
}

function isWebBuild(): boolean {
    return (import.meta as any).env?.VITE_TARGET === "web"
}

/** Returns true if this frontend is running against a Socket.IO backend (web build or remote desktop). */
export function isSocketTransport(): boolean {
    return isWebBuild() || !!getRemoteServerConfig()
}

// The web build has no connection dialog to type a token into: the server prints a
// `?token=...` URL when it generates one, so we take the token from the query string
// on first load and remember it.
//
// Stored in localStorage rather than sessionStorage so a second tab works without
// re-pasting the URL. That is not a meaningful downgrade - the token already travels
// in /media and /thumbnail query strings - but it does mean the value outlives the tab.
const WEB_TOKEN_KEY = "freeshow_web_token"
let cachedWebToken: string | null = null

/**
 * Token for the web build: reads `?token=` once, persists it, then strips it from the
 * address bar so it doesn't leak through bookmarks, history or Referer headers.
 */
export function getWebToken(): string {
    if (cachedWebToken !== null) return cachedWebToken
    cachedWebToken = ""

    try {
        if (typeof window === "undefined") return cachedWebToken

        const params = new URLSearchParams(window.location.search)
        const fromUrl = params.get("token")

        if (fromUrl) {
            cachedWebToken = fromUrl
            localStorage.setItem(WEB_TOKEN_KEY, fromUrl)

            params.delete("token")
            const query = params.toString()
            window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash)
        } else {
            cachedWebToken = localStorage.getItem(WEB_TOKEN_KEY) || ""
        }
    } catch {
        // storage disabled (private mode) or a malformed URL - carry on without a token
    }

    return cachedWebToken
}

/** Auth token for whichever socket backend is active, or "" when none applies. */
export function getConnectionToken(): string {
    const remote = getRemoteServerConfig()
    if (remote) return remote.token || ""
    return isWebBuild() ? getWebToken() : ""
}

/** Persist a token obtained from the login prompt. */
export function setWebToken(token: string) {
    cachedWebToken = token
    try {
        localStorage.setItem(WEB_TOKEN_KEY, token)
    } catch {
        // storage disabled - the token still applies to this page load
    }
}

/**
 * The server rejected our token (wrong, or rotated by a server restart). Drop it so the
 * prompt starts empty, then ask for a new one and reload once we have a verified token.
 * A full reload is the simplest way back to a clean startup, and matches what
 * ServerConnection.svelte already does on the desktop.
 */
function handleUnauthorized() {
    try {
        localStorage.removeItem(WEB_TOKEN_KEY)
    } catch {
        // ignore
    }
    cachedWebToken = ""

    showWebLogin(
        (token) => {
            setWebToken(token)
            window.location.reload()
        },
        hadToken ? "The saved access token was rejected." : ""
    )
}

// safely set window.api. In Electron the preload now exposes the IPC bridge as
// `window.electronAPI` (not `window.api`), so `window.api` is a normal writable
// property. The try/catch guards against an older preload that made window.api
// read-only via contextBridge (in which case the existing IPC api is kept).
function setWindowApi(api: FreeShowApi) {
    try {
        window.api = api
    } catch (err) {
        console.error("Could not set window.api (read-only preload?). Rebuild the app so preload exposes electronAPI.", err)
    }
}

// whether this page load started with a token, so the prompt can distinguish
// "you need a token" from "the one you had stopped working"
let hadToken = false

export function installTransport() {
    // 1. Web build: connect to the origin that served the bundle.
    if (isWebBuild()) {
        const token = getWebToken()
        hadToken = !!token
        setWindowApi(createSocketApi({ auth: token ? { token } : undefined, onStatus, onUnauthorized: handleUnauthorized }))
        return
    }

    // 2. Desktop configured (via GUI) to use a remote server: HYBRID transport.
    //    Library/show data + co-editing -> remote server; hardware/output/present +
    //    machine config -> local Electron IPC. See ./routing.ts for the exact split.
    const remote = getRemoteServerConfig()
    if (remote) {
        const socket = createSocketApi({ url: remote.url, auth: remote.token ? { token: remote.token } : undefined, onStatus })
        const local = getElectronApi()
        setWindowApi(local ? createHybridApi(local, socket) : socket)
        return
    }

    // 3. Desktop default: install the Electron IPC bridge (window.electronAPI) onto window.api.
    const electronApi = getElectronApi()
    if (electronApi && window.api !== electronApi) setWindowApi(electronApi)
}
