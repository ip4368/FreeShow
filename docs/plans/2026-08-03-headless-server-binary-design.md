# Headless server binary — build & release design

**Date:** 2026-08-03
**Branch:** `feat/webapp-server-coediting` (merge-base with `main`: `939e7dc1`)
**Status:** IMPLEMENTED (2026-08-03). See "Implementation" near the end for what
shipped, what is verified, and the one thing still untested.

> The core mechanism was validated end to end on 2026-08-03 by building a real
> staged tree in `/tmp` — see "Validation results" at the end. The approach works;
> the review found six defects in the *details*, corrected inline below:
> the Debian version-sort bug, the missing `app/package.json` (else the server
> reports `0.0.0`), `esbuild` being only a transitive dependency, `Depends:` vs
> `Recommends:` for ffmpeg, desktop junk in the staged `public/`, and the
> `"token": false` type smell. Plus one overstated risk, corrected in §3.
>
> Two review findings were subsequently overruled by the user (2026-08-03), both
> reasonably: a rotating generated token is acceptable given the config file and
> `--token` exist, and the web-token work need only land *before* the auth
> default rather than in the same commit.

## Goal

Ship the FreeShow headless web server as a releasable Linux artifact, the way the
desktop app is already released. Today the server only exists as a dev command
(`npm run dev:server`) that builds into `build/` and runs from the repo root.

## Decisions

| Question | Decision |
| --- | --- |
| Artifact form | Self-contained `.tar.gz` (+ `.deb` on Linux), each with a bundled Node runtime |
| Targets | `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64` |
| ffmpeg | System ffmpeg; declared as a `.deb` dependency, optional for the tarball |
| Release trigger | New `publish_linux_server` job in the existing `release.yml` |
| Config file | JSON, no new runtime dependency |
| Auth default | Auto-generate a token and print it; `--no-auth` opts out |
| Bind address | New `host` option, default stays `0.0.0.0` |

### What counts as "upstream"

The constraint is minimal deviation from upstream. Almost everything under
`src/server/headless/**`, `src/shared/**`, `src/frontend/IPC/transport/**` and
`config/typescript/tsconfig.headless.json` was *added* by this branch, so editing
those is not deviation. The only genuinely upstream-touching changes are:

- `.github/workflows/release.yml` — one appended job
- `package.json` — three added scripts (already modified on this branch)

## Dependency surface

Every import across `src/server/headless` and `src/shared` resolves to one of:
`express`, `socket.io`, `sharp`, `yjs`, or a Node builtin. Only `sharp` is native.
That is what makes a bundle-plus-one-external approach viable.

ffmpeg is invoked as an external binary via `src/shared/media/ffmpeg.ts`, which
already prefers a `PATH` lookup and returns `null` when absent — video thumbnails
then fall back to streaming the original file. No bundling required.

## 1. Artifact layout

```
FreeShow-Server-<version>-linux-<arch>/
├── freeshow-server              # launcher shell script
├── bin/node                     # official Node 22 LTS runtime for the arch
├── app/
│   ├── server.js                # esbuild bundle (express + socket.io + yjs inlined)
│   └── node_modules/sharp/      # + @img/sharp-linux-<arch>, @img/sharp-libvips-linux-<arch>
├── web/                         # from build/web   (~5.8 MB)
├── public/                      # from public/     (~11 MB, incl. generated public/build)
├── freeshow-server.json         # example config, commented in the README
├── LICENSE
└── README.md
```

`public/` must ship: `src/frontend/utils/language.ts:18` fetches `./lang/en.json`
at runtime, and `./assets/*` is referenced from roughly eight places (pdf worker,
weather icons, slide effects, metronome).

**Correction from implementation.** An earlier draft of this document claimed
`public/build/` holds the remote/stage/controller/cam clients and that packaging
must run `build:servers:prod` to produce it. Both claims were wrong:

- `public/build/` is the **desktop** frontend bundle (`vite.config.mjs:35`,
  `outDir: "public/build"` in production). The headless server serves `build/web`
  instead, so shipping it would add ~5 MB of dead weight. It is excluded.
- The remote/stage/controller/cam clients build to `build/electron/<id>`
  (`vite.config.servers.mjs:150`), and `httpRoutes.ts` has **no routes for them**
  at all. They are irrelevant to this artifact.

So the packaged `public/` is everything except `build/` and the Electron
packaging leftovers, and `build:servers:prod` is not part of the pipeline.

### Relocatability

The artifact must work from wherever it is extracted, so **no absolute build-machine
paths may be baked into the shipped config**. `webDir`/`publicDir` ship empty and
`index.ts` resolves them relative to `app/server.js` (`../web`, `../public`) when
unset, falling through to the existing cwd default in the repo dev flow.

The launcher therefore only has to find the config and exec the bundled runtime. It
resolves its own symlink by hand rather than with `readlink -f`, which is GNU-only:

```sh
SELF="$0"; while [ -L "$SELF" ]; do ...; done
DIR=$(cd "$(dirname "$SELF")" && pwd)
# only when the user hasn't chosen one, and only if it still exists
[ -z "$FREESHOW_CONFIG" ] && [ -f "$DIR/freeshow-server.json" ] && export FREESHOW_CONFIG=...
exec "$DIR/bin/node" "$DIR/app/server.js" "$@"
```

An explicit `--config` or a pre-set `$FREESHOW_CONFIG` still wins, and a deleted
config file is not an error.

## 2. Config file

New `src/server/headless/config.ts` (~40 lines, `JSON.parse` only, no new
dependency). Precedence: **CLI flag → env var → config file → built-in default**.

```json
{
  "port": 5540,
  "host": "0.0.0.0",
  "data": "/var/lib/freeshow-server",
  "token": "8f3a1c9e2b7d4056",
  "allowOpen": false,
  "webDir": null,
  "publicDir": null,
  "ffmpeg": null
}
```

Discovery order when `--config <path>` is not passed. First hit wins; a missing
file is not an error:

1. `$FREESHOW_CONFIG`
2. `./freeshow-server.json`
3. `/etc/freeshow-server/config.json`
4. `~/.config/freeshow-server/config.json`

Every key maps to an environment variable the code already reads
(`FREESHOW_PORT`, `FREESHOW_DATA`, `FREESHOW_TOKEN`, `FREESHOW_WEB_DIR`,
`FREESHOW_PUBLIC_DIR`, `FREESHOW_FFMPEG`), so nothing existing breaks.

`webDir`/`publicDir` live in the schema so the packaged layout is self-describing
and the launcher doesn't have to export environment variables.

## 3. Auth changes

Currently `auth.ts:23` and `auth.ts:31` both `return next()` when no token is
configured — no token means fully open. Combined with `cors: { origin: "*" }`
(`index.ts:59`), a `.deb` that enables a boot-time service would ship an
unauthenticated endpoint over the whole show library.

To be precise about the blast radius: the media gateway is **not** an arbitrary
filesystem read. `resolveInSandbox` (`data/dataPaths.ts:59`) confines every path
to the data root, and a `../../etc/passwd` probe returns 403 (verified). The
exposure is the show library and its media, which still warrants auth, but it is
narrower than "the filesystem".

New behaviour in `index.ts`:

- No token configured anywhere → generate one (`crypto.randomBytes`), print it
  with the connect URL, and continue.
- `--no-auth`, or `"allowOpen": true` in the config → today's open behaviour, with
  a loud warning.
- Token configured → unchanged.

**The generated token is deliberately ephemeral** (decided 2026-08-03). It rotates
on restart, which is accepted: anyone who needs a stable token sets one in the
config file or passes `--token`, and the `.deb`'s `postinst` pins one anyway. The
generated token is a safe default for casual/first-run use, not a managed
credential.

**Opting out is a separate boolean, not `"token": false`.** Overloading a
string-typed field with `false` is a type smell that every config parser and
editor will fight. Use a distinct `"allowOpen": true`.

```
$ freeshow-server
FreeShow headless server on http://localhost:5540
Auth: generated token (set "token" in config to pin it)

  http://localhost:5540/?token=8f3a1c9e2b7d4056
```

`server.listen(port)` (`index.ts:65`) gains the `host` argument, defaulting to
`0.0.0.0` so LAN access — the point of the feature — still works out of the box.

### Prerequisite: wire the token through the web client

Verified during design. On the web path, `installTransport()`
(`src/frontend/IPC/transport/index.ts:68`) calls `createSocketApi({ onStatus })`
with **no `auth` argument**, and `getRemoteServerConfig()` returns `null` for the
web build by design, so `mediaGateway.ts:35,51,62` also emit token-less
`/media` and `/thumbnail` URLs.

This is unwired plumbing, not a missing capability: `createSocketApi` already
accepts `auth`, and `mediaGateway` already reads `config?.token` — the
desktop-remote path uses both. The web branch just never populates them, because
the web build was written against an open server.

**The browser therefore only works against a token-less server today.** Ordering
matters, but the two changes need not be one commit:

| Landing | Effect |
| --- | --- |
| Web-token change alone | Safe. Server is still open by default so nothing breaks, and a manually-set token now works in the browser. Strict improvement. |
| Auto-generated token alone | **Breaks the browser** — it cannot authenticate. |

So the web-token work must land **before or with** the auth default. Both files
are branch-added, so this is not upstream deviation:

1. On web boot, read `token` from `location.search`.
2. Persist it in `sessionStorage`, then strip it from the URL with
   `history.replaceState` so it isn't leaked via bookmarks, referrers, or logs.
3. Feed it to both the socket handshake `auth` and the gateway URL builders via a
   shared `getWebToken()` helper.

Roughly 20 lines across `transport/index.ts` and `utils/mediaGateway.ts`.

### Login prompt (added 2026-08-03)

Reading `?token=` is not sufficient on its own. Someone who opens the bare origin —
no query string, nothing in storage — is rejected at the handshake, and **Socket.IO
does not retry after a middleware rejection**, so the app waits forever for a STARTUP
that never arrives. The visible result is a permanent splash screen with no
explanation.

`src/frontend/utils/webLogin.ts` renders a token prompt instead. Three design notes:

- **Plain DOM, not a Svelte component.** It has to work before and independently of
  the app mounting, including when the app is wedged mid-startup. It styles itself
  from the existing CSS custom properties, so it matches the theme.
- **Not translated.** The dictionary (`public/lang/*.json`) is fetched over the very
  connection being authenticated, so at prompt time there is nothing to translate
  with.
- **Verify, then reload.** Submitting opens a throwaway socket with the candidate
  token, so validation goes through the same `socketAuth` middleware the app will.
  Only a verified token is stored, then `location.reload()` gives a clean startup —
  the same approach `ServerConnection.svelte` already uses on the desktop.

Triggered by a new `onUnauthorized` callback on `createSocketApi`, which fires on
`connect_error` with the message `"unauthorized"` (what `auth.ts` passes to `next()`),
at most once per transport. Ordinary network failures are left to Socket.IO's own
retry.

A stale token — the common case, since the generated token rotates on restart — is
cleared and reported distinctly ("The saved access token was rejected.") so it doesn't
look like a first-time login.

One gotcha worth recording: `public/global.css` sets `p { white-space: nowrap;
text-overflow: ellipsis }`, which silently truncated the instructions to "It is
printed in…". The overlay overrides it, and the e2e test asserts the full sentence.

## 4. Build pipeline

A single new `scripts/packageServer.js`, driven by `--arch`:

| # | Step | Detail |
| --- | --- | --- |
| 1 | `build:web` | existing script → `build/web` |
| 2 | `build:headless` | existing script → `build/headless` |
| 3 | esbuild | → `dist/server/.../app/server.js`, `--bundle --platform=node --target=node22 --format=cjs --external:sharp` |
| 4 | `app/package.json` | written with the real version (see below) |
| 5 | sharp | `npm install --prefix <stage>/app --os=linux --cpu=<arch> --libc=glibc --no-save sharp@<locked>` |
| 6 | Node runtime | download `node-v22.21.1-linux-<arch>.tar.xz` (pinned constant), verify against `SHASUMS256.txt`, extract `bin/node` only |
| 7 | stage | copy `build/web` → `web/`, `public/` → `public/` minus the excluded files, config, LICENSE, README, launcher |
| 8 | archive | `tar czf FreeShow-Server-<version>-linux-<arch>.tar.gz` |

**`esbuild` must become an explicit devDependency.** It is currently only present
transitively (`vite@4.5.14 → esbuild@0.18.20`). Depending on a transitive package
for a release-critical step means a routine `vite` bump can silently change or
remove the bundler. Add it to `devDependencies` and pin it.

**Exclude desktop-only files from the staged `public/`.** The directory carries
`preload.ts`, `preload.js.map`, `icon.icns`, `icon.ico`, `dmg.png` and
`identify.html` — Electron packaging artifacts, including TypeScript source and a
source map, with no purpose on a web-facing static route. Copy `public/` with a
denylist for those.

**Pin the Node version as one constant** in the script rather than resolving the
latest 22.x at build time, so a rebuild of an old tag reproduces the old artifact.
`package.json` requires `>=22.12.0`; both `linux-x64` and `linux-arm64` tarballs
for 22.21.1 were confirmed available.

**Packaging must write `app/package.json`, or the server reports `0.0.0`.**
`getAppVersion()` (`platform/headlessPlatform.ts:31-45`) walks up from `__dirname`
looking for a `package.json` with a `version` field. In the repo that reaches the
root; from `/opt/freeshow-server/app/server.js` it walks `app` →
`/opt/freeshow-server` → `/opt` → `/` and finds nothing, so `Main.VERSION` would
lie to every connected client. The fix is simply to pack one:

```json
{ "name": "freeshow-server", "version": "<from package.json>", "private": true }
```

Two things the experiment pinned down:

- **`npm install --prefix` does not create a `package.json`** — verified. So this
  file has to be written deliberately; it does not appear as a side effect.
- **It must carry a `version` field.** The walk-up skips a `package.json` whose
  `version` is missing and keeps climbing, so a stub without one still yields
  `0.0.0`.

Verified all three cases: no file → `0.0.0`; `{"version":"1.6.5-beta.1"}` →
`1.6.5-beta.1`; version-less file → `0.0.0`.

Copying the repo's own `package.json` would also work but drags ~8 KB of Electron
dependency metadata into the artifact. Setting `FREESHOW_VERSION` in the launcher
is a third option, but the file is more robust because it survives someone
invoking `bin/node app/server.js` directly.

The version comes from `package.json`, so the server tracks the app version and
lands in the same GitHub Release as the desktop builds.

Step 5 is cross-install-safe — npm's `--os`/`--cpu` flags let an x64 runner
produce arm64 output — but since `release.yml` already has a native
`ubuntu-24.04-arm` runner, each arch is built natively and the flags act only as
a guardrail.

Step 6 dominates artifact size: `bin/node` is ~110 MB uncompressed, ~40 MB
compressed. Expect a `.tar.gz` around 60 MB.

New scripts in `package.json`, additive only:

```json
"package:server": "node scripts/packageServer.js",
"package:server:linux-x64": "node scripts/packageServer.js --arch x64",
"package:server:linux-arm64": "node scripts/packageServer.js --arch arm64"
```

### Fix: test files are being emitted into the build

`config/typescript/tsconfig.headless.json` sets `exclude: ["node_modules",
"**/*.test.ts"]`, but TypeScript resolves `exclude` relative to the tsconfig's own
directory (`config/typescript/`), so the pattern never matches
`src/server/headless/*.test.ts`. `mediaRoutes.test.js` and
`thumbnailRoutes.test.js` are currently emitted into `build/headless`. Fix the
pattern to `../../src/**/*.test.ts`. This is a branch-added file, so it is a
straightforward one-line fix rather than a packaging-time filter.

Scope correction from review: this does **not** contaminate the artifact. esbuild
walks the import graph from the entrypoint, and nothing imports the test files —
the bundle was confirmed to contain zero `vitest`/`describe(` references. So it is
a build-hygiene fix, not a packaging blocker.

## 5. `.deb` and systemd

Built with `dpkg-deb --build` rather than `fpm` — `dpkg-deb` is preinstalled on
both GitHub runners, so unlike the desktop arm64 job there is no
`ruby` / `gem install fpm` step.

```
/opt/freeshow-server/            # the tarball tree, verbatim
/usr/bin/freeshow-server         # symlink to /opt/freeshow-server/freeshow-server
/lib/systemd/system/freeshow-server.service
/etc/freeshow-server/config.json # dpkg conffile
```

Registering the config as a dpkg **conffile** means dpkg handles upgrade merges
and never clobbers an admin's edits.

### Two packaging defects found in review

**`Recommends: ffmpeg`, not `Depends:`.** ffmpeg pulls a large dependency tree for
a feature that is genuinely optional — `getFfmpegPath()` already degrades to
streaming the original file. apt installs `Recommends` by default, so the
out-of-the-box experience is unchanged, but users on constrained hosts (a Pi with
a small SD card) can opt out with `--no-install-recommends`. `Depends: libc6`
stays.

**The version string must be translated for Debian.** `package.json` is currently
`1.6.5-beta.1`. Debian treats the last `-` as the upstream/revision separator, so
`1.6.5-beta.1` parses as upstream `1.6.5`, revision `beta.1` — which dpkg sorts as
**newer** than the eventual `1.6.5` final release, so the beta would block the
upgrade. Map `-` to `~` (which sorts before everything) when generating the
control file:

| `package.json` | Debian version | sorts before `1.6.5`? |
| --- | --- | --- |
| `1.6.5-beta.1` | `1.6.5~beta.1` | yes — correct |
| `1.6.5-beta.1` | `1.6.5-beta.1` | no — **bug** |
| `1.6.5` | `1.6.5` | n/a |

The `.tar.gz` filename can keep the raw version; only the Debian control field
needs the mapping.

The unit runs as a system user `freeshow` created in `postinst`, with
`data` set to `/var/lib/freeshow-server` and standard hardening
(`NoNewPrivileges`, `ProtectSystem=strict`,
`ReadWritePaths=/var/lib/freeshow-server`). `postinst` generates a token into the
conffile on first install only, so it survives restarts rather than changing on
every boot; upgrades never overwrite an existing value. `postrm` on purge removes
the user and leaves the data directory.

## 6. CI

A `publish_linux_server` job appended to `.github/workflows/release.yml`:

```yaml
strategy:
  matrix:
    include:
      - { runner: ubuntu-latest,    arch: x64 }
      - { runner: ubuntu-24.04-arm, arch: arm64 }
```

Steps: checkout → setup-node 22 → `npm ci` → `npm run package:server:linux-<arch>`
→ upload `.tar.gz` and `.deb` to the same GitHub Release as the desktop artifacts.

No `libfontconfig1-dev` / `uuid-dev` / `libltc-dev` needed — those are Electron
and desktop-native-module dependencies, irrelevant to the headless server.

## 7. Testing

- Unit: `config.ts` precedence (CLI > env > file > default), discovery order,
  malformed-JSON handling, and the generate-vs-`--no-auth` branch in `index.ts`.
- Packaging smoke test in CI: extract the tarball into a scratch dir, start the
  server on a random port, assert `/health` returns `{ok:true}`, assert
  `/capabilities` returns the headless set, assert `/` serves the web
  `index.html`, and assert a `/thumbnail` request succeeds (proves the relocated
  `sharp` actually loads).
- Run the smoke test from a directory that is *not* the install root, to catch
  regressions in path resolution.
- `.deb` install test: `apt install ./FreeShow-Server-*.deb` in a container,
  confirm the unit starts, a token was generated, and `/health` answers.

## Validation results (2026-08-03)

A staged tree was built by hand in `/tmp` on macOS/arm64 and exercised. Every load-
bearing assumption in this design was checked against a running server rather than
reasoned about:

| Assumption | Result |
| --- | --- |
| esbuild can bundle the server | 2.5 MB single file, **zero warnings**, no dynamic-require complaints |
| Bundle excludes test code | 0 matches for `vitest` / `describe(` |
| `sharp` works relocated + `--external` | `/thumbnail?path=…&size=256` → 200, `image/webp`, verified real WebP by magic bytes |
| `sharp` installs standalone | 28 MB, 9 packages — pulls `detect-libc`, `semver`, `tslib`, `@emnapi`, so **copying `node_modules/sharp` alone would break**; `npm install --prefix` is required |
| Cross-arch `sharp` from a foreign host | `--os=linux --cpu=arm64 --libc=glibc` on macOS correctly fetched `sharp-linux-arm64` + `sharp-libvips-linux-arm64` |
| Node tarballs exist for both arches | `node-v22.21.1-linux-{x64,arm64}.tar.xz` and `SHASUMS256.txt` all HTTP 200 |
| Server runs from a foreign cwd | launched from `/tmp` via the launcher script — OK |
| Static serving | `/` → 200 (built `index.html`), `/lang/en.json` → 200 (public gap-fill) |
| JSON endpoints | `/health` → `{"ok":true}`, `/capabilities` → headless capability set |
| Socket.IO through the bundle | websocket transport connected, session id issued |
| Sandbox holds | `/media?path=../../etc/passwd` → 403 |
| `npm install --prefix` writes a `package.json` | **No** — so packaging must write `app/package.json` itself |
| Version walk-up needs a `version` field | Yes — a version-less `package.json` is skipped and still yields `0.0.0` |

The pieces *not* yet validated, and the highest-risk remaining unknowns:

1. The `.deb` install/upgrade cycle, systemd unit, and conffile handling — none of
   this was exercised; it needs a container test.
2. `bin/node` extraction and execution on a real Linux host (validated only that
   the tarballs exist and that the bundle runs under macOS Node 22).
3. The web-client token work described in §3, which is the one genuine blocker.

## Implementation (2026-08-03)

### Files

| File | Change |
| --- | --- |
| `scripts/packageServer.js` | new — tarball + `.deb` packaging |
| `scripts/smokeTestServer.js` | new — 11 checks against the extracted artifact |
| `src/server/headless/config.ts` | new — CLI/env/file/default resolution |
| `src/server/headless/config.test.ts` | new — 19 unit tests |
| `src/server/headless/index.ts` | config wiring, host binding, token generation, relocatable asset paths |
| `src/frontend/IPC/transport/index.ts` | `getWebToken()` / `getConnectionToken()`, web branch sends auth |
| `src/frontend/utils/mediaGateway.ts` | gateway URLs carry the token on the web build |
| `src/frontend/utils/webLogin.ts` | new — token prompt for the web build |
| `src/frontend/IPC/transport/socketTransport.ts` | `onUnauthorized` callback |
| `config/testing/webLogin.test.ts` | new — 6 Playwright e2e tests for the login flow |
| `config/typescript/tsconfig.headless.json` | fixed the `exclude` pattern |
| `config/testing/webCapabilities.test.ts` | sets `FREESHOW_ALLOW_OPEN` (it tests gating, not auth) |
| `package.json` | `esbuild` devDependency + 6 scripts |
| `.github/workflows/release.yml` | `publish_server` job (linux + macos, x64 + arm64) |

### Verified

Built `FreeShow-Server-1.6.5-beta.1-linux-x64.tar.gz` (**58.0 MB**, close to the
60 MB estimate) and confirmed `bin/node` is a `linux x86-64 ELF`. Then, by
substituting a host-runnable Node so the tree could execute on macOS:

- Extracted to an unrelated directory and launched with a different cwd — config
  auto-discovered from the install dir, `web/` and `public/` resolved relative to
  the bundle. Relocation works.
- `/health`, `/capabilities`, `/`, `/lang/en.json`, `/assets/pdf.worker.min.mjs`
  all 200.
- Auth enforced on HTTP (401 without/with a wrong token) **and** on the Socket.IO
  handshake (`unauthorized`); correct token connects.
- `VERSION` over the socket returned `1.6.5-beta.1` — the `app/package.json` fix
  confirmed in the packaged layout, where it would otherwise have been `0.0.0`.
- `/thumbnail` returned a real WebP, proving the relocated native `sharp` loads.
- `--no-auth`, a pinned config-file token, and `host: 127.0.0.1` all behave
  (verified the listener with `lsof`: `TCP 127.0.0.1:5602 (LISTEN)`).
- 115 unit tests pass; clean `build:headless` emits 0 test files; no new
  prettier or svelte-check findings.

### macOS, fully verified natively

Unlike Linux, macOS could be tested for real on the development machine:

| Artifact | Size | Smoke test |
| --- | --- | --- |
| `macos-arm64.tar.gz` | 51.4 MB | **11/11 natively** (real bundled Node, real sharp) |
| `macos-x64.tar.gz` | 53.3 MB | **11/11 under Rosetta** |
| `linux-x64.tar.gz` | 58.0 MB | not runnable here |

Also verified on macOS: the launchd plist passes `plutil -lint`, and the quarantine
scenarios described above.

The x64 result comes from Rosetta on Apple silicon, not native Intel hardware. CI
runs it on a real `macos-26` Intel runner.

### NOT verified

**Nothing has run on real Linux, and the `.deb` has never been built.** No Docker
was available in the development environment. Specifically untested: `dpkg-deb`
packaging, the systemd unit, conffile upgrade behaviour, the `postinst` token
generation, and the bundled Linux `bin/node` actually executing. `smokeTestServer.js`
covers all of this the moment CI runs, and it fails loudly rather than silently —
confirmed by running it against the real Linux tarball on macOS, where it reported
`cannot execute binary file` and exited non-zero.

The `.deb` is the part most likely to need a second pass. Everything shared between
Linux and macOS (bundling, relocation, config, auth, sharp, version) is now proven on
macOS, which substantially narrows what Linux CI still has to prove.

## macOS support (added 2026-08-03)

Genuinely straightforward — the pipeline is platform-parameterised
(`--platform linux|macos`), and only four things differ:

| | linux | macos |
| --- | --- | --- |
| Node archive | `node-v22.21.1-linux-<arch>.tar.xz` | `...-darwin-<arch>.tar.gz` |
| extract flag | `-xJf` | `-xzf` |
| `npm install` | `--os=linux --cpu=<arch> --libc=glibc` | `--os=darwin --cpu=<arch>` (no `--libc`) |
| package format | `.tar.gz` + `.deb` | `.tar.gz` + a sample launchd plist |

`macos` is the user-facing label; `darwin` is what nodejs.org and `npm --os` want.
The launcher, config resolution, relocatable asset paths and auth are all shared —
no platform branches in the server itself.

Two macOS extras: a sample `app.freeshow.server.plist` LaunchAgent (paths are
placeholders, since the tarball can be extracted anywhere; validated with
`plutil -lint`), and a `verifyMacSignatures()` packaging step.

### Gatekeeper: investigated, and less of a problem than expected

The initial worry was that an unsigned, un-notarized archive would be blocked. Tested
directly by stamping `com.apple.quarantine` the way Safari does:

- Command-line `tar` does **not** propagate quarantine to extracted files. Finder's
  Archive Utility does, so both paths were tested.
- With `bin/node` **and** the sharp dylibs quarantined, the server still started and
  `/thumbnail` still returned a real WebP — on both arches. Terminal-launched
  processes don't get the Gatekeeper prompt that Finder launches do.

So the README does **not** tell users to run `xattr -dr` as a matter of course — that
advice would weaken security for no benefit. It's documented only as a fallback.

`verifyMacSignatures()` did surface a real asymmetry worth knowing:

| binary | arm64 | x64 |
| --- | --- | --- |
| `bin/node` | signed | signed |
| `@img/sharp-darwin-*` | signed | **unsigned** |
| `@img/sharp-libvips-darwin-*` | signed | **unsigned** |

The unsigned x64 libraries still load, including under quarantine, because x86_64
macOS has no ad-hoc-signing requirement (arm64 does). The check stays in the pipeline
so a future regression here is visible at build time rather than in a user's logs.

Codesigning and notarizing the server artifacts is deliberately **not** done. The
desktop app already has `CSC_LINK` / notarize infrastructure that could be reused if
the unsigned experience turns out to be a problem in practice.

## Follow-ups, explicitly out of scope

- Windows server artifacts
- Codesigning / notarizing the macOS artifacts (see above — not needed today)
- Docker image (worth revisiting; it is the cleanest ffmpeg/sharp story)
- `.rpm` and AppImage variants
- TLS termination — assumed to be nginx or a tunnel in front
- Tightening `cors: { origin: "*" }` to a configurable allowlist
