// ----- FreeShow -----
// Packages the headless server into a self-contained artifact:
//
//   dist/server/FreeShow-Server-<version>-<platform>-<arch>/     staged tree
//   dist/server/FreeShow-Server-<version>-<platform>-<arch>.tar.gz
//   dist/server/freeshow-server_<debVersion>_<debArch>.deb       (linux, built on Linux)
//
// platform: linux | macos     arch: x64 | arm64
//
// The tree bundles a Node runtime, so the target host needs nothing installed.
// See docs/plans/2026-08-03-headless-server-binary-design.md
//
// Usage:
//   node scripts/packageServer.js [--platform linux|macos] [--arch x64|arm64]
//                                 [--skip-build] [--no-deb]

const { execFileSync, spawnSync } = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")

// Pinned so rebuilding an old tag reproduces the old artifact. package.json requires >=22.12.0.
const NODE_VERSION = "22.21.1"

const ROOT = path.join(__dirname, "..")
const DIST = path.join(ROOT, "dist", "server")
const CACHE = path.join(ROOT, "dist", ".node-cache")

// public/ is copied wholesale apart from these - lang/ and assets/ are fetched at
// runtime by the web frontend, so they have to ship.
//
// "build" is the DESKTOP frontend bundle (vite.config.mjs outDir in production), not
// anything the headless server serves; it only serves build/web. Shipping it would add
// ~5 MB of dead weight. The rest are Electron packaging leftovers, including TypeScript
// source and a source map, which have no business on a web-facing static route.
const PUBLIC_EXCLUDE = new Set(["build", "preload.ts", "preload.js.map", "icon.icns", "icon.ico", "dmg.png", "identify.html"])

const DEB_ARCH = { x64: "amd64", arm64: "arm64" }

// "macos" is the user-facing label; "darwin" is what nodejs.org and npm --os expect.
const PLATFORMS = {
    linux: { nodeOs: "linux", nodeExt: "tar.xz", tarFlag: "-xJf", libc: "glibc" },
    macos: { nodeOs: "darwin", nodeExt: "tar.gz", tarFlag: "-xzf", libc: "" }
}

function hostPlatform() {
    if (process.platform === "darwin") return "macos"
    if (process.platform === "linux") return "linux"
    return "" // Windows: no default, must be given explicitly
}

function parseArgs(argv) {
    const args = { platform: hostPlatform(), arch: process.arch === "arm64" ? "arm64" : "x64", skipBuild: false, deb: true }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--platform") args.platform = argv[++i]
        else if (arg === "--arch") args.arch = argv[++i]
        else if (arg === "--skip-build") args.skipBuild = true
        else if (arg === "--no-deb") args.deb = false
    }
    if (!PLATFORMS[args.platform]) fail(`unsupported --platform "${args.platform}" (expected linux or macos)`)
    if (!DEB_ARCH[args.arch]) fail(`unsupported --arch "${args.arch}" (expected x64 or arm64)`)
    return args
}

function fail(message) {
    console.error(`[packageServer] ${message}`)
    process.exit(1)
}

function step(message) {
    console.info(`\n[packageServer] ${message}`)
}

function run(cmd, cmdArgs, cwd = ROOT) {
    const res = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" })
    if (res.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} failed`)
}

/**
 * dpkg parses the last "-" as the upstream/revision separator, so "1.6.5-beta.1"
 * sorts as NEWER than the eventual "1.6.5" and would block the upgrade. "~" sorts
 * before everything, which is what a prerelease needs.
 */
function toDebianVersion(version) {
    return version.replace(/-/g, "~")
}

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true })
}

function copyDir(from, to, exclude = new Set()) {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (exclude.has(entry.name)) continue
        const src = path.join(from, entry.name)
        const dest = path.join(to, entry.name)
        if (entry.isDirectory()) copyDir(src, dest, exclude)
        else if (entry.isFile()) fs.copyFileSync(src, dest)
    }
}

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const request = (target, redirects = 0) => {
            https
                .get(target, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        if (redirects > 5) return reject(new Error("too many redirects"))
                        res.resume()
                        return request(new URL(res.headers.location, target).toString(), redirects + 1)
                    }
                    if (res.statusCode !== 200) {
                        res.resume()
                        return reject(new Error(`HTTP ${res.statusCode} for ${target}`))
                    }
                    const file = fs.createWriteStream(dest)
                    res.pipe(file)
                    file.on("finish", () => file.close(() => resolve()))
                    file.on("error", reject)
                })
                .on("error", reject)
        }
        request(url)
    })
}

function sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

/** Download + verify the official Node tarball and return the path to its `node` binary. */
async function fetchNodeBinary(platform, arch) {
    const { nodeOs, nodeExt, tarFlag } = PLATFORMS[platform]
    const name = `node-v${NODE_VERSION}-${nodeOs}-${arch}`
    const archive = `${name}.${nodeExt}`
    const cached = path.join(CACHE, name, "bin", "node")
    if (fs.existsSync(cached)) {
        console.info(`  using cached ${name}`)
        return cached
    }

    fs.mkdirSync(CACHE, { recursive: true })
    const tarball = path.join(CACHE, archive)
    const sumsFile = path.join(CACHE, `SHASUMS256-${NODE_VERSION}.txt`)
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`

    console.info(`  downloading ${archive}`)
    await download(`${base}/${archive}`, tarball)
    if (!fs.existsSync(sumsFile)) await download(`${base}/SHASUMS256.txt`, sumsFile)

    const expected = fs
        .readFileSync(sumsFile, "utf8")
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === archive)
    if (!expected) fail(`no checksum for ${archive} in SHASUMS256.txt`)

    const actual = sha256(tarball)
    if (actual !== expected[0]) fail(`checksum mismatch for ${archive}\n  expected ${expected[0]}\n  actual   ${actual}`)
    console.info("  checksum OK")

    // extract only the binary we ship
    execFileSync("tar", [tarFlag, tarball, "-C", CACHE, `${name}/bin/node`], { stdio: "inherit" })
    if (!fs.existsSync(cached)) fail(`node binary missing after extracting ${archive}`)
    return cached
}

const LAUNCHER = `#!/bin/sh
# ----- FreeShow -----
# Launcher for the packaged headless server.
set -e

# resolve symlinks (/usr/bin/freeshow-server -> /opt/freeshow-server/freeshow-server)
SELF="$0"
while [ -L "$SELF" ]; do
    LINK=$(readlink "$SELF")
    case "$LINK" in
        /*) SELF="$LINK" ;;
        *) SELF="$(dirname "$SELF")/$LINK" ;;
    esac
done
DIR=$(cd "$(dirname "$SELF")" && pwd)

# only point at the bundled config when the user hasn't chosen one; an explicit
# --config or $FREESHOW_CONFIG must win, and a deleted file must not be an error
if [ -z "$FREESHOW_CONFIG" ] && [ -f "$DIR/freeshow-server.json" ]; then
    case " $* " in
        *" --config "*) ;;
        *) FREESHOW_CONFIG="$DIR/freeshow-server.json"; export FREESHOW_CONFIG ;;
    esac
fi

exec "$DIR/bin/node" "$DIR/app/server.js" "$@"
`

// webDir/publicDir are deliberately left empty: the server resolves them relative to
// app/server.js, so the extracted tree works from any directory. Baking in absolute
// build-machine paths would break relocation.
function defaultConfig() {
    return { port: 5540, host: "0.0.0.0", data: "", token: "", allowOpen: false, webDir: "", publicDir: "", ffmpeg: "" }
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
    const { version } = pkg
    const sharpVersion = (pkg.dependencies && pkg.dependencies.sharp) || "latest"

    const target = PLATFORMS[args.platform]
    const name = `FreeShow-Server-${version}-${args.platform}-${args.arch}`
    const stageDir = path.join(DIST, name)

    console.info(`[packageServer] ${name} (node ${NODE_VERSION}, sharp ${sharpVersion})`)

    if (!args.skipBuild) {
        // Only these two. The remote/stage/controller/cam client bundles (build:servers:prod)
        // are NOT needed: they build to build/electron/<id> and the headless server has no
        // routes for them - it serves build/web plus the static public/ assets.
        step("building web bundle")
        run("npm", ["run", "build:web"])
        step("building headless server")
        run("npm", ["run", "build:headless"])
    } else {
        console.info("\n[packageServer] --skip-build: reusing existing build/ output")
    }

    const entry = path.join(ROOT, "build", "headless", "server", "headless", "index.js")
    if (!fs.existsSync(entry)) fail(`missing ${path.relative(ROOT, entry)} - run without --skip-build`)
    if (!fs.existsSync(path.join(ROOT, "build", "web", "index.html"))) fail("missing build/web - run without --skip-build")

    step(`staging ${path.relative(ROOT, stageDir)}`)
    rmrf(stageDir)
    fs.mkdirSync(path.join(stageDir, "app"), { recursive: true })
    fs.mkdirSync(path.join(stageDir, "bin"), { recursive: true })

    // sharp is native, so it stays external and is installed as a real package tree.
    // Everything else (express, socket.io, yjs) is pure JS and gets inlined.
    step("bundling server.js")
    run("npx", ["esbuild", entry, "--bundle", "--platform=node", "--target=node22", "--format=cjs", "--external:sharp", `--outfile=${path.join(stageDir, "app", "server.js")}`])

    // getAppVersion() walks up from __dirname looking for a package.json with a version
    // field; without this the packaged server reports "0.0.0". npm install does NOT
    // create this file, and a version-less one is skipped - it has to be written here.
    fs.writeFileSync(path.join(stageDir, "app", "package.json"), JSON.stringify({ name: "freeshow-server", version, private: true }, null, 2) + "\n")

    // --libc only means anything on linux; npm ignores it elsewhere, but passing it
    // conditionally keeps the intent clear
    step(`installing sharp for ${target.nodeOs}-${args.arch}`)
    const sharpFlags = ["--no-save", "--no-package-lock", "--no-audit", "--no-fund", `--os=${target.nodeOs}`, `--cpu=${args.arch}`]
    if (target.libc) sharpFlags.push(`--libc=${target.libc}`)
    run("npm", ["install", ...sharpFlags, `sharp@${sharpVersion.replace(/^[\^~]/, "")}`], path.join(stageDir, "app"))

    step(`fetching node ${NODE_VERSION} (${target.nodeOs}-${args.arch})`)
    const nodeBinary = await fetchNodeBinary(args.platform, args.arch)
    fs.copyFileSync(nodeBinary, path.join(stageDir, "bin", "node"))
    fs.chmodSync(path.join(stageDir, "bin", "node"), 0o755)

    step("copying web + public assets")
    copyDir(path.join(ROOT, "build", "web"), path.join(stageDir, "web"))
    copyDir(path.join(ROOT, "public"), path.join(stageDir, "public"), PUBLIC_EXCLUDE)
    // the web frontend fetches these at runtime; missing them is a silent, ugly failure
    for (const required of ["lang/en.json", "assets/pdf.worker.min.mjs"]) {
        if (!fs.existsSync(path.join(stageDir, "public", required))) console.warn(`  WARNING: public/${required} missing from the staged tree`)
    }

    fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(stageDir, "LICENSE"))
    fs.writeFileSync(path.join(stageDir, "freeshow-server"), LAUNCHER)
    fs.chmodSync(path.join(stageDir, "freeshow-server"), 0o755)
    fs.writeFileSync(path.join(stageDir, "freeshow-server.json"), JSON.stringify(defaultConfig(), null, 4) + "\n")
    fs.writeFileSync(path.join(stageDir, "README.md"), readme(version, args.platform))
    if (args.platform === "macos") fs.writeFileSync(path.join(stageDir, "app.freeshow.server.plist"), LAUNCHD_PLIST)

    step("creating tarball")
    run("tar", ["czf", `${name}.tar.gz`, name], DIST)

    const tarball = path.join(DIST, `${name}.tar.gz`)
    console.info(`  ${path.relative(ROOT, tarball)} (${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`)

    if (args.platform === "macos") verifyMacSignatures(stageDir)
    if (args.deb && args.platform === "linux") await buildDeb({ stageDir, version, arch: args.arch })

    console.info(`\n[packageServer] done -> ${path.relative(ROOT, DIST)}`)
}

const MACOS_README = `
## macOS: first run

Running \`./freeshow-server\` from Terminal works even on a browser-downloaded copy:
the bundled Node runtime and the native image library are both code-signed by their
publishers, and Terminal-launched processes don't get the Gatekeeper prompt that
Finder launches do.

If you do hit "cannot be opened because the developer cannot be verified" - most
likely launching it indirectly rather than from a shell - clear the quarantine flag:

    xattr -dr com.apple.quarantine .

The archive itself is not signed or notarized by FreeShow.

## macOS: run at login

Edit \`app.freeshow.server.plist\` so the path matches where you put this folder, then:

    cp app.freeshow.server.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/app.freeshow.server.plist

Logs go to \`/tmp/freeshow-server.log\`. To stop:

    launchctl unload ~/Library/LaunchAgents/app.freeshow.server.plist
`

// Paths are placeholders: the tarball can be extracted anywhere, so the README tells
// the user to edit them rather than guessing an install location.
const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>app.freeshow.server</string>

    <!-- EDIT: absolute path to the freeshow-server script in this folder -->
    <key>ProgramArguments</key>
    <array>
        <string>/opt/freeshow-server/freeshow-server</string>
    </array>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/freeshow-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/freeshow-server.log</string>
</dict>
</plist>
`

/**
 * arm64 macOS refuses to run code that isn't at least ad-hoc signed, and a quarantined
 * unsigned dylib fails at dlopen time - which would show up as a broken /thumbnail
 * rather than a startup error. Only meaningful when packaging ON macOS.
 */
function verifyMacSignatures(stageDir) {
    if (process.platform !== "darwin") return

    step("checking macOS code signatures")
    const targets = [path.join(stageDir, "bin", "node")]

    const imgDir = path.join(stageDir, "app", "node_modules", "@img")
    if (fs.existsSync(imgDir)) {
        for (const entry of fs.readdirSync(imgDir)) {
            const libDir = path.join(imgDir, entry, "lib")
            if (!fs.existsSync(libDir)) continue
            for (const file of fs.readdirSync(libDir)) {
                if (file.endsWith(".node") || file.endsWith(".dylib")) targets.push(path.join(libDir, file))
            }
        }
    }

    let unsigned = 0
    for (const target of targets) {
        const res = spawnSync("codesign", ["-v", "--strict", target], { encoding: "utf8" })
        if (res.error) {
            console.info("  codesign unavailable - skipping")
            return
        }
        if (res.status !== 0) {
            unsigned++
            console.warn(`  UNSIGNED  ${path.relative(stageDir, target)}`)
        }
    }
    console.info(unsigned ? `  ${unsigned} unsigned binaries - users must clear the quarantine flag (documented in README)` : `  all ${targets.length} binaries carry a signature`)
}

function readme(version, platform) {
    return `# FreeShow Server ${version}

Self-contained headless FreeShow server. A Node runtime is bundled in \`bin/\`, so
nothing needs to be installed on the host.

## Run

    ./freeshow-server

The server prints a URL containing a generated auth token. Open it in a browser.

The generated token changes on every restart. To pin one, set \`token\` in
\`freeshow-server.json\` next to this file, or pass \`--token <value>\`.

## Options

    --config <file>    config file (default: freeshow-server.json beside this script)
    --data <dir>       data folder (default: ~/.freeshow)
    --port <n>         listen port (default: 5540)
    --host <addr>      bind address (default: 0.0.0.0, all interfaces)
    --token <value>    fixed auth token
    --no-auth          disable auth entirely - anyone who can reach the port has
                       full read/write access to the show library

Settings resolve CLI flag -> environment variable -> config file -> default.

## Video thumbnails

Optional. Install \`ffmpeg\` and it is picked up from PATH automatically; without
it, video thumbnails fall back to streaming the original file.
${platform === "macos" ? MACOS_README : ""}`
}

const SYSTEMD_UNIT = `[Unit]
Description=FreeShow headless server
After=network.target

[Service]
Type=simple
User=freeshow
Group=freeshow
ExecStart=/opt/freeshow-server/freeshow-server --config /etc/freeshow-server/config.json
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/freeshow-server

[Install]
WantedBy=multi-user.target
`

const POSTINST = `#!/bin/sh
set -e

CONF=/etc/freeshow-server/config.json

if ! getent group freeshow >/dev/null; then
    addgroup --system freeshow
fi
if ! getent passwd freeshow >/dev/null; then
    adduser --system --ingroup freeshow --home /var/lib/freeshow-server \\
            --no-create-home --disabled-login --gecos "FreeShow server" freeshow
fi

mkdir -p /var/lib/freeshow-server
chown -R freeshow:freeshow /var/lib/freeshow-server

# Generate a token on FIRST install only, so it survives restarts and upgrades.
# The server would otherwise generate an ephemeral one on every boot, which nobody
# can read out of a systemd journal conveniently.
if grep -q '"token"[[:space:]]*:[[:space:]]*""' "$CONF" 2>/dev/null; then
    TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n')
    sed -i "s|\\"token\\"[[:space:]]*:[[:space:]]*\\"\\"|\\"token\\": \\"$TOKEN\\"|" "$CONF"
    echo "FreeShow server auth token: $TOKEN"
    echo "  (stored in $CONF)"
fi
chmod 640 "$CONF" || true
chown root:freeshow "$CONF" || true

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    systemctl enable freeshow-server.service || true
    systemctl restart freeshow-server.service || true
fi

exit 0
`

const PRERM = `#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then
    systemctl stop freeshow-server.service || true
    systemctl disable freeshow-server.service || true
fi
exit 0
`

const POSTRM = `#!/bin/sh
set -e
if [ "$1" = "purge" ]; then
    if getent passwd freeshow >/dev/null; then deluser --system freeshow || true; fi
    if getent group freeshow >/dev/null; then delgroup --system freeshow || true; fi
    # deliberately NOT removing /var/lib/freeshow-server - it holds the show library
    echo "FreeShow server data kept at /var/lib/freeshow-server"
fi
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
exit 0
`

async function buildDeb({ stageDir, version, arch }) {
    if (process.platform !== "linux") {
        console.info("\n[packageServer] skipping .deb (dpkg-deb only runs on Linux; use --no-deb to silence)")
        return
    }
    if (spawnSync("dpkg-deb", ["--version"], { stdio: "ignore" }).status !== 0) {
        console.warn("\n[packageServer] skipping .deb - dpkg-deb not found")
        return
    }

    const debVersion = toDebianVersion(version)
    const debArch = DEB_ARCH[arch]
    step(`building .deb (${debVersion} ${debArch})`)

    const root = path.join(DIST, `deb-${arch}`)
    rmrf(root)

    const optDir = path.join(root, "opt", "freeshow-server")
    copyDir(stageDir, optDir)
    fs.chmodSync(path.join(optDir, "freeshow-server"), 0o755)
    fs.chmodSync(path.join(optDir, "bin", "node"), 0o755)
    // the package keeps its config in /etc; drop the tarball's copy so there's one source of truth
    fs.rmSync(path.join(optDir, "freeshow-server.json"), { force: true })

    fs.mkdirSync(path.join(root, "usr", "bin"), { recursive: true })
    fs.symlinkSync("/opt/freeshow-server/freeshow-server", path.join(root, "usr", "bin", "freeshow-server"))

    fs.mkdirSync(path.join(root, "lib", "systemd", "system"), { recursive: true })
    fs.writeFileSync(path.join(root, "lib", "systemd", "system", "freeshow-server.service"), SYSTEMD_UNIT)

    fs.mkdirSync(path.join(root, "etc", "freeshow-server"), { recursive: true })
    fs.writeFileSync(path.join(root, "etc", "freeshow-server", "config.json"), JSON.stringify({ ...defaultConfig(), data: "/var/lib/freeshow-server" }, null, 4) + "\n")

    const debian = path.join(root, "DEBIAN")
    fs.mkdirSync(debian, { recursive: true })
    fs.writeFileSync(
        path.join(debian, "control"),
        [
            "Package: freeshow-server",
            `Version: ${debVersion}`,
            `Architecture: ${debArch}`,
            "Maintainer: ChurchApps <support@livecs.org>",
            "Section: sound",
            "Priority: optional",
            "Depends: libc6",
            // ffmpeg only powers video thumbnails and degrades gracefully, so it is a
            // Recommends (installed by default, but skippable on constrained hosts)
            "Recommends: ffmpeg",
            "Homepage: https://freeshow.app",
            "Description: FreeShow headless server",
            " Serves the FreeShow web app and syncs the show library for browser and",
            " remote desktop clients, with real-time co-editing.",
            ""
        ].join("\n")
    )
    fs.writeFileSync(path.join(debian, "conffiles"), "/etc/freeshow-server/config.json\n")

    for (const [scriptName, body] of [
        ["postinst", POSTINST],
        ["prerm", PRERM],
        ["postrm", POSTRM]
    ]) {
        const target = path.join(debian, scriptName)
        fs.writeFileSync(target, body)
        fs.chmodSync(target, 0o755)
    }

    const debName = `freeshow-server_${debVersion}_${debArch}.deb`
    run("dpkg-deb", ["--root-owner-group", "--build", path.basename(root), debName], DIST)
    rmrf(root)

    const debPath = path.join(DIST, debName)
    console.info(`  ${path.relative(ROOT, debPath)} (${(fs.statSync(debPath).size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch((err) => fail(err.stack || err.message))
