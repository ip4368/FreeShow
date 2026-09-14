import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_HOST, DEFAULT_PORT, loadConfigFile, parseArgs, resolveConfig } from "./config"

// env vars this module reads - cleared between tests so the host environment can't leak in
const ENV_KEYS = ["FREESHOW_CONFIG", "FREESHOW_PORT", "PORT", "FREESHOW_HOST", "FREESHOW_DATA", "FREESHOW_TOKEN", "FREESHOW_ALLOW_OPEN", "FREESHOW_WEB_DIR", "FREESHOW_PUBLIC_DIR", "FREESHOW_FFMPEG"]

let tempDir = ""
let savedEnv: Record<string, string | undefined> = {}
let savedCwd = ""

function writeConfig(values: unknown, name = "config.json"): string {
    const file = path.join(tempDir, name)
    fs.writeFileSync(file, typeof values === "string" ? values : JSON.stringify(values))
    return file
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-config-"))
    savedCwd = process.cwd()
    savedEnv = {}
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key]
        delete process.env[key]
    }
})

afterEach(() => {
    process.chdir(savedCwd)
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("parseArgs", () => {
    it("reads every supported flag", () => {
        const args = parseArgs(["--config", "/c.json", "--data", "/d", "--port", "1234", "--host", "127.0.0.1", "--token", "abc", "--web-dir", "/w", "--public-dir", "/p", "--ffmpeg", "/ff"])
        expect(args).toEqual({ config: "/c.json", data: "/d", port: 1234, host: "127.0.0.1", token: "abc", webDir: "/w", publicDir: "/p", ffmpeg: "/ff" })
    })

    it("treats --no-auth as a boolean", () => {
        expect(parseArgs(["--no-auth"]).allowOpen).toBe(true)
        expect(parseArgs([]).allowOpen).toBeUndefined()
    })

    it("ignores unknown flags", () => {
        expect(parseArgs(["--wat", "--port", "99"]).port).toBe(99)
    })
})

describe("loadConfigFile", () => {
    it("returns empty when nothing is found", () => {
        process.chdir(tempDir)
        expect(loadConfigFile()).toEqual({ values: {}, configPath: "" })
    })

    it("discovers freeshow-server.json in the working directory", () => {
        writeConfig({ port: 7000 }, "freeshow-server.json")
        process.chdir(tempDir)
        const { values, configPath } = loadConfigFile()
        expect(values.port).toBe(7000)
        expect(configPath).toContain("freeshow-server.json")
    })

    it("throws when an explicit path is missing", () => {
        expect(() => loadConfigFile(path.join(tempDir, "nope.json"))).toThrow()
    })

    it("throws when an explicit path is malformed", () => {
        expect(() => loadConfigFile(writeConfig("{ not json"))).toThrow()
    })

    it("rejects a JSON array", () => {
        expect(() => loadConfigFile(writeConfig([1, 2]))).toThrow(/JSON object/)
    })

    it("honours $FREESHOW_CONFIG", () => {
        process.env.FREESHOW_CONFIG = writeConfig({ port: 8123 })
        expect(loadConfigFile().values.port).toBe(8123)
    })

    it("skips a malformed discovered file instead of throwing", () => {
        writeConfig("{ broken", "freeshow-server.json")
        process.chdir(tempDir)
        expect(loadConfigFile()).toEqual({ values: {}, configPath: "" })
    })
})

describe("resolveConfig precedence", () => {
    it("falls back to defaults", () => {
        process.chdir(tempDir)
        const config = resolveConfig()
        expect(config.port).toBe(DEFAULT_PORT)
        expect(config.host).toBe(DEFAULT_HOST)
        expect(config.token).toBe("")
        expect(config.allowOpen).toBe(false)
    })

    it("uses the config file when nothing else is set", () => {
        const file = writeConfig({ port: 6001, host: "127.0.0.1", token: "from-file" })
        expect(resolveConfig({ config: file })).toMatchObject({ port: 6001, host: "127.0.0.1", token: "from-file" })
    })

    it("lets env beat the config file", () => {
        const file = writeConfig({ port: 6001, token: "from-file" })
        process.env.FREESHOW_PORT = "6002"
        process.env.FREESHOW_TOKEN = "from-env"
        expect(resolveConfig({ config: file })).toMatchObject({ port: 6002, token: "from-env" })
    })

    it("lets CLI beat env and the config file", () => {
        const file = writeConfig({ port: 6001, token: "from-file" })
        process.env.FREESHOW_PORT = "6002"
        process.env.FREESHOW_TOKEN = "from-env"
        expect(resolveConfig({ config: file, port: 6003, token: "from-cli" })).toMatchObject({ port: 6003, token: "from-cli" })
    })

    it("accepts PORT as well as FREESHOW_PORT, preferring FREESHOW_PORT", () => {
        process.chdir(tempDir)
        process.env.PORT = "7001"
        expect(resolveConfig().port).toBe(7001)
        process.env.FREESHOW_PORT = "7002"
        expect(resolveConfig().port).toBe(7002)
    })

    it("ignores a blank env var so it can't shadow the config file", () => {
        const file = writeConfig({ token: "from-file" })
        process.env.FREESHOW_TOKEN = ""
        expect(resolveConfig({ config: file }).token).toBe("from-file")
    })

    it("ignores a non-numeric --port instead of resolving to NaN", () => {
        const file = writeConfig({ port: 6001 })
        expect(resolveConfig({ config: file, port: Number("abc") }).port).toBe(6001)
    })

    it("resolves allowOpen from any layer", () => {
        expect(resolveConfig({ config: writeConfig({ allowOpen: true }) }).allowOpen).toBe(true)

        process.chdir(tempDir)
        process.env.FREESHOW_ALLOW_OPEN = "1"
        expect(resolveConfig().allowOpen).toBe(true)
        process.env.FREESHOW_ALLOW_OPEN = "false"
        expect(resolveConfig().allowOpen).toBe(false)

        expect(resolveConfig({ allowOpen: true }).allowOpen).toBe(true)
    })

    it("reports which config file was used", () => {
        const file = writeConfig({ port: 6001 })
        expect(resolveConfig({ config: file }).configPath).toBe(file)
        process.chdir(tempDir)
        expect(resolveConfig().configPath).toBe("")
    })
})
