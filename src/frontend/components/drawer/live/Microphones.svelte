<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { AudioMicrophone } from "../../../audio/audioMicrophone"
    import T from "../../helpers/T.svelte"
    import Center from "../../system/Center.svelte"
    import SelectElem from "../../system/SelectElem.svelte"
    import Mic from "./Mic.svelte"

    interface Mics {
        [groupId: string]: {
            [deviceId: string]: string
        }
    }

    let mics: Mics = {}

    async function updateList() {
        const devices = (await AudioMicrophone.getList()) || []

        // rebuilt rather than added to, so a device that has gone away actually disappears
        const updated: Mics = {}
        devices.forEach((d) => {
            if (!updated[d.groupId]) updated[d.groupId] = {}
            updated[d.groupId][d.deviceId] = d.label
        })

        mics = updated
    }

    // the list goes stale the moment anything is plugged in or disconnects, and a
    // stale entry looks identical to a working one until you try to listen to it
    onMount(() => {
        updateList()
        navigator.mediaDevices.addEventListener("devicechange", updateList)
    })
    onDestroy(() => navigator.mediaDevices.removeEventListener("devicechange", updateList))
</script>

{#if Object.values(mics).length}
    <div class="row" style="gap: 10px;">
        {#each Object.entries(mics) as [groupId, mic] (groupId)}
            <div class="row">
                <!-- keyed by device, so a Mic is destroyed along with its device rather
                     than being re-pointed at a different one while still monitoring the old -->
                {#each Object.entries(mic) as [id, name] (id)}
                    <SelectElem id="microphone" data={{ id, type: "microphone", name }} draggable>
                        <Mic mic={{ id, name }} />
                    </SelectElem>
                {/each}
            </div>
        {/each}
    </div>
{:else}
    <Center faded>
        <T id="empty.general" />
    </Center>
{/if}

<style>
    .row {
        display: flex;
        flex-direction: column;
        width: 100%;
    }
</style>
