<script lang="ts">
    import { dictionary, overlays } from "../../../stores"
    import Icon from "../../helpers/Icon.svelte"
    import Button from "../../inputs/Button.svelte"

    export let columns: number
    export let overlayId: string = ""

    $: overlay = $overlays[overlayId] || {}

    function changeAction(actionId: string) {
        // don't update until overlay display click has finished
        setTimeout(() => {
            // WIP history
            overlays.update((a) => {
                delete a[overlayId][actionId]
                return a
            })
        })
    }

    const actionsList = [
        { id: "locked", title: $dictionary.context?.lock_to_output, icon: "locked" },
        { id: "placeUnderSlide", title: $dictionary.context?.place_under_slide, icon: "under" },
        { id: "displayDuration", title: $dictionary.popup?.display_duration, icon: "clock" },
    ]

    $: zoom = 5 / columns
</script>

<div class="icons" style="zoom: {zoom};">
    {#each actionsList as action}
        {#if overlay[action.id]}
            <div>
                <div class="button white">
                    <Button style="padding: 3px;" redHover title="{$dictionary.actions?.remove}: {action.title}" {zoom} on:click={() => changeAction(action.id)}>
                        <Icon id={action.icon} size={0.9} white />
                    </Button>
                </div>
                {#if action.id === "displayDuration" && !isNaN(overlay[action.id] || 0)}
                    <span><p>{overlay[action.id] || 0}s</p></span>
                {/if}
            </div>
        {/if}
    {/each}
</div>

<style>
    .icons {
        pointer-events: none;
        display: flex;
        flex-direction: column;
        position: absolute;
        left: 0;
        /* right: 2px; */
        z-index: 1;
        font-size: 0.9em;

        height: 80%;
        flex-wrap: wrap; /* -reverse; */
        /* place-items: end; */
    }
    .icons div {
        opacity: 0.9;
        display: flex;
    }
    .icons .button {
        background-color: rgb(0 0 0 / 0.6);
        pointer-events: all;
    }
    .icons span {
        pointer-events: all;
        background-color: rgb(0 0 0 / 0.6);
        padding: 3px;
        font-size: 0.75em;
        font-weight: bold;
        display: flex;
        align-items: center;
    }

    .button:not(.white) :global(svg) {
        fill: #ff5050;
    }
</style>
