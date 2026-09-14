// ----- FreeShow -----
// Configuration for the headless server.
//
// Precedence, highest first:
//   CLI flag  ->  environment variable  ->  config file  ->  built-in default
//
// The config file is JSON. When neither --config nor $FREESHOW_CONFIG is given,
// the first of these that exists wins (a missing file is NOT an error):
//   ./freeshow-server.json
//   /etc/freeshow-server/config.json
//   ~/.config/freeshow-server/config.json
//
// An EXPLICIT path (--config or $FREESHOW_CONFIG) that doesn't exist or doesn't
// parse is a hard error — silently ignoring a typo'd path is worse than failing.

import fs from "fs"
import os from "os"
import path from "path"

export const DEFAULT_PORT = 5540
export const DEFAULT_HOST = "0.0.0.0"

/** Fully resolved settings. "" means "not set" for the string fields. */
export interface ServerConfig {
    port: number
    host: string
    data: string
    token: string
    allowOpen: boolean
    webDir: string
    publicDir: string
    ffmpeg: string
    /** Config file the values came from, or "" when none was found. */
    configPath: string
}

/** Shape of the JSON config file — every field optional. */
export interface ConfigFile {
    port?: number
    host?: string
    data?: string
    token?: string
    allowOpen?: boolean
    webDir?: string
    publicDir?: string
    ffmpeg?: string
}

export interface CliArgs extends ConfigFile {
    config?: string
}

export function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--config") args.config = argv[++i]
        else if (arg === "--data") args.data = argv[++i]
        else if (arg === "--port") args.port = Number(argv[++i])
        else if (arg === "--host") args.host = argv[++i]
        else if (arg === "--token") args.token = argv[++i]
        else if (arg === "--web-dir") args.webDir = argv[++i]
        else if (arg === "--public-dir") args.publicDir = argv[++i]
        else if (arg === "--ffmpeg") args.ffmpeg = argv[++i]
        else if (arg === "--no-auth") args.allowOpen = true
    }
    return args
}

/** Discovery order for the config file when no explicit path is given. */
export function getConfigCandidates(): string[] {
    return [path.join(process.cwd(), "freeshow-server.json"), "/etc/freeshow-server/config.json", path.join(os.homedir(), ".config", "freeshow-server", "config.json")]
}

function readConfigFile(filePath: string): ConfigFile {
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`config file must contain a JSON object: ${filePath}`)
    }
    return parsed as ConfigFile
}

/**
 * Load the config file. An explicit path must exist and parse; discovered paths
 * are best-effort. Returns an empty object when nothing was found.
 */
export function loadConfigFile(explicitPath?: string): { values: ConfigFile; configPath: string } {
    const explicit = explicitPath || process.env.FREESHOW_CONFIG
    if (explicit) {
        // let both ENOENT and SyntaxError propagate - the user named this file explicitly
        return { values: readConfigFile(explicit), configPath: explicit }
    }

    for (const candidate of getConfigCandidates()) {
        if (!fs.existsSync(candidate)) continue
        try {
            return { values: readConfigFile(candidate), configPath: candidate }
        } catch (err) {
            // a discovered file that exists but is broken is worth complaining about,
            // but it shouldn't stop the server from starting on defaults
            console.warn(`[headless] ignoring unreadable config ${candidate}: ${(err as Error).message}`)
        }
    }

    return { values: {}, configPath: "" }
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
    for (const value of values) if (value !== undefined) return value
    return undefined
}

/** Env vars are strings; treat blank/whitespace as "not set" so `FOO=` doesn't win over the config file. */
function envString(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]
        if (value !== undefined && value.trim() !== "") return value
    }
    return undefined
}

function envNumber(...names: string[]): number | undefined {
    const value = envString(...names)
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

function envBoolean(name: string): boolean | undefined {
    const value = envString(name)
    if (value === undefined) return undefined
    return value === "1" || value.toLowerCase() === "true"
}

export function resolveConfig(args: CliArgs = {}): ServerConfig {
    const { values: file, configPath } = loadConfigFile(args.config)

    // a CLI --port of NaN (e.g. `--port abc`) must not beat the config file
    const cliPort = Number.isFinite(args.port) ? args.port : undefined

    return {
        port: firstDefined(cliPort, envNumber("FREESHOW_PORT", "PORT"), file.port) ?? DEFAULT_PORT,
        host: firstDefined(args.host, envString("FREESHOW_HOST"), file.host) ?? DEFAULT_HOST,
        data: firstDefined(args.data, envString("FREESHOW_DATA"), file.data) ?? "",
        token: firstDefined(args.token, envString("FREESHOW_TOKEN"), file.token) ?? "",
        allowOpen: firstDefined(args.allowOpen, envBoolean("FREESHOW_ALLOW_OPEN"), file.allowOpen) ?? false,
        webDir: firstDefined(args.webDir, envString("FREESHOW_WEB_DIR"), file.webDir) ?? "",
        publicDir: firstDefined(args.publicDir, envString("FREESHOW_PUBLIC_DIR"), file.publicDir) ?? "",
        ffmpeg: firstDefined(args.ffmpeg, envString("FREESHOW_FFMPEG"), file.ffmpeg) ?? "",
        configPath
    }
}
