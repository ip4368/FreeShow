<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte"
    import type { Item, OutSlide, SlideData, TimelineAction, Transition } from "../../../../types/Show"
    import { showsCache, slideTimelineSpeedMultiplier } from "../../../stores"
    import { waitUntilValueIsDefined } from "../../../utils/common"
    import { shouldItemBeShown } from "../../edit/scripts/itemHelpers"
    import { clone } from "../../helpers/array"
    import { loadCustomFonts } from "../../helpers/fonts"
    import { getStyles } from "../../helpers/style"
    import Textbox from "../../slide/Textbox.svelte"
    import { SlideTimeline } from "../../timeline/SlideTimeline"
    import SlideItemTransition from "../transitions/SlideItemTransition.svelte"
    import { easings } from "../../../utils/transitions"
    import { matchItems } from "../transitions/morph/morphMatcher"
    import { hasTransform, interpolateStyle } from "../transitions/morph/styleInterpolate"
    import { alignSignature, diffWords, extractWords } from "../transitions/morph/textDiff"
    import { measureWords, type WordBox } from "../transitions/morph/wordMeasure"
    import WordMorphLayer from "../transitions/morph/WordMorphLayer.svelte"

    export let outputId: string
    export let outSlide: OutSlide
    export let isClearing = false

    export let slideData: SlideData | null
    export let currentSlide: any // Slide | null
    export let currentStyle: any

    export let animationData: any
    export let currentLineId: string | undefined
    export let lines: any

    export let ratio: number
    export let mirror = false
    export let preview = false
    export let transition: any = {}
    export let transitionEnabled = false
    export let styleIdOverride = ""

    let origin = ""
    $: if (outSlide.id) updateShow()
    function updateShow() {
        // custom fonts
        const currentShow = $showsCache[outSlide.id]
        if (currentShow?.settings?.customFonts) loadCustomFonts(currentShow.settings.customFonts)
        origin = currentShow?.origin || ""
    }

    // TEST:
    // conditions
    // transitions
    // overlays
    // style lines
    // starting slide while clearing

    let currentItems: Item[] = []
    let current: any = {}
    let show = false

    // Track items that are unchanged between slides and have no transition (to avoid redraw flicker)
    let persistentItems: Item[] = []
    let persistentItemIndexes: number[] = []

    // Check if a transition is "meaningful" (not none and duration > 0)
    function hasRealTransition(itemTransition: Transition | undefined, globalTrans: Transition | undefined): boolean {
        // Item-level transition takes priority
        const trans = itemTransition || globalTrans
        if (!trans) return false
        // If type is "none" or duration is 0/undefined, no real transition
        if (trans.type === "none") return false
        if (!trans.duration || trans.duration === 0) return false
        return true
    }

    // Compare two items to see if their visible content is identical
    function itemsAreEqual(oldItem: Item | undefined, newItem: Item | undefined): boolean {
        if (!oldItem || !newItem) return false
        // Compare the full serialized content (lines, style, etc.)
        return JSON.stringify(oldItem) === JSON.stringify(newItem)
    }
    // maintain a hidden workload that primes autosize results ahead of the visible reveal
    let precomputeTargets: { item: Item; index: number; key: string }[] = []
    let precomputePending = new Set<string>()

    const showItemRef = { outputId, slideIndex: outSlide?.index }
    // $: videoTime = $videosTime[outputId] || 0 // WIP only update if the items text has a video dynamic value
    // $: if ($activeTimers || $variables || $playingAudio || $playingAudioPaths || videoTime) updateValues()
    let conditionsUpdater = 0
    let isMic = false
    $: isMic = JSON.stringify(currentItems.map((a) => a?.conditions) || "").includes('"element":"volume"')

    let updaterInterval: NodeJS.Timeout
    $: {
        clearInterval(updaterInterval)
        updaterInterval = setInterval(
            () => {
                if (isClearing || !Array.isArray(currentItems)) return
                if (currentItems.find((a) => a?.conditions)) conditionsUpdater++
            },
            isMic ? 100 : 300
        )
    }
    onDestroy(() => {
        clearInterval(updaterInterval)
        if (morphRaf) cancelAnimationFrame(morphRaf)
        if (morphWordSettleTimeout) clearTimeout(morphWordSettleTimeout)
    })

    // do not update if only line has changed
    $: currentOutSlide = "{}"
    $: if (outSlide) {
        let newOutSlide = clone(outSlide)
        delete newOutSlide.line
        delete newOutSlide.revealCount
        delete newOutSlide.itemClickReveal
        let outSlideString = JSON.stringify(newOutSlide)
        if (outSlideString !== currentOutSlide) currentOutSlide = outSlideString
    }
    // do not update if lines has no changes for this output
    $: currentLines = "{}"
    $: if (lines) {
        let outLinesString = JSON.stringify(lines)
        if (outLinesString !== currentLines) currentLines = outLinesString
    }
    // only update if changed (no update when another output changes)
    let currentSlideItems: Item[] | null = null
    $: if (currentSlide?.items !== 0) {
        if (JSON.stringify(currentSlide?.items) !== JSON.stringify(currentSlideItems)) currentSlideItems = clone(currentSlide?.items || null)
    }
    $: if (current && outSlide) {
        if (current.outSlide) {
            current.outSlide.itemClickReveal = outSlide.itemClickReveal
            current.outSlide.revealCount = outSlide.revealCount
            current.outSlide.line = outSlide.line
        }
    }
    $: if (current && lines) {
        current.lines = clone(lines)
    }

    $: if (currentSlideItems !== undefined || currentOutSlide || currentLines) updateItems()
    let timeout: NodeJS.Timeout | null = null
    let updateGeneration = 0

    // if anything is outputted & changing to something that's outputted
    let transitioningBetween = false

    // lightweight guard so we only precompute for text items that actually rely on autosize
    function shouldPrecomputeAutoSize(item: Item) {
        if (!item) return false
        const type = item.type || "text"
        if (type !== "text") return false
        return !!item.auto
    }

    // kick off hidden textbox renders that warm the autosize cache before we flip "show" on
    function scheduleAutoSizePrecompute(items: Item[]) {
        if (preview || !Array.isArray(items) || !items.length) {
            precomputeTargets = []
            precomputePending.clear()
            return
        }

        const targets: { item: Item; index: number; key: string }[] = []
        const pendingKeys = new Set<string>()

        items.forEach((item, index) => {
            if (!shouldPrecomputeAutoSize(item)) return
            const key = createAutoSizeKey(item, index)
            if (!key) return
            if (item.autoFontSize) return // skip entries that already have cached measurements
            pendingKeys.add(key)
            targets.push({ item: clone(item), index, key })
        })

        precomputeTargets = targets
        precomputePending = pendingKeys
    }

    // remove hidden probes once the underlying textbox reports that its autosize cache is hot
    function handlePrecomputeReady(event: CustomEvent<{ key: string; fontSize: number }>) {
        const key = event.detail?.key
        if (!key) return
        if (!precomputePending.has(key)) return
        precomputePending.delete(key)
        if (!precomputePending.size) precomputeTargets = []
    }

    // MORPH TRANSITION: every matched object interpolates its box style (left/top/width/height/rotation)
    // from the previous slide (A) to the new slide (B) each frame — media re-fits (object-fit) instead of
    // stretching, and autosize text also interpolates its measured fitted font (A cache → B measured).
    // Unmatched objects fade. No CSS transform (which distorted non-proportional media/text).
    let morphActive = false
    let morphStyleA: Record<number, string> = {} // matched B index → A's box style
    let morphStyleB: Record<number, string> = {} // matched B index → B's box style
    let morphItemStyle: Record<number, string> = {} // matched B index → current interpolated box style (rAF)
    let morphIsText: Record<number, boolean> = {} // matched B index → true if text (gets font-size interpolation)
    let morphTextFont: Record<number, number> = {} // matched text B index → current interpolated font px (rAF)
    let morphFontA: Record<number, number> = {} // A's displayed font px
    let morphFontB: Record<number, number> = {} // B's displayed font px
    let flipEnteringIndexes: number[] = [] // B-only items → fade in
    let flipExitingItems: Item[] = [] // A-only items (from A) → fade out
    let morphGo = false // false = opacity 0/1 start state; true = animate opacity (for enter/exit fade)
    let morphOpacityTransition = "opacity 500ms ease-in-out"
    let morphGen = 0
    let morphTargetKey = "" // slide currently being morphed to (guards redundant updateItems calls)
    let morphExitTimeout: NodeJS.Timeout | null = null
    let morphRaf: number | null = null // drives per-frame box (+ font) interpolation

    // EXITING-MEDIA PRE-ROLL: when a matched->unmatched morph removes a media item, mount the exiting
    // copy while the previous slide (A) is still on screen and wait for it to paint, THEN swap to B.
    // The exiting copy keeps the same keys across the swap, so Svelte REUSES the element (no fresh <img>
    // blank). Scoped to exiting media only → matched media (image->image) is never delayed or remounted.
    let morphExitPreroll = false
    let morphExitRevealed = false // once the exit copies are loaded, a class force-shows them (see CSS)
    let exitLayerEl: HTMLElement | null = null
    let morphExitCtx: any = {} // stable context for rendering exiting (A-only) items across the swap
    let morphStartGen = 0 // guards against a slide change landing mid pre-roll

    // wait until every <img> in the exiting layer has painted (or a hard timeout), so the swap to B
    // reuses already-loaded copies instead of remounting a blank one
    // Resolve once every <img> in the exiting layer has actually loaded (or a hard timeout). We check the
    // DOM `complete`/`naturalWidth` here rather than <Image>'s internal `loaded` flag, because that flag is
    // unreliable for cached images (the load event can fire before the listener attaches). Once loaded, the
    // caller force-reveals the imgs (see startMorph) since <Image> would otherwise keep them at opacity:0.
    function waitForExitImages(container: HTMLElement | null, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            let done = false
            const finish = () => {
                if (done) return
                done = true
                resolve()
            }
            const check = () => {
                if (done) return
                if (!container) return finish()
                const imgs = Array.from(container.querySelectorAll("img"))
                if (imgs.length && imgs.every((im) => im.complete && im.naturalWidth > 0)) return finish()
                requestAnimationFrame(check)
            }
            requestAnimationFrame(check)
            setTimeout(finish, timeoutMs)
        })
    }

    // WORD MORPH: for matched text whose content changed, render hidden unrotated A/B probes, measure
    // per-word positions (in slide/output-resolution space so A & B share one frame), diff, and drive a
    // WordMorphLayer overlay (matched words FLIP A->B, removed fade out, added fade in).
    let morphProbes: { index: number; which: "a" | "b"; item: Item }[] = []
    let probeContainer: HTMLElement | null = null
    let morphMeasureGen = 0
    let morphWordActive: Record<number, boolean> = {} // matched text index → uses word morph
    let morphWordAItem: Record<number, Item> = {} // A item shown during the measurement pre-roll (no jump)
    let morphWordLayer: Record<number, { matched: any[]; removed: any[]; added: any[] }> = {} // measured overlay data
    let morphWordSettled: Record<number, boolean> = {} // index → animation done; hand back to real B text
    let morphWordSettleTimeout: NodeJS.Timeout | null = null
    let morphDuration = 500
    let morphEasingCss = "ease-in-out"
    const stripRotation = (item: Item): Item => ({ ...item, style: (item.style || "").replace(/transform:[^;]*;?/g, "") })

    async function measureWordMorph(gen: number) {
        await tick()
        try {
            await document.fonts.ready
        } catch {
            /* ignore */
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
        if (gen !== morphMeasureGen || !probeContainer) return
        // measure relative to the probe container → slide/output-resolution coords (A & B share this frame)
        const base = probeContainer.getBoundingClientRect()
        const els = Array.from(probeContainer.querySelectorAll(".item")) as HTMLElement[]
        const perIndex: Record<number, { a?: WordBox[]; b?: WordBox[] }> = {}
        morphProbes.forEach((p, i) => {
            const el = els[i]
            if (!el) return
            const words = measureWords(el, base, ratio)
            perIndex[p.index] = perIndex[p.index] || {}
            perIndex[p.index][p.which] = words
        })
        const layer: Record<number, { matched: any[]; removed: any[]; added: any[] }> = {}
        Object.entries(perIndex).forEach(([idx, ab]) => {
            if (!ab.a || !ab.b) return
            const aW = ab.a
            const bW = ab.b
            const d = diffWords(
                aW.map((w) => w.text),
                bW.map((w) => w.text)
            )
            layer[+idx] = {
                matched: d.matched.map(({ a, b }) => ({ text: bW[b].text, aX: aW[a].x, aY: aW[a].y, aFont: aW[a].fontSize, aLineHeight: aW[a].lineHeight, bX: bW[b].x, bY: bW[b].y, bFont: bW[b].fontSize, lineHeight: bW[b].lineHeight, color: bW[b].color, fontFamily: bW[b].fontFamily, fontWeight: bW[b].fontWeight, fontStyle: bW[b].fontStyle })),
                removed: d.removed.map((i) => ({ ...aW[i] })),
                added: d.added.map((i) => ({ ...bW[i] }))
            }
        })
        morphWordLayer = layer
        // after the animation, hand back to the real B text (real shaped run, dynamic values, etc.)
        if (morphWordSettleTimeout) clearTimeout(morphWordSettleTimeout)
        morphWordSettleTimeout = setTimeout(() => {
            if (gen !== morphMeasureGen) return
            const s: Record<number, boolean> = { ...morphWordSettled }
            Object.keys(layer).forEach((i) => (s[+i] = true))
            morphWordSettled = s
        }, morphDuration)
    }

    // a text item's stored (pre-ratio) font-size: from the text chunk style, else the item style, else
    // derived from the autosize fitted size. getCustomFontSize applies the output ratio at render time.
    function storedFontPx(item: Item, style: string, fontSizeRatio: number): number {
        const chunkStyle = item?.lines?.[0]?.text?.[0]?.style || ""
        const stored = parseFloat(getStyles(chunkStyle, true)["font-size"] || getStyles(style || "", true)["font-size"] || "")
        if (stored) return stored
        if (item?.autoFontSize) return item.autoFontSize / (fontSizeRatio || 1)
        return 100
    }

    // set every text chunk's font-size (pre-ratio px) on a clone of the item — applies the interpolated font
    function withChunkFont(item: Item, px: number): Item {
        const lines = (item.lines || []).map((line) => ({ ...line, text: (line.text || []).map((t) => ({ ...t, style: `${(t.style || "").replace(/font-size:[^;]*;?/g, "")};font-size:${px}px;` })) }))
        return { ...item, lines }
    }

    // map FreeShow easing names to a CSS timing function
    function cssEasing(easing: string): string {
        if (easing === "linear") return "linear"
        if (easing === "back") return "cubic-bezier(0.68, -0.55, 0.27, 1.55)"
        if (easing === "bounce" || easing === "elastic") return "cubic-bezier(0.34, 1.56, 0.64, 1)"
        return "ease-in-out" // sine / cubic / circ
    }

    // morph is a whole-slide transition set on a slide (like PowerPoint/Keynote). Detect it on
    // the incoming slide's resolved transition, OR on the slide we're leaving — so a morph set
    // on B animates both A->B (forward) and B->A (backward).
    function getMorphTransition() {
        if (transition?.type === "morph") return transition
        if (transition?.in?.type === "morph") return transition.in
        if (transition?.between?.type === "morph") return transition.between
        // bidirectional: the slide we're leaving (current context) used morph
        const outgoing = current?.slideData?.transition
        if (outgoing?.type === "morph") return outgoing
        return null
    }

    async function startMorph(morphTransition: any) {
        const myGen = ++morphStartGen
        const aItems: Item[] = clone(currentItems)
        const bItems: Item[] = clone(currentSlide.items || [])
        const match = matchItems(aItems, bItems)

        const duration = morphTransition?.duration ?? 500
        const easingName = morphTransition?.easing || "sine"
        morphOpacityTransition = `opacity ${duration}ms ${cssEasing(easingName)}`
        morphDuration = duration
        morphEasingCss = cssEasing(easingName)
        const easeFn: (t: number) => number = easings.find((e) => e.value === easingName)?.function || ((t: number) => t)

        // every matched pair interpolates its box style A->B; matched TEXT also interpolates its font size
        const ratio = ((currentStyle?.aspectRatio?.fontSizeRatio ?? 100) as number) / 100 || 1
        const styleA: Record<number, string> = {}
        const styleB: Record<number, string> = {}
        const itemStyle: Record<number, string> = {}
        const isText: Record<number, boolean> = {}
        const fontA: Record<number, number> = {}
        const fontB: Record<number, number> = {}
        const fontCur: Record<number, number> = {}
        match.pairs.forEach(({ aIndex, bIndex }) => {
            styleA[bIndex] = aItems[aIndex]?.style || ""
            styleB[bIndex] = bItems[bIndex]?.style || ""
            itemStyle[bIndex] = styleA[bIndex] // start at A's box
            if ((bItems[bIndex]?.type || "text") === "text") {
                isText[bIndex] = true
                fontA[bIndex] = storedFontPx(aItems[aIndex], styleA[bIndex], ratio)
                fontB[bIndex] = storedFontPx(bItems[bIndex], styleB[bIndex], ratio)
                fontCur[bIndex] = fontA[bIndex] // start at A's font
            }
        })
        morphStyleA = styleA
        morphStyleB = styleB
        morphItemStyle = itemStyle
        morphIsText = isText
        morphFontA = fontA
        morphFontB = fontB
        morphTextFont = fontCur
        flipEnteringIndexes = [...match.entering]
        flipExitingItems = match.exiting.map((i) => aItems[i])

        // WORD MORPH: for matched text whose content changed, render hidden A/B probes, measure per-word
        // positions and drive the overlay. Falls back to whole-box morph for rotated or gradient text.
        const probes: { index: number; which: "a" | "b"; item: Item }[] = []
        const wordActive: Record<number, boolean> = {}
        const wordAItem: Record<number, Item> = {}
        // gradient / background-clip:text fills can't be split per word (each word would restart the gradient)
        const hasGradientText = (it: Item) => {
            const styles = [it?.style || "", ...(it?.lines || []).flatMap((l) => (l.text || []).map((t) => t.style || ""))].join(" ")
            return /gradient|background-clip|-webkit-background-clip/i.test(styles)
        }
        match.pairs.forEach(({ aIndex, bIndex }) => {
            if ((bItems[bIndex]?.type || "text") !== "text") return
            // ANY transform (rotate, rotateX tilt, scaleX flip, perspective) → whole-box morph (v1).
            // The probes below are rendered through stripRotation, which drops the whole transform, and
            // the overlay is laid out in flat slide space — so a transformed item would animate untilted
            // /unflipped. A plain /rotate\(/ test missed rotateX & scaleX and let those through.
            if (hasTransform(aItems[aIndex]?.style) || hasTransform(bItems[bIndex]?.style)) return
            if (hasGradientText(aItems[aIndex]) || hasGradientText(bItems[bIndex])) return // gradient text → whole-box morph
            const aw = extractWords(aItems[aIndex]?.lines)
            const bw = extractWords(bItems[bIndex]?.lines)
            // Alignment (item.align = vertical, line.align = horizontal) is NOT part of item.style, so the
            // whole-box morph applies B's alignment from frame 0 while the box is still at A's geometry —
            // the text jumps before the animation starts. Word morph measures the real rendered word
            // positions in A and B, so it absorbs the alignment shift continuously.
            const sameText = aw.join(" ") === bw.join(" ")
            const sameAlign = alignSignature(aItems[aIndex]) === alignSignature(bItems[bIndex])
            if (sameText && sameAlign) return // nothing moves inside the box → whole-box morph handles it
            wordActive[bIndex] = true
            wordAItem[bIndex] = aItems[aIndex]
            probes.push({ index: bIndex, which: "a", item: stripRotation(aItems[aIndex]) })
            probes.push({ index: bIndex, which: "b", item: stripRotation(bItems[bIndex]) })
        })
        morphWordActive = wordActive
        morphWordAItem = wordAItem
        morphWordLayer = {}
        morphWordSettled = {}
        morphProbes = probes

        // capture the B context now; the swap below applies it (the morph path keeps rendering B → no flash)
        const bContext = { outSlide: clone(outSlide), slideData: clone(slideData), currentSlide: clone(currentSlide), lines: clone(lines), currentStyle: clone(currentStyle) }
        morphExitCtx = bContext // exiting (A-only) items render with a stable context across the swap
        morphGen++
        morphGo = false
        morphExitRevealed = false

        // PRE-ROLL: if we're fading out media, mount those exiting copies while A is still on screen and
        // wait for them to paint. The swap then reuses the loaded copies (no fresh <img> blank). Scoped to
        // exiting media only → image->image (matched, no exiting) and no-image->image are never delayed.
        const exitingHasMedia = flipExitingItems.some((it) => (it?.type || "text") === "media")
        if (exitingHasMedia) {
            morphExitPreroll = true
            await tick()
            await waitForExitImages(exitLayerEl, 300)
            if (myGen !== morphStartGen) return // a newer morph superseded this one during the pre-roll
            morphExitRevealed = true // force the loaded exit copies visible (CSS) before A is torn down
            await tick() // flush the reveal to the DOM before the swap removes A's own copy
            if (myGen !== morphStartGen) return
        }

        // SWAP: advance context to the new slide and reveal the morph branch
        current = bContext
        currentItems = bItems
        persistentItems = []
        persistentItemIndexes = []
        morphActive = true
        morphExitPreroll = false

        if (probes.length) measureWordMorph(++morphMeasureGen)

        // fade in/out the unmatched items (matched items are driven by the rAF below)
        requestAnimationFrame(() => requestAnimationFrame(() => (morphGo = true)))

        // interpolate every matched item's box style each frame (+ font for autosize text)
        const matchedIndexes = Object.keys(itemStyle).map(Number)
        if (morphRaf) cancelAnimationFrame(morphRaf)
        if (matchedIndexes.length) {
            const start = performance.now()
            const step = (now: number) => {
                const t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration)
                const et = easeFn(t)
                const nextStyle: Record<number, string> = {}
                const nextFont: Record<number, number> = {}
                matchedIndexes.forEach((i) => {
                    nextStyle[i] = interpolateStyle(morphStyleA[i], morphStyleB[i], et)
                    if (morphIsText[i]) nextFont[i] = morphFontA[i] + (morphFontB[i] - morphFontA[i]) * et
                })
                morphItemStyle = nextStyle
                morphTextFont = nextFont
                morphRaf = t < 1 ? requestAnimationFrame(step) : null
            }
            morphRaf = requestAnimationFrame(step)
        }

        // drop the exiting (A-only) items once they've faded out
        if (morphExitTimeout) clearTimeout(morphExitTimeout)
        morphExitTimeout = setTimeout(() => (flipExitingItems = []), duration)
    }

    // create a stable identifier for precompute + visible textbox coordination
    function createAutoSizeKey(item: Item, index: number) {
        return item?.id ? String(item.id) : `idx-${index}`
    }

    let isClearingToEmpty = false
    async function updateItems() {
        let betweenClearingTransition = transition.between || transition
        if (betweenClearingTransition?.type === "none") betweenClearingTransition.duration = 0

        if (!currentSlideItems?.length) {
            scheduleAutoSizePrecompute([])
            currentItems = []
            // Clear persistent items when no slide content
            persistentItems = []
            persistentItemIndexes = []
            current = {
                outSlide: clone(outSlide),
                slideData: clone(slideData),
                currentSlide: clone(currentSlide),
                lines: clone(lines),
                currentStyle: clone(currentStyle)
            }

            // wait for items to properly clear
            // if changing quickly from text to empty to text again, the first text will be displayed again (due to Svelte transition bug)
            if (transitionEnabled) {
                isClearingToEmpty = true
                setTimeout(() => (isClearingToEmpty = false), betweenClearingTransition.duration)
            }
            return
        }

        if (isClearingToEmpty) await waitUntilValueIsDefined(() => !isClearingToEmpty, 10, betweenClearingTransition.duration)

        scheduleAutoSizePrecompute(currentSlide.items)

        // MORPH: when advancing to a different slide with a morph transition, animate matched
        // objects A->B (and fade the unmatched) instead of running the show/hide cycle.
        const targetKey = `${outSlide?.id}-${outSlide?.layout}-${outSlide?.index}`
        const morphTransition = transitionEnabled ? getMorphTransition() : null
        const morphIsDifferentSlide = current.currentSlide?.id !== currentSlide?.id || current.outSlide?.index !== outSlide?.index || current.outSlide?.id !== outSlide?.id
        // ignore redundant re-triggers of updateItems for a morph already running (or pre-rolling) to this slide
        if ((morphActive || morphExitPreroll) && morphTransition && targetKey === morphTargetKey) return
        if (morphTransition && morphIsDifferentSlide && currentItems.length && currentSlide.items.length) {
            if (timeout) clearTimeout(timeout)
            morphTargetKey = targetKey
            startMorph(morphTransition)
            return
        }
        morphActive = false

        // get any items with no transition between the two slides
        let oldItemTransition = currentItems.find((a) => a.actions?.transition)?.actions?.transition
        let newItemTransition = currentSlide.items.find((a) => a.actions?.transition)?.actions?.transition
        let itemTransitionDuration: number | null = null
        if (oldItemTransition && JSON.stringify(oldItemTransition) === JSON.stringify(newItemTransition)) {
            itemTransitionDuration = oldItemTransition.duration ?? null
            if (oldItemTransition.type === "none") itemTransitionDuration = 0
            // find any item that should have no transition!
            else if (currentSlide.items.find((a) => a.actions?.transition?.duration === 0 || a.actions?.transition?.type === "none")) itemTransitionDuration = 0
        }

        let currentTransition = transition.between || transition.in || transition
        if (currentTransition?.type === "none") currentTransition.duration = 0

        let currentTransitionDuration = transitionEnabled ? (itemTransitionDuration ?? currentTransition?.duration ?? 0) : 0
        let waitToShow = currentTransitionDuration * ((currentTransition?.fadeInOffset ?? 50) / 100)

        // Identify items that are unchanged and have no real transition (to skip redraw)
        const newPersistentIndexes: number[] = []
        const newPersistentItems: Item[] = []
        const transitioningItems: Item[] = []
        const transitioningIndexes: number[] = []

        // First, check if ANY item on the slide has a real transition
        // If so, all items should animate together (no persistent items)
        const slideHasAnyTransition = currentSlide.items.some((item: Item) => {
            const itemTrans = item.actions?.transition
            return hasRealTransition(itemTrans, currentTransition)
        })

        currentSlide.items.forEach((newItem: Item, newIndex: number) => {
            // Find matching old item by index (position-based matching for slides)
            const oldItem = currentItems[newIndex]

            // Item is persistent only if:
            // 1. Content is unchanged AND
            // 2. No real transition on this item AND
            // 3. No other item on the slide has a transition (so whole slide animates together)
            if (itemsAreEqual(oldItem, newItem) && !slideHasAnyTransition) {
                newPersistentIndexes.push(newIndex)
                newPersistentItems.push(clone(newItem))
            } else {
                // Item needs to be re-rendered (changed, has transition, or another item has transition)
                transitioningIndexes.push(newIndex)
                transitioningItems.push(clone(newItem))
            }
        })

        // Update persistent items (these won't flash)
        persistentItemIndexes = newPersistentIndexes
        persistentItems = newPersistentItems

        // between
        const isDifferentSlide = current.currentSlide?.id !== currentSlide?.id || current.outSlide?.index !== outSlide?.index || current.outSlide?.id !== outSlide?.id
        if (isDifferentSlide && currentItems.length && currentSlide.items.length) transitioningBetween = true

        if (timeout) clearTimeout(timeout)

        // If all items are persistent (unchanged), skip the show/hide cycle entirely
        if (transitioningItems.length === 0 && persistentItems.length > 0) {
            // Just update the context without triggering transitions
            current = {
                outSlide: clone(outSlide),
                slideData: clone(slideData),
                currentSlide: clone(currentSlide),
                lines: clone(lines),
                currentStyle: clone(currentStyle)
            }
            // Keep currentItems in sync but don't toggle show
            currentItems = clone(currentSlide.items || [])
            transitioningBetween = false
            return
        }

        const gen = ++updateGeneration

        // wait for between to update out transition
        timeout = setTimeout(() => {
            if (gen !== updateGeneration) return
            show = false

            // wait for previous items to start fading out (svelte will keep them until the transition is done!)
            timeout = setTimeout(() => {
                if (gen !== updateGeneration) return
                // Only include items that need transitioning in currentItems
                // Persistent items are rendered separately
                currentItems = clone(currentSlide.items || [])
                current = {
                    outSlide: clone(outSlide),
                    slideData: clone(slideData),
                    currentSlide: clone(currentSlide),
                    lines: clone(lines),
                    currentStyle: clone(currentStyle)
                }

                // wait until half transition duration of previous items have passed as it looks better visually
                timeout = setTimeout(() => {
                    if (gen !== updateGeneration) return
                    show = true

                    // wait for between to set in transition
                    timeout = setTimeout(() => {
                        if (gen !== updateGeneration) return
                        transitioningBetween = false
                    })
                }, waitToShow)
            })
        })
    }

    // OUTPUT SLIDE TIMELINE
    // get current slide timeline position
    let timelinePos = 0
    let timelineItems = new Map<string, Item[]>()
    let timelineActions: TimelineAction[] = []
    let isReady = false
    $: if (outSlide) isReady = false
    $: if (currentSlide) setupTimeline()
    function setupTimeline() {
        if (isReady) return
        timelinePos = 0
        timelineActions = currentSlide?.timeline?.actions || []
        // timelineItems = new Set<Item[]>() // WIP reset eventually?
        setTimeout(() => (isReady = true))
    }
    onMount(() => {
        const interval = setInterval(() => {
            if (isClearing || !isReady || !timelineActions.length) return
            // WIP use actual slide timeline pos when available?
            timelinePos += 15 * $slideTimelineSpeedMultiplier
            styleActions(timelineActions)

            // loop back when reached last action
            if (currentSlide?.timeline?.loop) {
                const lastActionTime = Math.max(...timelineActions.map((a) => a.time + (a.duration || 0) * 1000))
                if (timelinePos >= lastActionTime) timelinePos = 0
            }
        }, 15)

        function styleActions(actions: TimelineAction[]) {
            const itemStyleActions = actions.filter((a) => a.type === "style")
            // group by style key & indexes
            const groupedActions = new Map<string, TimelineAction[]>()
            for (const action of itemStyleActions) {
                const key = action.data?.key
                if (!key) continue

                const indexes = action.data?.indexes ? action.data.indexes.join(",") : ""
                const groupKey = `${key}-${indexes}`

                if (!groupedActions.has(groupKey)) groupedActions.set(groupKey, [])
                groupedActions.get(groupKey)?.push(action)
            }

            const slideKey = `${outSlide?.id}-${outSlide?.layout}-${outSlide?.index}`
            const items = clone(timelineItems.get(slideKey) || currentItems)

            const currentTime = timelinePos
            groupedActions.forEach((actions, _key) => {
                const previous = getPreviousAction(actions)
                const next = getNextAction(actions)
                const value = SlideTimeline.interpolateValue(previous, next, currentTime)
                if (value === null) return

                const action = (previous || next)!
                // const ref = _show(outSlide?.id || "").layouts([outSlide?.layout]).ref()[0] || []
                // const slideId = ref[outSlide?.index || 0]?.id
                // SlideTimeline.triggerAction(action, value, { id: outSlide.id, slideId: slideId })

                const itemIndexes = action.data.indexes ?? [0]
                itemIndexes.forEach((itemIndex) => {
                    const item = items[itemIndex]
                    if (!item) return

                    const updatedItem = SlideTimeline.updateStyle(action, item, value)
                    items[itemIndex] = updatedItem
                })
            })

            timelineItems.set(slideKey, items)
            timelineItems = timelineItems
        }

        function getPreviousAction(actions: TimelineAction[]) {
            const now = timelinePos
            return actions.reduce((prev, curr) => (curr.time > (prev?.time ?? -1) && curr.time <= now ? curr : prev), null as TimelineAction | null)
        }

        function getNextAction(actions: TimelineAction[]) {
            const now = timelinePos
            return actions.reduce((next, curr) => (curr.time > now && (next === null || curr.time < next.time) ? curr : next), null as TimelineAction | null)
        }

        return () => {
            clearInterval(interval)
        }
    })
</script>

<!-- MORPH exiting (A-only) items: fade out in place. Rendered OUTSIDE the morph key block and during the
     pre-roll too, so the swap to B reuses these already-loaded elements (no fresh <img> blank). -->
{#if morphActive || morphExitPreroll}
    <div class="morph-exit-layer" class:revealed={morphExitRevealed} style="display: contents" bind:this={exitLayerEl}>
        {#each flipExitingItems as exItem, exIndex (createAutoSizeKey(exItem, exIndex) + "-morphexit")}
            {#if exItem && shouldItemBeShown(exItem, [], showItemRef, conditionsUpdater)}
                <div class="morph-fade" style="opacity: {morphGo ? 0 : 1}; transition: {morphGo ? morphOpacityTransition : 'none'};">
                    <Textbox item={exItem} transition={null} {ratio} {outputId} ref={{ type: "show", showId: morphExitCtx.outSlide?.id, slideId: morphExitCtx.currentSlide?.id, id: morphExitCtx.currentSlide?.id || "", layoutId: morphExitCtx.outSlide?.layout }} outputStyle={morphExitCtx.currentStyle} {mirror} {preview} slideIndex={morphExitCtx.outSlide?.index} {styleIdOverride} updateDynamicValues={false} />
                </div>
            {/if}
        {/each}
    </div>
{/if}

<!-- MORPH transition: matched items interpolate their box style A->B (media re-fits, autosize text re-fonts); unmatched fade -->
{#if morphActive}
    {#key morphGen}
        <!-- destination (B) items: matched interpolate box style (+font for autosize text); entering fades in -->
        {#each currentItems as item, index (createAutoSizeKey(item, index))}
            {#if item && shouldItemBeShown(item, [], showItemRef, conditionsUpdater) && (!item.clickReveal || current.outSlide?.itemClickReveal)}
                {@const linesStart = current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesStart" : "start"]}
                {@const linesEnd = current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesEnd" : "end"]}
                {@const clickRevealed = !!current.lines?.[currentLineId || ""]?.clickRevealed}
                {#if morphWordActive[index]}
                    <!-- WORD MORPH: A pre-roll → word overlay (matched FLIP, removed/added fade) → real B text -->
                    {#if morphWordSettled[index]}
                        <Textbox
                            backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                            chords={item.chords?.enabled}
                            animationStyle={animationData.style || {}}
                            {item}
                            transition={null}
                            {ratio}
                            {outputId}
                            ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }}
                            {linesStart}
                            {linesEnd}
                            {clickRevealed}
                            outputStyle={current.currentStyle}
                            {mirror}
                            {preview}
                            slideIndex={current.outSlide?.index}
                            {styleIdOverride}
                            autoSizeKey={createAutoSizeKey(item, index)}
                            updateDynamicValues={!isClearing}
                        />
                    {:else if morphWordLayer[index]}
                        {#key morphGen}
                            <WordMorphLayer matched={morphWordLayer[index].matched} removed={morphWordLayer[index].removed} added={morphWordLayer[index].added} duration={morphDuration} easing={morphEasingCss} />
                        {/key}
                    {:else}
                        <Textbox item={morphWordAItem[index]} transition={null} {ratio} {outputId} ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }} outputStyle={current.currentStyle} {mirror} {preview} slideIndex={current.outSlide?.index} {styleIdOverride} updateDynamicValues={false} />
                    {/if}
                {:else if morphItemStyle[index] !== undefined}
                    <!-- MATCHED: interpolated box style; text also gets interpolated font (injected into chunks, textFit none) -->
                    <Textbox
                        backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                        chords={item.chords?.enabled}
                        animationStyle={animationData.style || {}}
                        item={morphIsText[index] ? withChunkFont({ ...item, style: morphItemStyle[index], textFit: "none" }, morphTextFont[index] || 0) : { ...item, style: morphItemStyle[index] }}
                        transition={null}
                        {ratio}
                        {outputId}
                        ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }}
                        {linesStart}
                        {linesEnd}
                        {clickRevealed}
                        outputStyle={current.currentStyle}
                        {mirror}
                        {preview}
                        slideIndex={current.outSlide?.index}
                        {styleIdOverride}
                        updateDynamicValues={!isClearing}
                    />
                {:else if flipEnteringIndexes.includes(index)}
                    <!-- ENTERING (unmatched B): fade in at its own position -->
                    <div class="morph-fade" style="opacity: {morphGo ? 1 : 0}; transition: {morphGo ? morphOpacityTransition : 'none'};">
                        <Textbox
                            backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                            chords={item.chords?.enabled}
                            animationStyle={animationData.style || {}}
                            {item}
                            transition={null}
                            {ratio}
                            {outputId}
                            ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }}
                            {linesStart}
                            {linesEnd}
                            {clickRevealed}
                            outputStyle={current.currentStyle}
                            {mirror}
                            {preview}
                            slideIndex={current.outSlide?.index}
                            {styleIdOverride}
                            autoSizeKey={createAutoSizeKey(item, index)}
                            updateDynamicValues={!isClearing}
                        />
                    </div>
                {/if}
            {/if}
        {/each}
        <!-- WORD MORPH (Slice 1): hidden A/B probes (unrotated) rendered so we can Range-measure per-word positions -->
        {#if morphProbes.length}
            <div class="autosize-precompute" aria-hidden="true" bind:this={probeContainer}>
                {#each morphProbes as p (p.which + "-" + p.index)}
                    <Textbox item={p.item} {ratio} {outputId} outputStyle={current.currentStyle} {mirror} {preview} {styleIdOverride} ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }} updateDynamicValues={false} />
                {/each}
            </div>
        {/if}
    {/key}
{:else}
    <!-- Render all items in original order to maintain z-index layering -->
    {#each currentItems as item, index}
        {#if item && shouldItemBeShown(item, [], showItemRef, conditionsUpdater) && (!item.clickReveal || current.outSlide?.itemClickReveal)}
            {#if persistentItemIndexes.includes(index)}
                <!-- Persistent item: unchanged content, render outside transition to avoid flicker -->
                <Textbox
                    backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                    chords={item.chords?.enabled}
                    animationStyle={animationData.style || {}}
                    item={timelineItems.get(`${current.outSlide?.id}-${current.outSlide?.layout}-${current.outSlide?.index}`)?.[index] || item}
                    transition={null}
                    {ratio}
                    {outputId}
                    ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }}
                    linesStart={current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesStart" : "start"]}
                    linesEnd={current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesEnd" : "end"]}
                    clickRevealed={!!current.lines?.[currentLineId || ""]?.clickRevealed}
                    outputStyle={current.currentStyle}
                    {mirror}
                    {preview}
                    slideIndex={current.outSlide?.index}
                    {styleIdOverride}
                    autoSizeKey={createAutoSizeKey(item, index)}
                    updateDynamicValues={!isClearing}
                />
            {:else}
                <!-- Transitioning item: render with animation wrapper inside {#key} -->
                {#key show}
                    {#if show}
                        <!-- NOTE: this branch only renders when morphActive is false, i.e. the morph path is NOT
                             handling these items (first slide, same-slide update, transitions disabled, ...).
                             So the transition is always passed through — a morph type falls back to a plain
                             fade via the `morph` marker in utils/transitions. -->
                        <SlideItemTransition {preview} {transitionEnabled} {transitioningBetween} globalTransition={transition} currentSlide={current.currentSlide} {item} outSlide={current.outSlide} lines={current.lines} currentStyle={current.currentStyle} let:customSlide let:customItem let:customLines let:customOut let:transition>
                            <Textbox
                                backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                                chords={customItem.chords?.enabled}
                                animationStyle={animationData.style || {}}
                                item={timelineItems.get(`${customOut?.id}-${customOut?.layout}-${customOut?.index}`)?.[index] || customItem}
                                {transition}
                                {ratio}
                                {outputId}
                                ref={{ type: "show", showId: customOut?.id, slideId: customSlide?.id, id: customSlide?.id || "", layoutId: customOut?.layout, origin }}
                                linesStart={customLines?.[currentLineId || ""]?.[item.lineReveal ? "linesStart" : "start"]}
                                linesEnd={customLines?.[currentLineId || ""]?.[item.lineReveal ? "linesEnd" : "end"]}
                                clickRevealed={!!customLines?.[currentLineId || ""]?.clickRevealed}
                                outputStyle={current.currentStyle}
                                {mirror}
                                {preview}
                                slideIndex={customOut?.index}
                                {styleIdOverride}
                                autoSizeKey={createAutoSizeKey(item, index)}
                                updateDynamicValues={!isClearing}
                            />
                        </SlideItemTransition>
                    {/if}
                {/key}
            {/if}
        {/if}
    {/each}
{/if}

{#if precomputeTargets.length}
    <div class="autosize-precompute" aria-hidden="true">
        {#each precomputeTargets as target (target.key)}
            <Textbox item={target.item} {ratio} {outputId} outputStyle={currentStyle} {mirror} {preview} {styleIdOverride} ref={{ type: "show", showId: outSlide?.id, slideId: currentSlide?.id, id: currentSlide?.id || "", layoutId: outSlide?.layout }} autoSizeKey={target.key} on:autosizeReady={handlePrecomputeReady} updateDynamicValues={!isClearing} />
        {/each}
    </div>
{/if}

<style>
    /* MORPH: wrapper carries opacity only (for unmatched enter/exit fade). Zero-size; its child .item
       stays absolutely positioned relative to the slide. */
    .morph-fade {
        position: relative;
        width: 0;
        height: 0;
    }

    /* Once the exiting media copies are confirmed loaded, force them visible. <Image> keeps every img at
       opacity:0 until its own (cached-image-unreliable) `loaded` flag flips; this container class overrides
       that so the swap reveals them instantly. The fade-out is driven by the .morph-fade wrapper, not the img. */
    :global(.morph-exit-layer.revealed img) {
        opacity: 1 !important;
        transition: none !important;
    }

    /* park precompute textboxes far off-screen so they never flash during transitions */
    .autosize-precompute {
        position: absolute;
        top: -10000px;
        left: -10000px;
        width: 0;
        height: 0;
        overflow: hidden;
        pointer-events: none;
        visibility: hidden;
    }
</style>
