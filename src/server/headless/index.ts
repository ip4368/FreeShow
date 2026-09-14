// ----- FreeShow -----
// Headless FreeShow server entrypoint.
//
// Usage:
//   node build/headless/server/headless/index.js [--config <file>] [--data <dir>]
//                                                [--port 5540] [--host 0.0.0.0]
//                                                [--token <token>] [--no-auth]
//
// Settings resolve CLI -> env -> config file -> default; see ./config.ts.
//
// Serves the web build over HTTP and bridges the frontend's IPC envelopes over
// Socket.IO to the portable handler table (headless platform).

import crypto from "crypto"
import express from "express"
import fs from "fs"
import http from "http"
import path from "path"
import { Server } from "socket.io"
import { setAuthToken, socketAuth } from "./auth"
import type { CliArgs, ServerConfig } from "./config"
import { parseArgs, resolveConfig } from "./config"
import { getDataFolderRoot, setDataRoot } from "./data/dataPaths"
import { registerHttpRoutes } from "./httpRoutes"
import { registerClient } from "./socketServer"

// keep the server alive on transient/non-fatal errors (e.g. a file that vanished mid-request)
// instead of crashing the whole process the way an unhandled ENOENT would.
function installProcessGuards() {
    process.on("uncaughtException", (err) => console.error("[headless] uncaughtException:", err?.message || err))
    process.on("unhandledRejection", (reason) => console.error("[headless] unhandledRejection:", reason))
}

/**
 * httpRoutes and the ffmpeg lookup read these from the environment, so publish the
 * resolved values there rather than threading a config object through every module.
 *
 * When nothing is configured we look for the packaged layout (<root>/app/server.js
 * next to <root>/web and <root>/public) so an extracted tarball works from any
 * directory. Absolute paths must NOT be baked into the shipped config file - the
 * artifact is relocatable. Falling through leaves httpRoutes on its cwd default,
 * which is what the repo dev flow wants.
 */
function exportPathsToEnv(config: ServerConfig) {
    const bundleRoot = path.join(__dirname, "..")
    const bundled = (dir: string) => {
        const candidate = path.join(bundleRoot, dir)
        return fs.existsSync(candidate) ? candidate : ""
    }

    const webDir = config.webDir || bundled("web")
    const publicDir = config.publicDir || bundled("public")

    if (webDir) process.env.FREESHOW_WEB_DIR = webDir
    if (publicDir) process.env.FREESHOW_PUBLIC_DIR = publicDir
    if (config.ffmpeg) process.env.FREESHOW_FFMPEG = config.ffmpeg
}

/**
 * Pick the auth token. With nothing configured we generate one rather than running
 * open, because the media gateway exposes the whole show library. `--no-auth` (or
 * `"allowOpen": true`) restores the open behaviour for trusted LANs.
 *
 * A generated token is intentionally EPHEMERAL - it changes on every restart. Set
 * `token` in the config file or pass --token when a stable token is needed.
 */
function resolveToken(config: ServerConfig): { token: string; generated: boolean } {
    if (config.token) return { token: config.token, generated: false }
    if (config.allowOpen) return { token: "", generated: false }
    return { token: crypto.randomBytes(16).toString("hex"), generated: true }
}

/** 0.0.0.0 / :: aren't usable in a browser - show a URL someone can actually click. */
function displayHost(host: string): string {
    return host === "0.0.0.0" || host === "::" || host === "" ? "localhost" : host
}

function logStartup(config: ServerConfig, token: string, generated: boolean) {
    const url = `http://${displayHost(config.host)}:${config.port}`
    console.info(`FreeShow headless server on ${url}`)
    console.info(`Data folder: ${getDataFolderRoot()}`)
    if (config.configPath) console.info(`Config: ${config.configPath}`)

    if (generated) {
        console.info(`Auth: generated token (set "token" in a config file to pin it)`)
        console.info("")
        console.info(`  ${url}/?token=${token}`)
        console.info("")
    } else if (token) {
        console.info("Auth: token required")
    } else {
        console.warn("Auth: OPEN - anyone who can reach this port can read and write your show library.")
    }
}

export function startHeadlessServer(args: CliArgs = {}) {
    installProcessGuards()

    const config = resolveConfig(args)
    if (config.data) setDataRoot(config.data)
    exportPathsToEnv(config)

    const { token, generated } = resolveToken(config)
    setAuthToken(token)

    const app = express()
    const server = http.createServer(app)
    // cors origin "*" allows remote desktop clients (different origin) to connect;
    // access is still gated by the auth token. Tighten origin for production if needed.
    const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: "*" } }) // 100MB for larger payloads

    registerHttpRoutes(app)

    io.use(socketAuth)
    io.on("connection", (socket) => registerClient(io, socket))

    server.listen(config.port, config.host, () => logStartup(config, token, generated))

    return { app, server, io, config, token }
}

// run when invoked directly
if (require.main === module) {
    try {
        startHeadlessServer(parseArgs(process.argv.slice(2)))
    } catch (err) {
        console.error(`[headless] failed to start: ${(err as Error).message}`)
        process.exit(1)
    }
}
