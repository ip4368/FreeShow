<script lang="ts">
    import type { Transition } from "../../../../types/Show"
    import { custom } from "../../../utils/transitions"

    export let transition: Transition | undefined = undefined
    export let inTransition: Transition | null = null
    export let outTransition: Transition | null = null
    // additive ("plus-lighter") blend so the outgoing + incoming copies add instead of alpha-over
    // -> a crossfade of identical content holds constant intensity instead of dipping (#2169)
    export let blend = false

    $: disableTransition = (inTransition?.type || transition?.type) === "none" || (!inTransition?.duration && !transition?.duration)
</script>

<!-- svelte transition bug!!! -->
{#if disableTransition && !inTransition && !outTransition}
    <div class="transitioner" class:blend>
        <slot />
    </div>
{:else}
    <div class="transitioner" class:blend in:custom={inTransition || transition || {}} out:custom={outTransition || transition || {}} on:outrostart>
        <slot />
    </div>
{/if}

<style>
    div {
        width: 100%;
        height: 100%;

        position: absolute;
        top: 0;
        left: 0;

        pointer-events: none;
    }
    .blend {
        mix-blend-mode: plus-lighter;
    }
</style>
