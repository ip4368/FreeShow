<script lang="ts">
    import { Main } from "../../../../types/IPC/Main"
    import { requestMain } from "../../../IPC/main"
    import { isSocketTransport } from "../../../IPC/transport"
    import { activePopup } from "../../../stores"
    import { newToast } from "../../../utils/common"
    import { save } from "../../../utils/save"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import InputRow from "../../input/InputRow.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"

    // web build + a desktop connected to a remote server: the library lives on the
    // server, so "backup everything" downloads a zip from it instead of writing one
    // to this machine's local backups folder.
    const isRemote = isSocketTransport()

    async function backup() {
        if (!isRemote) return save(false, { backup: true })

        const bytes = await requestMain(Main.BACKUP_DOWNLOAD)
        if (!bytes) return newToast("Backup failed")

        const blob = new Blob([bytes])
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `freeshow_backup_${Date.now()}.zip`
        a.click()
        URL.revokeObjectURL(url)

        newToast("settings.backup_finished")
    }
</script>

<InputRow>
    <MaterialButton style="flex: 1;font-size: 1.1em;padding: 20px !important;" title="settings.backup_info" on:click={backup}>
        <Icon id="export" size={1.3} />
        <p><T id="settings.backup_all" /></p>
    </MaterialButton>
    <MaterialButton style="flex: 1;font-size: 1.1em;padding: 20px !important;" on:click={() => activePopup.set("restore")}>
        <Icon id="import" size={1.3} />
        <p><T id="settings.restore" /></p>
    </MaterialButton>
</InputRow>
