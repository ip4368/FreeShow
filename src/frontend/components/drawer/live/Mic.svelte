<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { uid } from "uid"
    import { AudioMicrophone } from "../../../audio/audioMicrophone"
    import { activeFocus, activeShow, focusMode, playingAudio } from "../../../stores"
    import Icon from "../../helpers/Icon.svelte"
    import Button from "../../inputs/Button.svelte"

    export let mic: { id: string; name: string }

    // The meter reads the capture AudioMicrophone already shares for this device.
    // It must not open one of its own: a second stream reconfigures the device and
    // interrupts anything already listening to it (see microphoneStream.ts).
    const monitorId = uid()

    let soundLevel = 0
    let listening = false
    let animationFrame = 0
    let lastTickTime = 0
    let retryTimeout: NodeJS.Timeout | null = null

    onMount(() => {
        listen()
        function listen() {
            retryTimeout = null
            AudioMicrophone.startListening(mic.id, monitorId).then((started) => {
                listening = started
                // the device can be busy elsewhere for a while, keep trying
                if (!started) retryTimeout = setTimeout(listen, 5000)
            })
        }

        function loop(timestamp: number) {
            animationFrame = requestAnimationFrame(loop)
            if (timestamp - lastTickTime < 33) return // throttle to ~30fps, matching AudioMeter
            lastTickTime = timestamp

            const dB = AudioMicrophone.getVolume(mic.id)
            soundLevel = dB <= -60 ? 0 : Math.min(100, ((dB + 60) / 60) * 100)
        }
        animationFrame = requestAnimationFrame(loop)
    })

    onDestroy(() => {
        if (animationFrame) cancelAnimationFrame(animationFrame)
        if (retryTimeout) clearTimeout(retryTimeout)
        AudioMicrophone.stopListening(mic.id, monitorId)
    })

    $: micId = "mic_sub_" + mic.id
    $: muted = !$playingAudio[micId]
</script>

<div class="main">
    <Button
        style="width: 100%;"
        bold={false}
        on:click={() => AudioMicrophone.start(mic.id, { name: mic.name }, { pauseIfPlaying: true })}
        on:dblclick={(e) => {
            if (e.ctrlKey || e.metaKey) return

            if ($focusMode) activeFocus.set({ id: mic.id, type: "audio" })
            else activeShow.set({ id: mic.id, name: mic.name, type: "audio", data: { isMic: true } })
        }}
    >
        <span style="display: flex;gap: 5px;flex: 3;align-items: center;">
            <Icon id={muted ? "muted" : "volume"} white={muted} right />
            <p>{mic.name}</p>
        </span>

        {#if listening}
            <div class="channel-row">
                <span class="signal-dot" class:active={soundLevel > 0}></span>
                <span class="meter">
                    <div style="width: {100 - soundLevel}%;" />
                    <span class="meter" style="position: absolute; opacity: 0.08; right: 0; height: inherit; width: 100%;" />
                </span>
            </div>
        {/if}
    </Button>
</div>

<style>
    .main {
        display: flex;
    }
    .main:nth-child(even) {
        background-color: rgb(0 0 20 / 0.08);
    }

    /* matches AudioMeter.svelte style */

    .channel-row {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1;
    }

    .signal-dot {
        width: 3px;
        height: 3px;
        border-radius: 2px;
        background-color: rgba(255, 255, 255, 0.2);
        transition:
            background-color 0.1s ease,
            box-shadow 0.1s ease;
        flex-shrink: 0;
    }

    .signal-dot.active {
        background-color: rgb(0, 200, 200);
    }

    .meter {
        background-image: linear-gradient(90deg, rgb(0, 200, 200) 0%, rgb(0, 255, 50) 55%, rgb(255, 200, 0) 84%, rgb(200, 0, 0) 100%);
        height: 3px;
        position: relative;
        border-radius: 1px;
        flex: 1;
    }

    .meter div {
        transition: width 0.05s ease 0s;
        background-color: var(--primary-darker);
        height: 100%;
        position: absolute;
        right: 0;
    }
</style>
