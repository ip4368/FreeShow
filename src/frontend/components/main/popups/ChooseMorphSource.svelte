<script lang="ts">
    // Picks which item on the PREVIOUS slide a morphing item should animate from (item.morphLink).
    // Opened from the "Morph from" button in the item panel (see values/boxes.ts morphSection).
    //
    // The slide is rendered read-only via Zoomed + Textbox, with transparent hit boxes laid over it
    // that are derived from each item's own left/top/width/height. Hit-testing synthetic boxes rather
    // than the rendered content keeps small or overlapping items reliably clickable, and gives the
    // outline + number badge somewhere to live.
    import type { Item } from "../../../../types/Show"
    import { activeEdit, activePopup, activeShow, popupData, showsCache } from "../../../stores"
    import { translateText } from "../../../utils/language"
    import { history } from "../../helpers/history"
    import { getLayoutRef } from "../../helpers/show"
    import { parseMorphStyle } from "../../output/transitions/morph/styleInterpolate"
    import Icon from "../../helpers/Icon.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import Textbox from "../../slide/Textbox.svelte"
    import Zoomed from "../../slide/Zoomed.svelte"
    import { MORPH_LINK_NONE, morphSourceLabel } from "../../output/transitions/morph/morphMatcher"

    const active: string = $popupData.active || ""

    const showId = $activeShow?.id || ""
    // default ("active") matches how BoxStyle resolves the layout; $showsCache keeps it reactive
    $: ref = getLayoutRef("active", $showsCache)
    $: slideIndex = $activeEdit.slide ?? 0
    $: previousSlideId = slideIndex > 0 ? ref[slideIndex - 1]?.id : ""
    $: previousSlide = previousSlideId ? $showsCache[showId]?.slides?.[previousSlideId] : null
    $: items = (previousSlide?.items || []) as Item[]

    // CONFLICTS: the matcher is strictly 1:1 and resolves a contested source by LOWEST item index —
    // not by whichever link was made most recently. So a second item linking the same source would
    // silently fall back to id/index matching instead of the source that was picked. Rather than let
    // that happen invisibly, flag it here and, on override, actually clear the other item's link so
    // "this one wins" is true rather than a coin flip on item order.
    $: currentSlideId = ref[slideIndex]?.id || ""
    $: currentItems = ($showsCache[showId]?.slides?.[currentSlideId]?.items || []) as Item[]
    $: editingIndex = $activeEdit.items?.[0] ?? -1

    // previous-slide item id → the OTHER item on this slide already linked to it
    $: linkedBy = currentItems.reduce(
        (map, it, index) => {
            if (index !== editingIndex && it?.morphLink && it.morphLink !== MORPH_LINK_NONE) map[it.morphLink] = index
            return map
        },
        {} as Record<string, number>
    )

    let pending: { sourceId: string; sourceLabel: string; conflictIndex: number } | null = null

    function pick(item: Item, index: number) {
        const sourceId = item.id || ""
        const conflictIndex = linkedBy[sourceId]

        if (conflictIndex === undefined) {
            choose(sourceId)
            return
        }

        pending = { sourceId, sourceLabel: morphSourceLabel(item, index), conflictIndex }
    }

    function confirmOverride() {
        if (!pending) return

        // release the previous holder first, so exactly one item ends up linked to this source
        history({
            id: "setItems",
            newData: { style: { key: "morphLink", values: [""] } },
            location: { page: "edit", show: $activeShow!, slide: currentSlideId, items: [pending.conflictIndex] }
        })

        choose(pending.sourceId)
    }

    // Hit box from the item's own box style, via the SAME parser the morph uses — so the boxes line up
    // with what the transition actually considers the item's geometry.
    // NB: do not use getStyles(style, true) here; that strips units ("120px" -> "120"), which yields
    // invalid CSS and collapses every box onto the top-left corner.
    // Fallback sizes mirror Zoomed's `:global(.item)` defaults for items with no explicit size.
    function boxOf(item: Item) {
        const s = parseMorphStyle(item?.style || "")
        return { left: s.left || "0px", top: s.top || "0px", width: s.width || "400px", height: s.height || "150px" }
    }

    // Rendered by the shared TooltipManager (cursor-following, edge-aware) with data-title-delay="0",
    // so a conflict is visible the moment the cursor lands rather than after the usual 700ms pause.
    // `links`/`slideItems` are passed in rather than read from scope so the template re-evaluates
    // this when either changes.
    function tooltipFor(item: Item, index: number, links: Record<string, number>, slideItems: Item[]) {
        const label = morphSourceLabel(item, index)
        const conflictIndex = item.id ? links[item.id] : undefined
        if (conflictIndex === undefined) return label

        return `${label} — ${translateText("morph.link_taken_hint", null, [morphSourceLabel(slideItems[conflictIndex], conflictIndex)])}`
    }

    function choose(value: string) {
        if ($popupData.trigger) $popupData.trigger(value)
        else popupData.set({ ...$popupData, value })

        activePopup.set(null)
    }
</script>

<div class="morphSource">
    {#if !previousSlide}
        <div class="empty">
            <Icon id="info" size={2} white />
            <p>{translateText("morph.no_previous_slide")}</p>
        </div>
    {:else}
        <p class="label">{translateText("morph.previous_slide")} ({slideIndex} / {ref.length})</p>

        <div class="slide">
            <Zoomed background={previousSlide.settings?.color || "#000000"} checkered={false}>
                {#each items as item}
                    <Textbox {item} ref={{ type: "show", showId, slideId: previousSlideId, id: previousSlideId }} preview mirror={false} />
                {/each}

                {#each items as item, index}
                    {@const box = boxOf(item)}
                    {@const conflictIndex = item.id ? linkedBy[item.id] : undefined}
                    {@const taken = conflictIndex !== undefined}
                    <button type="button" class="hitbox" class:selected={active === item.id} class:taken style="left:{box.left};top:{box.top};width:{box.width};height:{box.height};" data-title={tooltipFor(item, index, linkedBy, currentItems)} data-title-delay="0" on:click={() => pick(item, index)}>
                        <span class="badge" class:taken>{index + 1}</span>
                        <!-- at-a-glance marker so conflicts are visible without sweeping the cursor -->
                        {#if taken}
                            <span class="takenChip">
                                <Icon id="bind" size={0.8} />
                                {translateText("morph.link_taken", null, [String(conflictIndex + 1)])}
                            </span>
                        {/if}
                    </button>
                {/each}
            </Zoomed>
        </div>
    {/if}

    {#if pending}
        <div class="warning">
            <Icon id="warning" size={1.2} white />
            <p>{translateText("morph.override_warning", null, [pending.sourceLabel, morphSourceLabel(currentItems[pending.conflictIndex], pending.conflictIndex)])}</p>
            <MaterialButton icon="check" on:click={confirmOverride}>{translateText("morph.override")}</MaterialButton>
            <MaterialButton icon="close" on:click={() => (pending = null)}>{translateText("popup.cancel")}</MaterialButton>
        </div>
    {:else}
        <div class="actions">
            <MaterialButton icon="reset" on:click={() => choose("")} isActive={!active}>{translateText("morph.link_auto")}</MaterialButton>
            <MaterialButton icon="clear" on:click={() => choose(MORPH_LINK_NONE)} isActive={active === MORPH_LINK_NONE}>{translateText("morph.link_none")}</MaterialButton>
        </div>
    {/if}
</div>

<style>
    .morphSource {
        display: flex;
        flex-direction: column;
        gap: 10px;

        min-width: 60vw;
    }

    .label {
        opacity: 0.7;
        font-size: 0.9em;
    }

    .slide {
        position: relative;
        width: 100%;
    }

    .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 40px 20px;

        opacity: 0.6;
    }

    /* hit boxes sit in the same coordinate space as the items themselves */
    .hitbox {
        position: absolute;

        background-color: transparent;
        border: 2px dashed rgb(255 255 255 / 0.35);
        border-radius: 4px;
        cursor: pointer;
        padding: 0;
    }
    .hitbox:hover,
    .hitbox:focus-visible {
        background-color: var(--secondary-opacity);
        border-color: var(--secondary);
        border-style: solid;
        outline: none;
    }
    .hitbox.selected {
        border-color: var(--secondary);
        border-style: solid;
    }
    /* already claimed by another item on this slide — still selectable, but it will steal the link */
    .hitbox.taken {
        border-color: #e8a33d;
        border-style: dashed;
    }

    /* always on screen — this is the conflict warning, so it must not depend on hovering */
    .takenChip {
        position: absolute;
        top: 0;
        inset-inline-end: 0;

        display: flex;
        align-items: center;
        gap: 0.3em;
        padding: 0.2em 0.4em;

        background-color: #e8a33d;
        color: #000000;
        font-size: 0.85em;
        font-weight: bold;
        white-space: nowrap;
    }

    .warning {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;

        background-color: rgb(232 163 61 / 0.15);
        border: 1px solid #e8a33d;
        border-radius: 4px;
    }
    .warning p {
        flex: 1;
        font-size: 0.9em;
    }

    .badge.taken {
        background-color: #e8a33d;
        color: #000000;
    }

    .badge {
        position: absolute;
        top: 0;
        left: 0;

        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 1.6em;
        height: 1.6em;
        padding: 0 0.3em;

        background-color: var(--secondary);
        color: var(--secondary-text);
        font-size: 1.2em;
        font-weight: bold;
    }

    .actions {
        display: flex;
        gap: 10px;
        justify-content: center;
    }
</style>
