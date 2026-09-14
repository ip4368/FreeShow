<script lang="ts">
    import { onDestroy } from "svelte"
    import type { TrashEntryData } from "../../../../types/IPC/Main"
    import { mediaLibraryVersion } from "../../../stores"
    import { translateText } from "../../../utils/language"
    import { deleteTrashEntries, emptyTrashBin, listTrashEntries, restoreTrashEntries } from "../../../utils/trash"
    import Icon from "../../helpers/Icon.svelte"
    import { getExtension, getFileName, getMediaType } from "../../helpers/media"
    import T from "../../helpers/T.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import Center from "../../system/Center.svelte"

    // single shared server trash, filtered per drawer
    export let kind: "media" | "audio"

    const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000

    let entries: TrashEntryData[] = []
    let totalSize = 0
    let loading = true

    async function load() {
        loading = true
        const result = await listTrashEntries()
        entries = result.entries
        totalSize = result.totalSize
        loading = false
    }

    // refresh on every server trash mutation (any client, incl. expiry sweep)
    let seenVersion = 0
    const unsubscribe = mediaLibraryVersion.subscribe((v) => {
        if (v.n !== seenVersion) {
            seenVersion = v.n
            void load()
        }
    })
    onDestroy(unsubscribe)

    void load()

    $: visible = entries.filter((e) => e.isFolder || (kind === "audio" ? getMediaType(getExtension(e.name)) === "audio" : getMediaType(getExtension(e.name)) !== "audio"))

    function formatBytes(bytes: number): string {
        if (!bytes) return "0 B"
        const units = ["B", "KB", "MB", "GB"]
        let value = bytes
        let unit = 0
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024
            unit++
        }
        return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
    }

    function expiresIn(deletedAt: number): string {
        const remaining = deletedAt + TRASH_TTL_MS - Date.now()
        if (remaining <= 0) return translateText("trash.expires_in").replace("$1", "…")
        const days = Math.floor(remaining / (24 * 60 * 60 * 1000))
        if (days >= 1) return translateText("trash.expires_in").replace("$1", `${days}d`)
        const hours = Math.floor(remaining / (60 * 60 * 1000))
        if (hours >= 1) return translateText("trash.expires_in").replace("$1", `${hours}h`)
        return translateText("trash.expires_in").replace("$1", `${Math.max(1, Math.floor(remaining / 60000))}m`)
    }

    function locationOf(originalPath: string): string {
        const parts = originalPath.replace(/\\/g, "/").split("/").filter(Boolean)
        parts.pop()
        return parts.join("/") || "/"
    }

    function iconFor(entry: TrashEntryData): string {
        if (entry.isFolder) return "folder"
        const type = getMediaType(getExtension(entry.name))
        if (type === "audio") return "audio"
        if (type === "video") return "video"
        return "image"
    }

    async function restore(ids: string[]) {
        await restoreTrashEntries(ids)
    }

    async function remove(ids: string[], names: string[]) {
        await deleteTrashEntries(ids, names)
    }

    async function empty() {
        await emptyTrashBin(entries.length)
    }
</script>

<div class="trash">
    <div class="header">
        <p class="meta">
            {entries.length} • {formatBytes(totalSize)}
        </p>
        {#if entries.length}
            <MaterialButton title={translateText("actions.empty_trash")} variant="outlined" red small on:click={empty}>
                <Icon id="delete" size={1} />
                <p><T id="actions.empty_trash" /></p>
            </MaterialButton>
        {/if}
    </div>

    {#if loading && !entries.length}
        <Center faded><p>...</p></Center>
    {:else if !visible.length}
        <Center style="opacity: 0.5;">
            <Icon id="delete" size={4} />
            <p><T id="trash.empty" /></p>
        </Center>
    {:else}
        <div class="list">
            {#each visible as entry (entry.id)}
                <div class="row">
                    <Icon id={iconFor(entry)} size={2} />
                    <div class="info">
                        <p class="name" title={entry.originalPath}>{getFileName(entry.originalPath) || entry.name}</p>
                        <p class="sub">
                            {locationOf(entry.originalPath)} • {formatBytes(entry.size)} • {expiresIn(entry.deletedAt)}
                        </p>
                    </div>
                    <MaterialButton title={translateText("actions.restore")} small on:click={() => restore([entry.id])}>
                        <Icon id="undo" size={1.1} />
                    </MaterialButton>
                    <MaterialButton title={translateText("actions.delete_permanent")} small red on:click={() => remove([entry.id], [entry.name])}>
                        <Icon id="delete" size={1.1} />
                    </MaterialButton>
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .trash {
        display: flex;
        flex-direction: column;
        height: 100%;
        /* the drawer grid is a wrapping flex row: span it, or this collapses left */
        width: 100%;
        overflow-y: auto;
        padding: 10px;
        gap: 8px;
    }
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 4px;
    }
    .meta {
        opacity: 0.6;
        font-size: 0.85em;
    }
    .list {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 10px;
        background-color: var(--primary-darker);
        border: 1px solid var(--primary-lighter);
        border-radius: 8px;
    }
    .info {
        flex: 1;
        min-width: 0;
    }
    .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .sub {
        opacity: 0.55;
        font-size: 0.8em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
