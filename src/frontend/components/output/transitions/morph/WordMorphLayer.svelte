<script lang="ts">
    // Word-level text morph overlay. Rendered inside the morphing box container (which carries the
    // box's position/size/rotation), positioned in the box's local output-resolution frame.
    // Matched words FLIP from their A position/size to their B position/size (transform: translate+scale
    // — a word is a real shaped text run, so uniform scaling preserves kerning/ligatures); removed words
    // fade out at their A spot, added words fade in at their B spot. See design doc.
    import { onMount } from "svelte"

    interface MatchedWord {
        text: string
        aX: number
        aY: number
        aFont: number
        bX: number
        bY: number
        bFont: number
        lineHeight: number
        color: string
        fontFamily: string
        fontWeight: string
        fontStyle: string
    }
    interface FadeWord {
        text: string
        x: number
        y: number
        fontSize: number
        lineHeight: number
        color: string
        fontFamily: string
        fontWeight: string
        fontStyle: string
    }

    export let matched: MatchedWord[] = []
    export let removed: FadeWord[] = [] // A-only → fade out
    export let added: FadeWord[] = [] // B-only → fade in
    export let duration = 500
    export let easing = "ease-in-out" // CSS timing function

    let go = false
    onMount(() => requestAnimationFrame(() => requestAnimationFrame(() => (go = true))))

    const font = (w: { fontFamily: string; fontWeight: string; fontStyle: string }) => `font-family:${w.fontFamily};font-weight:${w.fontWeight};font-style:${w.fontStyle};`
</script>

<!-- matched: FLIP from A geometry to B (translate + scale; scale also carries the line-height/size delta) -->
{#each matched as w, i (i)}
    <span
        class="mw"
        style="left:{w.bX}px; top:{w.bY}px; font-size:{w.bFont}px; line-height:{w.lineHeight}px; color:{w.color}; {font(w)}
            transform: {go ? 'none' : `translate(${w.aX - w.bX}px, ${w.aY - w.bY}px) scale(${w.bFont ? w.aFont / w.bFont : 1})`};
            transition: transform {duration}ms {easing};">{w.text}</span
    >
{/each}

<!-- removed (A-only): fade out in place -->
{#each removed as w, i (i)}
    <span class="mw" style="left:{w.x}px; top:{w.y}px; font-size:{w.fontSize}px; line-height:{w.lineHeight}px; color:{w.color}; {font(w)} opacity:{go ? 0 : 1}; transition: opacity {duration}ms {easing};">{w.text}</span>
{/each}

<!-- added (B-only): fade in in place -->
{#each added as w, i (i)}
    <span class="mw" style="left:{w.x}px; top:{w.y}px; font-size:{w.fontSize}px; line-height:{w.lineHeight}px; color:{w.color}; {font(w)} opacity:{go ? 1 : 0}; transition: opacity {duration}ms {easing};">{w.text}</span>
{/each}

<style>
    .mw {
        position: absolute;
        white-space: pre;
        transform-origin: 0 0;
    }
</style>
