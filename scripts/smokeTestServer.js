// ----- FreeShow -----
// Smoke test for a packaged server tarball. Extracts it somewhere unrelated, starts it,
// and checks the things that packaging can silently break: relocated asset paths, the
// bundled Node runtime, the relocated native sharp install, auth, and the version fix.
//
// Deliberately runs against the ARTIFACT rather than the repo - most of these can only
// fail after packaging.
//
// Usage:
//   node scripts/smokeTestServer.js [path/to/FreeShow-Server-...tar.gz]

const { spawn, spawnSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const ROOT = path.join(__dirname, "..")
const PORT = 5599
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = "smoke-test-token"

let failures = 0
let server = null
let workDir = ""

function check(name, ok, detail = "") {
    console.info(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`)
    if (!ok) failures++
}

function findTarball() {
    const explicit = process.argv[2]
    if (explicit) return path.resolve(explicit)

    const dist = path.join(ROOT, "dist", "server")
    const found =
        fs.existsSync(dist) &&
        fs
            .readdirSync(dist)
            .filter((f) => f.endsWith(".tar.gz"))
            .sort()
    if (!found || !found.length) {
        console.error("[smokeTest] no tarball found in dist/server - run `npm run package:server` first")
        process.exit(1)
    }
    return path.join(dist, found[found.length - 1])
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch(`${BASE}/health`)
            if (res.ok) return true
        } catch {
            // not up yet
        }
        if (server && server.exitCode !== null) return false
        await delay(200)
    }
    return false
}

async function status(url) {
    try {
        return (await fetch(url)).status
    } catch {
        return 0
    }
}

/** VERSION travels over Socket.IO, and it is the check that catches a missing app/package.json. */
function checkVersionOverSocket(expected) {
    return new Promise((resolve) => {
        let client
        try {
            client = require("socket.io-client")
        } catch {
            console.info("  SKIP  version over socket - socket.io-client not installed")
            return resolve()
        }

        const socket = client.io(BASE, { transports: ["websocket"], timeout: 8000, auth: { token: TOKEN } })
        const finish = (ok, detail) => {
            check("VERSION over socket", ok, detail)
            socket.close()
            resolve()
        }

        socket.on("connect", () => {
            socket.on("MAIN", (msg) => {
                if (msg?.data?.channel !== "VERSION") return
                const actual = msg.data.data
                finish(actual === expected, `expected ${expected}, got ${JSON.stringify(actual)}`)
            })
            socket.emit("MAIN", { data: { channel: "VERSION", data: null }, listenerId: "smoke" })
        })
        socket.on("connect_error", (err) => finish(false, `connect_error: ${err.message}`))
        setTimeout(() => finish(false, "timed out"), 10000)
    })
}

async function main() {
    const tarball = findTarball()
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
    console.info(`[smokeTest] ${path.basename(tarball)}`)

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "freeshow-smoke-"))
    const dataDir = path.join(workDir, "data")
    fs.mkdirSync(dataDir)

    spawnSync("tar", ["xzf", tarball, "-C", workDir], { stdio: "inherit" })
    const installDir = path.join(
        workDir,
        fs.readdirSync(workDir).find((f) => f.startsWith("FreeShow-Server-"))
    )
    check("tarball extracts", fs.existsSync(path.join(installDir, "freeshow-server")))

    // an image inside the sandbox so /thumbnail exercises the relocated native sharp
    fs.copyFileSync(path.join(ROOT, "public", "512x512.png"), path.join(dataDir, "smoke.png"))

    // cwd is deliberately NOT the install dir - that is what catches path-resolution regressions
    server = spawn(path.join(installDir, "freeshow-server"), ["--port", String(PORT), "--data", dataDir, "--token", TOKEN, "--host", "127.0.0.1"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] })

    let output = ""
    server.stdout.on("data", (chunk) => (output += chunk))
    server.stderr.on("data", (chunk) => (output += chunk))

    if (!(await waitForServer())) {
        console.error("[smokeTest] server did not start:\n" + output)
        failures++
        return
    }

    const health = await (await fetch(`${BASE}/health`)).json()
    check("/health", health?.ok === true)

    const capabilities = await (await fetch(`${BASE}/capabilities`)).json()
    check("/capabilities is the headless set", capabilities?.outputWindows === false && capabilities?.nativeDialogs === false)

    check("/ serves the web build", (await status(`${BASE}/`)) === 200)
    check("/lang/en.json (public assets)", (await status(`${BASE}/lang/en.json`)) === 200)
    check("/assets/pdf.worker.min.mjs", (await status(`${BASE}/assets/pdf.worker.min.mjs`)) === 200)

    check("/media rejects a missing token", (await status(`${BASE}/media?path=smoke.png`)) === 401)
    check("/media accepts the token", (await status(`${BASE}/media?path=smoke.png&token=${TOKEN}`)) === 200)
    check("sandbox rejects traversal", (await status(`${BASE}/media?path=../../etc/passwd&token=${TOKEN}`)) === 403)

    // the real test of the relocated sharp install: a resized webp, not a passthrough
    const thumb = await fetch(`${BASE}/thumbnail?path=smoke.png&size=128&token=${TOKEN}`)
    const thumbBody = Buffer.from(await thumb.arrayBuffer())
    const isWebp = thumbBody.subarray(0, 4).toString() === "RIFF" && thumbBody.subarray(8, 12).toString() === "WEBP"
    check("/thumbnail returns webp (sharp loaded)", thumb.status === 200 && isWebp, `status=${thumb.status} bytes=${thumbBody.length}`)

    await checkVersionOverSocket(version)
}

main()
    .catch((err) => {
        console.error("[smokeTest]", err.stack || err.message)
        failures++
    })
    .finally(() => {
        server?.kill()
        if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
        console.info(failures ? `\n[smokeTest] ${failures} check(s) FAILED` : "\n[smokeTest] all checks passed")
        process.exit(failures ? 1 : 0)
    })
