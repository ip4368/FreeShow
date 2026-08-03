// ----- FreeShow -----
// Token prompt for the web build.
//
// The headless server generates an auth token when none is configured and prints a
// `?token=...` URL. Someone who opens the bare origin has no way to supply it, and the
// socket handshake is rejected before STARTUP - which leaves the app sitting on the
// splash screen forever. This renders a login overlay instead.
//
// Deliberately plain DOM rather than a Svelte component: it has to work before (and
// independently of) the app mounting, including when the app is stuck mid-startup.
// For the same reason the strings are not translated - the dictionary is loaded over
// the very connection being authenticated.

import { io } from "socket.io-client"

const STYLE_ID = "freeshow-login-style"
let overlay: HTMLElement | null = null

const CSS = `
#freeshow-login {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(140deg, #28276d 20%, #150f30);
    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    color: var(--text, #f0f0ff);
}
#freeshow-login .box {
    width: min(400px, calc(100vw - 40px));
    padding: 32px;
    border-radius: 8px;
    background: var(--primary, #242832);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.4);
    display: flex;
    flex-direction: column;
    gap: 16px;
}
#freeshow-login img { width: 64px; align-self: center; }
#freeshow-login h1 { margin: 0; font-size: 1.3em; font-weight: 600; text-align: center; color: var(--text, #f0f0ff); }
/* global.css sets p { white-space: nowrap; text-overflow: ellipsis } - undo it, this text wraps */
#freeshow-login p {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.7;
    line-height: 1.5;
    text-align: center;
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
}
#freeshow-login code {
    display: block;
    margin-top: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--primary-darker, #191923);
    font-size: 0.95em;
    word-break: break-all;
    opacity: 0.9;
}
#freeshow-login input {
    padding: 12px;
    border: 2px solid transparent;
    border-radius: 4px;
    background: var(--primary-darker, #191923);
    color: inherit;
    font: inherit;
}
#freeshow-login input:focus { outline: none; border-color: var(--secondary, #f0008c); }
#freeshow-login button {
    padding: 12px;
    border: none;
    border-radius: 4px;
    background: var(--secondary, #f0008c);
    color: var(--secondary-text, #f0f0ff);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
}
#freeshow-login button:disabled { opacity: 0.5; cursor: default; }
#freeshow-login .error {
    margin: 0;
    padding: 8px 10px;
    border-radius: 4px;
    background: var(--red, rgb(255 0 0 / 0.25));
    color: var(--text, #f0f0ff);
    font-size: 0.85em;
    text-align: center;
    opacity: 1;
    white-space: normal;
}
`

/** Try a real handshake with this token - the same middleware the app will go through. */
function verifyToken(token: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = io({ transports: ["websocket", "polling"], auth: { token }, forceNew: true, reconnection: false, timeout: 8000 })
        let settled = false
        const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            socket.close()
            resolve(ok)
        }

        socket.on("connect", () => finish(true))
        socket.on("connect_error", () => finish(false))
        setTimeout(() => finish(false), 9000)
    })
}

export function isWebLoginVisible(): boolean {
    return !!overlay
}

/**
 * Show the token prompt. `onToken` is called with a verified token; the caller decides
 * what to do with it (persist + reload).
 */
export function showWebLogin(onToken: (token: string) => void, initialError = "") {
    if (overlay) return

    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style")
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
    }

    overlay = document.createElement("div")
    overlay.id = "freeshow-login"
    overlay.innerHTML = `
        <form class="box" autocomplete="off">
            <img src="./icon.png" alt="" onerror="this.style.display='none'" />
            <h1>Connect to FreeShow</h1>
            <p>
                This server requires an access token. It is printed in the server's
                console at startup:
                <code>http://&hellip;/?token=&lt;token&gt;</code>
            </p>
            <input type="password" name="token" placeholder="Access token" autofocus spellcheck="false" />
            <p class="error" hidden></p>
            <button type="submit">Connect</button>
        </form>
    `

    const form = overlay.querySelector("form") as HTMLFormElement
    const input = overlay.querySelector("input") as HTMLInputElement
    const button = overlay.querySelector("button") as HTMLButtonElement
    const error = overlay.querySelector(".error") as HTMLElement

    const setError = (message: string) => {
        error.textContent = message
        error.hidden = !message
    }
    setError(initialError)

    form.addEventListener("submit", async (event) => {
        event.preventDefault()

        const token = input.value.trim()
        if (!token) return setError("Enter the access token.")

        button.disabled = true
        input.disabled = true
        button.textContent = "Connecting..."
        setError("")

        if (await verifyToken(token)) {
            onToken(token)
            return
        }

        button.disabled = false
        input.disabled = false
        button.textContent = "Connect"
        setError("That token was not accepted.")
        input.select()
    })

    document.body.appendChild(overlay)
    input.focus()
}
