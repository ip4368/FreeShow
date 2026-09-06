<script lang="ts">
    import { onMount } from "svelte"
    import { Main } from "../../../../types/IPC/Main"
    import { isSocketTransport } from "../../../IPC/transport"
    import { requestMain, sendMain } from "../../../IPC/main"
    import { activePopup, popupData, showsCache } from "../../../stores"
    import { newToast } from "../../../utils/common"
    import { translateText } from "../../../utils/language"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import InputRow from "../../input/InputRow.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"

    // web build + a desktop connected to a remote server: the library lives on the
    // server, so restore is a one-shot "upload a .zip" instead of browsing/opening
    // local backup files.
    const isRemote = isSocketTransport()

    let backupsList: { path: string; name: string; date: number; size: number }[] = []
    let fileInput: HTMLInputElement
    let restoring = false

    onMount(async () => {
        if (isRemote) return

        backupsList = (await requestMain(Main.BACKUPS)) || []
        backupsList = backupsList.sort((a, b) => b.date - a.date)

        if (!backupsList.length) restoreCustom()
    })

    function restoreCustom() {
        showsCache.set({})
        sendMain(Main.RESTORE)
    }

    async function restoreUpload(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return

        restoring = true
        newToast("settings.restore_started")

        try {
            const buffer = await file.arrayBuffer()
            const result = await requestMain(Main.RESTORE_UPLOAD, buffer)

            if (result?.finished) {
                showsCache.set({})
                activePopup.set(null)
                newToast("settings.restore_finished")
            } else {
                newToast(result?.error || "Restore failed")
            }
        } catch (err) {
            newToast((err as Error)?.message || "Restore failed")
        } finally {
            restoring = false
            if (fileInput) fileInput.value = ""
        }
    }

    function getDaysAgo(date: number) {
        const diff = Date.now() - date
        const days = Math.floor(diff / (1000 * 60 * 60 * 24))

        if (days === 0) return translateText("calendar.today")
        return `${days}d`
    }

    function sizeToString(size: number) {
        if (size < 1024) return `${size} B`
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`
        if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`
        return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    // WIP deleting multiple folders should be possible without having to wait 5 seconds for each

    let deletingPath: string | null = null
    let undoTimeout: NodeJS.Timeout | null = null
    function deleteBackup(path: string) {
        if (undoTimeout) {
            if (deletingPath === path) {
                clearTimeout(undoTimeout)
                clear()
            }
            return
        }

        deletingPath = path
        undoTimeout = setTimeout(() => {
            sendMain(Main.DELETE_BACKUP, { path })
            backupsList = backupsList.filter((b) => b.path !== path)
            clear()
        }, 5000)

        function clear() {
            deletingPath = null
            undoTimeout = null
        }
    }

    function restore(backup: { path: string; name: string; date: number; size: number }) {
        popupData.set({
            prompt: `<b>${backup.name}</b><br><br>${translateText("settings.restore_confirm")}`,
            trigger: () => sendMain(Main.RESTORE, { path: backup.path })
        })
        activePopup.set("confirm")
    }
</script>

{#if $popupData.back}
    <MaterialButton class="popup-back" icon="back" iconSize={1.3} title="actions.back" on:click={() => activePopup.set($popupData.back)} />
{/if}

{#if isRemote}
    <input bind:this={fileInput} type="file" accept=".zip" style="display: none;" on:change={restoreUpload} />
    <MaterialButton variant="outlined" disabled={restoring} on:click={() => fileInput.click()}>
        <Icon id="import" size={1.3} />
        <p><T id="settings.restore" /></p>
    </MaterialButton>
{:else}
    <div class="list">
        {#each backupsList as backup}
            <InputRow>
                <MaterialButton variant="outlined" title="settings.restore" style="width: 100%;" on:click={() => restore(backup)}>
                    <div class="info">
                        <div class="name">{backup.name.endsWith("_auto") ? translateText("settings.auto") : backup.name} <span style="opacity: 0.3;font-size: 0.7em;padding: 0 8px;">{sizeToString(backup.size)}</span></div>
                        <div class="date">{getDaysAgo(backup.date)} - {new Date(backup.date).toLocaleString()}</div>
                    </div>
                </MaterialButton>

                <!-- show delete button if backup is older than 30 days -->
                {#if backup.date < Date.now() - 86400000 * 30}
                    <MaterialButton variant="outlined" icon={deletingPath === backup.path ? "undo" : "delete"} title="actions.delete" disabled={deletingPath !== backup.path && undoTimeout !== null} on:click={() => deleteBackup(backup.path)} />
                {/if}
            </InputRow>
        {/each}
    </div>

    <MaterialButton variant="outlined" on:click={restoreCustom}>
        <Icon id="import" size={1.3} />
        <!-- <p><T id="settings.restore" /></p> -->
        <!-- <p><T id="actions.choose_custom" /></p> -->
        <p><T id="inputs.change_folder" /></p>
    </MaterialButton>
{/if}

<style>
    .list {
        display: flex;
        flex-direction: column;
        gap: 5px;
        margin-bottom: 20px;
    }

    .info {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
        width: 100%;
    }

    .date {
        font-size: 0.9em;
        opacity: 0.7;
        font-family: monospace;
    }
</style>
