<script lang="ts">
    import { uid } from "uid"
    import type { Item, Transition } from "../../../../types/Show"
    import { currentWindow, scriptureSettings, templates } from "../../../stores"
    import { clone } from "../../helpers/array"
    import { getStyleTemplate, slideHasAutoSizeItem } from "../../helpers/output"
    import OutputTransition from "./OutputTransition.svelte"
    // import { onMount } from "svelte"

    export let globalTransition: Transition
    export let transitionEnabled = false
    export let transitioningBetween = false
    export let preview = false
    export let item: Item
    export let currentSlide: any = {}
    export let outSlide: any = {}
    export let lines: any[] = []
    export let currentStyle: any = {}

    let currentlyTransitioning: { [key: string]: any } = {}

    $: if (item !== undefined || lines) startTransition()

    // additive crossfade only for text-like items; media/video/web must not blend additively
    $: blendItem = (item?.type || "text") === "text"

    // WIP item wait out time will not clear other items without wait time if between transition
    // WIP slide direction from top to bottom is a bit buggy
    // WIP image is flashing a bit in scripture transition none

    function startTransition() {
        // prevent stacking of the same item on update
        const lastStateId = Object.keys(currentlyTransitioning).pop()
        if (lastStateId) {
            const lastState = currentlyTransitioning[lastStateId]
            if (JSON.stringify(lastState.item) === JSON.stringify(item) && JSON.stringify(lastState.lines) === JSON.stringify(lines) && JSON.stringify(lastState.outSlide) === JSON.stringify(outSlide) && JSON.stringify(lastState.currentSlide) === JSON.stringify(currentSlide)) {
                return
            }
        }

        let itemTransition = item.actions?.transition ? clone(item.actions.transition) : null
        if (itemTransition?.type === "none") itemTransition.duration = 0

        // SET TRANSITION
        // globalTransition also has style & slide transition
        // priority: item > slide > style > global
        let transition = itemTransition || globalTransition
        if (transition?.type === "none") transition.duration = 0

        let inTransition = clone(transition.in || transition)
        let outTransition = clone(transition.out || transition)
        let transitionBetween = clone(transition.between || transition)
        if (transitioningBetween) inTransition = clone(transitionBetween)

        let inDelay = 0
        let outDelay = 0

        // ITEM IN/OUT DELAY
        let showDuration = $currentWindow === "output" || preview ? item?.actions?.showTimer || 0 : 0
        inDelay = showDuration ? showDuration * 1000 : 0
        let hideDuration = $currentWindow === "output" || preview ? item?.actions?.hideTimer || 0 : 0
        outDelay = hideDuration ? hideDuration * 1000 : 0

        // EXTRA DELAY

        // auto size delay
        if (!outDelay) {
            let customTemplate = getStyleTemplate(outSlide, currentStyle)
            if (!Object.keys(customTemplate).length && outSlide?.id === "temp") customTemplate = $templates[$scriptureSettings.template] || {}

            // only keep the legacy autosize delay when nothing has pre-populated a font size yet
            const templateNeedsAutoSize = Object.keys(customTemplate).length ? slideHasAutoSizeItem(customTemplate) : false
            const itemNeedsAutoSize = item.auto && !item.autoFontSize

            if (templateNeedsAutoSize || itemNeedsAutoSize) {
                outDelay = 500
                if (!inDelay) inDelay = outDelay * 0.98
            }
        }

        // add some time in case an identical item is "fading" in
        if (!outDelay && itemTransition?.duration === 0 && item.type === "media") outDelay = 250
        // the previous fallback kept the old item visible a moment longer to avoid a black flash,
        // but the autosize precompute path already keeps the new content ready, so we let the
        // zero-duration case swap immediately to prevent overlapping text.
        // WIP having outDelay on just 1 item will cause all other items to not clear until that is finished!

        // crossfade overlap (#2169): when replacing existing content, the incoming copy fades in while
        // the outgoing copy fades out, both driven by requestAnimationFrame (no setTimeout gate) so they
        // can't desync into a black flash under load. fadeInOffset delays the incoming fade: 0 = true
        // simultaneous crossfade (never dips to black); higher values fade the old out first (a dip).
        const hasPrevious = Object.keys(currentlyTransitioning).length > 0
        if (hasPrevious && transitionEnabled && !inDelay) {
            const offset = (globalTransition?.fadeInOffset ?? 0) / 100
            inDelay = (inTransition.duration || 0) * offset
        }

        // SET DELAY

        inTransition.delay = inDelay
        outTransition.delay = outDelay
        transitionBetween.delay = outDelay

        // delay won't work if no transition
        if (inDelay && (inTransition.type === "none" || inTransition?.duration === 0)) inTransition = { ...inTransition, type: "fade", duration: 1 }
        if (outDelay && (outTransition.type === "none" || outTransition?.duration === 0)) outTransition = { ...outTransition, type: "fade", duration: 1 }

        // SET

        let stateId = uid(5)
        let state = {
            item: clone(item),
            lines: clone(lines),
            outSlide: clone(outSlide),
            currentSlide: clone(currentSlide),
            inTransition,
            outTransition,
            transitionBetween
        }

        // Keep only the current state. Replacing it removes the previous key from the keyed {#each}
        // below, which triggers its out: transition — so the outgoing copy fades out while this new
        // copy fades in, both mounted at once (a true crossfade with no unmounted gap). #2169
        currentlyTransitioning = { [stateId]: state }
    }
</script>

<!-- isolate the outgoing + incoming copies so the additive (plus-lighter) blend adds them to EACH OTHER,
     not to the background — keeps a same-content crossfade at constant intensity, works on any background (#2169) -->
<div class="transition-group">
    {#each Object.entries(currentlyTransitioning) as [stateId, transitioning] (stateId)}
        <OutputTransition blend={blendItem} inTransition={transitionEnabled ? transitioning.inTransition : null} outTransition={transitionEnabled ? (transitioningBetween ? transitioning.transitionBetween : transitioning.outTransition) : null}>
            <slot customItem={transitioning.item} customLines={transitioning.lines} customOut={transitioning.outSlide} customSlide={transitioning.currentSlide} transition={transitionEnabled ? transitioning.inTransition : null} />
        </OutputTransition>
    {/each}
</div>

<style>
    .transition-group {
        position: absolute;
        inset: 0;
        isolation: isolate;
        pointer-events: none;
    }
</style>
