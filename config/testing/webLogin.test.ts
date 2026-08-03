// E2E: the web client must prompt for an access token instead of hanging.
//
// The headless server generates a token when none is configured, so anyone opening the
// bare origin is rejected at the Socket.IO handshake. Without a prompt the app sits on
// the splash screen forever (Socket.IO does not retry after a middleware rejection).
//
// Requires the built artifacts: npm run build:web && npm run build:headless

import { expect, test } from "@playwright/test"
import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import tmp from "tmp"

const TOKEN = "e2e-secret-token"
const AUTH_PORT = 5592
const OPEN_PORT = 5593
const AUTH_BASE = `http://localhost:${AUTH_PORT}`
const OPEN_BASE = `http://localhost:${OPEN_PORT}`

const ROOT = path.join(__dirname, "..", "..")
const SERVER_ENTRY = path.join(ROOT, "build", "headless", "server", "headless", "index.js")

const LOGIN = "#freeshow-login"

const servers: ChildProcess[] = []
let dataDir: tmp.DirResult

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForServer(base: string, timeoutMs = 20_000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            if ((await fetch(`${base}/health`)).ok) return
        } catch {
            // not up yet
        }
        await delay(200)
    }
    throw new Error(`headless server did not start on ${base}`)
}

function startServer(args: string[]) {
    const proc = spawn("node", [SERVER_ENTRY, ...args], { cwd: ROOT, env: { ...process.env, FREESHOW_DATA: dataDir.name }, stdio: "ignore" })
    servers.push(proc)
    return proc
}

test.beforeAll(async () => {
    if (!fs.existsSync(SERVER_ENTRY)) test.skip(true, "run `npm run build:headless` first")
    if (!fs.existsSync(path.join(ROOT, "build", "web", "index.html"))) test.skip(true, "run `npm run build:web` first")

    dataDir = tmp.dirSync({ unsafeCleanup: true })
    startServer(["--port", String(AUTH_PORT), "--token", TOKEN])
    startServer(["--port", String(OPEN_PORT), "--no-auth"])
    await Promise.all([waitForServer(AUTH_BASE), waitForServer(OPEN_BASE)])
})

test.afterAll(() => {
    servers.forEach((proc) => proc.kill())
    dataDir?.removeCallback()
})

test("prompts for a token when none is supplied", async ({ page }) => {
    await page.goto(AUTH_BASE, { waitUntil: "networkidle" })

    await expect(page.locator(LOGIN)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`${LOGIN} h1`)).toHaveText("Connect to FreeShow")
    // the instructions must not be clipped by global.css's `p { white-space: nowrap }`
    await expect(page.locator(`${LOGIN} p`).first()).toContainText("printed in the server's console")
})

test("rejects a wrong token and stays on the prompt", async ({ page }) => {
    await page.goto(AUTH_BASE, { waitUntil: "networkidle" })
    await expect(page.locator(LOGIN)).toBeVisible({ timeout: 15_000 })

    await page.fill(`${LOGIN} input`, "not-the-token")
    await page.click(`${LOGIN} button`)

    await expect(page.locator(`${LOGIN} .error`)).toHaveText("That token was not accepted.", { timeout: 15_000 })
    await expect(page.locator(LOGIN)).toBeVisible()
})

test("accepts the right token, persists it and loads the app", async ({ page }) => {
    await page.goto(AUTH_BASE, { waitUntil: "networkidle" })
    await expect(page.locator(LOGIN)).toBeVisible({ timeout: 15_000 })

    await page.fill(`${LOGIN} input`, TOKEN)
    await page.click(`${LOGIN} button`)

    // verified -> stored -> reload -> normal startup
    await expect(page.locator(LOGIN)).toHaveCount(0, { timeout: 20_000 })
    expect(await page.evaluate(() => localStorage.getItem("freeshow_web_token"))).toBe(TOKEN)
    await expect(page.locator("body")).toContainText("FreeShow", { timeout: 20_000 })
})

test("a ?token= URL logs straight in and is stripped from the address bar", async ({ page }) => {
    await page.goto(`${AUTH_BASE}/?token=${TOKEN}`, { waitUntil: "networkidle" })
    await delay(3000)

    await expect(page.locator(LOGIN)).toHaveCount(0)
    // the token must not linger in the URL (bookmarks / history / Referer)
    expect(page.url()).not.toContain("token")
    expect(await page.evaluate(() => localStorage.getItem("freeshow_web_token"))).toBe(TOKEN)
})

test("a stale saved token says so, rather than looking like a fresh login", async ({ page }) => {
    // seed from /health, not the app: loading the app would connect, get rejected, and
    // clear the token we are trying to plant (the whole point of handleUnauthorized)
    await page.goto(`${AUTH_BASE}/health`)
    await page.evaluate(() => localStorage.setItem("freeshow_web_token", "stale-rotated-token"))
    await page.goto(AUTH_BASE, { waitUntil: "networkidle" })

    await expect(page.locator(`${LOGIN} .error`)).toHaveText("The saved access token was rejected.", { timeout: 15_000 })
    // the rejected token is cleared so the prompt starts empty
    expect(await page.evaluate(() => localStorage.getItem("freeshow_web_token"))).toBeNull()
})

test("an open server never shows the prompt", async ({ page }) => {
    await page.goto(OPEN_BASE, { waitUntil: "networkidle" })
    await delay(3000)

    await expect(page.locator(LOGIN)).toHaveCount(0)
    await expect(page.locator("body")).toContainText("FreeShow", { timeout: 20_000 })
})
