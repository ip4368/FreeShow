// Regression test for issue #2169 — slide text transitions must never flash to (near-)black.
// It drives real slide changes in the live output preview while injecting main-thread jank (to emulate
// the real-world long tasks that made the old setTimeout-gated swap desync into a black gap), and samples
// the effective opacity of the slide text every frame. A correct crossfade keeps some text visible the
// whole time, so the darkest frame should stay well above black.
import { _electron as electron } from "playwright"
import { expect, test } from "@playwright/test"
import tmp from "tmp"

const timeoutMs = 3_000
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.beforeEach(async ({ context }) => {
    await context.route("https://api.github.com/repos/ChurchApps/freeshow/releases", (route) => route.abort())
})

test("slide transitions never flash to black (#2169)", async () => {
    const tmpSettingFolder = tmp.dirSync({ unsafeCleanup: true })
    const electronApp = await electron.launch({
        args: [".", "--no-sandbox"],
        env: { ...process.env, NODE_ENV: "production", FS_MOCK_STORE_PATH: tmpSettingFolder.name },
    })

    const tmpDataFolder = tmp.dirSync({ unsafeCleanup: true })
    await electronApp.evaluate(async ({ dialog }, tmpDataFolderName) => {
        dialog.showOpenDialogSync = (): string[] | undefined => [tmpDataFolderName]
    }, tmpDataFolder.name)

    await electronApp.waitForEvent("window")
    await delay(5_000)

    let window = electronApp.windows().find((w) => w.url().includes("index.html"))
    for (let i = 0; i < 20 && !window; i++) {
        await delay(500)
        window = electronApp.windows().find((w) => w.url().includes("index.html"))
    }
    if (!window) window = await electronApp.firstWindow()

    try {
        await window.locator(".popup button.start, .top").first().waitFor({ timeout: 10 * timeoutMs })

        const setupStart = window.locator(".popup button.start")
        let didSetup = false
        if ((await setupStart.count()) > 0) {
            const setupPopup = window.locator(".popup")
            await setupPopup.locator(".dropdown-trigger").first().click({ timeout: 5 * timeoutMs })
            await setupPopup.locator("li[role=option]").filter({ hasText: "English" }).first().click({ timeout: timeoutMs })
            await setupPopup.locator(".button-trigger").first().click({ timeout: timeoutMs })
            await setupStart.click({ timeout: timeoutMs })
            didSetup = true
        }

        const skipGuide = window.locator("#guideButtons").getByText("Skip")
        if (didSetup) await skipGuide.waitFor({ timeout: 5 * timeoutMs }).catch(() => {})
        if ((await skipGuide.count()) > 0) await skipGuide.click({ timeout: timeoutMs })

        await window.getByText("New project").first().click({ timeout: timeoutMs })
        await window.getByText("New show").first().click({ timeout: timeoutMs })
        await window.locator("#name").fill("Flicker Test", { timeout: timeoutMs })
        await window.getByText("Quick Lyrics").click({ timeout: timeoutMs })
        const lyricsBox = window.getByPlaceholder("[Verse]")
        await lyricsBox.focus()
        await lyricsBox.fill(`[Verse]\nalpha bravo charlie\ndelta echo foxtrot\n\n[Chorus]\ngolf hotel india\njuliet kilo lima`, { timeout: timeoutMs })
        await window.getByTestId("create.show.popup.new.show").click({ timeout: timeoutMs })

        await delay(1_500)
        await window.keyboard.press("Escape")
        const firstSlide = window.locator(".slide").first()
        if ((await firstSlide.count()) > 0) await firstSlide.click({ timeout: timeoutMs }).catch(() => {})
        await delay(500)

        // inject intermittent main-thread jank + start a per-frame text-opacity sampler over the live preview
        await window.evaluate(() => {
            const w = window as any
            w.__jank = setInterval(() => {
                const t = performance.now()
                while (performance.now() - t < 45) {}
            }, 80)

            const WORDS = ["alpha", "delta", "golf", "juliet"]
            w.__vis = { frames: 0, minMax: 1 }
            const effOpacity = (el: Element, stop: Element) => {
                let o = 1
                let n: Element | null = el
                while (n && n !== stop) {
                    const s = getComputedStyle(n)
                    if (s.visibility === "hidden" || s.display === "none") return 0
                    o *= parseFloat(s.opacity || "1")
                    n = n.parentElement
                }
                return o
            }
            const preview = () => document.querySelector('.previewOutput[id="default"]') || document.querySelector(".previewOutput")
            const sample = () => {
                const c = preview()
                if (c) {
                    let maxO = 0
                    c.querySelectorAll("*").forEach((el) => {
                        if (el.children.length) return
                        const txt = (el.textContent || "").trim()
                        if (!txt || !WORDS.some((word) => txt.includes(word))) return
                        const o = effOpacity(el, c as Element)
                        if (o > maxO) maxO = o
                    })
                    w.__vis.frames++
                    if (maxO < w.__vis.minMax) w.__vis.minMax = maxO
                }
                w.__vis._raf = requestAnimationFrame(sample)
            }
            sample()
        })

        // don't count the initial appearance; measure only real slide-to-slide changes
        await delay(400)
        await window.evaluate(() => { (window as any).__vis = { ...(window as any).__vis, frames: 0, minMax: 1 } })

        // mix of realistic and rapid/overlapping advances, both directions
        for (let i = 0; i < 24; i++) {
            await window.keyboard.press(i % 5 === 4 ? "ArrowLeft" : "ArrowRight")
            await delay(i % 3 === 0 ? 300 : 900) // some faster than the transition so they overlap
        }

        await delay(500)
        const vis = await window.evaluate(() => {
            const w = window as any
            cancelAnimationFrame(w.__vis?._raf)
            clearInterval(w.__jank)
            return w.__vis
        })
        console.log("[flicker vis]", JSON.stringify(vis))

        // the sampler must have observed real transitions
        expect(vis.frames).toBeGreaterThan(100)
        // a correct crossfade keeps text visible throughout; a regression to the old gap/desync would
        // drive this toward 0 (the black flash). 0.2 is a safe floor below the ~0.4 observed under stress.
        expect(vis.minMax).toBeGreaterThan(0.2)
    } finally {
        const proc = electronApp.process()
        await Promise.race([electronApp.close(), delay(5_000)]).catch(() => {})
        try {
            if (proc?.pid && !proc.killed) proc.kill("SIGKILL")
        } catch {}
        tmpDataFolder.removeCallback()
        tmpSettingFolder.removeCallback()
    }
})
